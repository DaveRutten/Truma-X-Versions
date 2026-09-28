// truma_mqtt.js - minimal MQTT 3.1.1 client over WebSocket (browser + Node >= 22).
// Only what truma-x needs: CONNECT, SUBSCRIBE, PUBLISH (QoS 0/1 in, QoS 0 out, retain),
// PUBACK for incoming QoS 1, PINGREQ keepalive, and fallback over a list of brokers.
// No third-party code.

const enc = new TextEncoder(), dec = new TextDecoder();

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return out;
}
function str(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function packet(type, body) { return new Uint8Array([type, ...varint(body.length), ...body]); }

export function connectPacket(clientId, keepalive, user, pass) {
  let flags = 0x02;                                   // clean session
  const payload = [...str(clientId)];
  if (user) { flags |= 0x80; payload.push(...str(user)); }
  if (pass) { flags |= 0x40; payload.push(...str(pass)); }
  return packet(0x10, [...str("MQTT"), 4, flags, keepalive >> 8, keepalive & 255, ...payload]);
}
export function subscribePacket(id, topics) {
  const body = [id >> 8, id & 255];
  for (const t of topics) body.push(...str(t), 0);    // QoS 0
  return packet(0x82, body);
}
export function publishPacket(topic, payload, retain = false) {
  return packet(0x30 | (retain ? 1 : 0), [...str(topic), ...payload]);
}

// Splits a byte stream into MQTT packets: -> [{type, flags, body}], rest stays buffered.
export class Parser {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0, mul = 1, i = 1, ok = false;
      for (; i < 5 && i < this.buf.length; i++) {
        len += (this.buf[i] & 127) * mul; mul *= 128;
        if (!(this.buf[i] & 128)) { ok = true; i++; break; }
      }
      if (!ok || this.buf.length < i + len) break;
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 15, body: this.buf.slice(i, i + len) });
      this.buf = this.buf.slice(i + len);
    }
    return out;
  }
}
export function parsePublish(p) {
  const tl = (p.body[0] << 8) | p.body[1];
  const topic = dec.decode(p.body.slice(2, 2 + tl));
  const qos = (p.flags >> 1) & 3;
  let off = 2 + tl, id = 0;
  if (qos) { id = (p.body[off] << 8) | p.body[off + 1]; off += 2; }
  return { topic, qos, id, retain: !!(p.flags & 1), payload: p.body.slice(off) };
}

// One logical connection that walks `urls` on failure.
// events: onMessage(topic, bytes, retain), onStatus({connected, url, error})
export class MqttLink {
  constructor(urls, topics, { onMessage, onStatus, keepalive = 30, WebSocketImpl } = {}) {
    this.urls = urls; this.topics = topics; this.keepalive = keepalive;
    this.onMessage = onMessage || (() => {}); this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.idx = 0; this.ws = null; this.connected = false; this.stopped = false;
    this.url = null; this.waiters = [];
  }
  start() { this._open(); return this; }
  stop() { this.stopped = true; clearInterval(this._ping); try { this.ws && this.ws.close(); } catch (e) {} }

  whenConnected(ms = 10000) {
    if (this.connected) return Promise.resolve();
    return new Promise((res, rej) => {
      const w = { res, t: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("no broker")); }, ms) };
      this.waiters.push(w);
    });
  }

  _open() {
    if (this.stopped) return;
    const url = this.urls[this.idx % this.urls.length];
    const u = new URL(url);
    const user = decodeURIComponent(u.username || ""), pass = decodeURIComponent(u.password || "");
    u.username = ""; u.password = "";
    this.url = url;
    let ws;
    try { ws = new this.WS(u.toString(), "mqtt"); } catch (e) { return this._fail(e); }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const parser = new Parser();
    let lastRx = Date.now(), opened = false, ended = false;
    // A broker that never answers (no open, no error) must not block us: some browsers
    // (Safari) never fire onclose for a socket closed while still connecting.
    const connectTimer = setTimeout(() => {
      if (this.connected || ended) return;
      ended = true; ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) {}
      this.onStatus({ connected: false, url: this.url, error: "timeout" });
      if (!this.stopped) { this.idx++; setTimeout(() => this._open(), 2000); }
    }, 10000);
    ws.onopen = () => {
      opened = true;
      ws.send(connectPacket("tx-" + Math.random().toString(16).slice(2, 12), this.keepalive, user, pass));
    };
    ws.onmessage = (ev) => {
      lastRx = Date.now();
      for (const p of parser.push(new Uint8Array(ev.data))) {
        if (p.type === 2) {                                   // CONNACK
          if (p.body[1] !== 0) { try { ws.close(); } catch (e) {} return; }
          clearTimeout(connectTimer);
          this.connected = true;
          ws.send(subscribePacket(1, this.topics));
          this._ping = setInterval(() => {
            if (Date.now() - lastRx > this.keepalive * 1500) { try { ws.close(); } catch (e) {} return; }
            ws.send(new Uint8Array([0xc0, 0]));
          }, this.keepalive * 1000);
          this.onStatus({ connected: true, url: this.url });
          for (const w of this.waiters.splice(0)) { clearTimeout(w.t); w.res(); }
        } else if (p.type === 3) {                            // PUBLISH
          const m = parsePublish(p);
          if (m.qos === 1) ws.send(new Uint8Array([0x40, 2, m.id >> 8, m.id & 255]));
          try { this.onMessage(m.topic, m.payload, m.retain); } catch (e) { console.warn(e); }
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (ended) return; ended = true;
      clearTimeout(connectTimer); clearInterval(this._ping);
      const was = this.connected; this.connected = false;
      this.onStatus({ connected: false, url: this.url, error: opened ? "closed" : "unreachable" });
      if (this.stopped) return;
      if (!was) this.idx++;              // never got in: try the next broker
      setTimeout(() => this._open(), was ? 1000 : 2000);
    };
  }
  _fail(e) {
    this.onStatus({ connected: false, url: this.url, error: String(e) });
    this.idx++; setTimeout(() => this._open(), 2000);
  }

  publish(topic, payload, retain = false) {
    if (!this.connected) return false;
    this.ws.send(publishPacket(topic, payload, retain));
    return true;
  }
}

// Connects to every broker at once and treats them as one link. The phone does not know
// which broker the ESP ended up on (a broker can be down for one side only), so it listens
// on all of them and publishes on every connected one. Duplicates are harmless: the
// replay window drops a second copy of a message and a response is taken only once.
export class MultiLink {
  constructor(urls, topics, { onMessage, onStatus, keepalive, WebSocketImpl } = {}) {
    this.onStatusCb = onStatus || (() => {});
    this.waiters = [];
    this.links = urls.map((u) => new MqttLink([u], topics, {
      onMessage, keepalive, WebSocketImpl, onStatus: () => this._status(),
    }));
  }
  get connected() { return this.links.some((l) => l.connected); }
  get urls() { return this.links.filter((l) => l.connected).map((l) => l.url); }
  start() { this.links.forEach((l) => l.start()); return this; }
  stop() { this.links.forEach((l) => l.stop()); }
  _status() {
    const up = this.urls;
    this.onStatusCb({ connected: up.length > 0, url: up[0] || null, urls: up });
    if (up.length) for (const w of this.waiters.splice(0)) { clearTimeout(w.t); w.res(); }
  }
  whenConnected(ms = 10000) {
    if (this.connected) return Promise.resolve();
    return new Promise((res, rej) => {
      const w = { res, t: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("no broker")); }, ms) };
      this.waiters.push(w);
    });
  }
  publish(topic, payload, retain = false) {
    let any = false;
    for (const l of this.links) any = l.publish(topic, payload, retain) || any;
    return any;
  }
}
