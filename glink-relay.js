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
const TTL_MS = 60 * 60 * 1000;
const ASSEMBLING = new Set(); // 1 час
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}

function setExpiry(file, hours) {
  const h = [1, 6, 24].includes(hours) ? hours : 1;
  try { fs.writeFileSync(file + '.ttl.json', JSON.stringify({ exp: Date.now() + h * 3600 * 1000 })); } catch (e) {}
}
function isExpired(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file + '.ttl.json', 'utf8'));
    return t.exp && Date.now() > t.exp;
  } catch (e) { return false; }
}
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
        const st = fs.statSync(p);
        const base = name.endsWith('.bin') ? p : null;
        if (base && isExpired(base)) { purge(base); continue; }
        if (now - st.mtimeMs > TTL_MS && !name.endsWith('.ttl.json')) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
}
setInterval(sweep, 10 * 60 * 1000).unref();
sweep();

// --- Wi-Fi передача: присутствие устройств и предложения (без QR и ссылок) ---
const DEVICES = new Map(); // id -> {name, ts}
const OFFERS = new Map();  // deviceId -> [{s,k,from,ts}]

function readBody(req, cb) {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb({}); } });
}
function jsonRes(res, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = function glinkRelay(req, res, next) {
  // присутствие: телефон/ПК объявляет себя в сети
  if (req.url === '/glink/presence' && req.method === 'POST') {
    readBody(req, o => {
      const id = String(o.id || '').slice(0, 64);
      if (!id) { res.statusCode = 400; return res.end('bad id'); }
      DEVICES.set(id, { name: String(o.name || 'Устройство').slice(0, 60), ts: Date.now() });
      jsonRes(res, { ok: true });
    });
    return;
  }
  if (req.url.startsWith('/glink/devices')) {
    const me = new URL(req.url, 'http://localhost').searchParams.get('me') || '';
    const now = Date.now();
    const list = [];
    for (const [id, d] of DEVICES) {
      if (now - d.ts > 90000) { DEVICES.delete(id); continue; }
      if (id !== me) list.push({ id, name: d.name });
    }
    return jsonRes(res, { devices: list });
  }
  // предложение передачи конкретному устройству
  if (req.url === '/glink/offer' && req.method === 'POST') {
    readBody(req, o => {
      const to = String(o.to || '').slice(0, 64);
      const s = String(o.s || '');
      const k = String(o.k || '');
      if (!to || !/^[a-zA-Z0-9_-]{6,64}$/.test(s) || !k) { res.statusCode = 400; return res.end('bad offer'); }
      const arr = OFFERS.get(to) || [];
      arr.push({ s, k, from: String(o.from || 'Устройство').slice(0, 60), ts: Date.now() });
      OFFERS.set(to, arr.slice(-5));
      jsonRes(res, { ok: true });
    });
    return;
  }
  if (req.url.startsWith('/glink/offers/')) {
    const id = req.url.slice('/glink/offers/'.length).split('?')[0].slice(0, 64);
    const now = Date.now();
    const arr = (OFFERS.get(id) || []).filter(o => now - o.ts < 15 * 60 * 1000);
    OFFERS.set(id, arr);
    return jsonRes(res, { offers: arr });
  }
  if (req.url === '/glink/offer-ack' && req.method === 'POST') {
    readBody(req, o => {
      const arr = (OFFERS.get(String(o.to || '')) || []).filter(x => x.s !== String(o.s || ''));
      OFFERS.set(String(o.to || ''), arr);
      jsonRes(res, { ok: true });
    });
    return;
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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(GLINK_PAGE.replace('__TOKEN__', m[2]));
  }

  if (op === 'up' && req.method === 'POST') {
    const ttlH = parseInt(new URL(req.url, 'http://localhost').searchParams.get('ttl') || '1', 10);
    setExpiry(file, ttlH);
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
    if (q.get('ttl')) setExpiry(file, parseInt(q.get('ttl'), 10));
    const idx = parseInt(q.get('i') || '-1', 10);
    const count = parseInt(q.get('n') || '0', 10);
    if (idx < 0 || count <= 0 || idx >= count) { res.statusCode = 400; return res.end('bad chunk'); }
    const dir = file + '.parts';
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    // АТОМАРНО: пишем во временное имя, публикуем часть только rename'ом,
    // иначе параллельная сборка хватала недописанные части и файл был битым
    const part = path.join(dir, String(idx) + '.tmp-' + Math.random().toString(36).slice(2, 9));
    const out = fs.createWriteStream(part);
    req.pipe(out);
    out.on('error', () => { res.statusCode = 500; res.end('write error'); });
    out.on('finish', () => {
      try { fs.renameSync(part, path.join(dir, String(idx))); } catch (e) {}
      fs.readdir(dir, (err, names) => {
        const have = err ? [] : names.filter(n => /^\d+$/.test(n)).map(n => parseInt(n, 10));
        const allHere = have.length >= count
          && Array.from({ length: count }, (_, i) => i).every(i => have.includes(i));
        if (allHere && !ASSEMBLING.has(file)) {
          ASSEMBLING.add(file);
          // все части на месте — собираем файл по порядку
          const finalTmp = file + '.assemble';
          const ws = fs.createWriteStream(finalTmp);
          let cur = 0;
          const pump = () => {
            if (cur >= count) {
              ws.end(() => {
                ASSEMBLING.delete(file);
                try { fs.renameSync(finalTmp, file); } catch (e) {}
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true, assembled: true }));
              });
              return;
            }
            const rs = fs.createReadStream(path.join(dir, String(cur++)));
            rs.on('end', pump);
            rs.on('error', () => { ASSEMBLING.delete(file); res.statusCode = 500; res.end('read error'); });
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
    fs.unlink(file, () => {});
    fs.unlink(file + '.prog.json', () => {});
    try { fs.rmSync(file + '.parts', { recursive: true, force: true }); } catch (e) {}
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }

  return next();
};


// Страница скачивания GLINK: ключ из #-фрагмента, расшифровка прямо в браузере.
const GLINK_PAGE = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1"><title>GLINK — файлы для вас</title>' +
'<style>body{background:#07060d;color:#e8e6f5;font-family:system-ui,sans-serif;margin:0;padding:24px}' +
'.card{max-width:560px;margin:8vh auto;background:#12101e;border:1px solid #2c2647;padding:24px}' +
'h1{font-weight:300;font-size:22px;margin:0 0 6px}.g{color:#22e39a}.v{color:#8b5cf6}' +
'button{background:#22e39a;color:#06130c;border:0;padding:12px 18px;font-size:15px;cursor:pointer;width:100%;margin-top:12px}' +
'.f{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #241f3d;font-size:14px}' +
'#st{color:#a49ec7;font-size:13px;margin-top:10px;white-space:pre-wrap}</style></head><body>' +
'<div class="card"><h1><span class="g">GLINK</span> · файлы для вас</h1>' +
'<div style="color:#a49ec7;font-size:13px">Расшифровка происходит прямо в браузере: ключ из ссылки на сервер не уходит. Ссылка живёт до 1 часа.</div>' +
'<div id="list"></div><div id="st">Загружаю…</div></div>' +
'<script>' +
'const TOKEN="__TOKEN__";' +
'const st=document.getElementById("st"),list=document.getElementById("list");' +
'function b64u(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}' +
'async function main(){' +
'const k=(location.hash.match(/k=([^&]+)/)||[])[1];' +
'if(!k){st.textContent="В ссылке нет ключа — попросите отправителя прислать ссылку целиком.";return;}' +
'const keyRaw=b64u(decodeURIComponent(k));' +
'const r=await fetch("/glink/dl/"+TOKEN);' +
'if(!r.ok){st.textContent="Файл не найден: ссылка устарела или отправитель отменил передачу.";return;}' +
'const buf=new Uint8Array(await r.arrayBuffer());' +
'if(new TextDecoder().decode(buf.slice(0,6))!=="GSENC1"){st.textContent="Формат не распознан.";return;}' +
'const salt=buf.slice(6,22);let pos=22;const frames=[];' +
'while(pos<buf.length){const len=new DataView(buf.buffer,buf.byteOffset+pos,4).getUint32(0);frames.push(buf.slice(pos+4,pos+4+len));pos+=4+len;}' +
'const kd=new Uint8Array(keyRaw.length+salt.length);kd.set(keyRaw);kd.set(salt,keyRaw.length);' +
'const hash=await crypto.subtle.digest("SHA-256",kd);' +
'const key=await crypto.subtle.importKey("raw",hash,{name:"AES-GCM"},false,["decrypt"]);' +
'const parts=[];' +
'for(const f of frames){const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:f.slice(0,12)},key,f.slice(12));parts.push(new Uint8Array(pt));}' +
'let total=0;for(const p of parts)total+=p.length;' +
'const plain=new Uint8Array(total);let off=0;for(const p of parts){plain.set(p,off);off+=p.length;}' +
'let q=0;const dv=new DataView(plain.buffer,plain.byteOffset);' +
'const mlen=dv.getUint32(q);q+=4;' +
'const man=JSON.parse(new TextDecoder().decode(plain.slice(q,q+mlen)));q+=mlen;' +
'st.textContent="От: "+(man.from||"GLINK")+". Нажмите файл, чтобы скачать.";' +
'if(man.text){addText("Текст",man.text);}' +
'if(man.link){addText("Ссылка",man.link);}' +
'for(const f of man.files||[]){const size=Number(dv.getBigUint64(q));q+=8;' +
'const data=plain.slice(q,q+size);q+=size+8;' +
'addRow(f.p,size,data);}' +
'}' +
'function addText(name,val){const d=document.createElement("div");d.className="f";d.innerHTML="<span></span>";d.firstChild.textContent=name+": "+val;list.appendChild(d);}' +
'function addRow(name,size,data){const d=document.createElement("div");d.className="f";' +
'const s=document.createElement("span");s.textContent=name+" · "+(size/1048576).toFixed(2)+" МБ";' +
'const b=document.createElement("button");b.textContent="Скачать";b.style.width="auto";b.style.margin="0";b.style.padding="6px 12px";' +
'b.onclick=()=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([data]));a.download=(name||"file").split("/").pop();a.click();};' +
'd.appendChild(s);d.appendChild(b);list.appendChild(d);}' +
'main().catch(e=>{st.textContent="Не удалось расшифровать: ссылка повреждена или ключ не тот.";});' +
'</' + 'script></body></html>';


// ПК-отправитель GLINK: шифрование и заливка прямо из браузера компьютера.
const GLINK_SEND_PAGE = '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1"><title>GLINK для ПК — отправить на телефон</title>' +
'<style>body{background:#07060d;color:#e8e6f5;font-family:system-ui,sans-serif;margin:0;padding:24px}' +
'.card{max-width:620px;margin:5vh auto;background:#12101e;border:1px solid #2c2647;padding:26px}' +
'h1{font-weight:300;font-size:24px;margin:0 0 6px}.g{color:#22e39a}' +
'#drop{border:1px dashed #4a3f7d;padding:34px;text-align:center;color:#a49ec7;cursor:pointer;margin-top:16px}' +
'#drop:hover{border-color:#22e39a;color:#e8e6f5}' +
'button{background:#22e39a;color:#06130c;border:0;padding:12px 18px;font-size:15px;cursor:pointer;margin-top:10px}' +
'button.alt{background:#2c2647;color:#e8e6f5}' +
'#bar{height:8px;background:#241f3d;margin-top:14px}#fill{height:100%;width:0;background:linear-gradient(90deg,#8b5cf6,#22e39a)}' +
'#st{color:#a49ec7;font-size:13px;margin-top:10px;white-space:pre-wrap;word-break:break-all}' +
'.f{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #241f3d;font-size:14px}' +
'a{color:#22e39a}</style></head><body>' +
'<div class="card"><h1><span class="g">GLINK</span> для ПК</h1>' +
'<div style="color:#a49ec7;font-size:13px">Файлы шифруются прямо на компьютере и заливаются на сервер GrapeScript. Дальше — ссылка: на телефоне её можно открыть в GLINK или скачать файлы в браузере. Живёт 1 час.</div>' +
'<div id="drop">Перетащите файлы сюда или нажмите, чтобы выбрать<input id="fi" type="file" multiple hidden></div>' +
'<button id="dirBtn" class="alt" style="width:100%">Или выбрать папку целиком (структура сохранится)</button><input id="fiDir" type="file" webkitdirectory hidden>' +
'<div id="list"></div>' +
'<button id="go" style="display:none;width:100%">Зашифровать и загрузить</button>' +
'<div id="bar" style="display:none"><div id="fill"></div></div>' +
'<div id="st"></div><div id="out"></div></div>' +
'<script>' +
'let FILES=[];' +
'const drop=document.getElementById("drop"),fi=document.getElementById("fi"),list=document.getElementById("list"),go=document.getElementById("go"),st=document.getElementById("st"),fill=document.getElementById("fill"),out=document.getElementById("out");' +
'drop.onclick=()=>fi.click();' +
'document.getElementById("dirBtn").onclick=()=>document.getElementById("fiDir").click();' +
'document.getElementById("fiDir").onchange=e=>setFiles(e.target.files);' +
'drop.ondragover=e=>{e.preventDefault();};' +
'drop.ondrop=e=>{e.preventDefault();setFiles(e.dataTransfer.files);};' +
'fi.onchange=()=>setFiles(fi.files);' +
'function setFiles(fs){FILES=[...fs];list.innerHTML="";let sum=0;' +
'for(const f of FILES){sum+=f.size;const d=document.createElement("div");d.className="f";d.innerHTML="<span></span><span></span>";d.children[0].textContent=f.name;d.children[1].textContent=(f.size/1048576).toFixed(2)+" МБ";list.appendChild(d);}' +
'go.style.display=FILES.length?"block":"none";st.textContent=FILES.length?("Выбрано файлов: "+FILES.length+", всего "+(sum/1048576).toFixed(1)+" МБ"):"";}' +
'const CRC_T=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c;}return t;})();' +
'function crc32(u8){let c=-1;for(let i=0;i<u8.length;i++)c=CRC_T[(c^u8[i])&255]^(c>>>8);return (c^-1)>>>0;}' +
'function u32(n){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n);return b;}' +
'function u64(n){const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,BigInt(n));return b;}' +
'function cat(parts){let t=0;for(const p of parts)t+=p.length;const o=new Uint8Array(t);let q=0;for(const p of parts){o.set(p,q);q+=p.length;}return o;}' +
'function b64u(u8){let s="";for(const b of u8)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_");}' +
'go.onclick=async()=>{' +
'try{go.disabled=true;document.getElementById("bar").style.display="block";' +
'st.textContent="Читаю файлы…";' +
'const bufs=[];for(const f of FILES)bufs.push(new Uint8Array(await f.arrayBuffer()));' +
'const man={t:"manifest",from:"Компьютер (GLINK web)",files:FILES.map((f,i)=>({p:(f.webkitRelativePath||f.name),s:bufs[i].length,m:f.type||"application/octet-stream"}))};' +
'const mb=new TextEncoder().encode(JSON.stringify(man));' +
'const parts=[u32(mb.length),mb];' +
'FILES.forEach((f,i)=>{parts.push(u64(bufs[i].length));parts.push(bufs[i]);parts.push(u64(crc32(bufs[i])));});' +
'const plain=cat(parts);' +
'st.textContent="Шифрую…";' +
'const keyRaw=crypto.getRandomValues(new Uint8Array(32));' +
'const sessB=crypto.getRandomValues(new Uint8Array(9));' +
'const session=[...sessB].map(x=>x.toString(16).padStart(2,"0")).join("");' +
'const salt=crypto.getRandomValues(new Uint8Array(16));' +
'const kd=new Uint8Array(48);kd.set(keyRaw);kd.set(salt,32);' +
'const hash=await crypto.subtle.digest("SHA-256",kd);' +
'const key=await crypto.subtle.importKey("raw",hash,{name:"AES-GCM"},false,["encrypt"]);' +
'const CH=65536;const frames=[new TextEncoder().encode("GSENC1"),salt];' +
'for(let q=0;q<plain.length||q===0;q+=CH){const piece=plain.slice(q,q+CH);' +
'const iv=crypto.getRandomValues(new Uint8Array(12));' +
'const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,piece));' +
'frames.push(u32(12+ct.length));frames.push(iv);frames.push(ct);' +
'if(piece.length===0)break;}' +
'const enc=cat(frames);' +
'st.textContent="Загружаю на сервер GrapeScript…";' +
'const CS=4*1024*1024;const n=Math.max(1,Math.ceil(enc.length/CS));' +
'for(let i=0;i<n;i++){const part=enc.slice(i*CS,(i+1)*CS);' +
'const r=await fetch("/glink/chunk/"+session+"?i="+i+"&n="+n,{method:"POST",body:part});' +
'if(!r.ok)throw new Error("chunk "+i);' +
'fill.style.width=Math.round((i+1)/n*100)+"%";}' +
'const PCID=localStorage.getItem("glinkPcId")||("pc-"+Math.random().toString(36).slice(2,10));localStorage.setItem("glinkPcId",PCID);' +
'fetch("/glink/presence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:PCID,name:"Компьютер (браузер)"})});' +
'setInterval(()=>{fetch("/glink/offers/"+PCID).then(r=>r.json()).then(j=>{for(const o of j.offers||[]){const d=document.createElement("div");d.style.marginTop="14px";d.innerHTML="<b>Входящая передача от "+o.from+"</b>";const a=document.createElement("button");a.textContent="Скачать файлы";a.onclick=()=>{location.href="/glink/get/"+o.s+"#k="+o.k;};d.appendChild(a);out.appendChild(d);fetch("/glink/offer-ack",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:PCID,s:o.s})});}}).catch(()=>{});},6000);' +
'const keyUrl=b64u(keyRaw);' +
'const dl=location.origin+"/glink/get/"+session+"#k="+keyUrl;' +
'const app="glink://receive?s="+session+"&k="+keyUrl;' +
'st.textContent="Готово! Выберите телефон по Wi-Fi:";' +
'out.innerHTML="";' +
'fetch("/glink/devices?me="+PCID).then(r=>r.json()).then(j=>{const ds=j.devices||[];if(!ds.length){st.textContent="Файл загружен, но телефонов рядом не видно. Откройте GLINK на телефоне и подождите несколько секунд.";return;}for(const dv of ds){const b=document.createElement("button");b.textContent="Отправить на "+dv.name;b.onclick=()=>{fetch("/glink/offer",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:dv.id,s:session,k:keyUrl,from:"Компьютер"})}).then(()=>{st.textContent="Отправлено на "+dv.name+" — подтвердите приём на телефоне.";});};out.appendChild(b);}});' +
'}catch(e){st.textContent="Ошибка: "+e.message;go.disabled=false;}};' +
'</' + 'script></body></html>';
