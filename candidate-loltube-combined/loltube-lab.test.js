'use strict';
/* Full-server regression with synthetic accounts and a local fake Cloudinary.
 * Requires the exact public upstream in LOLTUBE_UPSTREAM_DIR and Node 24. */
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), fsSync = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const rootProject = path.resolve(__dirname, '..'), upstream = process.env.LOLTUBE_UPSTREAM_DIR || '/var/tmp/loltube-combined-base';
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function waitForFile(dir, name) { if (fsSync.existsSync(path.join(dir, name))) return;
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { watcher.close(); reject(Error('synthetic media staging timeout')); }, 4000);
    const check = () => { if (fsSync.existsSync(path.join(dir, name))) { clearTimeout(timer); watcher.close(); resolve(); } };
    const watcher = fsSync.watch(dir, check); check(); }); }
function blobFile(cloud, id) { return path.join(cloud, Buffer.from(id).toString('base64url') + '.blob'); }
async function ledgerDb(cloud) {
  const prefix = 'loltube-ledger-v1/', head = JSON.parse(await fs.readFile(blobFile(cloud, prefix + 'head.json'), 'utf8'));
  const revision = JSON.parse(await fs.readFile(blobFile(cloud, prefix + 'revisions/' + String(head.seq).padStart(16, '0') + '.json'), 'utf8'));
  const chunks = await Promise.all(revision.files['accounts-v1.json'].blocks.map(b => fs.readFile(blobFile(cloud, prefix + 'blocks/' + b.sha256 + '.json'))));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function ready(child) { return new Promise((resolve, reject) => {
  let log = ''; const timer = setTimeout(() => reject(Error('synthetic server startup timeout')), 9000);
  child.stdout.on('data', b => { log += b.toString(); if (log.includes('LOLTUBE verified-backup lab running')) { clearTimeout(timer); resolve(); } });
  child.once('exit', code => { clearTimeout(timer); reject(Error('synthetic server exited before startup: ' + code)); });
}); }
async function start(lab, cloud, port) {
  const env = { ...process.env, PORT: String(port), LAB_CLOUD_DIR: cloud, CLOUDINARY_CLOUD_NAME: 'synthetic', CLOUDINARY_API_KEY: 'synthetic',
    CLOUDINARY_API_SECRET: 'synthetic', JWT_SECRET: 'synthetic-only-test-secret' };
  const c = spawn(process.execPath, ['--require', path.join(__dirname, 'fake-cloudinary-lab.cjs'), 'server.js'], { cwd: lab, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await ready(c); return c;
}
async function kill(c) { if (c.exitCode !== null || c.signalCode) return; const exited = new Promise(r => c.once('exit', r)); c.kill('SIGKILL'); await exited; }
async function request(base, method, url, body, token) {
  const form = body instanceof FormData, bin = Buffer.isBuffer(body); const r = await fetch(base + url, { method,
    headers: { ...(body === undefined || form ? {} : { 'Content-Type': bin ? 'application/octet-stream' : 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: form || bin ? body : JSON.stringify(body) }) });
  const bytes = Buffer.from(await r.arrayBuffer()); return { status: r.status, bytes, json: () => JSON.parse(bytes.toString()) };
}
test('full combined lab: verified backup, fail-closed boot, media outage and synthetic recovery', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'loltube-combined-full-')), lab = path.join(tmp, 'app'), cloud = path.join(tmp, 'cloud');
  await fs.cp(upstream, lab, { recursive: true }); await fs.mkdir(cloud, { recursive: true });
  for (const d of ['glink-cloud', 'gplus-cloud', 'loltube-safety', 'loltube-combined']) await fs.symlink(path.join(rootProject, d), path.join(lab, d), 'dir');
  await fs.symlink(path.join(rootProject, 'glink-relay'), path.join(lab, 'glink-web'), 'dir');
  execFileSync('python3', [path.join(__dirname, 'patch-upstream.py'), path.join(upstream, 'server.js'), path.join(lab, 'server.js')]);
  const seed = { users: [], videos: [], comments: [], playlists: [], notifications: [], history: [], reports: [], friends: [], live: { isLive: false, hlsUrl: '', title: 'SYNTHETIC', viewerCount: 0 } };
  await fs.writeFile(blobFile(cloud, 'loltube/db.json'), JSON.stringify(seed));
  const port = await freePort(), base = 'http://127.0.0.1:' + port; let child;
  t.after(async () => { if (child) await kill(child); await fs.rm(tmp, { recursive: true, force: true }); });
  child = await start(lab, cloud, port);
  assert.equal((await request(base, 'GET', '/api/config')).status, 200);
  assert.equal((await request(base, 'GET', '/gsrv-v1/gserver/status')).json().state, 'online');
  const login = await request(base, 'POST', '/api/login', { nickname: 'synthetic_user', password: '123' }); assert.equal(login.status, 200); const token = login.json().token;
  let saved = await ledgerDb(cloud); assert.equal(saved.users.length, 1);
  assert.equal(JSON.parse(await fs.readFile(blobFile(cloud, 'loltube/db.json'), 'utf8')).users.length, 0); // legacy backup is never overwritten
  assert.equal((await request(base, 'PUT', '/api/me', { bio: 'durable synthetic value' }, token)).status, 200);
  saved = await ledgerDb(cloud); assert.equal(saved.users[0].bio, 'durable synthetic value');
  const session = 'syntheticSession123', ciphertext = Buffer.from('synthetic opaque ciphertext');
  assert.equal((await request(base, 'POST', `/gsrv-v1/glink/chunk/${session}?i=0&n=1`, ciphertext)).status, 200);
  await fs.writeFile(path.join(cloud, 'fail-media'), '1');
  const form = new FormData(); form.set('title', 'synthetic video'); form.set('video', new Blob(['not a real video'], { type: 'video/mp4' }), 'synthetic.mp4');
  const media = await request(base, 'POST', '/api/videos/upload', form, token); assert.equal(media.status, 503);
  assert.equal((await ledgerDb(cloud)).videos.length, 0); await fs.unlink(path.join(cloud, 'fail-media'));
  // A long media upload must not lock unrelated LOLTUBE API calls while the
  // content is still being staged. Its final metadata still needs a commit.
  await fs.writeFile(path.join(cloud, 'delay-media'), '1');
  const slow = new FormData(); slow.set('title', 'slow synthetic video'); slow.set('video', new Blob(['synthetic bytes'], { type: 'video/mp4' }), 'slow.mp4');
  let uploadDone = false; const uploading = request(base, 'POST', '/api/videos/upload', slow, token).then(r => { uploadDone = true; return r; });
  await waitForFile(cloud, 'media-started');
  const concurrentRead = await request(base, 'GET', '/api/me', undefined, token); assert.equal(concurrentRead.status, 200); assert.equal(uploadDone, false);
  const video = await uploading; assert.equal(video.status, 200); assert.equal((await ledgerDb(cloud)).videos.length, 1);
  await fs.unlink(path.join(cloud, 'delay-media'));
  await fs.writeFile(path.join(cloud, 'fail-write'), '1');
  const speculative = await request(base, 'PUT', '/api/me', { bio: 'must not be acknowledged' }, token); assert.equal(speculative.status, 503);
  assert.equal((await request(base, 'GET', '/api/me', undefined, token)).status, 503);
  assert.equal((await request(base, 'GET', '/api/config')).status, 200); // no forced host restart
  assert.equal((await request(base, 'GET', '/gsrv-v1/gserver/status')).json().state, 'online');
  await kill(child); child = null; await fs.unlink(path.join(cloud, 'fail-write'));
  // A late write by an old process may modify the legacy object, but cannot
  // overwrite the separately committed immutable ledger.
  await fs.writeFile(blobFile(cloud, 'loltube/db.json'), JSON.stringify(seed));
  child = await start(lab, cloud, port);
  const same = await request(base, 'POST', '/api/login', { nickname: 'synthetic_user', password: '123' }); assert.equal(same.status, 200);
  assert.equal((await request(base, 'GET', '/api/me', undefined, same.json().token)).json().bio, 'durable synthetic value');
  assert.deepEqual((await request(base, 'GET', `/gsrv-v1/glink/dl/${session}`)).bytes, ciphertext);
  await kill(child); child = null; await fs.writeFile(path.join(cloud, 'fail-read'), '1');
  const env = { ...process.env, PORT: String(port), LAB_CLOUD_DIR: cloud, CLOUDINARY_CLOUD_NAME: 'synthetic', CLOUDINARY_API_KEY: 'synthetic', CLOUDINARY_API_SECRET: 'synthetic', JWT_SECRET: 'synthetic-only-test-secret' };
  const failed = spawn(process.execPath, ['--require', path.join(__dirname, 'fake-cloudinary-lab.cjs'), 'server.js'], { cwd: lab, env, stdio: 'ignore' });
  const code = await Promise.race([new Promise(r => failed.once('exit', r)), new Promise((_, reject) => setTimeout(() => reject(Error('unavailable backup did not fail closed')), 5000))]);
  assert.equal(code, 1); assert.equal((await ledgerDb(cloud)).users[0].bio, 'durable synthetic value');
});
