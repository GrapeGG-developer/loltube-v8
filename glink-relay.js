// ============================================================
// GLINK RELAY — серверный модуль передачи файлов GLINK (1.5+)
// Куда: в проект бэкенда ЛОЛТУБА (тот, что живёт на Render).
// Как подключить (2 строки в главном файле сервера, ДО SPA catch-all):
//   const glinkRelay = require('./glink-relay');
//   app.use(glinkRelay);
// Всё. Зависимости не нужны, только Node (fs/path).
// Канал: POST /glink/up/:token  — тело = шифротекст (сервер ключ не знает)
//        GET  /glink/meta/:token -> {size}
//        GET  /glink/dl/:token   — скачать шифротекст
//        POST /glink/done/:token — получатель забрал, удалить
// Файлы живут не дольше TTL (2 часа) и чистятся сами.
// ============================================================
const fs = require('fs');
const path = require('path');

const DIR = process.env.GLINK_RELAY_DIR || path.join(__dirname, 'glink-data');
const TTL_MS = 2 * 60 * 60 * 1000; // 2 часа
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}

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
        const st = fs.statSync(p);
        if (now - st.mtimeMs > TTL_MS) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
}
setInterval(sweep, 10 * 60 * 1000).unref();
sweep();

module.exports = function glinkRelay(req, res, next) {
  const m = req.url.match(/^\/glink\/(up|meta|dl|done|prog|chunk|chunks)\/([a-zA-Z0-9_-]{6,64})/);
  if (!m) return next();
  const op = m[1];
  const file = fileFor(m[2]);
  if (!file) { res.statusCode = 400; return res.end('bad token'); }

  if (op === 'up' && req.method === 'POST') {
    const tmp = file + '.tmp';
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    req.on('error', () => { try { fs.unlinkSync(tmp); } catch (e) {} });
    out.on('finish', () => {
      try { fs.renameSync(tmp, file); } catch (e) {}
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    out.on('error', () => { res.statusCode = 500; res.end('write error'); });
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
    const q = new URL(req.url, 'http://localhost').searchParams;
    const idx = parseInt(q.get('i') || '-1', 10);
    const count = parseInt(q.get('n') || '0', 10);
    if (idx < 0 || count <= 0 || idx >= count) { res.statusCode = 400; return res.end('bad chunk'); }
    const dir = file + '.parts';
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const part = path.join(dir, String(idx));
    const out = fs.createWriteStream(part);
    req.pipe(out);
    out.on('error', () => { res.statusCode = 500; res.end('write error'); });
    out.on('finish', () => {
      fs.readdir(dir, (err, names) => {
        const have = err ? [] : names.filter(n => /^\d+$/.test(n)).map(n => parseInt(n, 10));
        if (have.length >= count) {
          // все части на месте — собираем файл по порядку
          const finalTmp = file + '.assemble';
          const ws = fs.createWriteStream(finalTmp);
          let cur = 0;
          const pump = () => {
            if (cur >= count) {
              ws.end(() => {
                try { fs.renameSync(finalTmp, file); } catch (e) {}
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, assembled: true }));
              });
              return;
            }
            const rs = fs.createReadStream(path.join(dir, String(cur++)));
            rs.on('end', pump);
            rs.on('error', () => { res.statusCode = 500; res.end('read error'); });
            rs.pipe(ws, { end: false });
          };
          pump();
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, have: have.length }));
        }
      });
    });
    return;
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
    fs.unlink(file, () => {});
    fs.unlink(file + '.prog.json', () => {});
    try { fs.rmSync(file + '.parts', { recursive: true, force: true }); } catch (e) {}
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }

  return next();
};
