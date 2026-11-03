'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createCloudGPlus } = require('./bootstrap'), P = require('./app/protocol');
class Store {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? Buffer.from(this.m.get(k)) : null; }
  async putOnce(k, b) { if (this.m.has(k)) return false; this.m.set(k, Buffer.from(b)); return true; }
  async setHead(b) { this.m.set('head.json', Buffer.from(b)); }
}
function identity() { const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' }); return { id: P.id(der), key: der.toString('base64url'), priv: privateKey }; }
async function start(store, dir, now) { const s = await createCloudGPlus({ store, dataDir: dir, reserveBytes: 0, maxStorageBytes: 10485760, now, cleanupIntervalMs: 0 });
  await new Promise(r => s.server.listen(0, '127.0.0.1', r)); s.base = 'http://127.0.0.1:' + s.server.address().port + '/gsrv-v1'; return s; }
async function call(s, method, url, body, token) { const r = await fetch(s.base + url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: await r.json() }; }
async function login(s, who, nickname) { const c = await call(s, 'POST', '/gplus/auth/challenge', { public_key: who.key }); assert.equal(c.status, 200);
  const nonce = c.json.nonce, signature = crypto.sign('sha256', Buffer.concat([Buffer.from('G+ AUTH v1\0'), Buffer.from(nonce, 'base64url')]), who.priv).toString('base64url');
  const r = await call(s, 'POST', '/gplus/auth/verify', { public_key: who.key, nonce, signature, nickname }); assert.ok([200, 201].includes(r.status)); who.token = r.json.token; }
function makeEvent(who, chat, ids, ttl_seconds) { const id = crypto.randomBytes(16).toString('base64url'); return { id, ttl_seconds, boxes: ids.map(to => {
  const ciphertext = crypto.randomBytes(64).toString('base64url'), digest = P.messageDigest(chat, id, who.id, to, Buffer.from(ciphertext, 'base64url'));
  return { to, ciphertext, signature: crypto.sign('sha256', Buffer.concat([P.SIGN_DOMAIN, digest]), who.priv).toString('base64url') };
}) }; }
function rows(dir) { const db = new Database(path.join(dir, 'gplus-messages.sqlite3'), { readonly: true }); try { return db.prepare('SELECT event_id FROM events ORDER BY seq').all().map(x => x.event_id); } finally { db.close(); } }
test('expired messages are serialized and checkpointed while media timer is frozen', async t => {
  let clock = 1800000000000; const now = () => clock, root = await fs.mkdtemp(path.join(os.tmpdir(), 'gplus-expiry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); const store = new Store(), a = identity(), b = identity();
  const first = path.join(root, 'one'); let s = await start(store, first, now); await login(s, a, 'alice_expiry'); await login(s, b, 'bobby_expiry');
  const direct = await call(s, 'POST', '/gplus/chats/direct', { peer: b.id }, a.token); assert.equal(direct.status, 200); const chat = direct.json.id;
  const ephemeral = makeEvent(a, chat, [a.id, b.id], 5), ordinary = makeEvent(a, chat, [a.id, b.id], 0);
  assert.equal((await call(s, 'POST', `/gplus/chats/${chat}/events`, ephemeral, a.token)).status, 200);
  assert.equal((await call(s, 'POST', `/gplus/chats/${chat}/events`, ordinary, a.token)).status, 200);
  clock += 6000; assert.deepEqual(rows(first), [ephemeral.id, ordinary.id]);
  assert.deepEqual(await s.cleanupOnce(), { removed: false }); assert.deepEqual(rows(first), [ordinary.id]); await s.close();
  const second = path.join(root, 'two'); s = await start(store, second, now); assert.deepEqual(rows(second), [ordinary.id]); await login(s, b, 'bobby_expiry');
  const live = await call(s, 'GET', `/gplus/chats/${chat}/events`, undefined, b.token); assert.deepEqual(live.json.events.map(x => x.id), [ordinary.id]); await s.close();
});
