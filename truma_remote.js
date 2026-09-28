// truma_remote.js - remote protocol v1 (docs/remote-protocol.md) for the browser.
// WebCrypto only, no dependencies. Also runs under Node >= 18 (globalThis.crypto),
// which is how test/test_remote.mjs checks it against test/vectors/remote_v1.json.

import { MultiLink as DefaultMqttLink } from "./truma_mqtt.js";

export const VERSION = 1;
export const T_REQ = 1, T_RESP = 2, T_STATE = 3;
export const HDR_LEN = 14, TAG_LEN = 16, TS_WINDOW = 300;
export const BROKERS = {
  eclipse:   "wss://mqtt.eclipseprojects.io:443/mqtt",
  mosquitto: "wss://test.mosquitto.org:8081/mqtt",
  emqx:      "wss://broker.emqx.io:8084/mqtt",
};
export const DEFAULT_ORDER = ["eclipse", "mosquitto", "emqx"];

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const SALT = enc.encode("truma-x/remote/v1");

export class ProtocolMismatch extends Error {
  constructor(v) { super("protocol v" + v); this.version = v; }
}

async function hkdf(ikm, info, len) {
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: SALT, info: enc.encode(info) },
                                       base, len * 8);
  return new Uint8Array(bits);
}
const aesKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function b64u(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// keys: { view, base, canCmd, kState(CryptoKey), kCmd(CryptoKey|null), raw:{...} }
export async function deriveKeys({ master = null, view = null }) {
  let kCmdRaw = null;
  if (master) {
    if (master.length !== 32) throw new Error("master key must be 32 bytes");
    view = await hkdf(master, "view", 32);
    kCmdRaw = await hkdf(master, "cmd", 32);
  } else if (!view || view.length !== 32) throw new Error("need a 32-byte master or view key");
  const kStateRaw = await hkdf(view, "state", 32);
  const chan = await hkdf(view, "chan", 16);
  return {
    view, canCmd: !!kCmdRaw, base: "trumax/" + toHex(chan),
    kState: await aesKey(kStateRaw), kCmd: kCmdRaw ? await aesKey(kCmdRaw) : null,
    raw: { kState: kStateRaw, kCmd: kCmdRaw, chan },
  };
}
export const topic = (keys, kind) => `${keys.base}/${kind}`;   // s | q | r

function keyFor(keys, type) {
  const k = type === T_STATE ? keys.kState : keys.kCmd;
  if (!k) throw new Error("view-only link cannot use the command channel");
  return k;
}

function header(type, sender, counter) {
  const h = new Uint8Array(HDR_LEN), dv = new DataView(h.buffer);
  h[0] = VERSION; h[1] = type;
  dv.setUint32(2, sender >>> 0);
  dv.setBigUint64(6, BigInt(counter));
  return h;
}

export async function seal(keys, type, sender, counter, plaintext) {
  const pt = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const h = header(type, sender, counter);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: h.slice(2), additionalData: h, tagLength: 128 }, keyFor(keys, type), pt));
  const out = new Uint8Array(HDR_LEN + ct.length);
  out.set(h); out.set(ct, HDR_LEN);
  return out;
}

// -> { type, sender, counter, plaintext(Uint8Array) }; throws ProtocolMismatch / Error
export async function open(keys, blob) {
  blob = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (blob.length < HDR_LEN + TAG_LEN) throw new Error("short");
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const version = blob[0], type = blob[1];
  if (version !== VERSION) throw new ProtocolMismatch(version);
  if (type < T_REQ || type > T_STATE) throw new Error("type");
  const sender = dv.getUint32(2), counter = dv.getBigUint64(6);
  let pt;
  try {
    pt = await subtle.decrypt({ name: "AES-GCM", iv: blob.slice(2, HDR_LEN), additionalData: blob.slice(0, HDR_LEN),
                                tagLength: 128 }, keyFor(keys, type), blob.slice(HDR_LEN));
  } catch (e) {
    if (String(e.message).startsWith("view-only")) throw e;
    throw new Error("auth");
  }
  return { type, sender, counter, plaintext: new Uint8Array(pt) };
}

// Highest counter per sender, last 16 senders (LRU).
export class Replay {
  constructor(size = 16) { this.size = size; this.seen = new Map(); }
  accept(sender, counter) {
    counter = BigInt(counter);
    const last = this.seen.get(sender);
    if (last !== undefined && counter <= last) return false;
    this.seen.delete(sender);
    if (this.seen.size >= this.size) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(sender, counter);      // Map keeps insertion order = LRU order
    return true;
  }
}
export const tsOk = (ts, now = Date.now() / 1000) => typeof ts === "number" && Math.abs(now - ts) <= TS_WINDOW;

// One session's sender id + counter (new random sender per page load).
export class Sender {
  constructor() { this.id = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]; this.ctr = 0n; }
  next() { this.ctr += 1n; return [this.id, this.ctr]; }
}

// Link fragment "#k=..&b=..&u=.." or "#v=..". -> { keys, brokers:[url], canCmd }
export async function parseLink(hashOrUrl) {
  const frag = hashOrUrl.includes("#") ? hashOrUrl.split("#")[1] : hashOrUrl;
  const q = new URLSearchParams(frag);
  const keys = q.get("k") ? await deriveKeys({ master: unb64u(q.get("k")) })
                          : await deriveKeys({ view: unb64u(q.get("v") || "") });
  const ids = (q.get("b") || DEFAULT_ORDER.join(",")).split(",");
  const brokers = ids.map((i) => (i === "custom" ? q.get("u") : BROKERS[i.trim()])).filter(Boolean);
  return { keys, brokers: brokers.length ? brokers : DEFAULT_ORDER.map((i) => BROKERS[i]) };
}

export const encodeJson = (o) => enc.encode(JSON.stringify(o));
export const decodeJson = (b) => JSON.parse(dec.decode(b));

// ---------------------------------------------------------------- phone role
// Remote allowlist (docs/remote-protocol.md section 5); anything else is answered 403
// locally without a round trip.
export const REMOTE_ALLOWED = new Set(["GET /api/state", "GET /api/settings", "GET /api/timers",
  "GET /api/history", "GET /api/update", "GET /api/log", "POST /api/set", "POST /api/timers",
  "GET /api/push", "POST /api/push/subscribe", "POST /api/push/unsubscribe", "POST /api/push/test"]);
export const STALE_S = 150;

// events: onState(msg), onStatus({connected,url,error}), onMismatch(theirVersion)
export class RemoteClient {
  constructor(keys, brokers, { onState, onStatus, onMismatch, MqttLink = DefaultMqttLink, WebSocketImpl } = {}) {
    this.keys = keys; this.sender = new Sender(); this.replay = new Replay();
    this.pending = new Map(); this.nextId = 1; this.state = null; this.stateTs = 0;
    this.onState = onState || (() => {}); this.onMismatch = onMismatch || (() => {});
    const topics = [topic(keys, "s")].concat(keys.canCmd ? [topic(keys, "r")] : []);
    this.link = new MqttLink(brokers, topics, { onMessage: (t, b) => this._onMessage(t, b), onStatus, WebSocketImpl });
  }
  start() { this.link.start(); return this; }
  stop() { this.link.stop(); }
  isStale(now = Date.now() / 1000) { return !this.stateTs || now - this.stateTs > STALE_S; }

  async _onMessage(t, blob) {
    let m;
    try { m = await open(this.keys, blob); }
    catch (e) { if (e instanceof ProtocolMismatch) this.onMismatch(e.version); return; }
    if (!this.replay.accept(m.sender, m.counter)) return;
    const msg = decodeJson(m.plaintext);
    if (m.type === T_STATE) {
      if ((msg.ts || 0) < this.stateTs) return;
      this.stateTs = msg.ts; this.state = msg.b; this.onState(msg);
      for (const w of [...this.pending.values()]) if (w.wantState) w.done({ st: 200, b: msg.b });
    } else if (m.type === T_RESP) {
      if (!tsOk(msg.ts)) return;
      const w = this.pending.get(msg.id);
      if (w) w.done(msg);
    }
  }

  // -> {st, b}; throws on timeout / no broker / view-only
  async request(method, path, body = null, timeoutMs = 8000) {
    if (!this.keys.canCmd) throw new Error("view-only");
    await this.link.whenConnected(timeoutMs);
    const id = this.nextId++;
    const [sid, ctr] = this.sender.next();
    const blob = await seal(this.keys, T_REQ, sid, ctr,
      encodeJson({ ts: Math.floor(Date.now() / 1000), id, m: method, p: path, b: body }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error("timeout")); }, timeoutMs);
      this.pending.set(id, { done: (msg) => { clearTimeout(t); this.pending.delete(id); res({ st: msg.st, b: msg.b }); } });
      if (!this.link.publish(topic(this.keys, "q"), blob)) { clearTimeout(t); this.pending.delete(id); rej(new Error("no broker")); }
    });
  }

  // Waits for a pushed state (retained or live) up to timeoutMs.
  waitState(timeoutMs = 8000) {
    if (this.state) return Promise.resolve({ st: 200, b: this.state });
    return new Promise((res, rej) => {
      const key = Symbol();
      const t = setTimeout(() => { this.pending.delete(key); rej(new Error("no state")); }, timeoutMs);
      this.pending.set(key, { wantState: true, done: (m) => { clearTimeout(t); this.pending.delete(key); res(m); } });
    });
  }

  // fetch()-compatible front for the web app: same URLs, same JSON.
  async fetch(url, opt = {}) {
    const u = new URL(url, "http://x");
    const method = (opt.method || "GET").toUpperCase();
    const path = u.pathname, full = u.pathname + u.search;
    const json = (st, b) => new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } });
    if (!REMOTE_ALLOWED.has(method + " " + path)) return json(403, { error: "not available remotely" });
    if (method === "GET" && path === "/api/state") {
      try { const r = await this.waitState(); return json(200, r.b); }
      catch (e) { throw new TypeError("offline"); }
    }
    if (method !== "GET" && !this.keys.canCmd) return json(403, { error: "view-only link" });
    if (method === "GET" && !this.keys.canCmd) {
      if (path === "/api/timers" && this.state) return json(200, this.state.timers || []);
      return json(403, { error: "view-only link" });
    }
    let body = null;
    if (opt.body) { try { body = JSON.parse(opt.body); } catch (e) { body = null; } }
    try { const r = await this.request(method, full, body); return json(r.st, r.b); }
    catch (e) { throw new TypeError("remote " + e.message); }
  }
}
