'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { createCloudRouter } = require('./cloud-router');
const P = require('../gplus-cloud/app/protocol');
class Memory {
  constructor() { this.map = new Map(); }
  async get(k) { const b = this.map.get(k); return b === undefined ? null : Buffer.from(b); }
  async putOnce(k, b) { if (this.map.has(k)) return false; this.map.set(k, Buffer.from(b)); return true; }
  async replace(k, b) { this.map.set(k, Buffer.from(b)); }
  async setHead(b) { this.map.set('head.json', Buffer.from(b)); }
  async removeMany(keys) { for (const k of keys) this.map.delete(k); }
  async listMarkers() { return { ids: [], cursor: null }; }
}
function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { id: P.id(der), key: der.toString('base64url'), priv: privateKey };
}
async function start(stores, root, name) {
  const router = await createCloudRouter({ relayStore: stores.relay, offersStore: stores.offers, gplusStore: stores.gplus,
    dataDir: path.join(root, name), webDir: path.resolve(__dirname, '../glink-relay'), reserveBytes: 0, cleanupIntervalMs: 0 });
  const server = http.createServer((req, res) => router.handler(req, res, () => {
    if (req.url === '/api/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"name":"synthetic-loltube"}'); }
    res.writeHead(404); res.end('legacy-not-found');
  }));
  server.on('upgrade', async (req, socket, head) => { if (!await router.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { router, server, base, async close() { await new Promise(r => server.close(r)); await router.close(); } };
}
async function call(s, method, url, body, token, extra = {}) {
  const binary = Buffer.isBuffer(body), r = await fetch(s.base + '/gsrv-v1' + url, { method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
  const bytes = Buffer.from(await r.arrayBuffer());
  return { status: r.status, bytes, headers: r.headers, json: () => JSON.parse(bytes.toString()) };
}
async function login(s, who, nickname) {
  const c = await call(s, 'POST', '/gplus/auth/challenge', { public_key: who.key }); assert.equal(c.status, 200);
  const nonce = c.json().nonce;
  const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('G+ AUTH v1\0'), Buffer.from(nonce, 'base64url')]), who.priv).toString('base64url');
  const r = await call(s, 'POST', '/gplus/auth/verify', { public_key: who.key, nonce, signature, nickname });
  assert.ok([200, 201].includes(r.status)); who.token = r.json().token;
}
function encryptedEvent(sender, chat, recipients) {
  const id = crypto.randomBytes(16).toString('base64url');
  return { id, boxes: recipients.map(to => {
    const ciphertext = crypto.randomBytes(60).toString('base64url');
    const digest = P.messageDigest(chat, id, sender.id, to, Buffer.from(ciphertext, 'base64url'));
    return { to, ciphertext, signature: crypto.sign('sha256', Buffer.concat([P.SIGN_DOMAIN, digest]), sender.priv).toString('base64url') };
  }) };
}
function waitMessage(ws) {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('message timeout')), 3000);
    ws.once('message', (data, binary) => { clearTimeout(timer); resolve({ data, binary }); }); ws.once('error', reject); });
}
function openWs(url, token) {
  return new Promise((resolve, reject) => { const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token } });
    ws.once('open', () => resolve(ws)); ws.once('error', reject); });
}
test('combined routes preserve legacy LOLTUBE and recover GLINK + G+ synthetic data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'combined-cloud-router-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stores = { relay: new Memory(), offers: new Memory(), gplus: new Memory() };
  const a = identity(), b = identity(); let s = await start(stores, root, 'one');
  assert.deepEqual(await (await fetch(s.base + '/api/config')).json(), { name: 'synthetic-loltube' });
  assert.deepEqual((await call(s, 'GET', '/gserver/status')).json(), { mode: 'GLINK-S', state: 'online' });
  const web = await call(s, 'GET', '/glink/send'); assert.equal(web.status, 200); assert.match(web.bytes.toString(), /GLINK/);
  assert.equal((await call(s, 'GET', '/glink/send-v2.js')).status, 200);
  const preflight = await call(s, 'OPTIONS', '/gplus/me', undefined, null, { Origin: 'https://example.invalid' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  await login(s, a, 'alice_synthetic'); await login(s, b, 'bobby_synthetic');
  const direct = await call(s, 'POST', '/gplus/chats/direct', { peer: b.id }, a.token); assert.equal(direct.status, 200);
  const chat = direct.json().id, event = encryptedEvent(a, chat, [a.id, b.id]);
  assert.equal((await call(s, 'POST', `/gplus/chats/${chat}/events`, event, a.token)).status, 200);
  const asset = crypto.randomBytes(16).toString('base64url'), bytes = crypto.randomBytes(129 * 1024 + 7);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal((await call(s, 'PUT', `/gplus/assets/${asset}`, bytes, a.token, { 'X-GPlus-Chat': chat, 'X-GPlus-Sha256': sha })).status, 201);
  assert.equal((await call(s, 'POST', `/gplus/assets/${asset}/bind`, { event: event.id }, a.token)).status, 200);
  const session = crypto.randomBytes(12).toString('base64url'), p1 = crypto.randomBytes(10001), p2 = crypto.randomBytes(15003);
  assert.equal((await call(s, 'POST', `/glink/chunk/${session}?i=0&n=2`, p1)).status, 200);
  assert.equal((await call(s, 'POST', `/glink/chunk/${session}?i=1&n=2`, p2)).status, 200);
  const whole = Buffer.concat([p1, p2]); let range = await call(s, 'GET', `/glink/dl/${session}`, undefined, null, { Range: 'bytes=9999-10003' });
  assert.equal(range.status, 206); assert.deepEqual(range.bytes, whole.subarray(9999, 10004));
  // The WebSocket route is on the shared HTTP server, not the isolated G+ server.
  const callId = crypto.randomBytes(16).toString('base64url');
  const url = s.base.replace('http:', 'ws:') + `/gsrv-v1/gplus/call-relay?chat=${encodeURIComponent(chat)}&call=${callId}`;
  const wa = await openWs(url, a.token), joined = waitMessage(wa), wb = await openWs(url, b.token);
  const msg = await joined; assert.equal(msg.binary, false); assert.equal(JSON.parse(msg.data).type, 'peer_joined');
  const got = waitMessage(wb), frame = crypto.randomBytes(123); wa.send(frame, { binary: true });
  const received = await got; assert.equal(received.binary, true); assert.deepEqual(received.data, frame);
  wa.terminate(); wb.terminate(); await s.close();
  s = await start(stores, root, 'two'); await login(s, b, 'bobby_synthetic');
  const chatEvents = await call(s, 'GET', `/gplus/chats/${chat}/events`, undefined, b.token);
  assert.equal(chatEvents.json().events[0].id, event.id);
  assert.deepEqual((await call(s, 'GET', `/gplus/assets/${asset}`, undefined, b.token)).bytes, bytes);
  range = await call(s, 'GET', `/glink/dl/${session}`, undefined, null, { Range: 'bytes=9999-10003' });
  assert.equal(range.status, 206); assert.deepEqual(range.bytes, whole.subarray(9999, 10004));
  await s.close();
});
