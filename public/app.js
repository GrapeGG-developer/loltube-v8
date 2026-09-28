// ЛОЛ ТУБ v2 - MOBILE ONLY, FRIENDS, PLAYLISTS, LIVE TV-FANTOMAS, SEARCH, ADMIN
const LS_TOKEN = 'loltube_token_v3';
const LS_API = 'loltube_api_base';
const LS_THEME = 'loltube_theme';
const LS_ACCENT = 'loltube_accent';

function normalizeApiBase(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/^\[|\]$/g,'').replace(/\(.*\)$/,'').trim();
  s = s.replace(/^['"]+|['"]+$/g,'').trim();
  s = s.replace(/\/$/, '');
  if (!s) return '';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return `http://${s}:3000`;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(s)) return `http://${s}`;
  if (!s.startsWith('http://') && !s.startsWith('https://')) {
    if (s.includes('.') || s.includes(':')) return `http://${s}`;
  }
  return s.replace(/\/$/, '');
}
function getApiBase() {
  const fromLS = localStorage.getItem(LS_API);
  if (fromLS) return normalizeApiBase(fromLS);
  if (window.LOLTUBE_API_BASE) return normalizeApiBase(window.LOLTUBE_API_BASE);
  return '';
}
function isLocalMedia(p) {
  return typeof p === 'string' && (p.startsWith('idb:') || p.startsWith('data:') || p.startsWith('blob:'));
}
function apiUrl(p) {
  // оффлайн тест-режим: файлы лежат в IndexedDB браузера
  if (isLocalMedia(p)) return window.LM ? LM.url(p) : p;
  const base = getApiBase();
  return base ? base + p : p;
}
function localMode() { return typeof LM !== 'undefined' && LM.isEnabled(); }
function getToken() { return localStorage.getItem(LS_TOKEN); }
function setToken(t) { localStorage.setItem(LS_TOKEN, t); }
function clearToken() { localStorage.removeItem(LS_TOKEN); }

async function apiFetch(url, opts={}) {
  // ОФФЛАЙН ТЕСТ-РЕЖИМ: весь API эмулируется в браузере, бэкенд не нужен
  if (localMode()) {
    if (opts.body instanceof FormData) {
      if (url.indexOf('/api/me/avatar') >= 0) return LM.setMedia('avatar', opts.body);
      if (url.indexOf('/api/me/banner') >= 0) return LM.setMedia('banner', opts.body);
      return LM.upload(opts.body);
    }
    return LM.request(opts.method || 'GET', url, opts.body);
  }
  opts.headers = opts.headers || {};
  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) opts.headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(apiUrl(url), opts);
  } catch (netErr) {
    // сеть упала / бэкенд спит - это НЕ повод выходить из аккаунта
    const e = new Error('Бэкенд недоступен');
    e.status = 0; e.network = true;
    throw e;
  }
  const data = await res.json().catch(()=>({}));
  if (!res.ok) {
    const e = new Error(data.error || ('Ошибка ' + res.status));
    e.status = res.status;
    throw e;
  }
  return data;
}

// запрос с таймаутом и повтором (Render Free просыпается до 30 секунд)
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      return await apiFetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    } catch (e) {
      last = e;
      if (e && e.status === 401) { clearTimeout(t); throw e; }
      if (i < tries - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    } finally { clearTimeout(t); }
  }
  throw last;
}

let currentUser = null;
let selectedVideoFile = null;
let selectedThumbFile = null;
let selectedCoverFile = null;
let frameCanvas = null;

function showIsland(text, type='') {
  // v7.0: всплывающие плашки убраны по просьбе пользователя - фидбек молчаливый
  return;
}

const app = {
  async checkBackendStatus() {
    const dot = document.getElementById('backendDot');
    const connIcon = document.getElementById('connectionIcon');
    const connDot = connIcon ? connIcon.querySelector('.conn-dot') : null;
    const set = (state) => {
      if (dot) dot.className = 'status-dot ' + state;
      if (connIcon) connIcon.className = 'connection-icon ' + state;
      if (connDot) connDot.className = 'conn-dot';
    };
    if (localMode()) { set('online'); return; } // оффлайн тест-режим - бэкенд не нужен
    set('checking');
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(apiUrl('/api/config'), { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('offline');
      const data = await res.json();
      set('online');
      // показ онлайна сверху убран (v6.5) - статус виден только по значку подключения
    } catch (e) {
      const base = getApiBase();
      const isRender = base.includes('onrender.com');
      if (isRender) {
        set('checking');
        showIsland('ПРОСЫПАЕТСЯ...', 'violet');
        setTimeout(() => this.checkBackendStatus(), 5000);
      } else {
        set('offline');
        showIsland('ОФФЛАЙН', 'error');
      }
    }
  },

  async init() {
    this.applyTheme();
    this.checkBackendStatus();
    setInterval(() => this.checkBackendStatus(), 15000);
    await this.checkAuth();
    window.addEventListener('hashchange', () => this.router());
    this.router();

    document.getElementById('loginNick').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/[^a-zA-Z0-9_]/g,'').slice(0,20);
    });
    document.getElementById('loginPin').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g,'').slice(0,3);
    });
    document.getElementById('loginPin').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.doLogin();
    });
    document.getElementById('loginNick').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('loginPin').focus();
    });

    const testPixel = document.getElementById('testPixel');
    if (testPixel) {
      testPixel.addEventListener('click', async (e) => {
        e.stopPropagation();
        const code = prompt('Кодовый символ:');
        if (code === null) return;
        if (code.trim() !== '1') {
          const errEl = document.getElementById('loginError');
          if (errEl) { errEl.textContent = 'Неверный код'; errEl.style.display = 'block'; }
          return;
        }
        const errEl = document.getElementById('loginError');
        if (errEl) errEl.style.display='none';
        try {
          // ОФФЛАЙН: тест-аккаунт работает без бэкенда
          LM.enable();
          const data = await LM.request('POST', '/api/test-login', { code: '1' });
          setToken(data.token);
          currentUser = data.user;
          if (LM.counts().videos === 0) { try { await LM.seedDemo(); } catch (e) { console.warn(e); } }
          this.hideLogin();
          this.navigate('home');
          showIsland('ТЕСТ АККАУНТ • ОФФЛАЙН', 'violet');
        } catch (err) {
          const errEl = document.getElementById('loginError');
          if (errEl) { errEl.textContent = err.message; errEl.style.display='block'; }
        }
      });
    }

    this.setupScrollProgress();
    this.refreshNotifBadge();
    this.loadStorageInfo();

    // пасхалка Konami (вешаем один раз: init() может быть вызван повторно)
    if (!this._konamiBound) {
      this._konamiBound = true;
      this._konamiIdx = 0;
      const KONAMI = ['arrowup','arrowup','arrowdown','arrowdown','arrowleft','arrowright','arrowleft','arrowright','b','a'];
        document.addEventListener('keydown', (e) => {
          const k = String(e.key || '').toLowerCase();
          this._konamiIdx = (k === KONAMI[this._konamiIdx]) ? this._konamiIdx + 1 : (k === KONAMI[0] ? 1 : 0);
          if (this._konamiIdx === KONAMI.length) {
            this._konamiIdx = 0;
            document.body.classList.toggle('rainbow');
          }
        });
    }

    // search input live
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let timeout;
      searchInput.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (searchInput.value.trim().length>=2) this.doSearch();
        }, 600);
      });
    }
  },

  async loadStorageInfo() {
    try {
      const cfg = await apiFetch('/api/config');
      this._storageCfg = (cfg && cfg.storage) ? cfg.storage : null;
    } catch (e) { this._storageCfg = null; }
  },

  applyTheme() {
    const theme = localStorage.getItem(LS_THEME) || currentUser?.theme || 'light';
    const accent = localStorage.getItem(LS_ACCENT) || currentUser?.accent || 'violet';
    // вся покраска - через CSS-переменные в style.css, без инлайн-стилей
    document.body.setAttribute('data-theme', theme);
    document.body.setAttribute('data-accent', accent);
    document.body.style.background = '';
    document.body.style.color = '';
  },

  async checkAuth() {
    const token = getToken();
    if (!token) { this.showLogin(); return; }
    try {
      currentUser = await fetchRetry('/api/me');
      try { localStorage.setItem('loltube_last_nick', currentUser.nickname); } catch (e) {}
      this.hideLogin();
      this.renderAccountBtn();
      this.applyTheme();
    } catch (e) {
      // Выходим ТОЛЬКО если сервер прямо сказал, что токен недействителен (401).
      // Если бэкенд просто спит или недоступен - сессию сохраняем.
      if (e && e.status === 401) {
        clearToken();
        currentUser = null;
        this.showLogin();
      } else {
        showIsland('БЭКЕНД НЕ ОТВЕЧАЕТ, ПОВТОРЯЮ...', 'violet');
        setTimeout(async () => { try { await this.checkAuth(); } catch (err) {} this.router(); }, 4000);
      }
    }
  },

  showLogin() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'flex';
    const ln = document.getElementById('loginNick');
    if (ln && !ln.value) ln.value = localStorage.getItem('loltube_last_nick') || '';
    this.renderAccountBtn();
    this.setNavActive('home');
  },
  softLogout(msg) {
    clearToken();
    currentUser = null;
    if (msg) showIsland(msg, 'error');
    this.showLogin();
  },
  hideLogin() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'none';
    this.renderAccountBtn();
  },

  renderAccountBtn() {
    const btn = document.getElementById('accountBtn');
    if (!btn) return;
    if (currentUser) {
      const avUrl = currentUser.avatar ? this.getFileUrl(currentUser.avatar) : null;
      const av = avUrl ? `<div class="avatar"><img src="${avUrl}"></div>` : `<div class="avatar" style="background:${currentUser.avatarColor}">${currentUser.nickname[0].toUpperCase()}</div>`;
      btn.innerHTML = `${av}<span>${currentUser.nickname.slice(0,6)}</span>`;
      btn.classList.add('has-user');
    } else {
      btn.textContent = 'ВОЙТИ';
      btn.classList.remove('has-user');
    }
  },

  setNavActive(page) {
    document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.remove('active'));
    const map = { home:'navHome', shorts:'navShorts', live:'navLive', subs:'navSubs', friends:'navFriends', profile:'navProfile', upload:'navHome' };
    const id = map[page] || 'navHome';
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  },

  async doLogin() {
    const nick = document.getElementById('loginNick').value.trim();
    const pin = document.getElementById('loginPin').value.trim();
    const errEl = document.getElementById('loginError');
    const submitBtn = document.getElementById('loginSubmit');
    if (!nick) { errEl.textContent='Введи ник'; errEl.style.display='block'; return; }
    if (!/^\d{3}$/.test(pin)) { errEl.textContent='Пин только 3 цифры'; errEl.style.display='block'; return; }
    errEl.style.display='none';
    submitBtn.textContent='...';
    submitBtn.disabled=true;
    try {
      const data = await apiFetch('/api/login', { method:'POST', body: JSON.stringify({ nickname:nick, password:pin }) });
      setToken(data.token);
      currentUser = data.user;
      try { localStorage.setItem('loltube_last_nick', data.user.nickname); } catch (e) {}
      try { currentUser = await apiFetch('/api/me'); } catch {}
      this.hideLogin();
      this.navigate('home');
      showIsland(`ПРИВЕТ, ${currentUser.nickname.toUpperCase()}`, 'violet');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display='block';
    } finally {
      submitBtn.textContent='ВОЙТИ';
      submitBtn.disabled=false;
    }
  },

  // ---------- УВЕДОМЛЕНИЯ ----------
  notifText(n) {
    const d = n && n.data ? n.data : {};
    switch (n && n.type) {
      case 'friend_request': return `@${d.from || 'кто-то'} хочет добавить тебя в друзья`;
      case 'friend_accept':  return `@${d.from || 'кто-то'} принял заявку в друзья`;
      case 'new_subscriber': return `@${d.from || 'кто-то'} подписался на тебя`;
      case 'new_video':      return `Новое видео от @${d.author || 'автора'}: ${d.title || ''}`.trim();
      case 'new_comment':    return `@${d.from || 'кто-то'} прокомментировал твоё видео`;
      default:               return String((n && n.type) || 'Уведомление').replace(/_/g, ' ');
    }
  },

  async refreshNotifBadge() {
    if (!currentUser) { const b = document.getElementById('notifBadge'); if (b) b.style.display = 'none'; return; }
    try {
      const n = await apiFetch('/api/notifications');
      const list = Array.isArray(n) ? n : ((n && Array.isArray(n.notifications)) ? n.notifications : []);
      this._notifs = list;
      const unread = list.filter(x => !x.read).length;
      const b = document.getElementById('notifBadge');
      if (b) { b.textContent = unread > 9 ? '9+' : String(unread); b.style.display = unread ? 'flex' : 'none'; }
    } catch (e) {}
  },

  async toggleNotifPanel() {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    if (!currentUser) { this.showLogin(); return; }
    panel.style.display = 'block';
    await this.refreshNotifBadge();
    const list = this._notifs || [];
    panel.innerHTML = `
      <div class="notif-head">
        <span>УВЕДОМЛЕНИЯ • ${list.filter(x => !x.read).length} НОВЫХ</span>
        <div style="display:flex;gap:6px;">
          ${list.length ? '<button class="notif-mini-btn" onclick="app.readNotifications()">ПРОЧИТАТЬ ВСЕ</button>' : ''}
          <button class="notif-mini-btn" onclick="app.toggleNotifPanel()">✕</button>
        </div>
      </div>
      ${list.length ? list.slice(0, 20).map(x => `
        <div class="notif-item ${x.read ? '' : 'unread'}" onclick="app.openNotif('${x.id}')">
          <div class="notif-text">${this.esc(this.notifText(x))}</div>
          <div class="notif-time">${this.timeAgo(x.createdAt)}</div>
        </div>`).join('') : '<div class="notif-empty">Уведомлений пока нет</div>'}`;
    if (list.some(x => !x.read)) { try { await apiFetch('/api/notifications/read', { method:'POST' }); } catch (e) {} this.refreshNotifBadge(); }
  },

  openNotif(id) {
    const n = (this._notifs || []).find(x => x.id === id);
    const panel = document.getElementById('notifPanel');
    if (panel) panel.style.display = 'none';
    if (!n) return;
    const d = n.data || {};
    if (n.type === 'new_video' && d.videoId) this.navigate('watch', { id: d.videoId });
    else if (n.type === 'new_subscriber' && d.from) this.navigate('user', { nickname: d.from });
    else if (n.type === 'friend_request' || n.type === 'friend_accept') this.navigate('friends');
  },

  setupScrollProgress() {
    if (this._scrollBound) return;
    this._scrollBound = true;
    const fill = document.getElementById('scrollProgressFill');
    const update = () => {
      if (!fill) return;
      const h = document.documentElement;
      const max = (h.scrollHeight || 0) - (h.clientHeight || 0);
      fill.style.width = (max > 8 ? Math.min(100, Math.round((window.scrollY || 0) / max * 100)) : 0) + '%';
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    this._updateScrollProgress = update;
  },

  async savePosition(id, position, duration) {
    if (!currentUser || !id) return;
    position = Number(position) || 0;
    duration = Number(duration) || 0;
    if (!isFinite(position) || position < 1) return;
    if (duration > 0 && position > duration - 5) position = 0; // досмотрено - начинать с начала
    try {
      await apiFetch(`/api/videos/${id}/watch-position`, { method:'POST', body: JSON.stringify({ position, duration }) });
      if (this._historyMap) {
        const rec = this._historyMap[id] || (this._historyMap[id] = { id });
        rec.position = position; rec.duration = duration;
      }
    } catch (e) {}
  },

  async doubleTapLike(video, root) {
    const h = document.createElement('div');
    h.className = 'burst-heart';
    h.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="#ef4444" stroke="#fff" stroke-width="1"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2.08C10.5 3.5 9.5 3 7.75 3A5.5 5.5 0 0 0 2.25 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
    (root || document.body).appendChild(h);
    setTimeout(() => h.remove(), 900);
    try { await this.toggleLike(video.id, 'like'); } catch (e) {}
  },

  skeletonHtml() {
    return `
      <div class="skel-wrap">
        <div class="skel-row">${'<div class="skel chip"></div>'.repeat(5)}</div>
        ${'<div class="skel-card"><div class="skel thumb"></div><div class="skel line w70"></div><div class="skel line w40"></div></div>'.repeat(3)}
      </div>`;
  },

  closeWatch() {
    // сохраняем позицию, если шли по видео
    const vEl = document.getElementById('videoEl');
    if (vEl && this._currentVideoId && vEl.currentTime > 1) this.savePosition(this._currentVideoId, vEl.currentTime, vEl.duration || 0);
    if (this._posT) { clearInterval(this._posT); this._posT = null; }
    // трек продолжает играть в мини-плеере
    if (window.history.length > 1) window.history.back();
    else this.navigate('home');
  },

  // ---------- ДОП ФУНКЦИИ ОФФЛАЙН ТЕСТ-АККАУНТА ----------
  async testSeed() {
    if (!localMode()) return;
    try {
      const r = await LM.seedDemo();
      showIsland('ДЕМО ЗАГРУЖЕНО', 'violet');
      await this.testStorage();
      this.navigate('home');
    } catch (e) { alert(e.message); }
  },
  async testUploadVideo(btn) {
    if (!localMode()) return;
    const old = btn ? btn.textContent : '';
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'ГЕНЕРИРУЮ...'; }
      showIsland('ГЕНЕРИРУЮ ТЕСТОВОЕ ВИДЕО...', 'violet');
      const v = await LM.testUploadVideo((pct) => {
        if (btn) btn.textContent = 'ЗАГРУЗКА ' + Math.round(pct) + '%';
      });
      showIsland(v._testInfo && v._testInfo.indexOf('webm') === 0 ? 'ВИДЕО ЗАГРУЖЕНО' : 'ЗАГРУЖЕНО (wav)', 'violet');
      this.navigate('watch', { id: v.id });
    } catch (e) {
      alert('Не удалось: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  },
  async runSelfTest() {
    const out = document.getElementById('selfTestOut');
    if (!out) return;
    if (!localMode()) { showIsland('ДОСТУПНО В ОФФЛАЙН ТЕСТ-РЕЖИМЕ', 'error'); return; }
    const res = [];
    const t = (name, cond) => res.push({ name, ok: !!cond });
    out.style.display = 'block';
    out.innerHTML = '<div class="st-run">ЗАПУСКАЮ ТЕСТЫ...</div>';
    try {
      t('сессия активна', !!currentUser);
      const vids = await apiFetch('/api/videos');
      t('видео загружаются', Array.isArray(vids) && vids.length > 0);
      const v0 = Array.isArray(vids) ? vids[0] : null;
      let pl = null;
      try {
        pl = await apiFetch('/api/playlists', { method: 'POST', body: { title: 'САМОТЕСТ-' + (Date.now() % 10000) } });
      } catch (e) { pl = null; }
      t('плейлист создаётся', !!(pl && pl.id));
      if (pl && v0) {
        const added = await apiFetch(`/api/playlists/${pl.id}/add/${v0.id}`, { method: 'POST' });
        t('видео добавляется в плейлист', !!(added && added.videos && added.videos.includes(v0.id)));
        const removed = await apiFetch(`/api/playlists/${pl.id}/remove/${v0.id}`, { method: 'DELETE' });
        t('видео убирается из плейлиста', !!(removed && removed.videos && !removed.videos.includes(v0.id)));
        await apiFetch(`/api/videos/${v0.id}/watch-position`, { method: 'POST', body: { position: 33, duration: 120 } });
        const one = await apiFetch(`/api/videos/${v0.id}`);
        t('позиция просмотра сохраняется', one && one.watchPosition === 33);
        await apiFetch(`/api/videos/${v0.id}/watch-position`, { method: 'POST', body: { position: 0, duration: 120 } });
      }
      t('уведомления читаются', /подписался/i.test(this.notifText({ type: 'new_subscriber', data: { from: 'user' } })));
      t('rich-text :lol:', /emo-lol/.test(this.renderRichText(':lol:')));
      t('skeleton-экраны', /skel/.test(this.skeletonHtml()));
      t('авто-очередь музыки', typeof this.musicAutoNext === 'function');
      let st = null;
      try { st = await LM.storageInfo(); } catch (e) { st = null; }
      t('IndexedDB отвечает', !!st);
    } catch (e) {
      res.push({ name: 'сбой: ' + e.message, ok: false });
    }
    const bad = res.filter(r => !r.ok).length;
    out.innerHTML = res.map(r => `<div class="st-${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'} ${this.esc(r.name)}</div>`).join('') +
      `<div class="st-total">ИТОГ: ${res.length - bad}/${res.length} OK</div>`;
    showIsland(bad ? `ТЕСТЫ: ${bad} С ОШИБКОЙ` : 'ВСЕ ТЕСТЫ ПРОЙДЕНЫ', bad ? 'error' : 'violet');
  },

  async testStorage() {
    if (!localMode()) return;
    const el = document.getElementById('testInfo');
    if (!el) return;
    const i = await LM.storageInfo();
    el.innerHTML = `ВИДЕО: <b>${i.videos}</b> • ЮЗЕРЫ: <b>${i.users}</b> • ФАЙЛЫ: <b>${i.files}</b><br>МЕДИА: <b>${i.mediaSize}</b> • БАЗА: <b>${i.dbSize}</b><br>IndexedDB: <b>${i.idbOk ? 'OK' : 'НЕТ' + (i.idbError ? ' (' + i.idbError + ')' : '')}</b>`;
  },
  async testReset() {
    if (!localMode()) return;
    if (!confirm('Стереть все локальные данные теста?')) return;
    await LM.reset();
    clearToken();
    currentUser = null;
    this.showLogin();
    showIsland('ЛОКАЛЬНЫЕ ДАННЫЕ СТЁРТЫ', '');
  },

  logout() {
    if (!confirm('Выйти?')) return;
    if (localMode()) { try { LM.disable(); } catch (e) {} } // выход из оффлайн тест-режима
    clearToken();
    currentUser=null;
    this.showLogin();
    const nickEl = document.getElementById('loginNick');
    const pinEl = document.getElementById('loginPin');
    if (nickEl) nickEl.value='';
    if (pinEl) pinEl.value='';
    showIsland('ВЫШЕЛ', '');
  },

  navigate(page, params={}) {
    if (!currentUser && page!=='live') { this.showLogin(); return; }
    let hash = page;
    if (params.id) hash+=`/${params.id}`;
    if (params.nickname) hash+=`/${params.nickname}`;
    // если hash не изменился - hashchange не сработает, рендерим сами;
    // если изменился - отрендерит обработчик hashchange (иначе был двойной рендер)
    if (window.location.hash === '#' + hash) this.router(); else window.location.hash = hash;
    this.setNavActive(page);
  },

  openProfile() {
    if (!currentUser) { this.showLogin(); return; }
    this.navigate('profile');
  },

  async router() {
    const main = document.getElementById('app');
    if (!main) return;
    const myRun = (this._runId = (this._runId || 0) + 1); // защита от параллельных рендеров
    // музыку НЕ глушим - её подхватывает мини-плеер
    if (!currentUser) { 
      const hash = window.location.hash.slice(1) || 'home';
      if (hash.startsWith('live')) {
        // allow live without auth
      } else {
        this.showLogin(); 
        return; 
      }
    }
    const hash = window.location.hash.slice(1) || 'home';
    const [page, id] = hash.split('/');
    main.innerHTML = this.skeletonHtml();
    try {
      if (page==='home') await this.renderHome();
      else if (page==='live') await this.renderLive();
      else if (page==='friends') await this.renderFriends();
      else if (page==='watch' && id) await this.renderWatch(id);
      else if (page==='profile') await this.renderProfile();
      else if (page==='upload') await this.renderUpload();
      else if (page==='user' && id) await this.renderUser(id);
      else if (page==='search') await this.renderSearch(id);
      else if (page==='history') await this.renderHistory();
      else if (page==='favorites') await this.renderFavorites();
      else if (page==='playlists') await this.renderPlaylists();
      else if (page==='subs') await this.renderSubscriptions();
      else if (page==='admin') await this.renderAdmin();
      else await this.renderHome();
      this.updateMiniPlayer();
      main.classList.remove('page-anim');
      void main.offsetWidth;
      main.classList.add('page-anim');
      try { window.scrollTo(0, 0); } catch (e) {}
      const np = document.getElementById('notifPanel');
      if (np) np.style.display = 'none';
      this.refreshNotifBadge();
      if (this._updateScrollProgress) this._updateScrollProgress();
    } catch (e) {
      if (myRun !== this._runId) return; // уже идёт более свежий рендер - не затираем его
      if (e && e.cancelled) return;
      // из аккаунта выкидываем ТОЛЬКО по настоящему 401, и с объяснением
      if (e && e.status === 401) {
        this.softLogout('СЕССИЯ ИСТЕКЛА — ВОЙДИ СНОВА');
        return;
      }
      const sleeping = e && (e.status === 0 || e.network);
      main.innerHTML = `<div class="empty"><h2>${sleeping ? 'БЭКЕНД СПИТ' : 'ОШИБКА'}</h2><p>${this.esc(e.message)}</p><div style="display:flex;gap:6px;margin-top:16px;flex-wrap:wrap;justify-content:center;"><button class="btn btn-primary" onclick="app.router()">ПОВТОРИТЬ</button><button class="btn" onclick="app.navigate('home')">НА ГЛАВНУЮ</button></div></div>`;
    }
    this.updateMiniPlayer();
  },

  async renderHome() {
    const main = document.getElementById('app');
    const filter = new URLSearchParams(window.location.search).get('type') || 'all';
    let videos = [];
    try { videos = await apiFetch(`/api/videos?type=${filter}&sort=new`); } catch (e) { videos = []; }
    if (!Array.isArray(videos)) videos = [];
    // МУЗЫКА - одна категория: обычные треки и треки артистов вместе
    const isMusicCat = (filter === 'music' || filter === 'artist_music');
    // ТОП НЕДЕЛИ: самое просматриваемое за 7 дней
    let topHtml = '';
    if (filter === 'all') {
      const weekAgo = Date.now() - 7 * 86400000;
      const top = videos
        .filter(v => new Date(v.createdAt).getTime() > weekAgo)
        .sort((a, b) => (b.views || 0) - (a.views || 0))
        .slice(0, 3);
      if (top.length) {
        topHtml = `
          <div class="week-top">
            <div class="week-top-title">🔥 ТОП НЕДЕЛИ</div>
            <div class="week-top-row">
              ${top.map((v, i) => {
                const t = this.getFileUrl(v.cloudinaryThumbUrl || v.cover || v.thumbnail);
                return `
                <div class="week-card" onclick="app.navigate('watch', {id:'${v.id}'})">
                  <span class="week-pos">${i + 1}</span>
                  <div class="week-thumb">${t ? `<img src="${t}" onerror="this.style.display='none'">` : '♪'}</div>
                  <div class="week-title">${this.esc(v.title)}</div>
                  <div class="week-views">👁 ${v.views || 0}</div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
      }
    }
    // «продолжить просмотр»: берём недосмотренное из истории
    let continueHtml = '';
    try {
      const hist = await apiFetch('/api/history');
      this._historyMap = {};
      (Array.isArray(hist) ? hist : []).forEach(h => { this._historyMap[h.id] = h; });
      const resumeList = (Array.isArray(hist) ? hist : [])
        .filter(v => Number(v.position) > 5 && Number(v.duration) > 0 && v.position < v.duration - 10)
        .slice(0, 6);
      if (resumeList.length) {
        continueHtml = `
          <div class="week-top">
            <div class="week-top-title">▶ ПРОДОЛЖИТЬ</div>
            <div class="week-top-row">
              ${resumeList.map(v => {
                const t = this.getFileUrl(v.cloudinaryThumbUrl || v.cover || v.thumbnail);
                const p = Math.min(100, Math.round(v.position / v.duration * 100));
                return `
                <div class="week-card" onclick="app.navigate('watch', {id:'${v.id}'})">
                  <div class="week-thumb">${t ? `<img src="${t}" onerror="this.style.display='none'">` : '▶'}</div>
                  <div class="week-title">${this.esc(v.title)}</div>
                  <div class="week-views">${this._fmtTime(v.position)} из ${this._fmtTime(v.duration)}</div>
                  <div class="thumb-progress"><div style="width:${p}%"></div></div>
                </div>`;
              }).join('')}
            </div>
          </div>`;
      }
    } catch (e) { this._historyMap = {}; }
    // прогресс просмотра на обычных карточках
    if (this._historyMap) videos.forEach(v => {
      const h = this._historyMap[v.id];
      if (h) { v.position = h.position || 0; v.duration = h.duration || 0; }
    });
    main.innerHTML = `
      <div class="cat-row">
        <button class="btn ${filter==='all'?'btn-primary':''}" onclick="app.filterHome('all')">ВСЕ</button>
        <button class="btn ${filter==='video'?'btn-primary':''}" onclick="app.filterHome('video')">ВИДЕО</button>
        <button class="btn ${filter==='image'?'btn-primary':''}" onclick="app.filterHome('image')">ФОТО</button>
        <button class="btn ${filter==='gif'?'btn-primary':''}" onclick="app.filterHome('gif')">GIF</button>
        <button class="btn ${isMusicCat?'btn-primary':''}" onclick="app.filterHome('music')">МУЗЫКА</button>
      </div>
      ${continueHtml}
      ${topHtml}
      ${videos.length
        ? `<div class="video-grid">${videos.map((v,i) => this.videoCard(v,i)).join('')}</div>`
        : `<div class="empty"><h2>Пока пусто...</h2><p style="font-size:12px;color:#71717a;margin-top:8px;">${isMusicCat ? 'В этой категории пока нет треков' : 'Загрузи первое видео'}</p><button class="btn btn-primary" style="margin-top:12px" onclick="app.navigate('upload')">+ ЗАГРУЗИТЬ</button></div>`}`;
  },
  filterHome(type) {
    window.history.replaceState({}, '', `?type=${type}#home`);
    this.renderHome();
  },
  // переход на главную сразу с нужной категорией (используется из поиска/пустых состояний)
  goCategory(type) {
    this.navigate('home');
    window.history.replaceState({}, '', `?type=${type}#home`);
    this.renderHome();
  },

  getFileUrl(filename) {
    if (!filename) return null;
    if (isLocalMedia(filename)) return apiUrl(filename); // оффлайн: blob из IndexedDB / data-uri
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    if (filename.startsWith('/uploads/')) return apiUrl(filename);
    return apiUrl(`/uploads/${filename}`);
  },
  videoCard(v) {
    const isImage = v.contentType==='image' || v.contentType==='gif';
    const isMusic = v.contentType==='music';
    const isArtist = v.contentType==='artist_music';
    const thumb = this.getFileUrl(v.cloudinaryThumbUrl || v.cover || v.thumbnail);
    const typeKey = isArtist ? 'artist' : v.contentType;
    // Premium icons for content type
    const typeIcons = {
      video: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
      image: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
      gif: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 8h.01"/><path d="M12 8h.01"/><path d="M16 8h.01"/><path d="M8 16h.01"/><path d="M12 16h.01"/><path d="M16 16h.01"/></svg>`,
      music: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
      artist: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 1 0 2 2.83V8h6V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>`
    };
    const typeLabels = { video:'ВИДЕО', image:'ФОТО', gif:'GIF', music:'МУЗЫКА', artist:'АРТИСТ' };
    // прогресс просмотра (приходит из истории)
    const pos = Number(v.position || 0), dur = Number(v.duration || 0);
    const pct = (pos > 5 && dur > 0) ? Math.min(100, Math.round(pos / dur * 100)) : 0;
    const showProgress = pct > 2 && pct < 98;
    const fileUrl = this.getFileUrl(v.cloudinaryUrl || v.filename);
    const typeIcon = typeIcons[typeKey] || typeIcons.video;
    const typeLabel = typeLabels[typeKey] || String(v.contentType||'').toUpperCase();
    return `
      <div class="video-card" onclick="app.navigate('watch', {id:'${v.id}'})">${this.videoCardInner(v)}</div>
    `;
  },

  // содержимое карточки без обёртки (нужно в плейлисте, где свои кнопки)
  videoCardInner(v) {
    const isImage = v.contentType==='image' || v.contentType==='gif';
    const isMusic = v.contentType==='music';
    const isArtist = v.contentType==='artist_music';
    const thumb = this.getFileUrl(v.cloudinaryThumbUrl || v.cover || v.thumbnail);
    const typeKey = isArtist ? 'artist' : v.contentType;
    const typeIcons = {
      video: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
      image: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
      gif: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 8h.01"/><path d="M12 8h.01"/><path d="M16 8h.01"/><path d="M8 16h.01"/><path d="M12 16h.01"/><path d="M16 16h.01"/></svg>`,
      music: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
      artist: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 1 0 2 2.83V8h6V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>`
    };
    const typeLabels = { video:'ВИДЕО', image:'ФОТО', gif:'GIF', music:'МУЗЫКА', artist:'АРТИСТ' };
    const typeIcon = typeIcons[typeKey] || typeIcons.video;
    const typeLabel = typeLabels[typeKey] || String(v.contentType||'').toUpperCase();
    const fileUrl = this.getFileUrl(v.cloudinaryUrl || v.filename);
    const pos = Number(v.position || 0), dur = Number(v.duration || 0);
    const pct = (pos > 5 && dur > 0) ? Math.min(100, Math.round(pos / dur * 100)) : 0;
    const showProgress = pct > 2 && pct < 98;
    return `
        <div class="thumb ${isArtist?'thumb-music':''}">
          ${thumb ? `<img src="${thumb}" loading="lazy">` : isImage ? `<img src="${fileUrl}" loading="lazy">` : isArtist ? `<div class="thumb-placeholder music-ph"><span class="music-disc">${typeIcon}</span></div>` : `<div class="thumb-placeholder"><span style="display:flex;align-items:center;gap:4px;">${typeIcon} ЛОЛ ТУБ</span></div>`}
          ${isArtist ? '<div class="music-eq"><span></span><span></span><span></span><span></span></div>' : ''}
          <div class="thumb-meta"><span style="display:flex;align-items:center;gap:3px;">${typeIcon} ${v.views||0}</span></div>
          <div class="content-type-icon ${typeKey}">${typeIcon} ${typeLabel}</div>
          ${showProgress ? `<div class="thumb-progress"><div style="width:${pct}%"></div></div><div class="thumb-resume">▶ ${this._fmtTime(pos)}</div>` : ''}
        </div>
        <div class="video-info">
          <div class="video-title">${this.esc(v.title)}</div>
          ${isArtist && (v.artist||v.album) ? `<div class="artist-line"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 1 0 2 2.83V8h6V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> ${this.esc(v.artist||'')}${v.album?` • ${this.esc(v.album)}`:''}</div>` : ''}
          <div class="video-meta"><span style="display:flex;align-items:center;gap:3px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> ${this.esc(v.authorNickname)}</span><span>${this.timeAgo(v.createdAt)}</span><span style="display:flex;align-items:center;gap:2px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2.08C10.5 3.5 9.5 3 7.75 3A5.5 5.5 0 0 0 2.25 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg> ${v.likes?.length||0}</span></div>
        </div>
    `;
  },

  async renderSubscriptions() {
    const main = document.getElementById('app');
    if (!currentUser) { this.showLogin(); return; }
    let subs = [];
    try { subs = await apiFetch('/api/subscriptions'); } catch (e) { subs = []; }
    if (!Array.isArray(subs)) subs = [];
    let all = [];
    try { all = await apiFetch('/api/videos'); } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    const ids = subs.map(u => u.id);
    const vids = all
      .filter(v => ids.includes(v.authorId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    main.innerHTML = `
      <div style="font-size:14px;font-weight:800;margin:10px 0;">ПОДПИСКИ • ${subs.length} АВТОРОВ • ${vids.length} РОЛИКОВ</div>
      ${subs.length ? `<div class="cat-row" style="margin-bottom:10px;">${subs.map(u => `<button class="btn" onclick="app.navigate('user', {nickname:'${this.esc(u.nickname)}'})">${this.esc(u.nickname)}</button>`).join('')}</div>` : ''}
      ${vids.length
        ? `<div class="video-grid">${vids.map(v => this.videoCard(v)).join('')}</div>`
        : `<div class="empty"><h2>Пока пусто</h2><p>${subs.length ? 'Твои авторы ещё ничего не загрузили' : 'Подпишись на авторов — их ролики появятся здесь'}</p><button class="btn btn-primary" style="margin-top:12px" onclick="app.navigate('home')">НА ГЛАВНУЮ</button></div>`}`;
  },

  async renderLive() {
    const main = document.getElementById('app');
    const live = await apiFetch('/api/live');
    main.innerHTML = `
      <div style="padding:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:8px;">
            ${live.isLive ? '<span class="live-badge"><span style="width:6px;height:6px;background:white;border-radius:50% !important;display:inline-block;animation:pulse 1s infinite;"></span> LIVE</span>' : '<span style="background:#71717a;color:white;font-size:9px;font-weight:800;padding:3px 8px;">OFFLINE</span>'}
            <span>ТВ-ФАНТОМАС</span>
          </div>
          <div style="font-size:10px;color:#71717a;display:flex;align-items:center;gap:4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            ${live.viewerCount||0}
          </div>
        </div>
        
        <div class="live-player" id="livePlayer" style="border:var(--border-w-thick) solid var(--border);background:black;position:relative;overflow:hidden;">
          ${live.isLive && live.hlsUrl ? '' : `
            <div class="live-offline">
              <div class="offline-icon">◼</div>
              <div style="font-size:14px;font-weight:800;">${live.isLive ? 'ЗАГРУЗКА...' : 'ЭФИР ЗАВЕРШЕН'}</div>
              <div style="font-size:11px;color:#a1a1aa;margin-top:6px;">${this.esc(live.title)}</div>
              <div style="font-size:10px;color:#71717a;margin-top:12px;">Скоро снова в эфире</div>
            </div>
          `}
        </div>

        <div class="live-info">
          <div>
            <div class="live-title">${this.esc(live.title)}</div>
            <div class="live-sub">Фантомас ТВ • Прямой эфир • ${live.isLive ? 'В эфире' : 'Оффлайн'}</div>
          </div>
          <button class="btn" onclick="app.shareLive()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            ПОДЕЛИТЬСЯ
          </button>
        </div>


      </div>
    `;
    if (live.isLive && live.hlsUrl) {
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.width='100%';
      video.style.height='100%';
      video.style.background='black';
      const playerDiv = document.getElementById('livePlayer');
      if (playerDiv) {
        playerDiv.innerHTML='';
        playerDiv.appendChild(video);
        if (live.hlsUrl.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(live.hlsUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(()=>{}));
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = live.hlsUrl;
          video.play().catch(()=>{});
        } else {
          video.src = live.hlsUrl;
          video.play().catch(()=>{});
        }
        try { await apiFetch('/api/live/view', { method:'POST' }); } catch {}
      }
    }
  },
  async setLive(isLive) {
    const hlsUrl = document.getElementById('liveHlsUrl')?.value.trim();
    const title = document.getElementById('liveTitle')?.value.trim();
    try {
      await apiFetch('/api/live', { method:'POST', body: JSON.stringify({ isLive, hlsUrl, title }) });
      showIsland(isLive ? 'ЭФИР ВКЛЮЧЕН' : 'ЭФИР ВЫКЛЮЧЕН', 'violet');
      this.renderLive();
    } catch (e) { alert(e.message); }
  },

  async renderFriends() {
    const main = document.getElementById('app');
    let data = null, subs = [], netDead = false;
    try { data = await apiFetch('/api/friends'); } catch (e) { data = null; netDead = !!(e && (e.status === 0 || e.network)); }
    try { subs = await apiFetch('/api/subscriptions'); } catch (e) { subs = []; }
    if (!data || typeof data !== 'object') data = { friends: [], requests: [] };
    data.friends = Array.isArray(data.friends) ? data.friends : [];
    data.requests = Array.isArray(data.requests) ? data.requests : [];
    subs = Array.isArray(subs) ? subs : [];
    main.innerHTML = `
      ${netDead ? `<div class="empty" style="min-height:24vh;"><h2>БЭКЕНД СПИТ</h2><p style="font-size:12px;color:#71717a;margin-top:8px;">Друзья не загрузились — сервер недоступен.</p><button class="btn btn-primary" style="margin-top:12px" onclick="app.router()">ПОВТОРИТЬ</button></div>` : ''}
      <div style="font-size:16px;font-weight:800;margin:12px 0;">ДРУЗЬЯ • ПОДПИСКИ</div>
      <div class="chip-center" style="display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;">
        <button class="btn btn-primary" style="font-size:10px;min-height:32px;" onclick="app.navigate('friends')">ДРУЗЬЯ</button>
        <button class="btn" style="font-size:10px;min-height:32px;" onclick="app.navigate('history')">ИСТОРИЯ</button>
        <button class="btn" style="font-size:10px;min-height:32px;" onclick="app.navigate('favorites')">ИЗБРАННОЕ</button>
        <button class="btn" style="font-size:10px;min-height:32px;" onclick="app.navigate('playlists')">ПЛЕЙЛИСТЫ</button>
      </div>
      ${data.requests.length ? `<div class="settings-section"><h3>ЗАЯВКИ В ДРУЗЬЯ (${data.requests.length})</h3>${data.requests.map(u=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;"><div class="avatar" style="background:${u.avatarColor||'#7c3aed'}">${u.nickname[0].toUpperCase()}</div><span style="flex:1;font-weight:700;font-size:13px;">${this.esc(u.nickname)}</span><button class="btn btn-primary" style="font-size:10px;min-height:28px;padding:0 8px;" onclick="app.acceptFriend('${u.nickname}')">ПРИНЯТЬ</button><button class="btn" style="font-size:10px;min-height:28px;" onclick="app.declineFriend('${u.nickname}')">Х</button></div>`).join('')}</div>` : ''}
      <div class="settings-section"><h3>МОИ ДРУЗЬЯ (${data.friends.length})</h3>${data.friends.length ? data.friends.map(u=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;cursor:pointer;" onclick="app.navigate('user', {nickname:'${u.nickname}'})"><div class="avatar" style="background:${u.avatarColor||'#7c3aed'}">${u.nickname[0].toUpperCase()}</div><div style="flex:1"><div style="font-weight:700;font-size:13px;">${this.esc(u.nickname)}</div><div style="font-size:10px;color:#71717a;">LVL ${u.level||1}</div></div><button class="btn" style="font-size:10px;min-height:28px;" onclick="event.stopPropagation();app.removeFriend('${u.nickname}')">УДАЛИТЬ</button></div>`).join('') : '<div style="font-size:11px;color:#71717a;">Пока нет друзей</div>'}</div>
      <div class="settings-section" style="margin-top:12px;"><h3>ПОДПИСКИ (${subs.length})</h3>${subs.length ? subs.map(u=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;cursor:pointer;" onclick="app.navigate('user', {nickname:'${u.nickname}'})"><div class="avatar">${u.nickname[0].toUpperCase()}</div><div style="flex:1;font-weight:700;font-size:13px;">${this.esc(u.nickname)}</div><div style="font-size:10px;color:#71717a;">${u.subscribers} подписчиков</div></div>`).join('') : '<div style="font-size:11px;color:#71717a;">Нет подписок</div>'}</div>
      <div class="settings-section" style="margin-top:12px;">
        <h3>ДОБАВИТЬ ДРУГА</h3>
        <div style="display:flex;gap:6px;"><input id="friendNick" type="text" placeholder="НИК" style="flex:1;border:var(--border-w) solid var(--border);padding:8px;font-size:13px;"><button class="btn btn-primary" style="font-size:10px;" onclick="app.sendFriendRequest()">ДОБАВИТЬ</button></div>
      </div>
    `;
  },
  async sendFriendRequest() {
    const nick = document.getElementById('friendNick')?.value.trim();
    if (!nick) return;
    try { await apiFetch(`/api/friends/request/${nick}`, { method:'POST' }); showIsland('ЗАЯВКА ОТПРАВЛЕНА', 'violet'); this.renderFriends(); } catch(e){ alert(e.message); }
  },
  async acceptFriend(nick) { try { await apiFetch(`/api/friends/accept/${nick}`, { method:'POST' }); showIsland('ДРУГ ДОБАВЛЕН', 'violet'); this.renderFriends(); } catch(e){ alert(e.message); } },
  async declineFriend(nick) { try { await apiFetch(`/api/friends/decline/${nick}`, { method:'POST' }); this.renderFriends(); } catch(e){ alert(e.message); } },
  async removeFriend(nick) { if(!confirm('Удалить друга?')) return; try { await apiFetch(`/api/friends/${nick}`, { method:'DELETE' }); this.renderFriends(); } catch(e){ alert(e.message); } },

  async renderProfile() {
    const main = document.getElementById('app');
    // тестовый аккаунт в оффлайн-режиме имеет ПОЛНЫЙ профиль и доп функции
    let hist = [];
    try { hist = await apiFetch('/api/history'); } catch (e) { hist = []; }
    if (!Array.isArray(hist)) hist = [];
    const data = await apiFetch(`/api/users/${currentUser.nickname}/videos`);
    const user = data.user;
    const videos = data.videos;
    let notifs = [];
    try {
      const n = await apiFetch('/api/notifications');
      notifs = Array.isArray(n) ? n : (n.notifications && Array.isArray(n.notifications) ? n.notifications : []);
    } catch { notifs = []; }
    main.innerHTML = `
      <div class="profile-head" style="${user.banner ? `background:url(${apiUrl(user.banner)}) center/cover;` : ''}">
        <div class="avatar large" style="${!user.avatar ? `background:${user.avatarColor}` : ''}" onclick="document.getElementById('avatarInput').click()">
          ${user.avatar ? `<img src="${apiUrl(user.avatar)}">` : user.nickname[0].toUpperCase()}
        </div>
        <div style="flex:1;min-width:0;">
          <div class="profile-name" style="display:flex;align-items:center;gap:6px;">${this.esc(user.nickname)} <span style="font-size:10px;background:var(--violet);color:white;padding:2px 4px;">LVL ${user.level||1}</span> ${user.isAdmin?'<span style="font-size:9px;background:black;color:white;padding:2px 4px;">ADMIN</span>':''}</div>
          <div style="font-size:11px; color:#71717a; margin:4px 0;">${user.bio||'Нет био'} • ${user.subscribers||0} подписчиков • ${videos.length} видео • ${user.totalViews||0} просмотров</div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn" style="font-size:10px;min-height:28px;padding:0 8px;" onclick="document.getElementById('avatarInput').click()">АВАТАРКА</button>
            <button class="btn" style="font-size:10px;min-height:28px;padding:0 8px;" onclick="document.getElementById('bannerInput').click()">БАННЕР</button>
            <button class="btn" style="font-size:10px;min-height:28px;padding:0 8px;" onclick="app.logout()">ВЫЙТИ</button>
            ${user.isAdmin?'<button class="btn btn-primary" style="font-size:10px;min-height:28px;" onclick="app.navigate(\'admin\')">АДМИН</button>':''}
          </div>
        </div>
      </div>

      ${localMode() ? `
      <div class="settings-section test-panel">
        <h3>🧪 ОФФЛАЙН ТЕСТ-РЕЖИМ • ДОП ФУНКЦИИ</h3>
        <div class="test-status"><span class="dot-ok"></span> БЕКЕНД НЕ НУЖЕН • ВСЁ В БРАУЗЕРЕ (IndexedDB + localStorage)</div>
        <div class="test-perks">
          <span>✓ Без бэкенда</span><span>✓ Без лимита на размер</span><span>✓ Админка открыта</span>
          <span>✓ Демо-контент с треками</span><span>✓ Загрузка видео/фото/музыки</span><span>✓ Данные не пропадают после перезагрузки</span>
          <span>✓ Проверка загрузки видео в 1 клик</span><span>✓ Смена аватарки/баннера</span>
        </div>
        <div id="testInfo" class="test-info">Загрузка...</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          <button class="btn btn-primary" style="font-size:10px;min-height:32px;" onclick="app.testSeed()">ЗАПОЛНИТЬ ДЕМО</button>
          <button class="btn btn-primary" style="font-size:10px;min-height:32px;" onclick="app.testUploadVideo(this)">ПРОВЕРИТЬ ЗАГРУЗКУ ВИДЕО</button>
          <button class="btn" style="font-size:10px;min-height:32px;" onclick="app.testStorage()">ХРАНИЛИЩЕ</button>
          <button class="btn" style="font-size:10px;min-height:32px;background:#fef2f2;color:#ef4444;" onclick="app.testReset()">СБРОСИТЬ ВСЁ</button>
          <button class="btn btn-primary" style="font-size:10px;min-height:32px;" onclick="app.runSelfTest()">ТЕСТИРОВАТЬ ВСЁ</button>
        </div>
        <div id="selfTestOut" class="self-test-out" style="display:none"></div>
      </div>` : ''}

      <div class="settings-section">
        <h3>НАСТРОЙКИ АККАУНТА</h3>
        <div class="form-row"><label>БИО (до 200)</label><textarea id="bioInput" maxlength="200" placeholder="О себе...">${this.esc(user.bio||'')}</textarea></div>
        <div class="form-row"><label>ТЕМА</label><div class="theme-options">
          <div class="theme-option ${user.theme==='light'?'active':''}" onclick="app.setTheme('light')">LIGHT</div>
          <div class="theme-option ${user.theme==='dark'?'active':''}" onclick="app.setTheme('dark')">DARK</div>
          <div class="theme-option ${user.theme==='black'?'active':''}" onclick="app.setTheme('black')">BLACK</div>
        </div></div>
        <div class="form-row"><label>АКЦЕНТ</label><div class="theme-options">
          <div class="theme-option ${user.accent==='violet'?'active':''}" onclick="app.setAccent('violet')" style="background:#7c3aed;color:white;">VIOLET</div>
          <div class="theme-option ${user.accent==='green'?'active':''}" onclick="app.setAccent('green')" style="background:#22c55e;color:white;">GREEN</div>
          <div class="theme-option ${user.accent==='red'?'active':''}" onclick="app.setAccent('red')" style="background:#ef4444;color:white;">RED</div>
          <div class="theme-option ${user.accent==='blue'?'active':''}" onclick="app.setAccent('blue')" style="background:#3b82f6;color:white;">BLUE</div>
          <div class="theme-option ${user.accent==='pink'?'active':''}" onclick="app.setAccent('pink')" style="background:#db2777;color:white;">PINK</div>
          <div class="theme-option ${user.accent==='orange'?'active':''}" onclick="app.setAccent('orange')" style="background:#ea580c;color:white;">ORANGE</div>
          <div class="theme-option ${user.accent==='cyan'?'active':''}" onclick="app.setAccent('cyan')" style="background:#0891b2;color:white;">CYAN</div>
          <div class="theme-option ${user.accent==='lime'?'active':''}" onclick="app.setAccent('lime')" style="background:#65a30d;color:white;">LIME</div>
          <div class="theme-option ${user.accent==='amber'?'active':''}" onclick="app.setAccent('amber')" style="background:#d97706;color:white;">AMBER</div>
          <div class="theme-option ${user.accent==='fuchsia'?'active':''}" onclick="app.setAccent('fuchsia')" style="background:#c026d3;color:white;">FUCHSIA</div>
        </div></div>
        <button class="btn btn-primary" style="margin-top:10px;font-size:11px;" onclick="app.saveProfile()">СОХРАНИТЬ</button>
      </div>

      <div class="settings-section">
        <h3>СМЕНА НИКА (раз в день)</h3>
        <div style="display:flex;gap:6px;"><input id="newNickInput" type="text" placeholder="НОВЫЙ НИК" style="flex:1;border:var(--border-w) solid var(--border);padding:8px;font-size:13px;"><button class="btn btn-primary" style="font-size:10px;" onclick="app.changeNickname()">СМЕНИТЬ</button></div>
        <div style="font-size:10px;color:#71717a;margin-top:6px;">Последняя смена: ${user.nicknameChangedAt ? this.timeAgo(user.nicknameChangedAt) : 'никогда'}</div>
      </div>

      <div class="settings-section">
        <h3>УВЕДОМЛЕНИЯ (${notifs.filter(n=>!n.read).length} новых)</h3>
        ${notifs.length ? notifs.slice(0,10).map(n=>`<div class="profile-notif ${n.read?'':'unread'}"><div class="notif-text">${this.esc(this.notifText(n))}</div><div class="notif-time">${this.timeAgo(n.createdAt)}</div></div>`).join('') : '<div style="font-size:11px;color:#71717a;">Нет уведомлений</div>'}
        ${notifs.length ? '<button class="btn" style="margin-top:8px;font-size:10px;min-height:28px;" onclick="app.readNotifications()">ПРОЧИТАТЬ ВСЕ</button>' : ''}
      </div>

      ${hist.length ? `
      <div class="settings-section" style="margin-top:12px;">
        <h3>НЕДАВНО ПРОСМОТРЕННОЕ • ${hist.length}</h3>
        ${hist.slice(0, 6).map(h => `
          <div class="prof-hist-row" onclick="app.navigate('watch', {id:'${h.id}'})">
            <div class="prof-hist-thumb">${h.contentType === 'music' || h.contentType === 'artist_music' ? '♫' : '▶'}</div>
            <div style="flex:1;min-width:0;">
              <div class="prof-hist-title">${this.esc(h.title)}</div>
              <div class="prof-hist-sub">${this.timeAgo(h.watchedAt)}${h.position > 5 && h.duration > 0 ? ` • на ${this._fmtTime(h.position)}` : ''}</div>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="hub-line"><a class="hub-pill" href="https://grapegg-developer.github.io/RoboBattle-Web/" target="_blank" rel="noopener">GRAPESCRIPT HUB<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg></a></div>

      <div class="chip-center" style="display:flex;gap:6px;margin-top:12px;overflow-x:auto;">
        <button class="btn ${'btn-primary'}" style="font-size:10px;min-height:32px;white-space:nowrap;" onclick="app.navigate('profile')">ВИДЕО</button>
        <button class="btn" style="font-size:10px;min-height:32px;white-space:nowrap;" onclick="app.navigate('history')">ИСТОРИЯ</button>
        <button class="btn" style="font-size:10px;min-height:32px;white-space:nowrap;" onclick="app.navigate('favorites')">ИЗБРАННОЕ</button>
        <button class="btn" style="font-size:10px;min-height:32px;white-space:nowrap;" onclick="app.navigate('playlists')">ПЛЕЙЛИСТЫ</button>
        <button class="btn" style="font-size:10px;min-height:32px;white-space:nowrap;" onclick="app.navigate('friends')">ДРУЗЬЯ</button>
      </div>

      ${videos.length ? `<div class="video-grid" style="padding-top:12px;">${videos.map((v,i)=>this.videoCard(v,i)).join('')}</div>` : `<div class="empty"><h2>Пока пусто...</h2></div>`}
    `;
    const avInput = document.getElementById('avatarInput');
    if (avInput) avInput.onchange = e => this.uploadAvatar(e.target.files[0]);
    const bannerInput = document.getElementById('bannerInput');
    if (bannerInput) bannerInput.onchange = e => this.uploadBanner(e.target.files[0]);
    if (localMode()) this.testStorage();
  },
  async saveProfile() {
    const bio = document.getElementById('bioInput')?.value.trim();
    try {
      await apiFetch('/api/me', { method:'PUT', body: JSON.stringify({ bio }) });
      showIsland('СОХРАНЕНО', 'violet');
      this.renderProfile();
    } catch(e){ alert(e.message); }
  },
  async setTheme(theme) {
    localStorage.setItem(LS_THEME, theme);
    try { await apiFetch('/api/me', { method:'PUT', body: JSON.stringify({ theme }) }); } catch {}
    this.applyTheme();
    showIsland(`ТЕМА: ${theme.toUpperCase()}`, 'violet');
    this.renderProfile();
  },
  async setAccent(accent) {
    localStorage.setItem(LS_ACCENT, accent);
    try { await apiFetch('/api/me', { method:'PUT', body: JSON.stringify({ accent }) }); } catch {}
    document.body.setAttribute('data-accent', accent);
    showIsland(`АКЦЕНТ: ${accent.toUpperCase()}`, 'violet');
  },
  async changeNickname() {
    const newNick = document.getElementById('newNickInput')?.value.trim();
    if (!newNick) return;
    try {
      const res = await apiFetch('/api/me/change-nickname', { method:'POST', body: JSON.stringify({ newNickname: newNick }) });
      setToken(res.token);
      currentUser.nickname = res.new;
      showIsland(`НИК: ${res.new}`, 'violet');
      this.renderProfile();
    } catch(e){ alert(e.message); }
  },
  async readNotifications() {
    try { await apiFetch('/api/notifications/read', { method:'POST' }); this.renderProfile(); } catch(e){}
  },

  async renderUser(nickname) {
    const main = document.getElementById('app');
    const data = await apiFetch(`/api/users/${nickname}/videos`);
    const isFriend = currentUser?.friends?.includes(data.user.id);
    const isSubscribed = currentUser?.subscriptions?.includes(data.user.id);
    main.innerHTML = `
      <div class="profile-head" style="${data.user.banner ? `background:url(${apiUrl(data.user.banner)}) center/cover;` : ''}">
        <div class="avatar large" style="${!data.user.avatar ? `background:${data.user.avatarColor}` : ''}">
          ${data.user.avatar ? `<img src="${apiUrl(data.user.avatar)}">` : data.user.nickname[0].toUpperCase()}
        </div>
        <div style="flex:1;min-width:0;">
          <div class="profile-name">${this.esc(data.user.nickname)} <span style="font-size:10px;background:var(--violet);color:white;padding:2px 4px;">LVL ${data.user.level||1}</span></div>
          <div style="font-size:11px; color:#71717a;">${this.esc(data.user.bio||'')} • ${data.user.subscribers||0} подписчиков • ${data.videos.length} видео</div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
            <button class="btn ${isSubscribed?'btn-primary':''}" style="font-size:10px;min-height:28px;" onclick="app.subscribe('${data.user.nickname}')">${isSubscribed?'ОТПИСАТЬСЯ':'ПОДПИСАТЬСЯ'}</button>
            <button class="btn ${isFriend?'btn-primary':''}" style="font-size:10px;min-height:28px;" onclick="app.toggleFriend('${data.user.nickname}')">${isFriend?'ДРУЗЬЯ':'В ДРУЗЬЯ'}</button>
            <button class="btn" style="font-size:10px;min-height:28px;" onclick="app.navigate('home')">НАЗАД</button>
          </div>
        </div>
      </div>
      ${data.videos.length ? `<div class="video-grid">${data.videos.map((v,i)=>this.videoCard(v,i)).join('')}</div>` : `<div class="empty"><h2>Пока пусто...</h2></div>`}
    `;
  },
  async subscribe(nick) {
    try { const res = await apiFetch(`/api/subscribe/${nick}`, { method:'POST' }); showIsland(res.subscribed?'ПОДПИСАЛСЯ':'ОТПИСАЛСЯ', 'violet'); this.renderUser(nick); } catch(e){ alert(e.message); }
  },
  async toggleFriend(nick) {
    try {
      // check if friends
      const friends = await apiFetch('/api/friends');
      const isFriend = friends.friends.some(f=>f.nickname.toLowerCase()===nick.toLowerCase());
      if (isFriend) {
        await apiFetch(`/api/friends/${nick}`, { method:'DELETE' });
        showIsland('УДАЛЕН ИЗ ДРУЗЕЙ', '');
      } else {
        await apiFetch(`/api/friends/request/${nick}`, { method:'POST' });
        showIsland('ЗАЯВКА ОТПРАВЛЕНА', 'violet');
      }
    } catch(e){ alert(e.message); }
  },

  async renderUpload() {
    const main = document.getElementById('app');
    const offline = localMode();

    selectedVideoFile = null;
    selectedThumbFile = null;
    selectedCoverFile = null;

    main.innerHTML = `
      <div class="upload-page">
        <div class="upload-title"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> ЗАГРУЗКА • ФОТО • GIF • МУЗЫКА • ТРЕКИ АРТИСТОВ</div>
        ${offline ? `<div class="offline-banner"><b>ОФФЛАЙН ТЕСТ-РЕЖИМ</b> • всё сохраняется в браузере (IndexedDB), бэкенд не нужен • без лимита по размеру</div>` : `${this._storageCfg && this._storageCfg.persistent === false ? '<div class="warn-banner"><b>ФАЙЛЫ ХРАНЯТСЯ НА СЕРВЕРЕ БЕЗ ОБЛАКА</b> • после перезапуска хостинга загрузки пропадут • для постоянного хранения задай CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET</div>' : ''}`}
        <div class="upload-box" id="uploadFormBox">
          <div class="form-row" style="margin-top:0">
            <label><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> НАЗВАНИЕ</label>
            <input id="upTitle" type="text" placeholder="">
          </div>
          <div class="form-row">
            <label><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> ОПИСАНИЕ + ТАЙМКОДЫ (00:12 интро)</label>
            <textarea id="upDesc" placeholder="Описание... 00:00 начало"></textarea>
          </div>
          <div class="form-row">
            <label><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> ТИП КОНТЕНТА</label>
            <select id="upContentType" style="width:100%;border:var(--border-w) solid var(--border);padding:10px;font-size:13px;">
              <optgroup label="ВИДЕО">
                <option value="video">▶️ ВИДЕО</option>
              </optgroup>
              <optgroup label="ИЗОБРАЖЕНИЯ">
                <option value="image">🖼️ ФОТО / КАРТИНКА</option>
                <option value="gif">🎞️ GIF</option>
              </optgroup>
              <optgroup label="МУЗЫКА">
                <option value="music">♫ ПРОСТО МУЗЫКА</option>
                <option value="artist_music">🎤 АРТИСТ — ТРЕК + ОБЛОЖКА</option>
              </optgroup>
            </select>
          </div>

          <div id="artistSection" class="artist-section" style="display:none">
            <div class="artist-section-title">🎤 ТРЕК АРТИСТА • СТАТИЧНАЯ ОБЛОЖКА ВМЕСТО ВИДЕО</div>
            <div class="form-row">
              <label>ИМЯ АРТИСТА</label>
              <input id="upArtist" type="text" placeholder="Например: artist_vibe" maxlength="60">
            </div>
            <div class="form-row">
              <label>АЛЬБОМ / РЕЛИЗ (необязательно)</label>
              <input id="upAlbum" type="text" placeholder="Например: Offline EP" maxlength="80">
            </div>
            <div class="form-row">
              <label>ОБЛОЖКА ТРЕКА (статичное изображение)</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn" style="font-size:10px;min-height:32px;" onclick="document.getElementById('coverInput').click()">ВЫБРАТЬ ОБЛОЖКУ</button>
                <span id="coverStatus" style="font-size:10px;color:#71717a;">Не выбрана</span>
              </div>
              <div id="coverPreview" style="display:none;margin-top:8px;"><img id="coverPreviewImg" style="width:120px;height:120px;object-fit:cover;border:var(--border-w) solid var(--violet);"></div>
            </div>
            <div class="artist-hint">Как у артистов: трек проигрывается, а на экране статичная картинка-обложка.</div>
          </div>
          <input id="coverInput" type="file" accept="image/*" style="display:none">

          <div id="dropZone" class="video-drop" style="margin-top:14px;">
            <div style="font-weight:800; font-size:12px;display:flex;align-items:center;justify-content:center;gap:6px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> ВЫБЕРИ ФАЙЛ • ВИДЕО • ФОТО • GIF • MP3</div>
            <div id="videoFileName" style="margin-top:8px; font-weight:700; font-size:11px;"></div>
          </div>

          <div id="previewSection" class="preview-section" style="display:none">
            <div style="font-size:10px; font-weight:800; text-transform:uppercase; margin-bottom:6px;">ПРЕВЬЮ ИЗ КАДРА</div>
            <div class="preview-video-wrap">
              <video id="sourceVideo" muted playsinline></video>
            </div>
            <div class="frame-controls">
              <input id="frameSlider" class="frame-slider" type="range" min="0" max="100" value="0">
              <button class="btn" style="font-size:10px;min-height:28px;" onclick="app.captureFrame()">КАДР</button>
              <button class="btn" style="font-size:10px;min-height:28px;" onclick="app.captureRandomFrame()">РАНДОМ</button>
            </div>
            <div class="thumb-options">
              <div class="thumb-option" onclick="document.getElementById('customThumbInput').click()">СВОЕ ПРЕВЬЮ</div>
              <div class="thumb-option" onclick="app.useCurrentFrame()">КАДР</div>
            </div>
            <div id="thumbPreview" class="thumb-preview" style="display:none">
              <img id="thumbPreviewImg">
            </div>
            <div id="thumbStatus" style="font-size:10px; color:#71717a; margin-top:6px;">Кадр не выбран</div>
          </div>

          <div id="upError" class="error" style="display:none; margin-top:10px;"></div>
          <button id="upBtn" class="btn btn-primary btn-block" style="margin-top:14px;" onclick="app.doUpload()">ЗАГРУЗИТЬ</button>
          <button class="btn btn-block" style="margin-top:6px;" onclick="app.navigate('home')">ОТМЕНА</button>
        </div>

        <div id="uploadingState" class="uploading-state" style="display:none">
          <div style="font-weight:800; font-size:13px; text-transform:uppercase; margin-bottom:10px;">ЗАГРУЗКА...</div>
          <div class="uploading-bar">
            <div id="upBar" class="uploading-bar-fill"></div>
          </div>
          <div id="uploadingPercent" style="font-family:'JetBrains Mono', monospace; font-size:11px; margin-top:6px;">0%</div>
          
          <div id="uploadPreviewCard" class="video-preview-card" style="display:none">
            <div class="thumb">
              <img id="uploadPreviewThumb" style="display:none">
              <div id="uploadPreviewPlaceholder" class="thumb-placeholder">ЛОЛ ТУБ</div>
            </div>
            <div class="video-info">
              <div id="uploadPreviewTitle" class="video-title">Название</div>
              <div style="font-size:11px; color:#71717a; margin-top:4px;">Так будет выглядеть</div>
            </div>
          </div>
        </div>
      </div>
      <input id="customThumbInput" type="file" accept="image/*" style="display:none">
      <canvas id="frameCanvas" style="display:none"></canvas>
    `;

    frameCanvas = document.getElementById('frameCanvas');

    // ---- МУЗЫКА АРТИСТА: поля артист/альбом/обложка ----
    const typeSel = document.getElementById('upContentType');
    const artistSec = document.getElementById('artistSection');
    const coverInput = document.getElementById('coverInput');
    const syncType = () => {
      const t = typeSel ? typeSel.value : 'video';
      const isMusic = (t === 'music' || t === 'artist_music');
      if (artistSec) artistSec.style.display = (t === 'artist_music') ? 'block' : 'none';
      const ps = document.getElementById('previewSection');
      if (ps && isMusic) ps.style.display = 'none';
    };
    if (typeSel) typeSel.onchange = syncType;
    syncType();
    if (coverInput) {
      coverInput.onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        selectedCoverFile = f;
        const r = new FileReader();
        r.onload = (ev) => {
          const box = document.getElementById('coverPreview');
          const img = document.getElementById('coverPreviewImg');
          const st = document.getElementById('coverStatus');
          if (box) box.style.display = 'block';
          if (img) img.src = ev.target.result;
          if (st) st.textContent = f.name + ' (' + (f.size / 1024).toFixed(0) + ' KB)';
        };
        r.readAsDataURL(f);
      };
    }

    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
      dropZone.onclick = () => this.triggerVideoSelect();
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.background='#ede9fe'; });
      dropZone.addEventListener('dragleave', () => dropZone.style.background='');
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.style.background='';
        const file = e.dataTransfer.files[0];
        if (file) this.handleVideoFile(file);
      });
    }
    const customThumb = document.getElementById('customThumbInput');
    if (customThumb) {
      customThumb.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        selectedThumbFile = file;
        const reader = new FileReader();
        reader.onload = ev => {
          const prev = document.getElementById('thumbPreview');
          const img = document.getElementById('thumbPreviewImg');
          const status = document.getElementById('thumbStatus');
          if (prev) prev.style.display='block';
          if (img) img.src = ev.target.result;
          if (status) status.textContent = 'Свое превью выбрано';
        };
        reader.readAsDataURL(file);
      };
    }
  },

  triggerVideoSelect() {
    const type = document.getElementById('upContentType')?.value || 'video';
    let accept = 'video/*';
    if (type==='image') accept='image/*';
    else if (type==='gif') accept='image/gif';
    else if (type==='music' || type==='artist_music') accept='audio/*';
    else accept='video/*,image/*,audio/*';
    const input = document.createElement('input');
    input.type='file';
    input.accept=accept;
    input.onchange = e => {
      const file = e.target.files[0];
      if (file) this.handleVideoFile(file);
    };
    input.click();
  },

  handleVideoFile(file) {
    selectedVideoFile = file;
    const nameEl = document.getElementById('videoFileName');
    if (nameEl) nameEl.textContent = `${file.name} (${(file.size/1024/1024).toFixed(1)} MB) • ${file.type}`;
    const dz = document.getElementById('dropZone');
    if (dz) dz.classList.add('has-file');
    const previewSection = document.getElementById('previewSection');
    if (previewSection && file.type.startsWith('video/')) {
      previewSection.style.display='block';
      const video = document.getElementById('sourceVideo');
      if (!video) return;
      const url = URL.createObjectURL(file);
      video.src = url;
      video.load();
      video.onloadedmetadata = () => {
        const slider = document.getElementById('frameSlider');
        if (slider) {
          slider.max = Math.floor(video.duration * 10);
          slider.value = Math.floor(video.duration * 10 * 0.1);
        }
        video.currentTime = video.duration * 0.1;
        setTimeout(() => this.captureRandomFrame(), 800);
      };
      const slider = document.getElementById('frameSlider');
      if (slider) {
        slider.oninput = () => {
          if (video.duration) video.currentTime = slider.value / 10;
        };
      }
    }
  },

  captureFrame() {
    const video = document.getElementById('sourceVideo');
    if (!video || !video.videoWidth) return;
    const canvas = frameCanvas;
    if (!canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) return;
      const file = new File([blob], 'thumb.jpg', { type:'image/jpeg' });
      selectedThumbFile = file;
      const url = URL.createObjectURL(blob);
      const prev = document.getElementById('thumbPreview');
      const img = document.getElementById('thumbPreviewImg');
      const status = document.getElementById('thumbStatus');
      if (prev) prev.style.display='block';
      if (img) img.src = url;
      if (status) status.textContent = `Кадр: ${video.currentTime.toFixed(1)}с`;
    }, 'image/jpeg', 0.85);
  },

  captureRandomFrame() {
    const video = document.getElementById('sourceVideo');
    if (!video || !video.duration) return;
    const randomTime = Math.random() * Math.min(video.duration, 10) + 0.2;
    video.currentTime = randomTime;
    video.onseeked = () => {
      this.captureFrame();
      video.onseeked = null;
    };
  },

  useCurrentFrame() { this.captureFrame(); },

  async doUpload() {
    const titleEl = document.getElementById('upTitle');
    const descEl = document.getElementById('upDesc');
    const typeEl = document.getElementById('upContentType');
    const title = titleEl ? titleEl.value.trim() : '';
    const desc = descEl ? descEl.value.trim() : '';
    const contentType = typeEl ? typeEl.value : 'video';
    const errEl = document.getElementById('upError');
    const formBox = document.getElementById('uploadFormBox');
    const uploadingState = document.getElementById('uploadingState');
    const bar = document.getElementById('upBar');
    const percentEl = document.getElementById('uploadingPercent');
    const previewCard = document.getElementById('uploadPreviewCard');
    const previewTitle = document.getElementById('uploadPreviewTitle');
    const previewThumb = document.getElementById('uploadPreviewThumb');
    const previewPlaceholder = document.getElementById('uploadPreviewPlaceholder');

    if (!selectedVideoFile) { errEl.textContent='Выбери файл'; errEl.style.display='block'; return; }
    if (!title || !title.trim()) { errEl.textContent='Введи название'; errEl.style.display='block'; return; }

    if (!selectedThumbFile && contentType==='video') {
      const video = document.getElementById('sourceVideo');
      if (video && video.videoWidth && frameCanvas) {
        const canvas = frameCanvas;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
        if (blob) selectedThumbFile = new File([blob], 'thumb.jpg', { type:'image/jpeg' });
      }
    }

    errEl.style.display='none';
    if (formBox) formBox.style.display='none';
    if (uploadingState) uploadingState.style.display='block';
    if (previewCard) previewCard.style.display='block';
    if (previewTitle) previewTitle.textContent = title;
    if (selectedThumbFile && previewThumb && previewPlaceholder) {
      const url = URL.createObjectURL(selectedThumbFile);
      previewThumb.src = url;
      previewThumb.style.display='block';
      previewPlaceholder.style.display='none';
    }

    const form = new FormData();
    form.append('video', selectedVideoFile);
    if (selectedThumbFile) form.append('thumbnail', selectedThumbFile);
    if (selectedCoverFile) form.append('cover', selectedCoverFile);
    form.append('title', title);
    form.append('description', desc);
    form.append('contentType', contentType);
    // МУЗЫКА АРТИСТА
    const artistEl = document.getElementById('upArtist');
    const albumEl = document.getElementById('upAlbum');
    if (contentType === 'artist_music') {
      form.append('artist', artistEl ? artistEl.value.trim() : (currentUser ? currentUser.nickname : ''));
      form.append('album', albumEl ? albumEl.value.trim() : '');
      // если отдельная обложка не выбрана - используем превью как обложку
      if (!selectedCoverFile && selectedThumbFile) form.append('cover', selectedThumbFile);
    }

    try {
      // ОФФЛАЙН ТЕСТ-РЕЖИМ: грузим в IndexedDB браузера, бэкенд не нужен
      if (localMode()) {
        const data = await LM.upload(form, (pct) => {
          const p = Math.round(pct);
          if (bar) bar.style.width = p + '%';
          if (percentEl) percentEl.textContent = p + '%';
        });
        showIsland('ЗАГРУЖЕНО В БРАУЗЕР!', 'violet');
        this.navigate('watch', { id: data.id });
        return;
      }
      const xhr = new XMLHttpRequest();
      const promise = new Promise((resolve, reject) => {
        xhr.upload.onprogress = e => {
          if (e.lengthComputable && bar) {
            const pct = Math.round(e.loaded/e.total*100);
            bar.style.width = pct+'%';
            if (percentEl) percentEl.textContent = pct+'%';
          }
        };
        xhr.onload = () => {
          if (xhr.status>=200 && xhr.status<300) {
            try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
          } else {
            try { const d=JSON.parse(xhr.responseText); reject(new Error(d.error||'Ошибка')); } catch { reject(new Error('Ошибка загрузки')); }
          }
        };
        xhr.onerror = () => reject(new Error('Сеть упала'));
        xhr.open('POST', apiUrl('/api/videos/upload'));
        const token = getToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(form);
      });
      const data = await promise;
      showIsland('ЗАГРУЖЕНО!', 'violet');
      this.navigate('watch', {id: data.id});
    } catch (e) {
      if (e && e.status === 401) {
        clearToken();
        currentUser=null;
        this.showLogin();
        return;
      }
      if (formBox) formBox.style.display='block';
      if (uploadingState) uploadingState.style.display='none';
      errEl.textContent = e.message;
      errEl.style.display='block';
    }
  },

  // ---------- МУЗЫКА АРТИСТА: статичная обложка вместо видео ----------
  musicPlayerHtml(video, src, cover) {
    const hasAudio = !!src;
    const coverAttr = cover ? `style="background-image:url('${cover}')"` : '';
    return `
      <div class="music-player">
        <div class="music-bg" ${coverAttr}></div>
        <div class="music-stage">
          <div class="music-cover ${cover ? '' : 'no-cover'}" ${coverAttr}>
            <div class="music-disc-ring"></div>
            <div class="music-disc-ring r2"></div>
            <div class="music-disc-hole"></div>
            ${cover ? '' : '<div class="music-ph-icon">♫</div>'}
          </div>
        </div>
        <div class="music-eq-big" id="mEq"><span></span><span></span><span></span><span></span><span></span></div>
        <div class="music-meta">
          <div class="music-title">${this.esc(video.title)}</div>
          <div class="music-sub">${this.esc(video.artist || video.authorNickname)}${video.album ? ` • ${this.esc(video.album)}` : ''}</div>
        </div>
        ${hasAudio ? '' : `<div class="music-noaudio">НЕТ АУДИОФАЙЛА В ЭТОЙ ЗАПИСИ</div>`}
        <div class="music-controls">
          <span class="ctrl-spacer"></span>
          <button class="m-btn" id="mPlayBtn" title="Играть / пауза">▶</button>
          <button class="m-btn m-sm" id="mBackBtn" title="Назад 10 секунд">-10</button>
          <button class="m-btn m-sm" id="mFwdBtn" title="Вперёд 10 секунд">+10</button>
          <span class="ctrl-spacer"></span>
          <button class="m-btn m-sm" id="mGearBtn" title="Настройки"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2.2" fill="currentColor" stroke="none"/></svg></button>
          <button class="m-btn m-sm" id="mFsBtn" title="Во весь экран"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
        </div>
        <div class="player-settings music-settings" id="musicSettings">
          <div class="ps-row ps-btns">
            <button class="m-btn m-sm" id="mLoopBtn" title="Повтор трека"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></button>
            <button class="m-btn m-sm" id="mSleepBtn" title="Таймер сна"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>
            <button class="m-btn m-sm" id="mShuffleBtn" title="Перемешать"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg></button>
            <button class="m-btn m-sm" id="mRepeatBtn" title="Повторять все"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12a10 10 0 0 1 10-10h8"/><path d="M22 12a10 10 0 0 1-10 10H4"/><path d="m18 2 4 4-4 4"/><path d="m6 22-4-4 4-4"/></svg></button>
            <button class="m-btn m-sm" id="mNextBtn" title="Следующий трек"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button>
            <button class="m-btn m-sm" id="mDlBtn" title="Скачать"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
          </div>
        </div>
        <div class="m-seek"><input id="mSeek" type="range" min="0" max="1000" value="0"></div>
        <div class="m-time"><span id="mCur">0:00</span><span id="mDur">0:00</span></div>
      </div>`;
  },

  // ---------- ОБЩИЙ АУДИО-СИНГЛТОН + МИНИ-ПЛЕЕР ----------
  getSharedAudio(src) {
    if (!this._musicAudio) {
      const a = new Audio();
      this._musicAudio = a;
      const sync = () => this._syncMusicUI();
      a.addEventListener('play', sync);
      a.addEventListener('pause', sync);
      a.addEventListener('ended', () => { sync(); this.musicAutoNext(); });
      a.addEventListener('loadedmetadata', sync);
      a.addEventListener('timeupdate', () => this._syncMusicUI(true));
    }
    const a = this._musicAudio;
    if (src && a.dataset.src !== src) {
      a.dataset.src = src;
      try { a.src = src; a.currentTime = 0; } catch (e) {}
    }
    return a;
  },

  _fmtTime(t) {
    if (!isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60), sec = Math.floor(t % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  },

  _syncMusicUI() {
    const a = this._musicAudio;
    if (!a) return;
    const on = !a.paused && !a.ended;
    // полный плеер (если открыта страница трека)
    const playBtn = document.getElementById('mPlayBtn');
    const eq = document.getElementById('mEq');
    const seek = document.getElementById('mSeek');
    const cur = document.getElementById('mCur');
    const dur = document.getElementById('mDur');
    if (playBtn) playBtn.textContent = on ? '❚❚' : '▶';
    if (eq) eq.classList.toggle('playing', on);
    if (dur && a.duration) dur.textContent = this._fmtTime(a.duration);
    if (cur) cur.textContent = this._fmtTime(a.currentTime);
    if (seek && a.duration) {
      seek.value = Math.round(a.currentTime / a.duration * 1000);
      const p = (a.currentTime / a.duration) * 100;
      seek.style.background = `linear-gradient(to right, var(--violet) ${p}%, rgba(255,255,255,0.14) ${p}%)`;
    }
    // мини-плеер
    const mini = document.getElementById('miniPlayer');
    if (mini) {
      const mp = document.getElementById('miniPlayBtn');
      if (mp) mp.textContent = on ? '❚❚' : '▶';
      const bar = document.getElementById('miniProgress');
      if (bar && a.duration) bar.style.width = ((a.currentTime / a.duration) * 100) + '%';
      const mt = document.getElementById('miniTime');
      if (mt) mt.textContent = this._fmtTime(a.currentTime);
    }
  },

  updateMiniPlayer() {
    const a = this._musicAudio;
    const hash = window.location.hash.slice(1);
    const onTrack = !!(this._musicVideoId) && hash === 'watch/' + this._musicVideoId;
    const show = !!(a && this._musicMeta && !a.ended && !onTrack);
    let bar = document.getElementById('miniPlayer');
    if (show && !bar) {
      bar = document.createElement('div');
      bar.id = 'miniPlayer';
      bar.className = 'mini-player';
      bar.innerHTML = `
        <div class="mini-progress"><div id="miniProgress"></div></div>
        <div class="mini-cover" onclick="app.navigate('watch', {id:app._musicVideoId})"></div>
        <div class="mini-info" onclick="app.navigate('watch', {id:app._musicVideoId})">
          <div class="mini-title"></div><div class="mini-sub"></div>
        </div>
        <span id="miniTime" class="mini-time">0:00</span>
        <button id="miniPlayBtn" class="mini-btn">▶</button>
        <button id="miniCloseBtn" class="mini-btn">✕</button>`;
      document.body.appendChild(bar);
      document.getElementById('miniPlayBtn').onclick = (e) => { e.stopPropagation(); this.toggleMusic(); };
      document.getElementById('miniCloseBtn').onclick = (e) => { e.stopPropagation(); this.closeMiniPlayer(); };
    }
    if (!show && bar) { bar.remove(); bar = null; }
    if (bar && this._musicMeta) {
      const cov = bar.querySelector('.mini-cover');
      if (cov) cov.style.backgroundImage = this._musicMeta.cover ? `url('${this._musicMeta.cover}')` : '';
      const t = bar.querySelector('.mini-title'); if (t) t.textContent = this._musicMeta.title || '';
      const sub = bar.querySelector('.mini-sub'); if (sub) sub.textContent = this._musicMeta.sub || '';
    }
    this._syncMusicUI();
  },

  toggleMusic() {
    const a = this._musicAudio;
    if (!a) return;
    if (a.paused) { const pr = a.play(); if (pr && pr.catch) pr.catch(() => {}); }
    else a.pause();
    this._syncMusicUI();
  },

  closeMiniPlayer() {
    const a = this._musicAudio;
    if (a && this._musicVideoId && a.currentTime > 1) this.savePosition(this._musicVideoId, a.currentTime, a.duration || 0);
    if (this._mPosT) { clearInterval(this._mPosT); this._mPosT = null; }
    if (a) { try { a.pause(); } catch (e) {} try { a.src = ''; a.dataset.src = ''; } catch (e) {} }
    this._musicMeta = null;
    this._musicVideoId = null;
    const bar = document.getElementById('miniPlayer');
    if (bar) bar.remove();
  },

  async buildMusicQueue(current) {
    try {
      const all = await apiFetch('/api/videos');
      const musics = (Array.isArray(all) ? all : []).filter(v => v.contentType === 'music' || v.contentType === 'artist_music');
      const idx = musics.findIndex(v => v.id === current.id);
      this._musicQueue = musics;
      this._queueIdx = idx >= 0 ? idx : 0;
    } catch (e) { this._musicQueue = []; this._queueIdx = 0; }
    const n = (this._musicQueue || []).length;
    if (n > 1 && this._musicMeta) { this._musicMeta.sub = (this._musicMeta.sub || '') + ` • ${this._queueIdx + 1}/${n}`; }
    this.updateMiniPlayer();
  },

  playQueueNext() {
    const q = this._musicQueue || [];
    if (!q.length) return;
    let i;
    if (this._shuffle) i = Math.floor(Math.random() * q.length);
    else i = (this._queueIdx + 1) % q.length;
    this._queueIdx = i;
    this.navigate('watch', { id: q[i].id });
  },

  musicAutoNext() {
    const a = this._musicAudio;
    if (a && a.loop) return;               // повтор одного трека
    const q = this._musicQueue || [];
    if (q.length < 2) return;
    if (this._queueIdx >= q.length - 1 && !this._repeatAll && !this._shuffle) return; // конец очереди
    this.playQueueNext();
  },

  sleepIcon() {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  },

  setSleepTimer(btn) {
    const steps = [0, 15, 30, 60];
    const curMin = this._sleepMin || 0;
    const next = steps[(steps.indexOf(curMin) + 1) % steps.length];
    this._sleepMin = next;
    if (this._sleepT) { clearTimeout(this._sleepT); this._sleepT = null; }
    if (next > 0) {
      this._sleepT = setTimeout(() => {
        const a = this._musicAudio;
        if (a) a.pause();
        this._sleepMin = 0;
        this._syncMusicUI();
        const b = document.getElementById('mSleepBtn');
        if (b) { b.classList.remove('on'); b.innerHTML = this.sleepIcon(); }
      }, next * 60000);
    }
    if (btn) {
      btn.classList.toggle('on', next > 0);
      if (next > 0) btn.textContent = next + 'м'; else btn.innerHTML = this.sleepIcon();
    }
  },

  initMusicPlayer(video) {
    const videoSrc = this.getFileUrl(video.cloudinaryUrl || video.filename);
    const a = videoSrc ? this.getSharedAudio(videoSrc) : null;
    this._musicVideoId = video.id;
    this._musicMeta = {
      title: video.title,
      sub: (video.artist || video.authorNickname) + (video.album ? ' • ' + video.album : ''),
      cover: this.getFileUrl(video.cloudinaryThumbUrl || video.cover || video.thumbnail)
    };
    const playBtn = document.getElementById('mPlayBtn');
    const seek = document.getElementById('mSeek');
    const loopBtn = document.getElementById('mLoopBtn');
    const sleepBtn = document.getElementById('mSleepBtn');
    const dl = document.getElementById('mDlBtn');
    if (dl) dl.onclick = () => this.downloadVideo(video.id);
    if (sleepBtn) { sleepBtn.classList.toggle('on', (this._sleepMin || 0) > 0); if ((this._sleepMin || 0) > 0) sleepBtn.textContent = this._sleepMin + 'м'; sleepBtn.onclick = () => this.setSleepTimer(sleepBtn); }
    if (!a) { if (playBtn) playBtn.disabled = true; this.updateMiniPlayer(); return; }
    if (loopBtn) { loopBtn.classList.toggle('on', !!a.loop); loopBtn.onclick = () => { a.loop = !a.loop; loopBtn.classList.toggle('on', a.loop); }; }
    if (playBtn) playBtn.onclick = () => this.toggleMusic();
    this.buildMusicQueue(video);
    const savedPos = Number(video.watchPosition) || 0;
    if (savedPos > 5 && (Number(video.watchDuration) || 0) > savedPos + 10) {
      try { a.currentTime = savedPos; } catch (e) {}
      showIsland('ПРОДОЛЖАЕМ С ' + this._fmtTime(savedPos), 'violet');
    }
    if (this._mPosT) clearInterval(this._mPosT);
    this._mPosT = setInterval(() => {
      if (this._musicVideoId && !a.paused && a.currentTime > 1) this.savePosition(this._musicVideoId, a.currentTime, a.duration || 0);
    }, 10000);
    const sh = document.getElementById('mShuffleBtn');
    const rp = document.getElementById('mRepeatBtn');
    const nx = document.getElementById('mNextBtn');
    this._shuffle = localStorage.getItem('loltube_shuffle') === '1';
    this._repeatAll = localStorage.getItem('loltube_repeat') === '1';
    if (sh) { sh.classList.toggle('on', this._shuffle); sh.onclick = () => { this._shuffle = !this._shuffle; localStorage.setItem('loltube_shuffle', this._shuffle ? '1' : '0'); sh.classList.toggle('on', this._shuffle); showIsland(this._shuffle ? 'ПЕРЕМЕШИВАНИЕ ВКЛ' : 'ПЕРЕМЕШИВАНИЕ ВЫКЛ', 'violet'); }; }
    if (rp) { rp.classList.toggle('on', this._repeatAll); rp.onclick = () => { this._repeatAll = !this._repeatAll; localStorage.setItem('loltube_repeat', this._repeatAll ? '1' : '0'); rp.classList.toggle('on', this._repeatAll); showIsland(this._repeatAll ? 'ПОВТОР ВСЕХ ВКЛ' : 'ПОВТОР ВСЕХ ВЫКЛ', 'violet'); }; }
    if (nx) nx.onclick = () => this.playQueueNext();
    const mGear = document.getElementById('mGearBtn');
    const mSet = document.getElementById('musicSettings');
    if (mGear && mSet) mGear.onclick = () => mSet.classList.toggle('open');
    const mFs = document.getElementById('mFsBtn');
    if (mFs) mFs.onclick = () => {
      const root = document.querySelector('.music-player');
      if (!root) return;
      if (!document.fullscreenElement) (root.requestFullscreen || function(){}).call(root);
      else document.exitFullscreen && document.exitFullscreen();
    };
    const back = document.getElementById('mBackBtn');
    const fwd = document.getElementById('mFwdBtn');
    if (back) back.onclick = () => { a.currentTime = Math.max(0, a.currentTime - 10); };
    if (fwd) fwd.onclick = () => { a.currentTime = Math.min(a.duration || 0, a.currentTime + 10); };
    if (seek) seek.oninput = () => { if (a.duration) a.currentTime = seek.value / 1000 * a.duration; this._syncMusicUI(); };
    // автозапуск (в старых WebView play() может вернуть undefined)
    try {
      const started = a.play();
      if (started && typeof started.then === 'function') started.catch(() => {});
    } catch (e) {}
    this.updateMiniPlayer(); // на странице трека мини-бар прячется
  },

  async renderWatch(id) {
    const main = document.getElementById('app');
    const video = await apiFetch(`/api/videos/${id}`);
    const comments = await apiFetch(`/api/videos/${id}/comments`);
    let likeStatus = { likes: video.likes?.length||0, dislikes: video.dislikes?.length||0, userLiked:false, userDisliked:false };
    try { likeStatus = await apiFetch(`/api/videos/${id}/like-status`); } catch {}

    const authorAvatar = video.authorAvatar ? (video.authorAvatar.startsWith('http') ? video.authorAvatar : apiUrl(video.authorAvatar)) : null;
    const isImage = video.contentType==='image' || video.contentType==='gif';
    const isArtist = video.contentType==='artist_music';
    const isMusic = isArtist || video.contentType==='music';
    const videoSrc = this.getFileUrl(video.cloudinaryUrl || video.filename);
    const thumbSrc = this.getFileUrl(video.cloudinaryThumbUrl || video.cover || video.thumbnail);

    // Parse chapters for clickable
    let descHtml = this.esc(video.description||'');
    if (video.chapters && video.chapters.length) {
      video.chapters.forEach(ch => {
        const regex = new RegExp(this.escapeRegExp(ch.raw), 'g');
        descHtml = descHtml.replace(regex, `<span class="chapter-link" onclick="app.seekTo(${ch.time})" style="background:var(--violet);color:white;padding:1px 4px;cursor:pointer;font-weight:800;">${this.esc(ch.raw)}</span>`);
      });
    }
    // tags
    const tagsHtml = video.tags && video.tags.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;">${video.tags.map(t=>`<span style="background:var(--violet-pale);border:var(--border-w) solid var(--violet);padding:2px 6px;font-size:10px;font-weight:700;cursor:pointer;" onclick="app.searchTag('${t}')">#${this.esc(t)}</span>`).join('')}</div>` : '';

    const posAttr = Number(video.watchPosition) || 0;
    const durAttr = Number(video.watchDuration) || 0;
    const videoControlsHtml = `
            <div class="player-controls">
              <div class="progress-wrap"><input id="progress" type="range" min="0" max="100" value="0"></div>
              <div class="controls-row">
                <button class="ctrl-btn" id="playBtn" title="Играть / пауза">▶</button>
                <button class="ctrl-btn" id="rewindBtn" title="Назад 10 секунд">-10</button>
                <button class="ctrl-btn" id="forwardBtn" title="Вперёд 10 секунд">+10</button>
                <span class="ctrl-spacer"></span>
                <button class="ctrl-btn" id="gearBtn" title="Настройки плеера"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2.2" fill="currentColor" stroke="none"/></svg></button>
                <button class="ctrl-btn" id="fsBtn" title="Во весь экран"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
              </div>
              <div class="player-settings" id="playerSettings">
                <div class="ps-row"><span>ГРОМКОСТЬ</span><input id="volume" type="range" min="0" max="1" step="0.05" value="1"></div>
                <div class="ps-row"><span>СКОРОСТЬ</span>
                  <select id="speedSelect">
                    <option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option>
                  </select>
                </div>
                <div class="ps-row ps-btns">
                  <button class="ctrl-btn" id="loopBtn" title="Повтор"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></button>
                  <button class="ctrl-btn" id="pipBtn" title="Картинка в картинке"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16"/><rect x="12" y="12" width="8" height="6" fill="currentColor"/></svg></button>
                  <button class="ctrl-btn" id="screenshotBtn" title="Скриншот"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
                </div>
              </div>
            </div>`;
    const stageHtml = isImage
      ? `<img src="${videoSrc}" style="width:100%;height:100%;object-fit:contain;background:black;">`
      : isMusic
        ? this.musicPlayerHtml(video, videoSrc, thumbSrc)
        : `<video id="videoEl" src="${videoSrc}" poster="${thumbSrc || ''}" playsinline data-pos="${posAttr}" data-dur="${durAttr}"></video>` + videoControlsHtml;
    main.innerHTML = `
      <div class="watch-layout">
        <div>
          <div class="player-root ${isMusic?'music-mode':''}" id="playerRoot">
            <button class="watch-close" title="Закрыть" onclick="event.stopPropagation();app.closeWatch()">✕</button>
            ${stageHtml}
          </div>
          <div class="watch-info">
            <div class="watch-title">${this.esc(video.title)} ${video.contentType!=='video'? `<span class="type-chip ${video.contentType==='artist_music'?'artist':''}">${video.contentType==='artist_music'?'🎤 ТРЕК АРТИСТА':video.contentType.toUpperCase()}</span>`:''}</div>
            ${isArtist ? `<div class="artist-info-row"><span class="artist-chip">🎤 АРТИСТ</span><span class="artist-name">${this.esc(video.artist||video.authorNickname)}</span>${video.album?`<span class="album-chip">💿 ${this.esc(video.album)}</span>`:''}</div>` : ''}
            ${tagsHtml}
            ${descHtml ? `<div class="desc-block">${descHtml}</div>` : ''}
            ${video.chapters && video.chapters.length ? `<div class="chapters-block"><div class="chapters-title">ГЛАВЫ</div>${video.chapters.map(ch=>`<div class="chapter-row" onclick="app.seekTo(${ch.time})"><span>${this.formatTime(ch.time)}</span><span>${this.esc(ch.label)}</span></div>`).join('')}</div>` : ''}
            <div class="author-row" onclick="app.navigate('user', {nickname:'${video.authorNickname}'})">
              <div class="avatar" style="${!authorAvatar ? `background:${video.authorColor}` : ''}">${authorAvatar ? `<img src="${authorAvatar}">` : video.authorNickname[0].toUpperCase()}</div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:800; font-size:13px;">${this.esc(video.authorNickname)} ${video.authorSubscribers? `• ${video.authorSubscribers} подписчиков`:''}</div>
                <div style="font-size:10px; color:#71717a;">${video.views||0} просмотров • ${this.timeAgo(video.createdAt)} • LVL ${video.authorLevel||1}</div>
              </div>
              <button class="btn ${video.authorIsSubscribed?'btn-primary':''}" style="font-size:10px;min-height:28px;padding:0 8px;" onclick="event.stopPropagation();app.subscribe('${video.authorNickname}')">${video.authorIsSubscribed?'ОТПИСАЛСЯ':'ПОДПИСАТЬСЯ'}</button>
            </div>
            <div class="action-row">
              <button id="likeBtn" class="action-btn violet ${likeStatus.userLiked?'active':''}" onclick="app.toggleLike('${video.id}','like')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="${likeStatus.userLiked?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
                ${likeStatus.likes}
              </button>
              <button id="dislikeBtn" class="action-btn ${likeStatus.userDisliked?'active':''}" onclick="app.toggleLike('${video.id}','dislike')" title="Не нравится">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="${likeStatus.userDisliked?'currentColor':'none'}" stroke="currentColor" stroke-width="2"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>
                ${likeStatus.dislikes}
              </button>
              <button class="action-btn" onclick="app.toggleFavorite('${video.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                ИЗБРАННОЕ
              </button>
              <button class="action-btn" onclick="app.shareVideo('${video.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                ПОДЕЛИТЬСЯ
              </button>
              <button class="action-btn" onclick="app.openPlaylistPicker('${video.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                В ПЛЕЙЛИСТ
              </button>
              <button class="action-btn" onclick="app.downloadVideo('${video.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                СКАЧАТЬ
              </button>
              ${currentUser && (currentUser.id===video.authorId || currentUser.isAdmin) ? `<button class="action-btn" style="background:black; color:white;" onclick="app.deleteVideo('${video.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> УДАЛИТЬ</button>` : ''}
            </div>
          </div>
          <div class="comments">
            <h3>КОММЕНТАРИИ • ${comments.length}</h3>
            <div class="comment-input-row">
              <input id="commentInput" type="text" placeholder="Комментарий..." maxlength="1000" onkeydown="if(event.key==='Enter') app.postComment('${video.id}')">
              <button class="btn btn-primary" style="min-height:36px;padding:0 12px;font-size:11px;" onclick="app.postComment('${video.id}')">ОК</button>
            </div>
            <div id="commentsList">${comments.length ? comments.map(c=>this.commentHtml(c)).join('') : `<div style="font-size:11px; color:#71717a;">Пока нет</div>`}</div>
          </div>
        </div>
        <div>
          <div style="font-size:10px; font-weight:800; text-transform:uppercase; margin-bottom:8px;">ДАЛЕЕ</div>
          <div id="related"></div>
        </div>
      </div>
    `;
    this._currentVideoId = video.id;
    if (!isImage && !isMusic) this.initPlayer(video.id);
    if (isMusic) this.initMusicPlayer(video);
    const prEl = document.getElementById('playerRoot');
    if (prEl) prEl.addEventListener('dblclick', () => this.doubleTapLike(video, prEl));
    try {
      const all = await apiFetch('/api/videos');
      const related = all.filter(v=>v.id!==id).slice(0,6);
      const relEl = document.getElementById('related');
      if (relEl) {
        relEl.innerHTML = `<div style="display:flex; flex-direction:column; gap:8px;">${related.map(v=>{
          const t = this.getFileUrl(v.cloudinaryThumbUrl || v.cover || v.thumbnail) || '';
          return `
          <div class="video-card" onclick="app.navigate('watch', {id:'${v.id}'})">
            <div class="thumb"><img src="${t}" onerror="this.style.display='none'"><div class="thumb-placeholder" style="position:absolute; inset:0; display:${t?'none':'flex'}">ЛОЛ ТУБ</div></div>
            <div class="video-info"><div class="video-title" style="font-size:12px;">${this.esc(v.title)}</div><div style="font-size:10px;color:#71717a;">${v.views||0} 👁</div></div>
          </div>
        `}).join('')}</div>`;
      }
    } catch {}
  },

  renderRichText(text) {
    let h = this.esc(text);
    h = h.replace(/:lol:/gi, '<span class="emo-lol">ЛОЛ</span>');
    h = h.replace(/@([a-zA-Z0-9_]+)/g, '<span class="mention">@$1</span>');
    return h;
  },
  commentHtml(c) {
    const av = c.authorAvatar ? apiUrl(c.authorAvatar) : null;
    const isReply = c.replyTo ? `style="margin-left:20px;border-left:2px solid var(--violet);padding-left:8px;"` : '';
    return `<div class="comment" ${isReply}><div class="avatar" style="${!av ? `background:${c.authorColor}; width:28px; height:28px; font-size:10px;` : 'width:28px; height:28px;'}">${av ? `<img src="${av}">` : c.authorNickname[0].toUpperCase()}</div><div style="flex:1;min-width:0;"><div style="display:flex;gap:6px;align-items:center;"><span style="font-weight:800;font-size:11px;">${this.esc(c.authorNickname)}</span><span style="font-size:9px;background:var(--violet);color:white;padding:1px 3px;">LVL ${c.authorLevel||1}</span><span style="font-size:10px;color:#71717a;">${this.timeAgo(c.createdAt)}</span></div><div style="font-size:12px;margin-top:2px;word-break:break-word;">${this.renderRichText(c.text)}</div><div style="display:flex;gap:8px;margin-top:4px;"><span style="font-size:10px;cursor:pointer;color:#71717a;" onclick="app.likeComment('${c.id}')">♥ ${c.likes?.length||0}</span><span style="font-size:10px;cursor:pointer;color:#71717a;" onclick="app.replyComment('${c.id}', '${c.authorNickname}')">ОТВЕТИТЬ</span></div></div></div>`;
  },

  initPlayer(videoId) {
    const video = document.getElementById('videoEl');
    const root = document.getElementById('playerRoot');
    const playBtn = document.getElementById('playBtn');
    const progress = document.getElementById('progress');
    const volume = document.getElementById('volume');
    const speed = document.getElementById('speedSelect');
    const loopBtn = document.getElementById('loopBtn');
    const pipBtn = document.getElementById('pipBtn');
    const screenshotBtn = document.getElementById('screenshotBtn');
    if (!video || !root || !playBtn || !progress) return;
    let hideTimeout;
    const show = () => { root.classList.add('show-controls'); clearTimeout(hideTimeout); hideTimeout=setTimeout(()=>root.classList.remove('show-controls'), 3000); };
    video.addEventListener('click', () => { video.paused ? video.play() : video.pause(); show(); });
    root.addEventListener('touchstart', show);
    root.addEventListener('mousemove', show);
    playBtn.onclick = () => video.paused ? video.play() : video.pause();
    video.addEventListener('play', () => { playBtn.textContent='❚❚'; root.classList.remove('paused'); });
    video.addEventListener('pause', () => { playBtn.textContent='▶'; root.classList.add('paused'); });
    video.addEventListener('timeupdate', () => { if (video.duration) progress.value = (video.currentTime/video.duration)*100; });
    // «продолжить с того же места» + автосохранение позиции
    const savedPos = Number(video.dataset.pos || 0);
    if (savedPos > 5) {
      const tryResume = () => {
        const d = Number(video.duration || video.dataset.dur || 0);
        if (savedPos < (d || savedPos + 1) - 10) {
          try { video.currentTime = savedPos; } catch (e) {}
          showIsland('ПРОДОЛЖАЕМ С ' + this._fmtTime(savedPos), 'violet');
        }
      };
      if (video.readyState >= 1) tryResume(); else video.addEventListener('loadedmetadata', tryResume);
    }
    if (this._posT) clearInterval(this._posT);
    this._posT = setInterval(() => {
      if (videoId && !video.paused && video.currentTime > 1) this.savePosition(videoId, video.currentTime, video.duration || 0);
    }, 10000);
    video.addEventListener('pause', () => { if (videoId && video.currentTime > 1) this.savePosition(videoId, video.currentTime, video.duration || 0); });
    progress.addEventListener('input', () => { if (video.duration) video.currentTime = (progress.value/100)*video.duration; });
    if (volume) volume.addEventListener('input', () => video.volume = volume.value);
    if (speed) speed.addEventListener('change', () => video.playbackRate = parseFloat(speed.value));
    const rw = document.getElementById('rewindBtn');
    const fw = document.getElementById('forwardBtn');
    const fs = document.getElementById('fsBtn');
    const gear = document.getElementById('gearBtn');
    const pset = document.getElementById('playerSettings');
    if (gear && pset) gear.onclick = (e) => { e.stopPropagation(); pset.classList.toggle('open'); show(); };
    if (rw) rw.onclick = () => video.currentTime = Math.max(0, video.currentTime-10);
    if (fw) fw.onclick = () => video.currentTime = Math.min(video.duration||0, video.currentTime+10);
    if (fs) fs.onclick = () => {
      if (!document.fullscreenElement) (root.requestFullscreen||video.requestFullscreen).call(root);
      else document.exitFullscreen && document.exitFullscreen();
    };
    if (loopBtn) loopBtn.onclick = () => { video.loop = !video.loop; loopBtn.style.background = video.loop ? 'var(--violet)' : ''; showIsland(video.loop ? 'LOOP ВКЛ' : 'LOOP ВЫКЛ', 'violet'); };
    if (pipBtn) pipBtn.onclick = async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch(e){} };
    if (screenshotBtn) screenshotBtn.onclick = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video,0,0);
      const a = document.createElement('a');
      a.download = `loltube-${Date.now()}.png`;
      a.href = canvas.toDataURL();
      a.click();
      showIsland('СКРИНШОТ СОХРАНЕН', 'violet');
    };
    // hotkeys
    document.onkeydown = (e) => {
      if (e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA') return;
      if (e.key===' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
      if (e.key==='ArrowLeft') video.currentTime = Math.max(0, video.currentTime-5);
      if (e.key==='ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime+5);
      if (e.key==='m') video.muted = !video.muted;
      if (e.key==='f') fs?.click();
      if (e.key==='j') video.currentTime = Math.max(0, video.currentTime-10);
      if (e.key==='k') video.paused ? video.play() : video.pause();
      if (e.key==='l') video.currentTime = Math.min(video.duration, video.currentTime+10);
    };
    show(); root.classList.add('paused');
  },
  seekTo(time) {
    const video = document.getElementById('videoEl');
    if (video) video.currentTime = time;
  },
  formatTime(s) {
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const sec = Math.floor(s%60);
    if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  },
  escapeRegExp(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },

  // обновляет только число, не ломая SVG-иконку
  _setBtnCount(btn, n) {
    if (!btn) return;
    const txt = Array.from(btn.childNodes).find(nd => nd.nodeType === 3 && nd.textContent.trim() !== '');
    if (txt) txt.textContent = '\n                ' + n + '\n              ';
    else btn.appendChild(document.createTextNode(' ' + n));
  },
  async toggleLike(id, type) {
    try {
      const res = await apiFetch(`/api/videos/${id}/like`, { method:'POST', body: JSON.stringify({ type }) });
      const likeBtn = document.getElementById('likeBtn');
      const dislikeBtn = document.getElementById('dislikeBtn');
      this._setBtnCount(likeBtn, res.likes);
      this._setBtnCount(dislikeBtn, res.dislikes);
      if (likeBtn) {
        likeBtn.classList.toggle('active', res.userLiked);
        const svg = likeBtn.querySelector('svg'); if (svg) svg.setAttribute('fill', res.userLiked ? 'currentColor' : 'none');
      }
      if (dislikeBtn) {
        dislikeBtn.classList.toggle('active', res.userDisliked);
        const svg = dislikeBtn.querySelector('svg'); if (svg) svg.setAttribute('fill', res.userDisliked ? 'currentColor' : 'none');
      }
      if (res.userLiked) showIsland('ЛАЙК!', 'violet');
    } catch (e) {
      if (e && e.status === 401) { this.softLogout('СЕССИЯ ИСТЕКЛА — ВОЙДИ СНОВА'); return; }
    }
  },

  async toggleFavorite(id) {
    try {
      const res = await apiFetch(`/api/favorites/${id}`, { method:'POST' });
      showIsland(res.favorited ? 'В ИЗБРАННОЕ' : 'УБРАНО ИЗ ИЗБРАННОГО', 'violet');
    } catch(e){ alert(e.message); }
  },

  async downloadVideo(id) {
    try {
      await apiFetch(`/api/videos/${id}/download`, { method:'POST' });
      const video = await apiFetch(`/api/videos/${id}`);
      const a = document.createElement('a');
      // getFileUrl умеет в cloudinary-URL, idb: (оффлайн) и /uploads/
      a.href = this.getFileUrl(video.cloudinaryUrl || video.filename);
      a.download = video.originalName || video.filename;
      a.click();
      showIsland('СКАЧИВАНИЕ...', 'violet');
    } catch(e){ alert(e.message); }
  },

  async postComment(videoId) {
    const input = document.getElementById('commentInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
      const c = await apiFetch(`/api/videos/${videoId}/comments`, { method:'POST', body: JSON.stringify({ text }) });
      input.value='';
      const list = document.getElementById('commentsList');
      if (list) list.insertAdjacentHTML('afterbegin', this.commentHtml(c));
      showIsland('КОММЕНТ ДОБАВЛЕН', 'violet');
    } catch (e) {
      if (e && e.status === 401) { this.softLogout('СЕССИЯ ИСТЕКЛА — ВОЙДИ СНОВА'); return; }
    }
  },
  async likeComment(id) {
    try { const res = await apiFetch(`/api/comments/${id}/like`, { method:'POST' }); showIsland(`♥ ${res.likes}`, 'violet'); } catch(e){}
  },
  replyComment(id, nick) {
    const input = document.getElementById('commentInput');
    if (input) { input.value = `@${nick} `; input.focus(); input.dataset.replyTo = id; }
  },

  shareVideo(id) {
    const url = `https://grapescript.gitverse.site/loltube/#watch/${id}`;
    const full = `https://grapescript.gitverse.site/loltube/#watch/${id}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(full).then(()=>{ showIsland('ССЫЛКА СКОПИРОВАНА', 'violet'); }).catch(()=>{ prompt('Ссылка:', full); });
    } else {
      prompt('Ссылка:', full);
    }
  },
  shareLive() {
    const url = `https://grapescript.gitverse.site/loltube/#live`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(()=>{ showIsland('ССЫЛКА НА ТВ СКОПИРОВАНА', 'violet'); }).catch(()=>{ prompt('Ссылка:', url); });
    } else {
      prompt('Ссылка:', url);
    }
  },

  async deleteVideo(id) {
    if (!confirm('Удалить?')) return;
    try { await apiFetch(`/api/videos/${id}`, { method:'DELETE' }); showIsland('УДАЛЕНО', ''); this.navigate('home'); } catch (e) {
      if (e && e.status === 401) { this.softLogout('СЕССИЯ ИСТЕКЛА — ВОЙДИ СНОВА'); return; }
    }
  },

  async uploadAvatar(file) {
    if (!file) return;
    const form = new FormData();
    form.append('avatar', file);
    try {
      const res = await apiFetch('/api/me/avatar', { method:'POST', body: form });
      currentUser.avatar = res.avatar;
      this.renderAccountBtn();
      this.renderProfile();
      showIsland('АВАТАРКА ОБНОВЛЕНА', 'violet');
    } catch (e) {
      if (e && e.status === 401) { this.softLogout('СЕССИЯ ИСТЕКЛА — ВОЙДИ СНОВА'); return; }
      alert(e.message);
    }
  },
  async uploadBanner(file) {
    if (!file) return;
    const form = new FormData();
    form.append('banner', file);
    try {
      const res = await apiFetch('/api/me/banner', { method:'POST', body: form });
      currentUser.banner = res.banner;
      this.renderProfile();
      showIsland('БАННЕР ОБНОВЛЕН', 'violet');
    } catch(e){ alert(e.message); }
  },

  async doSearch() {
    const input = document.getElementById('searchInput');
    const q = input ? input.value.trim() : '';
    if (!q) { this.navigate('home'); return; }
    window.location.hash = `search/${encodeURIComponent(q)}`;
    this.router();
  },
  searchTag(tag) {
    const input = document.getElementById('searchInput');
    if (input) input.value = tag;
    this.doSearch();
  },
  recentSearches() {
    try { const r = JSON.parse(localStorage.getItem('loltube_recent_search') || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; }
  },
  addRecentSearch(q) {
    q = String(q || '').trim();
    if (!q) return;
    let list = this.recentSearches().filter(x => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    list = list.slice(0, 6);
    try { localStorage.setItem('loltube_recent_search', JSON.stringify(list)); } catch (e) {}
  },
  clearRecentSearches() {
    try { localStorage.removeItem('loltube_recent_search'); } catch (e) {}
    const el = document.getElementById('recentSearchRow');
    if (el) el.remove();
  },

  async renderSearch(query) {
    const main = document.getElementById('app');
    const q = decodeURIComponent(query||'');
    this.addRecentSearch(q);
    const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
    main.innerHTML = `
      <div style="font-size:14px;font-weight:800;margin:10px 0;">ПОИСК: ${this.esc(q)} • ${data.videos.length} видео • ${data.users.length} юзеров</div>
      ${data.users.length ? `<div class="settings-section"><h3>ЮЗЕРЫ</h3>${data.users.map(u=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;cursor:pointer;" onclick="app.navigate('user', {nickname:'${u.nickname}'})"><div class="avatar">${u.nickname[0].toUpperCase()}</div><div style="flex:1"><div style="font-weight:700;font-size:13px;">${this.esc(u.nickname)}</div><div style="font-size:10px;color:#71717a;">${this.esc(u.bio||'')} • ${u.subscribers} подписчиков</div></div></div>`).join('')}</div>` : ''}
      ${(!data.videos.length && !data.users.length) ? `
        <div class="empty">
          <h2>Ничего не найдено</h2>
          <p>По запросу «${this.esc(q)}» пусто. Проверь опечатку или посмотри категории:</p>
          <div class="cat-row" style="margin-top:12px;justify-content:center;">
            <button class="btn" onclick="app.goCategory('video')">ВИДЕО</button>
            <button class="btn" onclick="app.goCategory('music')">МУЗЫКА</button>
            <button class="btn" onclick="app.goCategory('image')">ФОТО</button>
            <button class="btn" onclick="app.goCategory('gif')">GIF</button>
          </div>
          ${this.recentSearches().length ? `<div id="recentSearchRow" style="margin-top:14px;"><div style="font-size:10px;font-weight:800;margin-bottom:6px;">НЕДАВНО ИСКАЛ</div><div class="cat-row" style="justify-content:center;">${this.recentSearches().map(r => `<button class="btn" onclick="app.searchTag('${this.esc(r)}')">${this.esc(r)}</button>`).join('')}<button class="btn" onclick="app.clearRecentSearches()">ОЧИСТИТЬ</button></div></div>` : ''}
        </div>`
      : `<div class="video-grid" style="margin-top:12px;">${data.videos.map(v=>this.videoCard(v)).join('')}</div>`}
    `;
  },

  async renderHistory() {
    const main = document.getElementById('app');
    const videos = await apiFetch('/api/history');
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0;"><div style="font-size:14px;font-weight:800;">ИСТОРИЯ • ${videos.length}</div><button class="btn" style="font-size:10px;min-height:28px;" onclick="app.clearHistory()">ОЧИСТИТЬ</button></div>
      <div class="video-grid">${videos.map(v=>this.videoCard(v)).join('') || '<div style="font-size:11px;color:#71717a;">Пусто</div>'}</div>
    `;
  },
  async clearHistory() { if(!confirm('Очистить историю?')) return; await apiFetch('/api/history', { method:'DELETE' }); this.renderHistory(); },

  async renderFavorites() {
    const main = document.getElementById('app');
    const videos = await apiFetch('/api/favorites');
    main.innerHTML = `<div style="font-size:14px;font-weight:800;margin:10px 0;">ИЗБРАННОЕ • ${videos.length}</div><div class="video-grid">${videos.map(v=>this.videoCard(v)).join('') || '<div style="font-size:11px;color:#71717a;">Пусто</div>'}</div>`;
  },

  async renderPlaylists(plId) {
    const main = document.getElementById('app');
    const pls = await apiFetch('/api/playlists');
    // открытый плейлист: показываем его содержимое
    if (plId) {
      const pl = (pls || []).find(p => p.id === plId);
      if (pl) {
        let all = [];
        try { all = await apiFetch('/api/videos'); } catch (e) { all = []; }
        const items = (pl.videos || []).map(id => (all || []).find(v => v.id === id)).filter(Boolean);
        main.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;margin:10px 0;">
            <button class="btn" style="font-size:10px;min-height:28px;" onclick="app.renderPlaylists()">← НАЗАД</button>
            <div style="font-size:14px;font-weight:800;">${this.esc(pl.title)} • ${items.length}</div>
          </div>
          <div class="video-grid">${items.map(v => `
            <div class="video-card">
              <div onclick="app.navigate('watch', {id:'${v.id}'})">${this.videoCardInner(v)}</div>
              <button class="pl-remove" onclick="app.removeFromPlaylist('${pl.id}', '${v.id}')">✕ УБРАТЬ</button>
            </div>`).join('') || '<div class="empty"><h2>Плейлист пуст</h2><p>Открой видео и нажми «В ПЛЕЙЛИСТ»</p></div>'}</div>`;
        return;
      }
    }
    main.innerHTML = `
      <div style="font-size:14px;font-weight:800;margin:10px 0;">ПЛЕЙЛИСТЫ • ${pls.length}</div>
      <div class="settings-section">
        <h3>СОЗДАТЬ ПЛЕЙЛИСТ</h3>
        <div style="display:flex;gap:6px;"><input id="plTitle" type="text" placeholder="Название" style="flex:1;border:var(--border-w) solid var(--border);padding:8px;"><button class="btn btn-primary" style="font-size:10px;" onclick="app.createPlaylist()">СОЗДАТЬ</button></div>
      </div>
      <div style="margin-top:12px;">${pls.map(p=>`<div class="pl-card"><div style="font-weight:800;font-size:13px;cursor:pointer;" onclick="app.renderPlaylists('${p.id}')">${this.esc(p.title)} • ${(p.videos||[]).length} видео</div><div style="font-size:10px;color:#71717a;">${this.esc(p.description||'')} • ${p.isPublic?'Публичный':'Приватный'}</div><div style="display:flex;gap:6px;margin-top:6px;"><button class="btn" style="font-size:10px;min-height:28px;" onclick="app.renderPlaylists('${p.id}')">ОТКРЫТЬ</button><button class="btn" style="font-size:10px;min-height:28px;" onclick="app.deletePlaylist('${p.id}')">УДАЛИТЬ</button></div></div>`).join('') || '<div style="font-size:11px;color:#71717a;margin-top:8px;">Нет плейлистов</div>'}</div>
    `;
  },
  async openPlaylistPicker(videoId) {
    if (!currentUser) { this.showLogin(); return; }
    this._plPickerVideo = videoId;
    let pls = [];
    try { pls = await apiFetch('/api/playlists'); } catch (e) { pls = []; }
    if (!Array.isArray(pls)) pls = [];
    const mine = pls.filter(p => p.authorId === currentUser.id);
    const ov = document.createElement('div');
    ov.className = 'pl-modal-overlay';
    ov.id = 'plModal';
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    ov.innerHTML = `
      <div class="pl-modal">
        <div class="pl-modal-head">
          <span>В ПЛЕЙЛИСТ</span>
          <button class="notif-mini-btn" onclick="document.getElementById('plModal').remove()">✕</button>
        </div>
        <div class="pl-modal-list">
          ${mine.length ? mine.map(p => {
            const has = (p.videos || []).includes(videoId);
            return `<label class="pl-row ${has ? 'on' : ''}">
              <input type="checkbox" ${has ? 'checked' : ''} onchange="app.togglePlaylistVideo('${p.id}', '${videoId}', this.checked)">
              <span>${this.esc(p.title)}</span>
              <em>${(p.videos || []).length}</em>
            </label>`;
          }).join('') : '<div class="notif-empty">Сначала создай плейлист</div>'}
        </div>
        <div class="pl-modal-new">
          <input id="plQuickTitle" type="text" placeholder="Новый плейлист" maxlength="40">
          <button class="btn btn-primary" onclick="app.createPlaylistFor('${videoId}')">СОЗДАТЬ</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
  },

  async togglePlaylistVideo(plId, videoId, add) {
    try {
      const res = add
        ? await apiFetch(`/api/playlists/${plId}/add/${videoId}`, { method:'POST' })
        : await apiFetch(`/api/playlists/${plId}/remove/${videoId}`, { method:'DELETE' });
      showIsland(add ? 'ДОБАВЛЕНО В ПЛЕЙЛИСТ' : 'УБРАНО ИЗ ПЛЕЙЛИСТА', 'violet');
      const row = document.querySelector(`#plModal .pl-row input[onchange*="${plId}"]`);
      if (row && row.parentElement) row.parentElement.classList.toggle('on', add);
      return res;
    } catch (e) { alert(e.message); }
  },

  async createPlaylistFor(videoId) {
    const input = document.getElementById('plQuickTitle');
    const title = input ? input.value.trim() : '';
    if (!title) return;
    try {
      const pl = await apiFetch('/api/playlists', { method:'POST', body: JSON.stringify({ title }) });
      await apiFetch(`/api/playlists/${pl.id}/add/${videoId}`, { method:'POST' });
      showIsland('ПЛЕЙЛИСТ СОЗДАН', 'violet');
      this.openPlaylistPicker(videoId);
    } catch (e) { alert(e.message); }
  },

  async removeFromPlaylist(plId, videoId) {
    try {
      await apiFetch(`/api/playlists/${plId}/remove/${videoId}`, { method:'DELETE' });
      showIsland('УБРАНО ИЗ ПЛЕЙЛИСТА', 'violet');
      this.renderPlaylists(plId);
    } catch (e) { alert(e.message); }
  },

  async createPlaylist() {
    const title = document.getElementById('plTitle')?.value.trim();
    if (!title) return;
    try { await apiFetch('/api/playlists', { method:'POST', body: JSON.stringify({ title }) }); showIsland('ПЛЕЙЛИСТ СОЗДАН', 'violet'); this.renderPlaylists(); } catch(e){ alert(e.message); }
  },
  async deletePlaylist(id) { if(!confirm('Удалить плейлист?')) return; await apiFetch(`/api/playlists/${id}`, { method:'DELETE' }); this.renderPlaylists(); },

  async renderAdmin() {
    const main = document.getElementById('app');
    if (!currentUser?.isAdmin) { main.innerHTML = `<div class="empty"><h2>Только админ</h2></div>`; return; }
    const stats = await apiFetch('/api/admin/stats');
    const users = await apiFetch('/api/admin/users');
    let liveCfg = { hlsUrl: '', title: 'ТВ-ФАНТОМАС' };
    try { liveCfg = await apiFetch('/api/live'); } catch (e) {}
    main.innerHTML = `
      <div style="font-size:18px;font-weight:800;margin:12px 0;">АДМИН ПАНЕЛЬ • MAX ВОЗМОЖНОСТЕЙ</div>
      <div class="settings-section">
        <h3>СТАТИСТИКА</h3>
        <div style="font-size:11px;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>Юзеров: ${stats.users}</div><div>Видео: ${stats.videos}</div>
          <div>Комментов: ${stats.comments}</div><div>Плейлистов: ${stats.playlists}</div>
          <div>Жалоб: ${stats.reports}</div><div>Live: ${stats.live.isLive?'ON':'OFF'}</div>
          <div>Файлов: ${stats.storage.uploads}</div><div>Аватарок: ${stats.storage.avatars}</div>
        </div>
      </div>
      <div class="settings-section" style="margin-top:12px;">
        <h3>ЮЗЕРЫ (${users.length})</h3>
        <div style="max-height:300px;overflow-y:auto;">
          ${users.map(u=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #eee;font-size:11px;"><span>${this.esc(u.nickname)} ${u.isAdmin?'[ADMIN]':''} LVL${u.level} • ${u.videos} видео</span><button class="btn" style="font-size:9px;min-height:24px;padding:0 6px;" onclick="app.adminDeleteUser('${u.id}')">УДАЛИТЬ</button></div>`).join('')}
        </div>
      </div>
      <div class="settings-section" style="margin-top:12px;">
        <h3>ТВ-ФАНТОМАС • УПРАВЛЕНИЕ ЭФИРОМ</h3>
        <div class="form-row"><label>HLS URL</label><input id="liveHlsUrl" type="text" value="${this.esc(liveCfg.hlsUrl)}" placeholder="https://.../live.m3u8"></div>
        <div class="form-row"><label>Название</label><input id="liveTitle" type="text" value="${this.esc(liveCfg.title)}"></div>
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button class="btn btn-primary" style="font-size:10px;" onclick="app.setLive(true)">В ЭФИР</button>
          <button class="btn" style="font-size:10px;" onclick="app.setLive(false)">СТОП</button>
        </div>
      </div>
      <div class="settings-section" style="margin-top:12px;">
        <h3>БЫСТРЫЕ ДЕЙСТВИЯ</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn" style="font-size:10px;" onclick="app.navigate('live')">ТВ-ФАНТОМАС</button>
          <button class="btn" style="font-size:10px;" onclick="alert('Очистка кэша - TODO')">ОЧИСТИТЬ КЭШ</button>
          <button class="btn" style="font-size:10px;" onclick="alert('Бэкап - TODO')">БЭКАП БД</button>
        </div>
      </div>
    `;
  },
  async adminDeleteUser(id) { if(!confirm('Удалить юзера?')) return; try { await apiFetch(`/api/admin/users/${id}`, { method:'DELETE' }); showIsland('ЮЗЕР УДАЛЕН', ''); this.renderAdmin(); } catch(e){ alert(e.message); } },

  esc(s) { return (s||'').replace(/[&<>\"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); },
  timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff/60000);
    if (mins<1) return 'сейчас';
    if (mins<60) return `${mins}м`;
    const h = Math.floor(mins/60);
    if (h<24) return `${h}ч`;
    const d = Math.floor(h/24);
    return `${d}д`;
  }
};

window.app = app;
window.addEventListener('DOMContentLoaded', () => app.init());
