// ЛОЛ ТУБ v2.2 - ОФФЛАЙН ТЕСТ-РЕЖИМ
// Тестовый аккаунт работает БЕЗ бэкенда: весь API эмулируется в браузере.
// Данные -> localStorage, медиафайлы -> IndexedDB (объектные URL).
(function () {
  const DB_KEY = 'loltube_local_db_v1';
  const FLAG_KEY = 'loltube_test_mode';
  const TOKEN_KEY = 'loltube_local_token';
  const IDB_NAME = 'loltube_files';
  const IDB_STORE = 'blobs';

  const uid = () => 'l' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = () => new Date().toISOString();
  const COLORS = ['#7c3aed', '#22c55e', '#ef4444', '#3b82f6', '#ec4899', '#f97316'];

  // ---------- IndexedDB (файлы) ----------
  const store = {
    dbp: null,
    available: true,
    error: null,
    open() {
      if (this.dbp) return this.dbp;
      this.dbp = new Promise((resolve) => {
        try {
          if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') {
            this.available = false; this.error = 'IndexedDB недоступен в этом браузере';
            return resolve(null);
          }
          const rq = indexedDB.open(IDB_NAME, 1);
          rq.onupgradeneeded = () => {
            const d = rq.result;
            if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
          };
          rq.onsuccess = () => resolve(rq.result);
          rq.onerror = () => { this.available = false; this.error = 'IndexedDB: ' + (rq.error || 'ошибка'); resolve(null); };
        } catch (e) { this.available = false; this.error = String(e && e.message || e); resolve(null); }
      });
      return this.dbp;
    },
    async put(key, blob) {
      const d = await this.open(); if (!d) { this.available = false; return false; }
      return new Promise((res) => {
        const tx = d.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(blob, key);
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
      });
    },
    async get(key) {
      const d = await this.open(); if (!d) return null;
      return new Promise((res) => {
        const tx = d.transaction(IDB_STORE, 'readonly');
        const rq = tx.objectStore(IDB_STORE).get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      });
    },
    async del(key) {
      const d = await this.open(); if (!d) return;
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
    },
    async all() {
      const d = await this.open(); if (!d) return [];
      return new Promise((res) => {
        const tx = d.transaction(IDB_STORE, 'readonly');
        const rq = tx.objectStore(IDB_STORE).getAllKeys();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => res([]);
      });
    },
    async size() {
      const d = await this.open(); if (!d) return 0;
      return new Promise((res) => {
        const tx = d.transaction(IDB_STORE, 'readonly');
        const rq = tx.objectStore(IDB_STORE).getAll();
        rq.onsuccess = () => {
          let s = 0; (rq.result || []).forEach(b => { s += (b && b.size) || 0; });
          res(s);
        };
        rq.onerror = () => res(0);
      });
    }
  };

  const urls = {}; // key -> objectURL

  async function blobToUrl(blob) {
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    return u;
  }

  // ---------- База ----------
  function blank() {
    return {
      users: [], videos: [], comments: [], playlists: [], history: [],
      notifications: [], reports: [],
      live: { isLive: false, hlsUrl: '', title: 'ТВ-ФАНТОМАС', viewerCount: 0 },
      seededAt: null
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return blank();
      const d = JSON.parse(raw);
      const b = blank();
      return Object.assign(b, d);
    } catch (e) { return blank(); }
  }
  function save() { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn('LM save fail', e); } }

  let db = load();
  let me = null; // текущий юзер (объект из db.users)

  function mkUser(nickname, extra) {
    return Object.assign({
      id: uid(), nickname, pin: '000',
      avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
      avatar: null, banner: null, bio: '',
      friends: [], friendRequests: [], subscriptions: [], subscribers: [],
      favorites: [], theme: 'light', accent: 'violet',
      nicknameChangedAt: null, isAdmin: false,
      level: 1, xp: 0, badges: [], totalViews: 0, createdAt: now()
    }, extra || {});
  }

  function ensureTestUser() {
    let u = db.users.find(x => x.nickname === 'test_account');
    if (!u) {
      u = mkUser('test_account', {
        pin: '1', isAdmin: true, level: 99, xp: 9900,
        bio: 'Оффлайн тест-аккаунт. Работает без бэкенда.',
        badges: ['ТЕСТЕР', 'ОФФЛАЙН', 'БЕЗ ЛИМИТОВ'],
        avatarColor: '#7c3aed'
      });
      db.users.push(u);
      save();
    }
    return u;
  }

  function addXP(userId, n) {
    const u = db.users.find(x => x.id === userId); if (!u) return;
    u.xp = (u.xp || 0) + n;
    u.level = Math.floor(u.xp / 100) + 1;
  }
  function notify(userId, type, data) {
    db.notifications.push(Object.assign({ id: uid(), userId, type, read: false, createdAt: now(), data: data || {} }, data || {}));
  }

  function authorOf(v) { return db.users.find(u => u.id === v.authorId); }
  function enrich(v) {
    const a = authorOf(v);
    return Object.assign({}, v, {
      authorColor: a ? a.avatarColor : '#7c3aed',
      authorAvatar: a && a.avatar ? a.avatar : null
    });
  }
  function enrichFull(v) {
    const a = authorOf(v);
    const h = me ? db.history.find(x => x.userId === me.id && x.videoId === v.id) : null;
    return Object.assign(enrich(v), {
      chapters: parseChapters(v.description || ''),
      watchPosition: h ? (h.position || 0) : 0,
      watchDuration: h ? (h.duration || 0) : 0,
      authorBio: a ? a.bio : '',
      authorSubscribers: a ? (a.subscribers || []).length : 0,
      authorIsFriend: me ? !!(a && (a.friends || []).includes(me.id)) : false,
      authorIsSubscribed: me ? !!(me.subscriptions || []).includes(a ? a.id : '') : false
    });
  }
  function parseChapters(desc) {
    const out = [];
    const re = /(\d{1,2}:)?\d{1,2}:\d{2}/g;
    let m;
    while ((m = re.exec(desc)) !== null) {
      const raw = m[0];
      const parts = raw.split(':').map(Number);
      const time = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      const after = desc.slice(m.index + raw.length).trim().split('\n')[0].slice(0, 40);
      out.push({ raw, time, label: after || 'Глава' });
    }
    return out;
  }

  function pubUser(u) {
    return {
      id: u.id, nickname: u.nickname, avatarColor: u.avatarColor,
      avatar: u.avatar || null, banner: u.banner || null, bio: u.bio,
      friends: u.friends, friendRequests: u.friendRequests,
      subscriptions: u.subscriptions, subscribers: u.subscribers,
      theme: u.theme, accent: u.accent, nicknameChangedAt: u.nicknameChangedAt,
      isAdmin: u.isAdmin, level: u.level, xp: u.xp, badges: u.badges,
      createdAt: u.createdAt, favorites: u.favorites || []
    };
  }

  // ---------- Генератор демо-контента ----------
  function coverSvg(title, sub, c1, c2) {
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <rect width="480" height="480" fill="url(#g)"/>
      <circle cx="240" cy="240" r="120" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="3"/>
      <circle cx="240" cy="240" r="80" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
      <circle cx="240" cy="240" r="14" fill="rgba(255,255,255,.8)"/>
      <text x="240" y="400" font-family="monospace" font-size="30" font-weight="bold" fill="white" text-anchor="middle">${title}</text>
      <text x="240" y="434" font-family="monospace" font-size="18" fill="rgba(255,255,255,.85)" text-anchor="middle">${sub}</text>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  // Простой синтез WAV (без внешних файлов) - чтобы демо-треки реально играли
  function makeWav(seconds, notes, sr) {
    sr = sr || 16000;
    const total = Math.floor(sr * seconds);
    const pcm = new Int16Array(total);
    let pos = 0;
    notes.forEach(n => {
      const len = Math.floor(sr * n.d);
      for (let i = 0; i < len && pos < total; i++, pos++) {
        const t = i / sr;
        const env = Math.min(1, i / (sr * 0.01)) * Math.min(1, (len - i) / (sr * 0.05));
        const s = Math.sin(2 * Math.PI * n.f * t) * 0.5 + Math.sin(2 * Math.PI * n.f * 2 * t) * 0.12;
        pcm[pos] = Math.max(-32767, Math.min(32767, s * env * 20000));
      }
    });
    const buf = new ArrayBuffer(44 + total * 2);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + total * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, total * 2, true);
    for (let i = 0; i < total; i++) dv.setInt16(44 + i * 2, pcm[i], true);
    return new Blob([buf], { type: 'audio/wav' });
  }
  const N = { C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.00, A: 440.00, B: 493.88, C2: 523.25 };

  // Генерирует НАСТОЯЩИЙ видеофайл прямо в браузере (canvas + MediaRecorder),
  // чтобы можно было проверить загрузку видео без внешних файлов.
  async function makeTestVideo(seconds) {
    seconds = seconds || 4;
    const canRecord = typeof document !== 'undefined'
      && typeof MediaRecorder !== 'undefined'
      && document.createElement('canvas').captureStream;
    if (canRecord) {
      try {
        const cv = document.createElement('canvas');
        cv.width = 320; cv.height = 180;
        const ctx = cv.getContext('2d');
        const stream = cv.captureStream(25);
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
          : MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 600000 });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' })); });
        rec.start();
        let f = 0;
        await new Promise((res) => {
          const iv = setInterval(() => {
            f++;
            const t = f / 25;
            ctx.fillStyle = 'hsl(' + Math.round((t * 80) % 360) + ',70%,20%)';
            ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.fillStyle = '#a78bfa';
            ctx.fillRect(Math.round((t * 70) % (cv.width - 40)), 70, 40, 40);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 16px monospace';
            ctx.fillText('ТЕСТ ЗАГРУЗКИ ' + t.toFixed(1) + 's', 10, 30);
            if (t >= seconds) { clearInterval(iv); try { rec.stop(); } catch (e) {} res(); }
          }, 40);
        });
        const blob = await done;
        if (blob && blob.size > 1000) return { blob, name: 'test-video.webm', type: 'video/webm', real: true };
      } catch (e) { /* падаем в запасной вариант */ }
    }
    // запасной вариант: реальный WAV (проверяет весь пайплайн загрузки без видеокодеков)
    const wav = makeWav(seconds, [
      { f: N.C, d: .5 }, { f: N.E, d: .5 }, { f: N.G, d: .5 }, { f: N.C2, d: .8 }
    ]);
    return { blob: wav, name: 'test-track.wav', type: 'audio/wav', real: false };
  }

  // Полный прогон загрузки: генерим файл -> FormData -> тот же код, что и у обычной загрузки
  async function testUploadVideo(onProgress) {
    await LM.ready; need();
    const gen = await makeTestVideo(4);
    const FileCtor = typeof File !== 'undefined' ? File : null;
    const file = FileCtor ? new FileCtor([gen.blob], gen.name, { type: gen.type }) : gen.blob;
    const fd = new FormData();
    fd.append('video', file);
    fd.append('title', 'ТЕСТ ЗАГРУЗКИ ВИДЕО');
    fd.append('description', 'Автоматическая проверка загрузки.\n00:00 старт\n00:02 середина');
    fd.append('contentType', gen.real ? 'video' : 'music');
    const v = await upload(fd, onProgress);
    v._testInfo = gen.real ? 'настоящий webm из MediaRecorder' : 'webm недоступен в этом браузере, загружен wav';
    return v;
  }

  async function seedDemo() {
    ensureTestUser();
    const t = ensureTestUser();

    // артисты
    let a1 = db.users.find(u => u.nickname === 'artist_vibe');
    if (!a1) { a1 = mkUser('artist_vibe', { bio: 'Биты и синты. Оффлайн артист.', badges: ['АРТИСТ'], avatarColor: '#ec4899', level: 12, xp: 1200 }); db.users.push(a1); }
    let a2 = db.users.find(u => u.nickname === 'dj_phantom');
    if (!a2) { a2 = mkUser('dj_phantom', { bio: 'ТВ-ФАНТОМАС в эфире', badges: ['АРТИСТ', 'СТРИМЕР'], avatarColor: '#22c55e', level: 24, xp: 2400 }); db.users.push(a2); }

    const exists = (title) => db.videos.some(v => v.title === title);
    const add = (o) => { db.videos.push(o); };
    const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

    if (!exists('Фантомас открывает эфир')) {
      add({
        id: uid(), title: 'Фантомас открывает эфир', description: 'Тестовое видео оффлайн режима.\n00:00 интро\n00:05 основная часть',
        filename: null, contentType: 'video', thumbnail: coverSvg('ВИДЕО', 'test_account', '#0f172a', '#7c3aed'),
        authorId: t.id, authorNickname: t.nickname, createdAt: daysAgo(1), views: 42, viewedBy: [],
        likes: [a1.id], dislikes: [], downloads: 3, tags: ['тест'], chapters: []
      });
    }
    if (!exists('Осенний кадр')) {
      add({
        id: uid(), title: 'Осенний кадр', description: 'Статичная картинка', filename: null,
        contentType: 'image', thumbnail: coverSvg('ФОТО', 'pixel', '#f97316', '#7c3aed'),
        authorId: t.id, authorNickname: t.nickname, createdAt: daysAgo(2), views: 15, viewedBy: [],
        likes: [], dislikes: [], downloads: 0, tags: [], chapters: []
      });
    }

    // ТРЕКИ АРТИСТА (музыка со статичной обложкой)
    const trackDefs = [
      {
        title: 'Ночной вайб', artist: 'artist_vibe', album: 'Offline EP',
        notes: [{ f: N.A, d: .35 }, { f: N.C2, d: .35 }, { f: N.E, d: .35 }, { f: N.G, d: .5 }, { f: N.A, d: .35 }, { f: N.C2, d: .35 }, { f: N.B, d: .7 }],
        cover: ['#7c3aed', '#ec4899'], sub: 'artist_vibe'
      },
      {
        title: 'Фантомас FM', artist: 'dj_phantom', album: 'Live Sessions',
        notes: [{ f: N.C, d: .3 }, { f: N.E, d: .3 }, { f: N.G, d: .3 }, { f: N.C2, d: .6 }, { f: N.G, d: .3 }, { f: N.E, d: .3 }, { f: N.C, d: .6 }],
        cover: ['#22c55e', '#0ea5e9'], sub: 'dj_phantom'
      },
      {
        title: 'Пиксель дождь', artist: 'artist_vibe', album: 'Offline EP',
        notes: [{ f: N.D, d: .25 }, { f: N.F, d: .25 }, { f: N.A, d: .25 }, { f: N.D, d: .5 }, { f: N.F, d: .5 }, { f: N.A, d: .8 }],
        cover: ['#3b82f6', '#7c3aed'], sub: 'artist_vibe'
      }
    ];
    for (const td of trackDefs) {
      if (exists(td.title)) continue;
      const au = db.users.find(u => u.nickname === td.artist);
      const wav = makeWav(3.2, td.notes);
      const key = 'f_' + uid();
      await store.put(key, wav);
      urls[key] = await blobToUrl(wav);
      const cover = coverSvg(td.title, td.sub, td.cover[0], td.cover[1]);
      add({
        id: uid(), title: td.title, description: 'Трек артиста • альбом ' + td.album,
        filename: 'idb:' + key, contentType: 'artist_music',
        thumbnail: cover, cover: cover,
        artist: td.artist, album: td.album, trackArtist: td.artist,
        authorId: au.id, authorNickname: au.nickname, createdAt: daysAgo(1 + Math.random() * 3),
        views: Math.floor(Math.random() * 200) + 10, viewedBy: [], likes: [], dislikes: [],
        downloads: Math.floor(Math.random() * 8), tags: ['музыка', td.artist], chapters: [],
        size: wav.size, mimetype: 'audio/wav'
      });
    }

    // обычный музыкальный трек (без артиста)
    if (!exists('Просто бит')) {
      const wav = makeWav(2.4, [{ f: N.E, d: .4 }, { f: N.G, d: .4 }, { f: N.B, d: .8 }]);
      const key = 'f_' + uid();
      await store.put(key, wav);
      urls[key] = await blobToUrl(wav);
      add({
        id: uid(), title: 'Просто бит', description: 'Обычная музыка без обложки артиста',
        filename: 'idb:' + key, contentType: 'music', thumbnail: null, cover: null,
        authorId: t.id, authorNickname: t.nickname, createdAt: daysAgo(4),
        views: 7, viewedBy: [], likes: [], dislikes: [], downloads: 0, tags: [], chapters: [],
        size: wav.size, mimetype: 'audio/wav'
      });
    }

    // комментарии и уведомления
    if (!db.comments.length) {
      const first = db.videos.find(v => v.contentType === 'artist_music');
      if (first) {
        db.comments.push({ id: uid(), videoId: first.id, authorId: a2.id, authorNickname: 'dj_phantom', text: 'Обложка топ 🔥', replyTo: null, likes: [], createdAt: now() });
      }
    }
    if (!db.notifications.length) {
      notify(t.id, 'new_subscriber', { from: 'dj_phantom' });
      notify(t.id, 'comment', { from: 'artist_vibe', text: 'круто' });
    }
    // подписки
    if (!(t.subscriptions || []).includes(a1.id)) { t.subscriptions.push(a1.id); a1.subscribers.push(t.id); }

    db.seededAt = now();
    save();
    return { videos: db.videos.length, users: db.users.length };
  }

  // ---------- Роутер API ----------
  function parseUrl(path) {
    const qi = path.indexOf('?');
    const p = (qi >= 0 ? path.slice(0, qi) : path).replace(/\/+$/, '') || '/';
    const q = {};
    if (qi >= 0) path.slice(qi + 1).split('&').forEach(kv => {
      if (!kv) return;
      const i = kv.indexOf('=');
      q[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    });
    return { p, q };
  }

  function fail(msg) { const e = new Error(msg); e.local = true; throw e; }

  async function request(method, url, body) {
    await LM.ready;
    method = (method || 'GET').toUpperCase();
    let payload = body;
    if (typeof payload === 'string' && payload) { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    payload = payload || {};

    const { p, q } = parseUrl(url);
    const seg = p.split('/').filter(Boolean); // ['api','videos',...]
    const r2 = seg.slice(1); // без 'api'
    const need = () => { if (!me) fail('Нет токена'); return me; };
    const findVideo = (id) => db.videos.find(v => v.id === id);

    // ---- config ----
    if (p === '/api/config') {
      return {
        name: 'LolTube', version: '2.2', local: true,
        developer: 'offline-test-mode',
        features: ['offline', 'friends', 'playlists', 'live', 'search', 'themes', 'admin', 'history', 'favorites', 'chapters', 'download', 'loop', 'screenshot', 'artist_music'],
        storage: { cloudinary: false, persistent: true, local: true }
      };
    }

    // ---- auth ----
    if (p === '/api/test-login' && method === 'POST') {
      const u = ensureTestUser();
      me = u;
      localStorage.setItem(TOKEN_KEY, 'local-test-token');
      save();
      return { token: 'local-test-token', user: pubUser(u) };
    }
    if (p === '/api/login' && method === 'POST') {
      const u = db.users.find(x => x.nickname.toLowerCase() === String(payload.nickname || '').toLowerCase());
      if (!u) fail('Юзер не найден');
      if (String(payload.pin) !== String(u.pin)) fail('Неверный пин');
      me = u;
      localStorage.setItem(TOKEN_KEY, 'local-' + u.id);
      return { token: 'local-' + u.id, user: pubUser(u) };
    }
    if (p === '/api/register' && method === 'POST') {
      const nick = String(payload.nickname || '').trim();
      if (!nick) fail('Ник обязателен');
      if (db.users.some(u => u.nickname.toLowerCase() === nick.toLowerCase())) fail('Ник занят');
      const u = mkUser(nick, { pin: String(payload.pin || '000') });
      db.users.push(u); me = u; save();
      return { token: 'local-' + u.id, user: pubUser(u) };
    }
    if (p === '/api/me' && method === 'GET') { need(); return pubUser(me); }
    if (p === '/api/me' && method === 'PUT') {
      need();
      ['bio', 'theme', 'accent'].forEach(k => { if (payload[k] !== undefined) me[k] = payload[k]; });
      save(); return pubUser(me);
    }
    if (p === '/api/me/change-nickname' && method === 'POST') {
      need();
      const nn = String(payload.nickname || '').trim();
      if (!nn) fail('Пусто');
      if (db.users.some(u => u.id !== me.id && u.nickname.toLowerCase() === nn.toLowerCase())) fail('Ник занят');
      const last = me.nicknameChangedAt ? new Date(me.nicknameChangedAt).getTime() : 0;
      if (Date.now() - last < 86400000) fail('Смена ника раз в сутки');
      me.nickname = nn; me.nicknameChangedAt = now(); save();
      return { new: nn };
    }

    // ---- videos list ----
    if (p === '/api/videos' && method === 'GET') {
      let list = db.videos.slice();
      const type = q.type;
      if (type && type !== 'all') {
        if (type === 'music') list = list.filter(v => v.contentType === 'music' || v.contentType === 'artist_music');
        else list = list.filter(v => v.contentType === type);
      }
      const sort = q.sort || 'new';
      if (sort === 'popular') list.sort((a, b) => (b.views || 0) - (a.views || 0));
      else if (sort === 'old') list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      else list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return list.map(enrich);
    }

    // ---- like status / like / download / comments ----
    let m = p.match(/^\/api\/videos\/([^/]+)\/like-status$/);
    if (m && method === 'GET') {
      const v = findVideo(m[1]); if (!v) fail('Видео не найдено');
      const id = me ? me.id : 'anon';
      return { likes: (v.likes || []).length, dislikes: (v.dislikes || []).length, userLiked: (v.likes || []).includes(id), userDisliked: (v.dislikes || []).includes(id) };
    }
    m = p.match(/^\/api\/videos\/([^/]+)\/like$/);
    if (m && method === 'POST') {
      need();
      const v = findVideo(m[1]); if (!v) fail('Видео не найдено');
      v.likes = (v.likes || []).filter(x => x !== me.id);
      v.dislikes = (v.dislikes || []).filter(x => x !== me.id);
      const type = payload.type || 'like';
      if (type === 'like') v.likes.push(me.id); else if (type === 'dislike') v.dislikes.push(me.id);
      if (type === 'like' && v.authorId !== me.id) notify(v.authorId, 'like', { from: me.nickname, videoId: v.id });
      save();
      return { likes: v.likes.length, dislikes: v.dislikes.length, userLiked: v.likes.includes(me.id), userDisliked: v.dislikes.includes(me.id) };
    }
    m = p.match(/^\/api\/videos\/([^/]+)\/download$/);
    if (m && method === 'POST') {
      const v = findVideo(m[1]); if (!v) fail('Не найдено');
      v.downloads = (v.downloads || 0) + 1; save();
      return { downloads: v.downloads };
    }
    m = p.match(/^\/api\/videos\/([^/]+)\/comments$/);
    if (m && method === 'GET') {
      return db.comments.filter(c => c.videoId === m[1])
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(c => {
          const a = db.users.find(u => u.id === c.authorId);
          return Object.assign({}, c, { authorColor: a ? a.avatarColor : '#7c3aed', authorAvatar: a && a.avatar ? a.avatar : null, authorLevel: a ? a.level : 1 });
        });
    }
    if (m && method === 'POST') {
      need();
      const v = findVideo(m[1]); if (!v) fail('Видео не найдено');
      const text = String(payload.text || '').trim();
      if (!text) fail('Пусто');
      const c = { id: uid(), videoId: v.id, authorId: me.id, authorNickname: me.nickname, text, replyTo: payload.replyTo || null, likes: [], createdAt: now() };
      db.comments.push(c);
      if (v.authorId !== me.id) notify(v.authorId, 'comment', { from: me.nickname, videoId: v.id, text: text.slice(0, 50) });
      addXP(me.id, 2); save();
      return Object.assign({}, c, { authorColor: me.avatarColor, authorAvatar: me.avatar });
    }
    m = p.match(/^\/api\/comments\/([^/]+)\/like$/);
    if (m && method === 'POST') {
      need();
      const c = db.comments.find(x => x.id === m[1]); if (!c) fail('Не найден');
      c.likes = c.likes || [];
      if (c.likes.includes(me.id)) c.likes = c.likes.filter(x => x !== me.id); else c.likes.push(me.id);
      save();
      return { likes: c.likes.length, userLiked: c.likes.includes(me.id) };
    }

    // ---- позиция просмотра («продолжить с того же места») ----
    m = p.match(/^\/api\/videos\/([^/]+)\/watch-position$/);
    if (m && method === 'POST') {
      need();
      const v = findVideo(m[1]); if (!v) fail('Видео не найдено');
      const position = Number(payload.position) || 0;
      const duration = Number(payload.duration) || 0;
      let rec = db.history.find(h => h.userId === me.id && h.videoId === v.id);
      if (!rec) { rec = { id: uid(), userId: me.id, videoId: v.id, watchedAt: now() }; db.history.push(rec); }
      rec.position = Math.max(0, position);
      if (duration > 0) rec.duration = duration;
      rec.watchedAt = now();
      save();
      return { ok: true, position: rec.position, duration: rec.duration || 0 };
    }

    // ---- single video / delete ----
    m = p.match(/^\/api\/videos\/([^/]+)$/);
    if (m && method === 'GET') {
      const v = findVideo(m[1]); if (!v) fail('Видео не найдено');
      const viewerId = me ? me.id : 'anon';
      if (v.authorId !== viewerId && !(v.viewedBy || []).includes(viewerId)) {
        v.viewedBy = v.viewedBy || []; v.viewedBy.push(viewerId); v.views = v.viewedBy.length;
        if (me) {
          db.history = db.history.filter(h => !(h.userId === me.id && h.videoId === v.id));
          db.history.push({ id: uid(), userId: me.id, videoId: v.id, watchedAt: now() });
        }
        addXP(v.authorId, 1);
        save();
      }
      return enrichFull(v);
    }
    if (m && method === 'DELETE') {
      need();
      const v = findVideo(m[1]); if (!v) fail('Не найдено');
      if (v.authorId !== me.id && !me.isAdmin) fail('Не твоё');
      if (typeof v.filename === 'string' && v.filename.startsWith('idb:')) { store.del(v.filename.slice(4)); }
      db.videos = db.videos.filter(x => x.id !== v.id);
      db.comments = db.comments.filter(c => c.videoId !== v.id);
      save();
      return { ok: true };
    }

    // ---- user videos ----
    m = p.match(/^\/api\/users\/([^/]+)\/videos$/);
    if (m && method === 'GET') {
      const nick = decodeURIComponent(m[1]);
      const u = db.users.find(x => x.nickname.toLowerCase() === nick.toLowerCase());
      if (!u) fail('Юзер не найден');
      const vids = db.videos.filter(v => v.authorId === u.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return {
        user: {
          id: u.id, nickname: u.nickname, avatarColor: u.avatarColor, avatar: u.avatar, banner: u.banner,
          bio: u.bio, subscribers: (u.subscribers || []).length, subscriptions: (u.subscriptions || []).length,
          friends: (u.friends || []).length, level: u.level, xp: u.xp, badges: u.badges,
          totalViews: u.totalViews || 0, createdAt: u.createdAt, isAdmin: u.isAdmin
        },
        videos: vids.map(enrich)
      };
    }

    // ---- search ----
    if (p === '/api/search' && method === 'GET') {
      const s = String(q.q || '').toLowerCase().trim();
      if (!s) return { videos: [], users: [] };
      const videos = db.videos.filter(v =>
        v.title.toLowerCase().includes(s) ||
        (v.description || '').toLowerCase().includes(s) ||
        v.authorNickname.toLowerCase().includes(s) ||
        (v.artist || '').toLowerCase().includes(s) ||
        (v.album || '').toLowerCase().includes(s) ||
        (v.tags || []).some(t => t.toLowerCase().includes(s))
      ).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 20).map(enrich);
      const users = db.users.filter(u => u.nickname.toLowerCase().includes(s) || (u.bio || '').toLowerCase().includes(s))
        .slice(0, 10).map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar, bio: u.bio, subscribers: (u.subscribers || []).length }));
      return { videos, users };
    }

    // ---- friends ----
    if (p === '/api/friends' && method === 'GET') {
      need();
      const friends = db.users.filter(u => (me.friends || []).includes(u.id)).map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar, avatarColor: u.avatarColor, level: u.level }));
      const requests = db.users.filter(u => (me.friendRequests || []).includes(u.id)).map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar }));
      return { friends, requests };
    }
    m = p.match(/^\/api\/friends\/request\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      const t = db.users.find(u => u.nickname.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
      if (!t) fail('Юзер не найден');
      if (t.id === me.id) fail('Себя нельзя');
      if (!(t.friendRequests || []).includes(me.id)) { t.friendRequests = t.friendRequests || []; t.friendRequests.push(me.id); }
      notify(t.id, 'friend_request', { from: me.nickname });
      save(); return { ok: true };
    }
    m = p.match(/^\/api\/friends\/accept\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      const t = db.users.find(u => u.nickname.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
      if (!t) fail('Юзер не найден');
      me.friendRequests = (me.friendRequests || []).filter(id => id !== t.id);
      me.friends = me.friends || []; if (!me.friends.includes(t.id)) me.friends.push(t.id);
      t.friends = t.friends || []; if (!t.friends.includes(me.id)) t.friends.push(me.id);
      save(); return { ok: true };
    }
    m = p.match(/^\/api\/friends\/decline\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      const t = db.users.find(u => u.nickname.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
      if (t) me.friendRequests = (me.friendRequests || []).filter(id => id !== t.id);
      save(); return { ok: true };
    }
    m = p.match(/^\/api\/friends\/([^/]+)$/);
    if (m && method === 'DELETE') {
      need();
      const t = db.users.find(u => u.nickname.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
      if (t) {
        me.friends = (me.friends || []).filter(id => id !== t.id);
        t.friends = (t.friends || []).filter(id => id !== me.id);
      }
      save(); return { ok: true };
    }

    // ---- subscriptions ----
    m = p.match(/^\/api\/subscribe\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      const t = db.users.find(u => u.nickname.toLowerCase() === decodeURIComponent(m[1]).toLowerCase());
      if (!t) fail('Юзер не найден');
      if (t.id === me.id) fail('Себя нельзя');
      me.subscriptions = me.subscriptions || [];
      if (me.subscriptions.includes(t.id)) {
        me.subscriptions = me.subscriptions.filter(id => id !== t.id);
        t.subscribers = (t.subscribers || []).filter(id => id !== me.id);
        save(); return { subscribed: false };
      }
      me.subscriptions.push(t.id);
      t.subscribers = t.subscribers || []; t.subscribers.push(me.id);
      notify(t.id, 'new_subscriber', { from: me.nickname });
      save(); return { subscribed: true };
    }
    if (p === '/api/subscriptions' && method === 'GET') {
      need();
      return db.users.filter(u => (me.subscriptions || []).includes(u.id))
        .map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar, subscribers: (u.subscribers || []).length }));
    }

    // ---- playlists ----
    if (p === '/api/playlists' && method === 'GET') {
      let list = db.playlists.slice();
      if (q.userId) list = list.filter(pl => pl.authorId === q.userId);
      else if (me) list = list.filter(pl => pl.authorId === me.id || pl.isPublic !== false);
      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return list;
    }
    if (p === '/api/playlists' && method === 'POST') {
      need();
      const title = String(payload.title || '').trim();
      if (!title) fail('Название обязательно');
      const pl = { id: uid(), title, description: String(payload.description || '').trim(), authorId: me.id, authorNickname: me.nickname, videos: [], isPublic: payload.isPublic !== false, createdAt: now() };
      db.playlists.push(pl); save();
      return pl;
    }
    m = p.match(/^\/api\/playlists\/([^/]+)\/add\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      const pl = db.playlists.find(x => x.id === m[1]); if (!pl) fail('Плейлист не найден');
      if (!pl.videos.includes(m[2])) pl.videos.push(m[2]);
      save(); return pl;
    }
    m = p.match(/^\/api\/playlists\/([^/]+)\/remove\/([^/]+)$/);
    if (m && method === 'DELETE') {
      need();
      const pl = db.playlists.find(x => x.id === m[1]); if (!pl) fail('Плейлист не найден');
      pl.videos = pl.videos.filter(id => id !== m[2]); save(); return pl;
    }
    m = p.match(/^\/api\/playlists\/([^/]+)$/);
    if (m && method === 'DELETE') {
      need();
      db.playlists = db.playlists.filter(x => x.id !== m[1]); save(); return { ok: true };
    }

    // ---- history / favorites ----
    if (p === '/api/history' && method === 'GET') {
      need();
      return db.history.filter(h => h.userId === me.id)
        .sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt)).slice(0, 50)
        .map(h => { const v = findVideo(h.videoId); return v ? Object.assign(enrich(v), { watchedAt: h.watchedAt, position: h.position || 0, duration: h.duration || 0 }) : null; })
        .filter(Boolean);
    }
    if (p === '/api/history' && method === 'DELETE') {
      need(); db.history = db.history.filter(h => h.userId !== me.id); save(); return { ok: true };
    }
    if (p === '/api/favorites' && method === 'GET') {
      need();
      const fav = me.favorites || [];
      return db.videos.filter(v => fav.includes(v.id)).map(enrich);
    }
    m = p.match(/^\/api\/favorites\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      me.favorites = me.favorites || [];
      if (me.favorites.includes(m[1])) { me.favorites = me.favorites.filter(id => id !== m[1]); save(); return { favorited: false }; }
      me.favorites.push(m[1]); save(); return { favorited: true };
    }

    // ---- notifications ----
    if (p === '/api/notifications' && method === 'GET') {
      need();
      return db.notifications.filter(n => n.userId === me.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30);
    }
    if (p === '/api/notifications/read' && method === 'POST') {
      need(); db.notifications.filter(n => n.userId === me.id).forEach(n => n.read = true); save(); return { ok: true };
    }

    // ---- reports ----
    m = p.match(/^\/api\/report\/([^/]+)$/);
    if (m && method === 'POST') {
      need();
      db.reports.push({ id: uid(), videoId: m[1], reporterId: me.id, reason: payload.reason || 'other', createdAt: now() });
      save(); return { ok: true };
    }

    // ---- live ----
    if (p === '/api/live' && method === 'GET') return Object.assign({}, db.live);
    if (p === '/api/live' && method === 'POST') {
      need();
      if (payload.isLive !== undefined) db.live.isLive = payload.isLive;
      if (payload.hlsUrl !== undefined) db.live.hlsUrl = payload.hlsUrl;
      if (payload.title !== undefined) db.live.title = payload.title;
      save(); return Object.assign({}, db.live);
    }
    if (p === '/api/live/view' && method === 'POST') {
      db.live.viewerCount = (db.live.viewerCount || 0) + 1; save();
      return { viewerCount: db.live.viewerCount };
    }

    // ---- admin ----
    if (p === '/api/admin/stats' && method === 'GET') {
      need(); if (!me.isAdmin) fail('Только админ');
      return {
        users: db.users.length, videos: db.videos.length, comments: db.comments.length,
        playlists: db.playlists.length, reports: db.reports.length,
        live: db.live, local: true,
        storage: { mode: 'IndexedDB (браузер)', files: (await store.all()).length, bytes: await store.size() }
      };
    }
    if (p === '/api/admin/users' && method === 'GET') {
      need(); if (!me.isAdmin) fail('Только админ');
      return db.users.map(u => ({ id: u.id, nickname: u.nickname, level: u.level, xp: u.xp, isAdmin: u.isAdmin, createdAt: u.createdAt, videos: db.videos.filter(v => v.authorId === u.id).length }));
    }
    if (p === '/api/admin/videos' && method === 'GET') {
      need(); if (!me.isAdmin) fail('Только админ');
      return db.videos.map(enrich);
    }
    m = p.match(/^\/api\/admin\/videos\/([^/]+)$/);
    if (m && method === 'DELETE') {
      need(); if (!me.isAdmin) fail('Только админ');
      const v = findVideo(m[1]);
      if (v && typeof v.filename === 'string' && v.filename.startsWith('idb:')) store.del(v.filename.slice(4));
      db.videos = db.videos.filter(x => x.id !== m[1]);
      db.comments = db.comments.filter(c => c.videoId !== m[1]);
      save(); return { ok: true };
    }
    m = p.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (m && method === 'DELETE') {
      need(); if (!me.isAdmin) fail('Только админ');
      if (m[1] === me.id) fail('Себя нельзя');
      db.users = db.users.filter(u => u.id !== m[1]);
      db.videos = db.videos.filter(v => v.authorId !== m[1]);
      save(); return { ok: true };
    }

    fail('Оффлайн: нет такого запроса ' + method + ' ' + p);
  }

  // ---------- Загрузка файлов ----------
  async function upload(formData, onProgress) {
    await LM.ready;
    need();
    const file = formData.get('video') || formData.get('content');
    if (!file || typeof file === 'string') fail('Файл обязателен');
    const title = String(formData.get('title') || '').trim();
    if (!title) fail('Название обязательно');

    let type = formData.get('contentType') || 'video';
    if (type === 'auto') {
      type = file.type.startsWith('image/') ? (file.type === 'image/gif' ? 'gif' : 'image')
        : file.type.startsWith('audio/') ? 'music' : 'video';
    }

    // прогресс (эмуляция)
    let pct = 0;
    const tick = setInterval(() => {
      pct = Math.min(92, pct + Math.random() * 18);
      if (onProgress) onProgress(pct);
    }, 60);

    const key = 'f_' + uid();
    await store.put(key, file);
    urls[key] = await blobToUrl(file);

    let thumbKey = null;
    const thumb = formData.get('thumbnail');
    const cover = formData.get('cover');
    let thumbRef = null;
    const imgFile = (thumb && typeof thumb !== 'string') ? thumb : ((cover && typeof cover !== 'string') ? cover : null);
    if (imgFile) {
      thumbKey = 'f_' + uid();
      await store.put(thumbKey, imgFile);
      urls[thumbKey] = await blobToUrl(imgFile);
      thumbRef = 'idb:' + thumbKey;
    }

    clearInterval(tick);
    if (onProgress) onProgress(100);

    const v = {
      id: uid(), title,
      description: String(formData.get('description') || '').trim(),
      filename: 'idb:' + key,
      originalName: file.name, size: file.size, mimetype: file.type,
      contentType: type,
      thumbnail: thumbRef, cover: thumbRef,
      artist: (formData.get('artist') || '').toString().trim() || null,
      album: (formData.get('album') || '').toString().trim() || null,
      authorId: me.id, authorNickname: me.nickname, createdAt: now(),
      views: 0, viewedBy: [], likes: [], dislikes: [], downloads: 0,
      tags: (formData.get('tags') || '').toString().split(',').map(s => s.trim()).filter(Boolean),
      chapters: parseChapters(String(formData.get('description') || ''))
    };
    db.videos.push(v);
    (db.users.find(u => u.id === me.id).subscribers || []).forEach(sid => notify(sid, 'new_video', { author: me.nickname, videoId: v.id, title: v.title }));
    addXP(me.id, 10);
    save();
    return v;
  }

  // аватар / баннер
  async function setMedia(kind, formData) {
    await LM.ready; need();
    const file = formData.get(kind);
    if (!file || typeof file === 'string') fail('Файл не загружен');
    const key = 'f_' + uid();
    await store.put(key, file);
    urls[key] = await blobToUrl(file);
    me[kind] = 'idb:' + key;
    save();
    return kind === 'avatar' ? { avatar: 'idb:' + key } : { banner: 'idb:' + key };
  }

  function need() { if (!me) fail('Нет токена'); return me; }

  // ---------- Публичный API ----------
  const LM = {
    version: '2.2',
    ready: (async () => {
      await store.open();
      // прогрев объектных URL для всех сохранённых файлов
      const keys = await store.all();
      for (const k of keys) {
        const b = await store.get(k);
        if (b) urls[k] = URL.createObjectURL(b);
      }
      // восстановление сессии
      if (localStorage.getItem(FLAG_KEY) === '1') {
        const u = db.users.find(x => x.nickname === 'test_account');
        if (u) me = u;
      }
    })(),
    isEnabled() { return localStorage.getItem(FLAG_KEY) === '1'; },
    enable() { localStorage.setItem(FLAG_KEY, '1'); },
    disable() { localStorage.removeItem(FLAG_KEY); localStorage.removeItem(TOKEN_KEY); me = null; },
    isLocalPath(p) { return typeof p === 'string' && (p.startsWith('idb:') || p.startsWith('data:') || p.startsWith('blob:')); },
    url(p) {
      if (p.startsWith('data:') || p.startsWith('blob:')) return p;
      const k = p.slice(4);
      return urls[k] || '';
    },
    request, upload, setMedia, seedDemo, testUploadVideo, makeTestVideo,
    user() { return me; },
    async reset() {
      const keys = await store.all();
      for (const k of keys) { await store.del(k); if (urls[k]) { URL.revokeObjectURL(urls[k]); delete urls[k]; } }
      Object.keys(urls).forEach(k => { URL.revokeObjectURL(urls[k]); delete urls[k]; });
      db = blank(); me = null;
      localStorage.removeItem(DB_KEY);
      this.disable();
      return { ok: true };
    },
    async storageInfo() {
      const bytes = await store.size();
      const files = (await store.all()).length;
      let lsBytes = 0;
      try { lsBytes = (localStorage.getItem(DB_KEY) || '').length * 2; } catch (e) { }
      const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
      return { files, mediaSize: mb(bytes), dbSize: mb(lsBytes), videos: db.videos.length, users: db.users.length, idbOk: store.available !== false, idbError: store.error };
    },
    counts() { return { videos: db.videos.length, users: db.users.length, comments: db.comments.length }; }
  };

  window.LM = LM;
})();
