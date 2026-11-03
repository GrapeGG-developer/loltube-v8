'use strict';
// Wi-Fi discovery and offers v2. No dependencies; kept separate for reuse by GSERVER.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// This factory isolates device state and reports every persisted offer mutation.
function createDeviceV2({offerFile,onMutation}) {
  if(!path.isAbsolute(offerFile)||typeof onMutation!=='function')throw Error('invalid_offer_configuration');
const DEVICES = new Map();
const CHALLENGES = new Map();
const SESSIONS = new Map();
const OFFERS = new Map();
const AUTH_DOMAIN = Buffer.from('GLINK-WIFI-AUTH-2\0', 'utf8');
const DEVICE_TTL = 90_000, CHALLENGE_TTL = 120_000, SESSION_TTL = 60 * 60_000, OFFER_TTL = 15 * 60_000;
const OFFER_FILE = offerFile;
let frozen = false, loaded = false;

// Persist only already-encrypted offers; bearer tokens, discovery and challenges
// remain in memory. A frozen GSERVER snapshots this file with the relay payloads.
function persistOffers(map) {
  fs.mkdirSync(path.dirname(OFFER_FILE), { recursive: true, mode: 0o700 });
  const tmp = OFFER_FILE + '.tmp-' + crypto.randomBytes(8).toString('hex');
  const encoded = JSON.stringify({ v: 2, offers: Object.fromEntries(map) });
  if (Buffer.byteLength(encoded, 'utf8') > 4 * 1024 * 1024) throw Error('offer queue full');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, encoded);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, OFFER_FILE);
    try { const dir = fs.openSync(path.dirname(OFFER_FILE), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch (_) {}
    onMutation();
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}
function commitOffers(map) {
  persistOffers(map);
  OFFERS.clear();
  for (const [id, offers] of map) OFFERS.set(id, offers);
}
function loadOffers() {
  const restored = new Map();
  if (fs.existsSync(OFFER_FILE)) {
    if (fs.statSync(OFFER_FILE).size > 4 * 1024 * 1024) throw Error('Wi-Fi offer store too large');
    const data = JSON.parse(fs.readFileSync(OFFER_FILE, 'utf8'));
    if (!data || data.v !== 2 || !data.offers || typeof data.offers !== 'object' || Array.isArray(data.offers)) throw Error('Invalid Wi-Fi offer store');
    const entries = Object.entries(data.offers);
    if (entries.length > 10000) throw Error('Wi-Fi offer store too large');
    for (const [id, list] of entries) {
      if (!/^[A-Za-z0-9_-]{19}$/.test(id) || !Array.isArray(list) || list.length > 5) throw Error('Invalid Wi-Fi offer store');
      const keep = [];
      for (const x of list) {
        if (!x || typeof x.s !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(x.s) || !validEnvelope(x.k)
            || typeof x.from !== 'string' || x.from.length > 60 || !Number.isSafeInteger(x.ts)) throw Error('Invalid Wi-Fi offer store');
        if (Date.now() - x.ts < OFFER_TTL) keep.push(x);
      }
      if (keep.length) restored.set(id, keep);
    }
  }
  OFFERS.clear(); for (const [id, offers] of restored) OFFERS.set(id, offers);
  DEVICES.clear(); CHALLENGES.clear(); SESSIONS.clear(); loaded = true;
}
function setFrozen(value) {
  if (value) { frozen = true; return; }
  if (frozen || !loaded) loadOffers();
  frozen = false;
}
function ensureLoaded() { if (!loaded) loadOffers(); }

function reply(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}
function body(req, cb) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return cb(req.body);
  let s = '';
  req.on('data', c => { s += c; if (s.length > 16384) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(s || '{}')); } catch (_) { cb({}); } });
}
function b64(v, max = 256) {
  if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) throw Error('bad base64');
  const out = Buffer.from(v, 'base64url');
  if (out.toString('base64url') !== v) throw Error('bad base64');
  return out;
}
function publicKey(encoded) {
  const der = b64(encoded, 220);
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw Error('bad curve');
  return { der, key };
}
function idFromKey(der) {
  const h = crypto.createHash('sha256').update(der).digest().subarray(0, 12).toString('base64url');
  return `${h.slice(0,4)}-${h.slice(4,8)}-${h.slice(8,12)}-${h.slice(12,16)}`;
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function currentAuth(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const hash = tokenHash(m[1]);
  const a = SESSIONS.get(hash);
  if (!a || a.exp <= Date.now()) { SESSIONS.delete(hash); return null; }
  return a;
}
function clean() {
  const now = Date.now();
  for (const [n, c] of CHALLENGES) if (c.exp <= now) CHALLENGES.delete(n);
  for (const [n, s] of SESSIONS) if (s.exp <= now) SESSIONS.delete(n);
  for (const [n, d] of DEVICES) if (now - d.ts > DEVICE_TTL) DEVICES.delete(n);
  const next = new Map(); let changed = false;
  for (const [n, list] of OFFERS) {
    const keep = list.filter(x => now - x.ts < OFFER_TTL);
    if (keep.length !== list.length) changed = true;
    if (keep.length) next.set(n, keep);
  }
  if (changed) commitOffers(next);
}
// Expired offers are removed only inside gated requests, never by a background writer.
function validEnvelope(k) {
  try {
    if (typeof k !== 'string' || !k.startsWith('g2.')) return false;
    const x = b64(k.slice(3), 300);
    if (x.length < 3 || x[0] !== 2) return false;
    const len = x.readUInt16BE(1);
    if (len < 80 || len > 150 || x.length !== 3 + len + 12 + 48) return false;
    publicKey(x.subarray(3, 3 + len).toString('base64url'));
    return true;
  } catch (_) { return false; }
}

function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (!u.pathname.startsWith('/glink/')) return false;
  const p = u.pathname;
  const deviceRoute = p === '/glink/device/challenge' || p === '/glink/device/auth' || p === '/glink/presence'
      || p === '/glink/devices' || p === '/glink/offer' || p.startsWith('/glink/offers/') || p === '/glink/offer-ack';
  if (!deviceRoute) return false;
  if (frozen) { reply(res, 503, { error: 'maintenance' }); return true; }
  try { ensureLoaded(); } catch (_) { reply(res, 503, { error: 'offer storage unavailable' }); return true; }
  if (p === '/glink/device/challenge' && req.method === 'POST') {
    body(req, o => {
      try {
        clean();
        if (CHALLENGES.size >= 10000) return reply(res, 503, { error: 'busy' });
        const pub = publicKey(o.publicKey);
        const id = idFromKey(pub.der);
        const nonce = crypto.randomBytes(32).toString('base64url');
        CHALLENGES.set(nonce, { id, pub: o.publicKey, exp: Date.now() + CHALLENGE_TTL });
        reply(res, 200, { v: 2, id, nonce });
      } catch (_) { reply(res, 400, { error: 'invalid identity' }); }
    });
    return true;
  }
  if (p === '/glink/device/auth' && req.method === 'POST') {
    body(req, o => {
      const c = CHALLENGES.get(o.nonce);
      CHALLENGES.delete(o.nonce); // a challenge is single-use, even after an invalid signature
      try {
        if (!c || c.exp <= Date.now()) throw Error('expired challenge');
        const sign = publicKey(c.pub), transport = publicKey(o.transportKey);
        const nonce = b64(o.nonce, 64);
        const signature = b64(o.signature, 150);
        const data = Buffer.concat([AUTH_DOMAIN, nonce, transport.der]);
        const encoding = signature.length === 64 ? 'ieee-p1363' : 'der';
        if (!crypto.verify('sha256', data, { key: sign.key, dsaEncoding: encoding }, signature)) throw Error('bad signature');
        const name = String(o.name || 'Устройство').slice(0, 60);
        const token = crypto.randomBytes(32).toString('base64url');
        const exp = Date.now() + SESSION_TTL;
        SESSIONS.set(tokenHash(token), { id: c.id, exp, enc: o.transportKey });
        DEVICES.set(c.id, { name, enc: o.transportKey, ts: Date.now() });
        reply(res, 200, { v: 2, id: c.id, token, expiresIn: SESSION_TTL });
      } catch (_) { reply(res, 401, { error: 'invalid device proof' }); }
    });
    return true;
  }
  if (p === '/glink/presence' && req.method === 'POST') {
    const a = currentAuth(req);
    if (!a) { reply(res, 401, { error: 'v2 device authentication required' }); return true; }
    body(req, o => {
      DEVICES.set(a.id, { name: String(o.name || 'Устройство').slice(0, 60), enc: a.enc, ts: Date.now() });
      reply(res, 200, { ok: true, v: 2 });
    });
    return true;
  }
  if (p === '/glink/devices' && req.method === 'GET') {
    try { clean(); } catch (_) { reply(res, 503, { error: 'offer storage unavailable' }); return true; }
    const me = u.searchParams.get('me') || '';
    const devices = [...DEVICES].filter(([id]) => id !== me)
      .map(([id, d]) => ({ id, name: d.name, enc: d.enc }));
    const caps = process.env.GSERVER_CONTROLLED === '1' ? process.env.GSERVER_RUNTIME_CAPABILITIES : '';
    reply(res, 200, { v: 2, devices, ...(caps ? { gserverCapabilities: caps.split(',') } : {}) });
    return true;
  }
  if (p === '/glink/offer' && req.method === 'POST') {
    body(req, o => {
      if (typeof o.to !== 'string' || !/^[A-Za-z0-9_-]{19}$/.test(o.to)
          || typeof o.s !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(o.s)) {
        return reply(res, 400, { error: 'invalid recipient or session' });
      }
      // Never accept a legacy plaintext session key, even for old clients.
      if (!validEnvelope(o.k)) return reply(res, 426, { error: 'encrypted v2 offer required' });
      try {
        clean();
        if (!DEVICES.has(o.to)) return reply(res, 404, { error: 'recipient offline' });
        if (!OFFERS.has(o.to) && OFFERS.size >= 10000) return reply(res, 503, { error: 'offer queue full' });
        const current = OFFERS.get(o.to) || [], previous = current.find(x => x.s === o.s);
        if (previous) return previous.k === o.k ? reply(res, 200, { ok: true, v: 2, duplicate: true }) : reply(res, 409, { error: 'session conflict' });
        if (current.length >= 5) return reply(res, 429, { error: 'recipient queue full' });
        const arr = [...current, { s: o.s, k: o.k, from: String(o.from || 'Устройство').slice(0, 60), ts: Date.now() }];
        const next = new Map(OFFERS); next.set(o.to, arr); commitOffers(next);
        reply(res, 200, { ok: true, v: 2 });
      } catch (_) { reply(res, 503, { error: 'offer storage unavailable' }); }
    });
    return true;
  }
  if (p.startsWith('/glink/offers/') && req.method === 'GET') {
    const id = p.slice('/glink/offers/'.length);
    const a = currentAuth(req);
    if (!a || a.id !== id) { reply(res, 401, { error: 'device authentication required' }); return true; }
    try { clean(); } catch (_) { reply(res, 503, { error: 'offer storage unavailable' }); return true; }
    reply(res, 200, { v: 2, offers: OFFERS.get(id) || [] });
    return true;
  }
  if (p === '/glink/offer-ack' && req.method === 'POST') {
    const a = currentAuth(req);
    if (!a) { reply(res, 401, { error: 'device authentication required' }); return true; }
    body(req, o => {
      if (o.to !== a.id || typeof o.s !== 'string') return reply(res, 403, { error: 'wrong recipient' });
      try {
        const next = new Map(OFFERS), keep = (OFFERS.get(a.id) || []).filter(x => x.s !== o.s);
        if (keep.length) next.set(a.id, keep); else next.delete(a.id);
        commitOffers(next); reply(res, 200, { ok: true });
      } catch (_) { reply(res, 503, { error: 'offer storage unavailable' }); }
    });
    return true;
  }
  return false;
}
return { handle, idFromKey, validEnvelope, setFrozen };
}
module.exports={createDeviceV2};
