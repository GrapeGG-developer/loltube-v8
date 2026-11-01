'use strict';
// Stateless public entry point: GSERVER remains the only data writer. Mount
// before the existing GLINK relay and before body parsers / SPA catch-all.
// The allowed SHA-256 is a public fingerprint, never a bearer secret.
const http = require('node:http'), https = require('node:https'), net = require('node:net'), crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { TunnelMux, MAX_FRAME } = require('./tunnel-stream');
const DEFAULT_PIN_URL = 'https://raw.githubusercontent.com/GrapeGG-developer/GLINK/main/gserver-public-key.json';
function readPublicPin(url = DEFAULT_PIN_URL) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'raw.githubusercontent.com' || u.username || u.password) return reject(Error('invalid pin source'));
    u.searchParams.set('v', String(Math.floor(Date.now() / 60000)));
    const req = https.get(u, { headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }, timeout: 8000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(Error('public fingerprint unavailable')); }
      let n = 0, chunks = [];
      res.on('data', b => { n += b.length; if (n <= 4096) chunks.push(b); });
      res.on('end', () => { try {
        if (n > 4096) throw Error('public fingerprint too large');
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v.v !== 1 || !/^[0-9a-f]{64}$/.test(v.sha256)) throw Error('invalid public fingerprint');
        resolve(v.sha256);
      } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('public fingerprint timeout'))); req.on('error', reject);
  });
}
function equalPin(secret, pin) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(secret) || typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) return false;
  const candidate = crypto.createHash('sha256').update(secret, 'utf8').digest(), expected = Buffer.from(pin, 'hex');
  return crypto.timingSafeEqual(candidate, expected);
}
function cleanPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\r\n]/.test(raw)) return '';
  try { return new URL(raw, 'http://local').pathname; } catch (_) { return ''; }
}
function managed(raw) {
  const p = cleanPath(raw);
  return p === '/glink' || p.startsWith('/glink/') || p === '/gplus' || p.startsWith('/gplus/') || p === '/gserver' || p.startsWith('/gserver/') || p === '/gserver-admin' || p.startsWith('/gserver-admin/');
}
function json(res, code, value) {
  if (res.destroyed || res.writableEnded) return;
  const b = Buffer.from(JSON.stringify(value));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(b);
}
function reject(socket, status = '503 Service Unavailable') {
  if (!socket.destroyed) { socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
}
// Start in staging: keep the existing GLINK relay untouched while the owner
// starts and tests the PC. Activate only in a reviewed follow-up commit.
function createTunnelGateway({ getPin = readPublicPin, maxStreams = 64, active = false } = {}) {
  let session = null, pendingAuth = 0, closed = false;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME });
  const tcp = net.createServer({ allowHalfOpen: true }, socket => {
    if (!session || !session.mux.open(socket)) socket.destroy();
  });
  tcp.on('error', () => {}); tcp.listen(0, '127.0.0.1');
  const port = () => { const a = tcp.address(); return a && typeof a === 'object' ? a.port : 0; };
  function headers(req, upgrade = false) {
    const h = { ...req.headers, host: '127.0.0.1:' + port(), 'x-gserver-proxy-key': session.secret };
    delete h['x-gserver-admin']; delete h['proxy-authorization'];
    if (!upgrade) { delete h.connection; delete h.upgrade; delete h['transfer-encoding']; delete h['keep-alive']; }
    return h;
  }
  function proxy(req, res, target = req.url) {
    if (!session || !port()) return json(res, 503, { error: 'gserver_unavailable' });
    const up = http.request({ host: '127.0.0.1', port: port(), path: target, method: req.method, headers: headers(req), timeout: 120000 }, response => {
      const h = { ...response.headers }; delete h.connection; delete h['transfer-encoding']; delete h['keep-alive'];
      res.writeHead(response.statusCode || 502, h); response.on('error', () => res.destroy()); response.pipe(res);
    });
    up.on('timeout', () => up.destroy(Error('idle timeout')));
    up.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'gserver_unavailable' }); else res.destroy(); });
    req.on('aborted', () => up.destroy()); req.pipe(up);
  }
  function preview(raw) {
    const p = cleanPath(raw), prefix = '/gserver-preview';
    // Read-only probes only: staging must not expose account or upload APIs.
    if (p !== prefix + '/glink/devices' && p !== prefix + '/gplus/me') return '';
    const q = raw.indexOf('?'); return p.slice(prefix.length) + (q < 0 ? '' : raw.slice(q));
  }
  function handler(req, res, next) {
    const p = cleanPath(req.url), target = preview(req.url);
    if (target) return active || req.method !== 'GET' ? json(res, 404, { error: 'not_found' }) : proxy(req, res, target);
    if (p === '/gserver-preview' || p.startsWith('/gserver-preview/')) return json(res, 404, { error: 'not_found' });
    if (!managed(req.url)) return typeof next === 'function' ? next() : json(res, 404, { error: 'not_found' });
    if (p === '/gserver/status' && req.method === 'GET') return active
      ? json(res, 200, { mode: 'GSERVER', state: session ? 'online' : 'unavailable', stage: 'active' })
      : json(res, 200, { mode: 'GLINK-S', state: 'online', stage: 'staging', gserver: session ? 'online' : 'unavailable' });
    if (p === '/gserver/tunnel' || p === '/gserver-admin' || p.startsWith('/gserver-admin/')) return json(res, 404, { error: 'not_found' });
    if (!active && (p === '/glink' || p.startsWith('/glink/'))) return typeof next === 'function' ? next() : json(res, 404, { error: 'not_found' });
    if (!active) return json(res, 503, { error: 'gserver_staging' });
    return proxy(req, res);
  }
  function acceptTunnel(req, socket, head) {
    if (closed || session || pendingAuth >= 12) return reject(socket, session ? '409 Conflict' : '503 Service Unavailable');
    pendingAuth++;
    let counted = true;
    const finishPending = () => { if (counted) { counted = false; pendingAuth--; } };
    socket.once('close', finishPending);
    try { wss.handleUpgrade(req, socket, head, ws => {
      let settled = false;
      const timer = setTimeout(() => ws.terminate(), 10000); timer.unref();
      const done = () => { if (!settled) { settled = true; finishPending(); clearTimeout(timer); } };
      let authenticating = false;
      const first = async (data, binary) => {
        if (authenticating || binary || data.length > 512) { done(); return ws.terminate(); }
        authenticating = true;
        let value; try { value = JSON.parse(data.toString('utf8')); } catch (_) { done(); return ws.terminate(); }
        if (!value || value.v !== 1 || value.type !== 'auth') { done(); return ws.terminate(); }
        let pin; try { pin = await getPin(); } catch (_) { done(); return ws.terminate(); }
        if (closed || session || ws.readyState !== 1 || !equalPin(value.secret, pin)) { done(); return ws.terminate(); }
        done(); ws.off('message', first);
        const current = { ws, secret: value.secret, mux: null, alive: true };
        current.mux = new TunnelMux(ws, { maxStreams }); session = current;
        ws.on('pong', () => { current.alive = true; });
        ws.on('close', () => { current.mux.shutdown(); current.secret = ''; if (session === current) session = null; });
        ws.on('error', () => {});
        try { ws.send(JSON.stringify({ v: 1, type: 'ready' })); } catch (_) { ws.terminate(); }
      };
      ws.on('message', first); ws.on('close', done); ws.on('error', done);
    }); } catch (_) { finishPending(); socket.destroy(); }
  }
  function proxyUpgrade(req, socket, head, target = req.url) {
    if (!session || !port()) { reject(socket); return; }
    const up = http.request({ host: '127.0.0.1', port: port(), path: target, method: req.method, headers: headers(req, true), timeout: 15000 });
    up.on('upgrade', (response, remote, remoteHead) => {
      let line = 'HTTP/1.1 ' + response.statusCode + ' ' + response.statusMessage + '\r\n';
      for (let i = 0; i < response.rawHeaders.length; i += 2) line += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n';
      socket.write(line + '\r\n'); if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket); remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    });
    up.on('response', r => { const code = r.statusCode || 503; r.resume(); reject(socket, code === 401 ? '401 Unauthorized' : '503 Service Unavailable'); });
    up.on('timeout', () => up.destroy()); up.on('error', () => reject(socket)); up.end();
  }
  function handleUpgrade(req, socket, head) {
    const p = cleanPath(req.url);
    if (p === '/gserver/tunnel') { acceptTunnel(req, socket, head); return true; }
    if (p === '/gplus/call-relay') { if (active) proxyUpgrade(req, socket, head); else reject(socket); return true; }
    if (p === '/gserver-preview' || p.startsWith('/gserver-preview/')) { reject(socket, '404 Not Found'); return true; }
    return false;
  }
  const heartbeat = setInterval(() => {
    if (!session) return;
    if (!session.alive) return session.ws.terminate();
    session.alive = false; try { session.ws.ping(); } catch (_) { session.ws.terminate(); }
  }, 15000); heartbeat.unref();
  function close() {
    closed = true; clearInterval(heartbeat);
    if (session) session.ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    wss.close(); tcp.close();
  }
  return { handler, handleUpgrade, close, isOnline: () => !!session };
}
module.exports = { createTunnelGateway, readPublicPin, equalPin, managed };
