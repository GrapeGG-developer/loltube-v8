'use strict';
/* Fixed-name LOLTUBE backup adapter. Production use also requires an exclusive
 * writer / no-overlap cutover; readback alone is not compare-and-swap. */
const MAX = 10 * 1024 * 1024, ID = 'loltube/db.json';
function createBackupStore({ cloudinary, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (!cloudinary || !cloudinary.uploader || !cloudinary.utils || typeof fetchImpl !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw Error('invalid_backup_store');
  async function read() {
    const signed = cloudinary.utils.private_download_url(ID, '', { resource_type: 'raw', type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 120 });
    let response;
    try { response = await fetchImpl(signed, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', cache: 'no-store' }); }
    catch (_) { throw Error('backup_unavailable'); }
    if (response.status !== 200) throw Error('backup_unavailable');
    const size = Number(response.headers.get('content-length'));
    if (Number.isFinite(size) && size > MAX) throw Error('backup_too_large');
    const reader = response.body?.getReader(); if (!reader) throw Error('backup_unavailable');
    const pieces = []; let total = 0;
    try {
      for (;;) { const x = await reader.read(); if (x.done) break;
        total += x.value.length; if (total > MAX) throw Error('backup_too_large'); pieces.push(Buffer.from(x.value)); }
    } catch (e) { try { await reader.cancel(); } catch (_) {} throw e; }
    return Buffer.concat(pieces, total);
  }
  async function replace(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > MAX) throw Error('invalid_backup');
    let result;
    try {
      result = await cloudinary.uploader.upload('data:application/json;base64,' + raw.toString('base64'), {
        resource_type: 'raw', type: 'authenticated', public_id: ID, overwrite: true, unique_filename: false,
        invalidate: false, timeout: timeoutMs
      });
    } catch (_) { throw Error('backup_write_failed'); }
    if (!result || result.public_id !== ID || result.resource_type !== 'raw' || result.type !== 'authenticated')
      throw Error('backup_write_failed');
  }
  return { read, replace };
}
module.exports = { createBackupStore, MAX };
