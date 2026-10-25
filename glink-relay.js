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
  const m = req.url.match(/^\/glink\/(up|meta|dl|done|prog)\/([a-zA-Z0-9_-]{6,64})/);
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
      res.setHeader('Content-Length', st.size);
      fs.createReadStream(file).pipe(res);
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
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }

  return next();
};
