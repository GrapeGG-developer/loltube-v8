'use strict';
(async () => {
  const G = window.GlinkCryptoV2, c = window.crypto, enc = new TextEncoder(), dec = new TextDecoder();
  // The explicit, versioned PC route may coexist with the legacy relay.
  // Never change origin or route legacy traffic through the new server silently.
  const routePrefix = /^\/gsrv-v1\/glink\/send\/?$/.test(window.location.pathname) ? '/gsrv-v1' : '';
  const endpoint = path => routePrefix + path;
  const $ = id => document.getElementById(id);
  const status = s => { $('status').textContent = s; };
  let files = [], keys, id = '', bearer = '', expires = 0, authPending = null;
  let busy = false; const displayed = new Set();
  if (!G || !c || !c.subtle || !window.indexedDB) { status('Нужен современный браузер и защищённый HTTPS.'); return; }
  function u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n); return a; }
  function u64(n) { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n)); return a; }
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let x = n; for (let i = 0; i < 8; i++) x = x & 1 ? 0xEDB88320 ^ (x >>> 1) : x >>> 1; t[n] = x >>> 0; } return t; })();
  function crcStep(x, b) { for (const v of b) x = crcTable[(x ^ v) & 255] ^ (x >>> 8); return x; }
  function crc32(b) { return (crcStep(0xffffffff, b) ^ 0xffffffff) >>> 0; }
  function openDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('glink-device-v2', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('identity');
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
  }
  function dbGet(db) { return new Promise((resolve, reject) => { const r = db.transaction('identity').objectStore('identity').get('keys'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  function dbSet(db, value) { return new Promise((resolve, reject) => { const tx = db.transaction('identity', 'readwrite'); tx.objectStore('identity').put(value, 'keys'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
  async function loadIdentity() {
    const db = await openDb(); let saved = await dbGet(db);
    if (!saved) {
      saved = {
        sign: await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
        transport: await c.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      };
      await dbSet(db, saved);
    }
    db.close(); return saved;
  }
  async function request(path, options = {}) {
    const r = await fetch(endpoint(path), { cache: 'no-store', ...options });
    let data; try { data = await r.json(); } catch (_) { throw Error('Сервер GLINK нужно обновить для защищённой передачи'); }
    if (!r.ok) { const e = Error(data.error || ('Ошибка сервера ' + r.status)); e.code = r.status; throw e; }
    return data;
  }
  function post(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
  async function authenticate() {
    if (bearer && Date.now() < expires - 30000) return;
    if (authPending) return authPending;
    authPending = (async () => {
      const pub = new Uint8Array(await c.subtle.exportKey('spki', keys.sign.publicKey));
      const transport = new Uint8Array(await c.subtle.exportKey('spki', keys.transport.publicKey));
      const challenge = await request('/glink/device/challenge', post({ publicKey: G.b64(pub) }));
      if (challenge.v !== 2) throw Error('Сервер GLINK нужно обновить');
      const digest = new Uint8Array(await c.subtle.digest('SHA-256', pub));
      const short = G.b64(digest.slice(0, 12)), expected = [0, 4, 8, 12].map(i => short.slice(i, i + 4)).join('-');
      if (challenge.id !== expected) throw Error('Ошибка ID устройства');
      const message = G.cat(enc.encode('GLINK-WIFI-AUTH-2\0'), G.unb64(challenge.nonce), transport);
      const sig = new Uint8Array(await c.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.sign.privateKey, message));
      const auth = await request('/glink/device/auth', post({ nonce: challenge.nonce, transportKey: G.b64(transport), signature: G.b64(sig), name: 'Компьютер (браузер)' }));
      if (auth.v !== 2 || auth.id !== expected || !auth.token) throw Error('Ошибка авторизации устройства');
      id = auth.id; bearer = auth.token; expires = Date.now() + Number(auth.expiresIn || 0);
      $('identity').textContent = 'GLINK ID · ' + id;
    })();
    try { await authPending; } finally { authPending = null; }
  }
  async function authed(path, options = {}) {
    await authenticate();
    try { return await request(path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + bearer } }); }
    catch (e) {
      if (e.code !== 401) throw e;
      bearer = ''; await authenticate();
      return request(path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + bearer } });
    }
  }
  function showFiles(input) {
    files = Array.from(input); $('fileList').replaceChildren();
    for (const f of files) { const d = document.createElement('div'); d.className = 'row'; d.textContent = (f.webkitRelativePath || f.name) + ' · ' + (f.size / 1048576).toFixed(2) + ' МБ'; $('fileList').appendChild(d); }
    status(files.length ? 'Выберите устройство ниже.' : 'Файлы не выбраны.');
  }
  $('files').onchange = e => showFiles(e.target.files);
  $('folder').onchange = e => showFiles(e.target.files);
  $('folderButton').onclick = () => $('folder').click();
  const drop = document.querySelector('.drop');
  drop.ondragover = e => e.preventDefault();
  drop.ondrop = e => { e.preventDefault(); showFiles(e.dataTransfer.files); };
  $('refresh').onclick = () => refreshDevices().catch(e => status(e.message));
  async function refreshDevices() {
    await authenticate();
    const response = await request('/glink/devices?me=' + encodeURIComponent(id));
    if (response.v !== 2) throw Error('Сервер GLINK нужно обновить');
    const box = $('devices'); box.replaceChildren();
    if (!response.devices.length) { box.textContent = 'Нет доступных обновлённых устройств. Откройте GLINK на телефоне.'; return; }
    for (const d of response.devices) {
      const b = document.createElement('button'); b.className = 'alt'; b.textContent = d.name; b.onclick = () => send(d).catch(e => status('Ошибка: ' + e.message)); box.appendChild(b);
    }
  }
  async function send(target) {
    if (busy) return; if (!files.length) { status('Сначала выберите файлы.'); return; }
    busy = true; $('progress').style.width = '0%'; let raw = null;
    try {
      if (files.length > 10000 || files.some(f => !Number.isSafeInteger(f.size) || f.size < 0)) throw Error('Некорректный список файлов');
      const manifest = { t: 'manifest', from: 'Компьютер (GLINK web)', files: files.map(f => ({ p: f.webkitRelativePath || f.name, s: f.size, m: f.type || 'application/octet-stream' })) };
      const m = enc.encode(JSON.stringify(manifest));
      if (m.length > 4 * 1024 * 1024) throw Error('Слишком большой список файлов');
      let plainSize = 4 + m.length;
      for (const f of files) { plainSize += 16 + f.size; if (!Number.isSafeInteger(plainSize)) throw Error('Передача слишком большая'); }
      const frameSize = 65536, chunkSize = 4 * 1024 * 1024;
      const encryptedSize = 22 + plainSize + Math.ceil(plainSize / frameSize) * 32 + 32;
      if (!Number.isSafeInteger(encryptedSize)) throw Error('Передача слишком большая');
      const count = Math.ceil(encryptedSize / chunkSize), session = Array.from(c.getRandomValues(new Uint8Array(9)), v => v.toString(16).padStart(2, '0')).join('');
      raw = c.getRandomValues(new Uint8Array(32));
      // The offer is sealed for the recipient before any ciphertext is uploaded.
      const sealed = await G.seal(target.enc, raw, session, target.id), salt = c.getRandomValues(new Uint8Array(16));
      const hash = await c.subtle.digest('SHA-256', G.cat(raw, salt));raw.fill(0);raw=null;
      const key = await c.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt']);
      let chunk = new Uint8Array(chunkSize), chunkUsed = 0, index = 0, emitted = 0;
      async function uploadChunk() {
        if (!chunkUsed) return;
        const r = await fetch(endpoint('/glink/chunk/' + session + '?i=' + index + '&n=' + count), { method: 'POST', body: chunk.slice(0, chunkUsed) });
        if (!r.ok) throw Error('Не удалось загрузить часть ' + (index + 1));
        index++; $('progress').style.width = Math.round(index * 100 / count) + '%'; chunkUsed = 0;
      }
      async function emit(bytes) {
        emitted += bytes.length;
        for (let p = 0; p < bytes.length;) {
          const n = Math.min(chunkSize - chunkUsed, bytes.length - p); chunk.set(bytes.subarray(p, p + n), chunkUsed); chunkUsed += n; p += n;
          if (chunkUsed === chunkSize) await uploadChunk();
        }
      }
      async function frame(plain) {
        const iv = c.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
        await emit(u32(12 + ct.length)); await emit(iv); await emit(ct);
      }
      const buffer = new Uint8Array(frameSize);let used = 0;
      async function feed(bytes) {
        for (let p = 0; p < bytes.length;) {
          const n = Math.min(frameSize - used, bytes.length - p);buffer.set(bytes.subarray(p, p + n), used);used += n;p += n;
          if (used === frameSize) { await frame(buffer);used = 0; }
        }
      }
      status('Шифруем и загружаем файлы…');await emit(enc.encode('GSENC1'));await emit(salt);await feed(u32(m.length));await feed(m);
      for (const f of files) {
        await feed(u64(f.size));let crc = 0xffffffff;
        for (let offset = 0; offset < f.size; offset += frameSize) {
          const end = Math.min(f.size, offset + frameSize);
          // Real File/Blob objects are sliced, keeping memory bounded for large uploads.
          const part = typeof f.slice === 'function' ? await f.slice(offset, end).arrayBuffer() : (await f.arrayBuffer()).slice(offset, end);
          const bytes = new Uint8Array(part);if (bytes.length !== end - offset) throw Error('Не удалось прочитать файл целиком');
          crc = crcStep(crc, bytes);await feed(bytes);
        }
        await feed(u64((crc ^ 0xffffffff) >>> 0));
      }
      if (used) await frame(buffer.slice(0, used));await frame(new Uint8Array());await uploadChunk();
      if (emitted !== encryptedSize || index !== count) throw Error('Ошибка размера передачи');
      await request('/glink/offer', post({ to: target.id, s: session, k: sealed, from: 'Компьютер' }));
      status('Предложение отправлено: ' + target.name + '. Подтвердите получение на другом устройстве.');
    } finally { if (raw) raw.fill(0); busy = false; }
  }
  async function heartbeat() { await authed('/glink/presence', post({ name: 'Компьютер (браузер)' })); }
  async function ack(session) { await authed('/glink/offer-ack', post({ to: id, s: session })); }
  async function poll() {
    const result = await authed('/glink/offers/' + encodeURIComponent(id));
    for (const o of result.offers || []) {
      if (displayed.has(o.s)) continue;
      displayed.add(o.s);
      const box = $('incoming'); if (box.textContent === 'Пока нет входящих передач') box.replaceChildren();
      const item = document.createElement('div'); item.className = 'incoming';
      const label = document.createElement('div'); label.textContent = 'Передача от ' + (o.from || 'устройства'); item.appendChild(label);
      const accept = document.createElement('button'); accept.textContent = 'Принять';
      const reject = document.createElement('button'); reject.className = 'alt'; reject.textContent = 'Отклонить';
      accept.onclick = async () => {
        accept.disabled = reject.disabled = true;
        try { await receive(o, item); await ack(o.s); }
        catch (e) { status('Не удалось получить: ' + e.message); accept.disabled = reject.disabled = false; }
      };
      reject.onclick = async () => { try { await ack(o.s); item.remove(); } catch (e) { status(e.message); } };
      item.append(accept, reject); box.appendChild(item);
    }
  }
  async function receive(o, item) {
    status('Расшифровываем передачу…');
    const raw = await G.open(keys.transport.privateKey, o.k, o.s, id);
    const r = await fetch(endpoint('/glink/dl/' + encodeURIComponent(o.s)), { cache: 'no-store' });
    if (!r.ok) throw Error('Зашифрованные файлы ещё не готовы или срок истёк');
    const all = new Uint8Array(await r.arrayBuffer());
    if (all.length < 22 || dec.decode(all.slice(0, 6)) !== 'GSENC1') throw Error('Неверный формат файлов');
    const hash = await c.subtle.digest('SHA-256', G.cat(raw, all.slice(6, 22))); raw.fill(0);
    const key = await c.subtle.importKey('raw', hash, 'AES-GCM', false, ['decrypt']);
    const segments = []; let pos = 22, terminated = false;
    while (pos < all.length) {
      if (pos + 4 > all.length) throw Error('Обрыв передачи');
      const n = new DataView(all.buffer, all.byteOffset + pos, 4).getUint32(0); pos += 4;
      if (n < 28 || n > 65600 || pos + n > all.length) throw Error('Повреждённый кадр');
      const iv = all.slice(pos, pos + 12), ct = all.slice(pos + 12, pos + n); pos += n;
      const piece = new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
      if (!piece.length) { terminated = true; break; } segments.push(piece);
    }
    if (!terminated || pos !== all.length) throw Error('Передача неполная');
    const plain = G.cat(...segments); let cursor = 0;
    function read32() { if (cursor + 4 > plain.length) throw Error('Обрыв описания'); const n = new DataView(plain.buffer, plain.byteOffset + cursor, 4).getUint32(0); cursor += 4; return n; }
    function read64() { if (cursor + 8 > plain.length) throw Error('Обрыв файла'); const n = new DataView(plain.buffer, plain.byteOffset + cursor, 8).getBigUint64(0); cursor += 8; if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Файл слишком большой'); return Number(n); }
    const ml = read32(); if (ml > 4 * 1024 * 1024 || cursor + ml > plain.length) throw Error('Повреждено описание');
    const manifest = JSON.parse(dec.decode(plain.slice(cursor, cursor + ml))); cursor += ml;
    if (!Array.isArray(manifest.files) || manifest.files.length > 10000) throw Error('Повреждён список файлов');
    item.replaceChildren();
    const title = document.createElement('div'); title.textContent = 'Готово · ' + (o.from || 'устройство'); item.appendChild(title);
    for (const f of manifest.files) {
      const n = read64(); if (cursor + n > plain.length) throw Error('Обрыв файла');
      const content = plain.slice(cursor, cursor + n); cursor += n; const expected = read64();
      if (expected !== crc32(content)) throw Error('Контрольная сумма файла не совпала');
      const a = document.createElement('a'); a.className = 'download'; a.textContent = 'Скачать ' + String(f.p || 'файл');
      a.download = String(f.p || 'file').split(/[\\/]/).pop(); a.href = URL.createObjectURL(new Blob([content], { type: f.m || 'application/octet-stream' })); item.appendChild(a);
    }
    for (const field of ['text', 'link', 'fun']) if (manifest[field]) { const p = document.createElement('p'); p.textContent = String(manifest[field]); item.appendChild(p); }
    if (cursor !== plain.length) throw Error('Лишние данные передачи');
    await fetch(endpoint('/glink/done/' + encodeURIComponent(o.s)), { method: 'POST' });
    status('Готово. Нажмите на файлы, чтобы сохранить их.');
  }
  try {
    keys = await loadIdentity(); await authenticate(); await heartbeat(); await refreshDevices(); await poll();
    status('Компьютер готов к защищённой передаче.');
    setInterval(() => heartbeat().catch(e => status('Связь: ' + e.message)), 25000);
    setInterval(() => poll().catch(e => status('Связь: ' + e.message)), 5000);
  } catch (e) { status('Не удалось подключить компьютер: ' + e.message); }
})();
