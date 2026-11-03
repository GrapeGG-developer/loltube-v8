'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createBackupStore } = require('./backup-store');
const { commitVerified, requireVerifiedBackup } = require('../loltube-safety/verified-backup');
function fixture() {
  let remote = Buffer.from('{"users":[],"videos":[]}'), status = 200, bad = false, lost = false;
  const cloud = { utils: { private_download_url(id, format, options) {
    assert.equal(id, 'loltube/db.json'); assert.equal(options.type, 'authenticated'); assert.equal(options.resource_type, 'raw');
    return 'https://synthetic.invalid/private';
  } }, uploader: { async upload(data, opts) {
    assert.equal(opts.public_id, 'loltube/db.json'); assert.equal(opts.type, 'authenticated'); assert.equal(opts.resource_type, 'raw'); assert.equal(opts.overwrite, true);
    remote = Buffer.from(data.split(',')[1], 'base64'); if (bad) remote = Buffer.from('{"users":[]}');
    if (lost) throw Error('synthetic response lost'); return { public_id: opts.public_id, type: opts.type, resource_type: opts.resource_type };
  } } };
  const fetchImpl = async () => new Response(status === 200 ? remote : null, { status, headers: { 'Content-Length': String(status === 200 ? remote.length : 0) } });
  return { store: createBackupStore({ cloudinary: cloud, fetchImpl }), status: n => { status = n; }, corrupt: () => { bad = true; }, lost: () => { lost = true; } };
}
test('only the fixed authenticated raw object is read and exactly verified after overwrite', async () => {
  const f = fixture(), initial = await requireVerifiedBackup(f.store); assert.equal(JSON.parse(initial).users.length, 0);
  const next = Buffer.from('{"users":[{"id":"synthetic"}],"videos":[]}'); await commitVerified(f.store, next);
  assert.deepEqual(await f.store.read(), next);
});
test('read outage and mismatching write fail closed', async () => {
  const f = fixture(); f.status(404); await assert.rejects(requireVerifiedBackup(f.store), /backup_unavailable/);
  f.status(200); f.corrupt(); await assert.rejects(commitVerified(f.store, Buffer.from('{"users":[{}],"videos":[]}')), /backup_verification_failed/);
});
test('ambiguous upload response is accepted only when exact valid bytes can be read back', async () => {
  const f = fixture(), body = Buffer.from('{"users":[{}],"videos":[]}'); f.lost();
  const result = await commitVerified(f.store, body); assert.equal(result.wasAmbiguous, true); assert.deepEqual(await f.store.read(), body);
});
