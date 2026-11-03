'use strict';
/* Experimental combined GLINK/G+ router for a single process. Not production.
 * The caller mounts this before the legacy GSERVER gateway and body parsers.
 * Stores MUST be scoped to three distinct, owner-selected namespaces.
 * Provider fencing, a global cost cap and no-overlap cutover are not solved. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCloudGPlus } = require('../gplus-cloud/bootstrap');
const { createOffers } = require('../glink-cloud/offers');
const { createRelay } = require('../glink-cloud/relay');

function send(res, code, data) {
  if (res.destroyed || res.writableEnded) return;
  const raw = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(raw);
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-GPlus-Chat, X-GPlus-Sha256, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
}
async function createCloudRouter({ relayStore, offersStore, gplusStore, dataDir, webDir,
  onFatal = () => {}, maxStorageBytes = 1024 * 1024 * 1024, reserveBytes = 256 * 1024 * 1024,
  now = Date.now, retentionMs, cleanupIntervalMs = 0 } = {}) {
  if (!relayStore || !offersStore || !gplusStore || !path.isAbsolute(dataDir || '') ||
      !path.isAbsolute(webDir || '') || typeof onFatal !== 'function' || typeof now !== 'function')
    throw Error('invalid_cloud_router');
  const web = new Map();
  for (const [route, file, type] of [
    ['/glink/send', 'glink-send.html', 'text/html; charset=utf-8'],
    ['/glink/crypto-v2.js', 'glink-crypto-v2.js', 'application/javascript; charset=utf-8'],
    ['/glink/send-v2.js', 'glink-send-v2.js', 'application/javascript; charset=utf-8']]) {
    web.set(route, { bytes: await fs.readFile(path.join(webDir, file)), type });
  }
  let failed = false;
  const fail = () => { if (!failed) { failed = true; try { onFatal(); } catch (_) {} } };
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const offers = await createOffers({ store: offersStore, dataDir: path.join(dataDir, 'offers'), onFatal: fail });
  const gplus = await createCloudGPlus({ store: gplusStore, dataDir: path.join(dataDir, 'gplus'), onFatal: fail,
    maxStorageBytes, reserveBytes, now, ...(retentionMs === undefined ? {} : { retentionMs }), cleanupIntervalMs });
  const relay = createRelay({ store: relayStore, now });
  const healthy = () => !failed && offers.healthy() && gplus.gateway.isHealthy();
  function handler(req, res, next) {
    const raw = req.url || '';
    let pathname; try { pathname = new URL(raw, 'http://cloud.local').pathname; } catch (_) { return next(); }
    const prefix = '/gsrv-v1';
    if (pathname === prefix + '/gserver/status' && req.method === 'GET') {
      cors(res); return send(res, 200, { mode: 'GLINK-S', state: healthy() ? 'online' : 'unavailable' });
    }
    if (!(pathname.startsWith(prefix + '/glink/') || pathname === prefix + '/glink' ||
          pathname.startsWith(prefix + '/gplus/') || pathname === prefix + '/gplus')) return next();
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
    if (!healthy()) { req.resume(); return send(res, 503, { error: 'cloud_storage_unavailable' }); }
    // Do not copy proxy-provided user-controlled headers into any internal secret.
    req.url = raw.slice(prefix.length);
    const localPath = pathname.slice(prefix.length);
    const asset = web.get(localPath);
    if (asset && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(asset.bytes);
    }
    if (localPath === '/gplus' || localPath.startsWith('/gplus/')) return gplus.gateway(req, res);
    return offers(req, res, () => relay(req, res, () => send(res, 404, { error: 'not_found' })));
  }
  async function handleUpgrade(req, socket, head) {
    const prefix = '/gsrv-v1';
    let pathname; try { pathname = new URL(req.url || '', 'http://cloud.local').pathname; } catch (_) { return false; }
    if (pathname !== prefix + '/gplus/call-relay') return false;
    try {
      if (!healthy() || await gplus.ledger.changedExternally()) { socket.destroy(); return true; }
      req.url = req.url.slice(prefix.length);
      if (!gplus.app.handleUpgrade(req, socket, head)) socket.destroy();
    } catch (_) { socket.destroy(); }
    return true;
  }
  async function close() { await gplus.close(); }
  return { handler, handleUpgrade, healthy, relay, offers, gplus, close };
}
module.exports = { createCloudRouter };
