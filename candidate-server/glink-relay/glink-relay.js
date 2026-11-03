// ============================================================
// GLINK RELAY — временное файловое реле и Wi-Fi v2 для GLINK 2.8+.
// Подключить до JSON-parser и SPA catch-all: app.use(require('./glink-relay')).
// Рядом обязательны glink-device-v2.js, glink-send.html, glink-crypto-v2.js,
// glink-send-v2.js; см. README. Хранилище временное, это не история G+.
// Сервер v2 отклоняет открытые ключи старых Wi-Fi-клиентов.
// Без проверки публичного ключа пользователем доверие к обнаружению ограничено.
// ============================================================
const fs = require('fs');
const path = require('path');

const DIR = process.env.GLINK_RELAY_DIR || path.join(__dirname, 'glink-data');
const ASSEMBLING = new Set();
let ACTIVE_WRITES = 0;
function trackWrite() { ACTIVE_WRITES++; let finished = false; return () => { if (!finished) { finished = true; ACTIVE_WRITES--; } }; }
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
// Reserve enough real HDD space before accepting concurrent writes or creating
// a second assembly copy. This guards the OS/user's free space, not availability
// against deliberate flooding; disk consumption by other processes can race it.
const DISK_RESERVE = Number(process.env.GLINK_DISK_RESERVE_BYTES || '0');
const MAX_UPLOAD_BYTES = 8 * 1024 ** 4, MAX_CHUNK_BYTES = 8 * 1024 ** 2, MAX_CHUNKS = 2097152;
if (!Number.isSafeInteger(DISK_RESERVE) || DISK_RESERVE < 0) throw Error('invalid GLINK disk reserve');
let RESERVED_BYTES = 0;
function reserveSpace(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_UPLOAD_BYTES) throw Error('invalid_length');
  let st; try { st = fs.statfsSync(DIR); } catch (_) { throw Error('storage_unavailable'); }
  const free = Number(st.bavail) * Number(st.bsize);
  if (!Number.isFinite(free) || free < DISK_RESERVE + RESERVED_BYTES + bytes) throw Error('insufficient_disk_space');
  RESERVED_BYTES += bytes; let released = false;
  return () => { if (!released) { released = true; RESERVED_BYTES -= bytes; } };
}
function reserveRequest(req, max) {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) throw Error('length_required');
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size > max) throw Error('upload_too_large');
  return reserveSpace(size);
}
function refuseUpload(req, res, error) {
  const code = error.message === 'length_required' ? 411 : error.message === 'upload_too_large' || error.message === 'invalid_length' ? 413 : error.message === 'insufficient_disk_space' ? 507 : 503;
  req.resume(); res.statusCode = code; res.end(error.message);
}

function setExpiry(file, hours) {
  const h = [1, 6, 24].includes(hours) ? hours : 1;
  try { fs.writeFileSync(file + '.ttl.json', JSON.stringify({ exp: Date.now() + h * 3600 * 1000 })); } catch (e) {}
}
function expiry(file) {
  try {
    const meta = file + '.ttl.json', st = fs.lstatSync(meta);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) return null;
    const t = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return Number.isSafeInteger(t.exp) && t.exp > 0 ? t.exp : null;
  } catch (e) { return null; }
}
function isExpired(file) { const exp = expiry(file); return exp !== null && Date.now() > exp; }
function purge(file) {
  try { fs.unlinkSync(file); } catch (e) {}
  try { fs.unlinkSync(file + '.prog.json'); } catch (e) {}
  try { fs.unlinkSync(file + '.ttl.json'); } catch (e) {}
  try { fs.rmSync(file + '.parts', { recursive: true, force: true }); } catch (e) {}
}

function fileFor(token) {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(token)) return null;
  return path.join(DIR, token + '.bin');
}

function sweep() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(DIR)) {
      const p = path.join(DIR, name);
      try {
        // The durable encrypted offer queue is not a temporary file.
        if (name === 'wifi-offers-v2.json') continue;
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) continue;
        // Files with no verifiable explicit lifetime may be legacy or unrelated
        // user data. Preserve them, even if that means manual disk cleanup.
        // Do not recursively sweep unknown names in the user's storage.
        if (st.isFile() && /^[A-Za-z0-9_-]{6,64}\.bin$/.test(name)) {
          const exp = expiry(p);
          if (!ACTIVE_WRITES && !ASSEMBLING.has(p) && exp !== null && now > exp) purge(p);
          continue;
        }
        const match = name.match(/^([A-Za-z0-9_-]{6,64}\.bin)\.(?:parts|prog\.json|ttl\.json)$/);
        if (match) {
          const file = path.join(DIR, match[1]), exp = expiry(file);
          if (!ACTIVE_WRITES && !ASSEMBLING.has(file) && exp !== null && now > exp) purge(file);
        }
      } catch (e) {}
    }
  } catch (e) {}
}
// GSERVER freezes the writer and suspends cleanup while a consistent snapshot is copied.
let relayFrozen = process.env.GSERVER_CONTROLLED === '1';
// Frozen after restart is locked; drain access is enabled only explicitly.
let drainingSessions = null;
setInterval(() => { if (!relayFrozen) sweep(); }, 10 * 60 * 1000).unref();
if (!relayFrozen) sweep();

// Wi-Fi v2 accepts only encrypted offers and authenticates recipient polling.
const deviceV2 = require('./glink-device-v2');
const GLINK_SEND_PAGE = fs.readFileSync(path.join(__dirname, 'glink-send.html'), 'utf8');
const GLINK_CRYPTO_JS = fs.readFileSync(path.join(__dirname, 'glink-crypto-v2.js'), 'utf8');
const GLINK_SEND_JS = fs.readFileSync(path.join(__dirname, 'glink-send-v2.js'), 'utf8');

module.exports = function glinkRelay(req, res, next) {
  if (deviceV2.handle(req, res)) return;
  if (req.url === '/glink/crypto-v2.js' || req.url === '/glink/send-v2.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(req.url === '/glink/crypto-v2.js' ? GLINK_CRYPTO_JS : GLINK_SEND_JS);
  }
  if (req.url === '/glink/send' || req.url.startsWith('/glink/send?')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(GLINK_SEND_PAGE);
  }
  const m = req.url.match(/^\/glink\/(up|meta|dl|done|prog|chunk|chunks|get|ttl)\/([a-zA-Z0-9_-]{6,64})/);
  if (!m) return next();
  const op = m[1];
  const file = fileFor(m[2]);
  if (!file) { res.statusCode = 400; return res.end('bad token'); }

  if (op === 'get') {
    res.statusCode = 410;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Public GLINK links were removed; use NFC or a v2 device offer.');
  }

  if (op === 'up' && req.method === 'POST') {
    let release; try { release = reserveRequest(req, MAX_UPLOAD_BYTES); } catch (e) { return refuseUpload(req, res, e); }
    const ttlH = parseInt(new URL(req.url, 'http://localhost').searchParams.get('ttl') || '1', 10);
    setExpiry(file, ttlH);
    const tmp = file + '.tmp';
    const finishWrite = trackWrite();
    const done = () => { release(); finishWrite(); };
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    req.on('aborted', () => out.destroy(new Error('request aborted')));
    req.on('error', () => out.destroy(new Error('request error')));
    out.on('finish', () => {
      try { fs.renameSync(tmp, file); } catch (e) { done(); res.statusCode = 500; return res.end('write error'); }
      done();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    out.on('error', () => { try { fs.unlinkSync(tmp); } catch (e) {} done(); if (!res.destroyed) { res.statusCode = 500; res.end('write error'); } });
    return;
  }

  // --- Докачка загрузки: части по 4 МБ, сборка по готовности ---
  if (op === 'chunks') {
    const dir = file + '.parts';
    fs.readdir(dir, (err, names) => {
      const have = err ? [] : names.filter(n => /^\d+$/.test(n)).map(n => parseInt(n, 10));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ have }));
    });
    return;
  }

  if (op === 'chunk' && req.method === 'POST') {
    const q = new URL(req.url, 'http://localhost').searchParams, rawIdx = q.get('i'), rawCount = q.get('n');
    if (!/^(0|[1-9][0-9]{0,6})$/.test(rawIdx || '') || !/^[1-9][0-9]{0,6}$/.test(rawCount || '')) { req.resume(); res.statusCode = 400; return res.end('bad chunk'); }
    const idx = Number(rawIdx), count = Number(rawCount);
    if (count > MAX_CHUNKS || idx >= count) { req.resume(); res.statusCode = 400; return res.end('bad chunk'); }
    let release; try { release = reserveRequest(req, MAX_CHUNK_BYTES); } catch (e) { return refuseUpload(req, res, e); }
    if (q.get('ttl')) setExpiry(file, parseInt(q.get('ttl'), 10));
    const dir = file + '.parts';
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { release(); req.resume(); res.statusCode = 503; return res.end('storage unavailable'); }
    // АТОМАРНО: пишем во временное имя, публикуем часть только rename'ом,
    // иначе параллельная сборка хватала недописанные части и файл был битым
    const part = path.join(dir, String(idx) + '.tmp-' + Math.random().toString(36).slice(2, 9));
    const finishWrite = trackWrite();
    const done = () => { release(); finishWrite(); };
    const out = fs.createWriteStream(part);
    req.pipe(out);
    req.on('aborted', () => out.destroy(new Error('request aborted')));
    req.on('error', () => out.destroy(new Error('request error')));
    out.on('error', () => { try { fs.unlinkSync(part); } catch (e) {} done(); if (!res.destroyed) { res.statusCode = 500; res.end('write error'); } });
    out.on('finish', () => {
      try { fs.renameSync(part, path.join(dir, String(idx))); } catch (e) { done(); res.statusCode = 500; return res.end('write error'); }
      fs.readdir(dir, (err, names) => {
        if (err) { done(); if (!res.destroyed) { res.statusCode = 503; res.end('storage unavailable'); } return; }
        const have = names.filter(n => /^(0|[1-9][0-9]{0,6})$/.test(n)).map(n => Number(n));
        const present = new Set(have);
        let allHere = present.size >= count;
        for (let i = 0; allHere && i < count; i++) if (!present.has(i)) allHere = false;
        if (allHere && !ASSEMBLING.has(file)) {
          // Assembling duplicates the parts temporarily. Check again now that
          // the last part has landed; on low space leave all chunks resumable.
          let releaseAssembly;
          try {
            let total = 0;
            for (let i = 0; i < count; i++) {
              const st = fs.lstatSync(path.join(dir, String(i)));
              if (!st.isFile() || st.isSymbolicLink()) throw Error('storage_unavailable');
              total += st.size; if (!Number.isSafeInteger(total) || total > MAX_UPLOAD_BYTES) throw Error('upload_too_large');
            }
            releaseAssembly = reserveSpace(total);
          } catch (e) { done(); if (!res.destroyed) { res.statusCode = e.message === 'insufficient_disk_space' ? 507 : e.message === 'upload_too_large' ? 413 : 503; res.end(e.message); } return; }
          ASSEMBLING.add(file);
          // все части на месте — собираем файл по порядку
          const finalTmp = file + '.assemble';
          const ws = fs.createWriteStream(finalTmp);
          ws.on('error', () => { ASSEMBLING.delete(file); releaseAssembly(); done(); if (!res.destroyed) { res.statusCode = 500; res.end('assembly error'); } });
          let cur = 0;
          const pump = () => {
            if (cur >= count) {
              ws.end(() => {
                ASSEMBLING.delete(file);
                try { fs.renameSync(finalTmp, file); } catch (e) { releaseAssembly(); done(); res.statusCode = 500; return res.end('assembly error'); }
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                releaseAssembly(); done();
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, assembled: true }));
              });
              return;
            }
            const rs = fs.createReadStream(path.join(dir, String(cur++)));
            rs.on('end', pump);
            rs.on('error', () => { ASSEMBLING.delete(file); releaseAssembly(); ws.destroy(); done(); if (!res.destroyed) { res.statusCode = 500; res.end('read error'); } });
            rs.pipe(ws, { end: false });
          };
          pump();
        } else {
          done();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, have: have.length }));
        }
      });
    });
    return;
  }

  if (op === 'ttl' && req.method === 'POST') {
    const h = parseInt(new URL(req.url, 'http://localhost').searchParams.get('h') || '1', 10);
    setExpiry(file, h);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, hours: [1, 6, 24].includes(h) ? h : 1 }));
  }

  if ((op === 'meta' || op === 'dl' || op === 'get') && isExpired(file)) {
    purge(file);
    res.statusCode = 404;
    return res.end('expired');
  }

  if (op === 'meta') {
    fs.stat(file, (err, st) => {
      if (err) { res.statusCode = 404; return res.end('not ready'); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ size: st.size }));
    });
    return;
  }

  if (op === 'dl') {
    fs.stat(file, (err, st) => {
      if (err) { res.statusCode = 404; return res.end('not ready'); }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      const mm = range && range.match(/^bytes=(\d+)-(\d*)$/);
      if (mm) {
        const start = parseInt(mm[1], 10);
        const end = mm[2] ? Math.min(parseInt(mm[2], 10), st.size - 1) : st.size - 1;
        if (start > end) { res.statusCode = 416; return res.end(); }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', st.size);
        fs.createReadStream(file).pipe(res);
      }
    });
    return;
  }

  if (op === 'prog') {
    const progFile = file + '.prog.json';
    if (req.method === 'POST') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const got = Math.max(0, parseInt(q.get('got') || '0', 10) || 0);
      const total = Math.max(0, parseInt(q.get('total') || '0', 10) || 0);
      try { fs.writeFileSync(progFile, JSON.stringify({ got, total })); } catch (e) {}
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    }
    fs.readFile(progFile, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('no progress'); }
      res.setHeader('Content-Type', 'application/json');
      res.end(data);
    });
    return;
  }

  if (op === 'done' && req.method === 'POST') {
    purge(file);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }

  return next();
};


// Only an authenticated GSERVER controller can call these in-process hooks.
// Once fully frozen, no request can alter a published migration snapshot.
module.exports.setFrozen = function (value) { if (value) relayFrozen = true; drainingSessions = null; deviceV2.setFrozen(!!value); if (!value) relayFrozen = false; };
module.exports.beginDrain = function () {
  relayFrozen = true; drainingSessions = null; deviceV2.setFrozen(true);
  const found = new Map(), now = Date.now();
  for (const name of fs.readdirSync(DIR)) {
    const m = /^([a-zA-Z0-9_-]{6,64})\.bin\.parts$/.exec(name); if (!m) continue;
    const st = fs.lstatSync(path.join(DIR, name));
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe_chunk_session');
    // Give every pre-existing session a full idle grace period even if its
    // last filesystem mtime is old (e.g. the sender was temporarily offline).
    found.set(m[1], now);
  }
  drainingSessions = found;
};
function drainSessionCount() {
  if (!drainingSessions) return 0;
  for (const token of drainingSessions.keys()) {
    try {
      const st = fs.lstatSync(path.join(DIR, token + '.bin.parts'));
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe_chunk_session');
    } catch (e) { if (e.code === 'ENOENT') drainingSessions.delete(token); else throw e; }
  }
  return drainingSessions.size;
}
function chunkRoute(req) {
  let p; try { p = new URL(req.url, 'http://local').pathname; } catch { return null; }
  const m = /^\/glink\/(chunk|chunks)\/([a-zA-Z0-9_-]{6,64})$/.exec(p);
  return m && ((m[1] === 'chunk' && req.method === 'POST') || (m[1] === 'chunks' && req.method === 'GET')) ? m[2] : null;
}
module.exports.isChunkRequest = function (req) { return chunkRoute(req) !== null; };
module.exports.allowDrainRequest = function (req) {
  const id = chunkRoute(req), allowed = !!(relayFrozen && drainingSessions && id && drainingSessions.has(id));
  if (allowed) drainingSessions.set(id, Date.now());
  return allowed;
};
// Only the user-initiated shutdown may pause an abandoned chunk session.
// Migration freeze NEVER calls this; partial files are retained for resume.
module.exports.pauseIdleDrainSessions = function (idleMs) {
  if (!drainingSessions || ACTIVE_WRITES || ASSEMBLING.size || !Number.isSafeInteger(idleMs) || idleMs < 1) return 0;
  const now = Date.now(); let paused = 0;
  for (const [id, last] of drainingSessions) if (now - last >= idleMs) { drainingSessions.delete(id); paused++; }
  return paused;
};
module.exports.pendingWrites = function () { return ACTIVE_WRITES + ASSEMBLING.size + drainSessionCount(); };
module.exports.sweepForTests = sweep;

// Direct public download links are disabled; Wi-Fi v2 delivers only encrypted offers.
