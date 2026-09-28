const express = require('express');
const multer = require('multer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

let cloudinary = null;
let useCloudinary = false;
try {
  cloudinary = require('cloudinary').v2;
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
    useCloudinary = true;
    console.log('Cloudinary enabled - videos will be persistent for free without card (25GB free)');
  } else {
    console.log('Cloudinary not configured - using local storage (ephemeral on Render free, use volume on Fly.io or add CLOUDINARY env vars)');
  }
} catch (e) {
  console.log('Cloudinary not installed - using local storage');
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'loltube-secret-violet-2024-v2';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBS_DIR = path.join(__dirname, 'uploads', 'thumbs');
const AVATARS_DIR = path.join(__dirname, 'uploads', 'avatars');
const BANNERS_DIR = path.join(__dirname, 'uploads', 'banners');
const CONTENT_DIR = path.join(__dirname, 'uploads', 'content'); // images, gif, music

[DATA_DIR, UPLOADS_DIR, THUMBS_DIR, AVATARS_DIR, BANNERS_DIR, CONTENT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const DB_PATH = path.join(DATA_DIR, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { 
      users: [], 
      videos: [], 
      comments: [], 
      playlists: [],
      notifications: [],
      history: [],
      reports: [],
      friends: [],
      live: { isLive: false, hlsUrl: '', title: 'ТВ-ФАНТОМАС', viewerCount: 0 }
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (!data.users) data.users = [];
    if (!data.videos) data.videos = [];
    if (!data.comments) data.comments = [];
    if (!data.playlists) data.playlists = [];
    if (!data.notifications) data.notifications = [];
    if (!data.history) data.history = [];
    if (!data.reports) data.reports = [];
    if (!data.friends) data.friends = [];
    if (!data.live) data.live = { isLive: false, hlsUrl: '', title: 'ТВ-ФАНТОМАС', viewerCount: 0 };
    // migrate users
    data.users.forEach(u => {
      if (!u.friends) u.friends = [];
      if (!u.friendRequests) u.friendRequests = [];
      if (!u.subscriptions) u.subscriptions = [];
      if (!u.subscribers) u.subscribers = [];
      if (!u.bio) u.bio = '';
      if (!u.banner) u.banner = null;
      if (!u.theme) u.theme = 'light';
      if (!u.accent) u.accent = 'violet';
      if (!u.nicknameChangedAt) u.nicknameChangedAt = null;
      if (!u.isAdmin) u.isAdmin = false;
      if (!u.badge) u.badge = null;
      if (!u.level) u.level = 1;
      if (!u.xp) u.xp = 0;
    });
    // migrate videos
    data.videos.forEach(v => {
      if (!v.contentType) v.contentType = 'video'; // video, image, gif, music
      if (!v.tags) v.tags = [];
      if (!v.chapters) v.chapters = [];
      if (v.views === undefined) v.views = 0;
      if (!v.viewedBy) v.viewedBy = [];
      if (!v.downloads) v.downloads = 0;
    });
    return data;
  } catch {
    return { users: [], videos: [], comments: [], playlists: [], notifications: [], history: [], reports: [], friends: [], live: { isLive: false, hlsUrl: '', title: 'ТВ-ФАНТОМАС', viewerCount: 0 } };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  scheduleDBBackup();
}

// ---------- АВТО-БЭКАП БАЗЫ В CLOUDINARY ----------
// Render free стирает диск при каждом рестарте/деплое. Чтобы аккаунты и видео-записи
// не терялись, сервер держит копию db.json в Cloudinary (raw + authenticated:
// файл недоступен публично, скачивается только по подписи).
const DB_BACKUP_PUBLIC_ID = 'loltube/db.json';
const DB_BACKUP_DEBOUNCE_MS = 60000;
let dbBackupTimer = null;
let dbBackupBusy = false;
let lastBackupAt = null;
let dbRestoreState = 'not_needed'; // not_needed | restored | failed

async function backupDBToCloudinary() {
  if (!useCloudinary || dbBackupBusy) return;
  dbBackupBusy = true;
  try {
    // защита: не затираем хороший бэкап пустой базой, если при старте восстановление не удалось
    try {
      const cur = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      const empty = (!cur.users || cur.users.length === 0) && (!cur.videos || cur.videos.length === 0);
      if (empty && dbRestoreState === 'failed') {
        console.log('DB backup skipped: restore failed + local DB is empty (защита от затирания бэкапа)');
        return;
      }
    } catch {}
    await cloudinary.uploader.upload(DB_PATH, {
      resource_type: 'raw',
      type: 'authenticated',
      public_id: DB_BACKUP_PUBLIC_ID,
      overwrite: true,
      invalidate: true
    });
    lastBackupAt = new Date().toISOString();
    console.log('DB backup -> Cloudinary OK (' + lastBackupAt + ')');
  } catch (e) {
    console.error('DB backup failed:', e.message);
  } finally {
    dbBackupBusy = false;
  }
}

function scheduleDBBackup() {
  if (!useCloudinary || dbBackupTimer) return;
  dbBackupTimer = setTimeout(() => {
    dbBackupTimer = null;
    backupDBToCloudinary();
  }, DB_BACKUP_DEBOUNCE_MS);
}

async function restoreDBFromCloudinary() {
  if (!useCloudinary) return false;
  try {
    const url = cloudinary.utils.private_download_url(DB_BACKUP_PUBLIC_ID, '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 600
    });
    const res = await fetch(url);
    if (!res.ok) { console.log('DB restore: бэкап не найден/недоступен (HTTP ' + res.status + ')'); return false; }
    const txt = await res.text();
    const parsed = JSON.parse(txt);
    if (!parsed || !Array.isArray(parsed.users)) { console.log('DB restore: бэкап повреждён, пропускаю'); return false; }
    fs.writeFileSync(DB_PATH, txt);
    console.log('DB restored from Cloudinary: users=' + parsed.users.length + ', videos=' + (parsed.videos ? parsed.videos.length : 0));
    return true;
  } catch (e) {
    console.log('DB restore skipped:', e.message);
    return false;
  }
}

const DB_EXISTED_AT_BOOT = fs.existsSync(DB_PATH);
let db = loadDB();

// make first user admin
function ensureAdmin() {
  db = loadDB();
  if (db.users.length > 0 && !db.users.some(u => u.isAdmin)) {
    db.users[0].isAdmin = true;
    saveDB(db);
  }
}
ensureAdmin();

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '50mb' }));
// index.html никогда не кэшируем - иначе браузер держит старые ?v= ассеты
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'thumbnail') cb(null, THUMBS_DIR);
    else if (file.fieldname === 'cover') cb(null, THUMBS_DIR); // обложка трека артиста -> thumbs/
    else if (file.fieldname === 'avatar') cb(null, AVATARS_DIR);
    else if (file.fieldname === 'banner') cb(null, BANNERS_DIR);
    else if (file.fieldname === 'content') cb(null, CONTENT_DIR);
    else cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: Infinity, fields: 20 }, // без лимита по размеру (лимит даёт сам хостинг)
  fileFilter: (req, file, cb) => {
    // Allow all for content
    if (file.fieldname === 'content') {
      // image, gif, audio, video
      return cb(null, true);
    }
    if (file.fieldname === 'video' && !file.mimetype.startsWith('video/')) {
      // allow image/gif/music as video field for backward compat
      if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) return cb(null, true);
      return cb(new Error('Только видео/картинки/музыка'));
    }
    if ((file.fieldname === 'thumbnail' || file.fieldname === 'avatar' || file.fieldname === 'banner') && !file.mimetype.startsWith('image/')) return cb(new Error('Только картинки'));
    cb(null, true);
  }
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Нет токена' });
  const token = (header.split(' ')[1] || '').trim();
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
  // проверяем, что юзер ещё существует - иначе дальше будут 500 вместо честного 401
  db = loadDB();
  const exists = db.users.find(u => u.id === decoded.id);
  if (!exists) return res.status(401).json({ error: 'Аккаунт не найден' });
  req.user = decoded;
  next();
}
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return next();
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch {}
  next();
}
function adminMiddleware(req, res, next) {
  db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Только админ' });
  next();
}
function isNumericPin(pw) { return /^\d{3}$/.test(pw); }

// Helpers
function parseChapters(description) {
  // Parse timecodes like 00:12 or 0:12 or 01:23:45
  const regex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+)/g;
  const chapters = [];
  let m;
  while ((m = regex.exec(description)) !== null) {
    const h = m[1] ? parseInt(m[1]) : 0;
    const mm = parseInt(m[2]);
    const ss = parseInt(m[3]);
    const total = h*3600 + mm*60 + ss;
    chapters.push({ time: total, label: m[4].trim(), raw: m[0] });
  }
  return chapters.sort((a,b)=>a.time-b.time);
}
function addNotification(userId, type, data) {
  db = loadDB();
  const notif = { id: uuidv4(), userId, type, data, read: false, createdAt: new Date().toISOString() };
  db.notifications.push(notif);
  // keep only 100 per user
  const userNotifs = db.notifications.filter(n=>n.userId===userId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  if (userNotifs.length > 100) {
    const toDelete = userNotifs.slice(100).map(n=>n.id);
    db.notifications = db.notifications.filter(n=>!toDelete.includes(n.id));
  }
  saveDB(db);
  return notif;
}
function addXP(userId, amount) {
  db = loadDB();
  const user = db.users.find(u=>u.id===userId);
  if (!user) return;
  user.xp = (user.xp||0)+amount;
  user.level = Math.floor(user.xp/100)+1;
  // badges
  if (user.xp >= 100 && !user.badges?.includes('first100')) {
    if (!user.badges) user.badges=[];
    user.badges.push('first100');
  }
  saveDB(db);
}

async function uploadToCloudinary(filePath, resourceType='auto') {
  if (!useCloudinary) return null;
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      folder: 'loltube',
      use_filename: true,
      unique_filename: true
    });
    // delete local file after upload to save space
    try { fs.unlinkSync(filePath); } catch {}
    return result.secure_url;
  } catch (e) {
    console.error('Cloudinary upload error:', e.message);
    return null;
  }
}

// Auth
app.post('/api/login', async (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) return res.status(400).json({ error: 'Ник и пин обязательны' });
  const cleanNick = nickname.trim();
  if (cleanNick.length < 2 || cleanNick.length > 20) return res.status(400).json({ error: 'Ник 2-20 символов' });
  if (!/^[a-zA-Z0-9_]+$/.test(cleanNick)) return res.status(400).json({ error: 'Ник: только латиница, цифры, _' });
  if (!isNumericPin(password)) return res.status(400).json({ error: 'Пин только 3 цифры' });

  db = loadDB();
  let user = db.users.find(u => u.nickname.toLowerCase() === cleanNick.toLowerCase());

  if (!user) {
    const hash = await bcrypt.hash(password, 10);
    user = {
      id: uuidv4(),
      nickname: cleanNick,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      avatarColor: `hsl(${Math.floor(Math.random()*40+250)}, 85%, 60%)`,
      avatar: null,
      banner: null,
      bio: '',
      friends: [],
      friendRequests: [],
      subscriptions: [],
      subscribers: [],
      theme: 'light',
      accent: 'violet',
      nicknameChangedAt: null,
      isAdmin: db.users.length===0,
      badges: [],
      level: 1,
      xp: 0,
      totalViews: 0
    };
    db.users.push(user);
    saveDB(db);
  } else {
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ error: 'Неверный пинкод' });
  }

  const token = jwt.sign({ id: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: '60d' });
  res.json({ 
    token, 
    user: { 
      id: user.id, 
      nickname: user.nickname, 
      avatarColor: user.avatarColor,
      avatar: user.avatar ? `/uploads/avatars/${user.avatar}` : null,
      banner: user.banner ? `/uploads/banners/${user.banner}` : null,
      bio: user.bio,
      theme: user.theme,
      accent: user.accent,
      isAdmin: user.isAdmin,
      level: user.level,
      xp: user.xp,
      badges: user.badges
    } 
  });
});

app.post('/api/test-login', async (req, res) => {
  const { code } = req.body;
  if (code !== '1') return res.status(400).json({ error: 'Неверный код' });
  db = loadDB();
  const testNick = 'test_account';
  let user = db.users.find(u => u.nickname === testNick);
  if (!user) {
    const hash = await bcrypt.hash('000', 10);
    user = {
      id: uuidv4(),
      nickname: testNick,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      avatarColor: '#000000',
      avatar: null,
      banner: null,
      bio: 'Тестовый аккаунт',
      friends: [],
      friendRequests: [],
      subscriptions: [],
      subscribers: [],
      theme: 'light',
      accent: 'violet',
      nicknameChangedAt: null,
      isTest: true,
      isAdmin: false,
      badges: [],
      level: 1,
      xp: 0
    };
    db.users.push(user);
    saveDB(db);
  }
  const token = jwt.sign({ id: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: '60d' });
  res.json({
    token,
    user: {
      id: user.id,
      nickname: user.nickname,
      avatarColor: user.avatarColor,
      avatar: user.avatar ? `/uploads/avatars/${user.avatar}` : null,
      isAdmin: false
    }
  });
});

app.post('/api/register', async (req, res) => {
  return res.redirect(307, '/api/login');
});

app.get('/api/me', authMiddleware, (req, res) => {
  db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ 
    id: user.id, 
    nickname: user.nickname, 
    avatarColor: user.avatarColor,
    avatar: user.avatar ? `/uploads/avatars/${user.avatar}` : null,
    banner: user.banner ? `/uploads/banners/${user.banner}` : null,
    bio: user.bio,
    friends: user.friends,
    friendRequests: user.friendRequests,
    subscriptions: user.subscriptions,
    subscribers: user.subscribers,
    theme: user.theme,
    accent: user.accent,
    nicknameChangedAt: user.nicknameChangedAt,
    isAdmin: user.isAdmin,
    level: user.level,
    xp: user.xp,
    badges: user.badges,
    createdAt: user.createdAt
  });
});

// Update profile
app.put('/api/me', authMiddleware, (req, res) => {
  db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  const { bio, theme, accent } = req.body;
  if (bio !== undefined) {
    if (bio.length > 200) return res.status(400).json({ error: 'Био макс 200' });
    user.bio = bio.trim();
  }
  if (theme !== undefined) {
    if (!['light','dark','black'].includes(theme)) return res.status(400).json({ error: 'Тема light/dark/black' });
    user.theme = theme;
  }
  if (accent !== undefined) {
    if (!['violet','green','red','blue','pink','orange'].includes(accent)) return res.status(400).json({ error: 'Акцент violet/green/red/blue/pink/orange' });
    user.accent = accent;
  }
  saveDB(db);
  res.json({ ok: true, user });
});

// Change nickname - once per day
app.post('/api/me/change-nickname', authMiddleware, async (req, res) => {
  const { newNickname } = req.body;
  if (!newNickname) return res.status(400).json({ error: 'Новый ник обязателен' });
  const clean = newNickname.trim();
  if (clean.length < 2 || clean.length > 20) return res.status(400).json({ error: 'Ник 2-20' });
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) return res.status(400).json({ error: 'Только латиница, цифры, _' });
  db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (user.nicknameChangedAt) {
    const diff = Date.now() - new Date(user.nicknameChangedAt).getTime();
    if (diff < 24*60*60*1000) {
      const hours = Math.ceil((24*60*60*1000 - diff)/3600000);
      return res.status(400).json({ error: `Смена ника раз в день, подожди ${hours}ч` });
    }
  }
  if (db.users.some(u => u.nickname.toLowerCase()===clean.toLowerCase() && u.id!==user.id)) {
    return res.status(400).json({ error: 'Ник занят' });
  }
  const old = user.nickname;
  user.nickname = clean;
  user.nicknameChangedAt = new Date().toISOString();
  // update videos authorNickname
  db.videos.forEach(v => { if (v.authorId===user.id) v.authorNickname = clean; });
  db.comments.forEach(c => { if (c.authorId===user.id) c.authorNickname = clean; });
  saveDB(db);
  const token = jwt.sign({ id: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: '60d' });
  res.json({ ok: true, old, new: clean, token });
});

app.post('/api/me/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (user.nickname === 'test_account') {
    try { fs.unlinkSync(path.join(AVATARS_DIR, req.file.filename)); } catch {}
    return res.status(403).json({ error: 'Тестовый аккаунт не может менять аватарку' });
  }
  let avatarUrl = null;
  if (useCloudinary) {
    avatarUrl = await uploadToCloudinary(req.file.path, 'image');
  }
  if (user.avatar && !user.avatar.startsWith('http')) {
    try { fs.unlinkSync(path.join(AVATARS_DIR, user.avatar)); } catch {}
  }
  user.avatar = avatarUrl || req.file.filename;
  saveDB(db);
  addXP(user.id, 5);
  res.json({ avatar: avatarUrl || `/uploads/avatars/${user.avatar}` });
});

app.post('/api/me/banner', authMiddleware, upload.single('banner'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  let bannerUrl = null;
  if (useCloudinary) {
    bannerUrl = await uploadToCloudinary(req.file.path, 'image');
  }
  if (user.banner && !user.banner.startsWith('http')) {
    try { fs.unlinkSync(path.join(BANNERS_DIR, user.banner)); } catch {}
  }
  user.banner = bannerUrl || req.file.filename;
  saveDB(db);
  res.json({ banner: bannerUrl || `/uploads/banners/${user.banner}` });
});

// Friends
app.post('/api/friends/request/:nickname', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  const target = db.users.find(u=>u.nickname.toLowerCase()===req.params.nickname.toLowerCase());
  if (!target) return res.status(404).json({ error: 'Юзер не найден' });
  if (target.id===me.id) return res.status(400).json({ error: 'Себя нельзя' });
  // защита от старых аккаунтов без инициализированных массивов (иначе 500)
  me.friends = me.friends || []; me.friendRequests = me.friendRequests || [];
  target.friends = target.friends || []; target.friendRequests = target.friendRequests || [];
  if (me.friends.includes(target.id)) return res.status(400).json({ error: 'Уже друзья' });
  if (target.friendRequests.includes(me.id)) return res.status(400).json({ error: 'Заявка уже отправлена' });
  target.friendRequests.push(me.id);
  saveDB(db);
  addNotification(target.id, 'friend_request', { from: me.nickname, fromId: me.id });
  res.json({ ok: true });
});
app.post('/api/friends/accept/:nickname', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  const target = db.users.find(u=>u.nickname.toLowerCase()===req.params.nickname.toLowerCase());
  if (!target) return res.status(404).json({ error: 'Юзер не найден' });
  me.friends = me.friends || []; me.friendRequests = me.friendRequests || [];
  target.friends = target.friends || []; target.friendRequests = target.friendRequests || [];
  if (!me.friendRequests.includes(target.id)) return res.status(400).json({ error: 'Нет заявки' });
  me.friendRequests = me.friendRequests.filter(id=>id!==target.id);
  if (!me.friends.includes(target.id)) me.friends.push(target.id);
  if (!target.friends.includes(me.id)) target.friends.push(me.id);
  saveDB(db);
  addNotification(target.id, 'friend_accept', { from: me.nickname });
  res.json({ ok: true, friends: me.friends });
});
app.post('/api/friends/decline/:nickname', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  const target = db.users.find(u=>u.nickname.toLowerCase()===req.params.nickname.toLowerCase());
  if (!target) return res.status(404).json({ error: 'Юзер не найден' });
  me.friendRequests = (me.friendRequests || []).filter(id=>id!==target.id);
  saveDB(db);
  res.json({ ok: true });
});
app.delete('/api/friends/:nickname', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  const target = db.users.find(u=>u.nickname.toLowerCase()===req.params.nickname.toLowerCase());
  if (!target) return res.status(404).json({ error: 'Юзер не найден' });
  me.friends = (me.friends || []).filter(id=>id!==target.id);
  target.friends = (target.friends || []).filter(id=>id!==me.id);
  saveDB(db);
  res.json({ ok: true });
});
app.get('/api/friends', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  if (!me) return res.status(401).json({ error: 'Сессия недействительна' });
  const friends = db.users.filter(u=>(me.friends||[]).includes(u.id)).map(u=>({ id: u.id, nickname: u.nickname, avatar: u.avatar ? `/uploads/avatars/${u.avatar}` : null, avatarColor: u.avatarColor, level: u.level }));
  const requests = db.users.filter(u=>(me.friendRequests||[]).includes(u.id)).map(u=>({ id: u.id, nickname: u.nickname, avatar: u.avatar ? `/uploads/avatars/${u.avatar}` : null }));
  res.json({ friends, requests });
});

// Subscriptions
app.post('/api/subscribe/:nickname', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  const target = db.users.find(u=>u.nickname.toLowerCase()===req.params.nickname.toLowerCase());
  if (!target) return res.status(404).json({ error: 'Юзер не найден' });
  if (target.id===me.id) return res.status(400).json({ error: 'Себя нельзя' });
  me.subscriptions = me.subscriptions || []; target.subscribers = target.subscribers || [];
  if (me.subscriptions.includes(target.id)) {
    me.subscriptions = me.subscriptions.filter(id=>id!==target.id);
    target.subscribers = target.subscribers.filter(id=>id!==me.id);
    saveDB(db);
    return res.json({ subscribed: false });
  } else {
    me.subscriptions.push(target.id);
    target.subscribers.push(me.id);
    saveDB(db);
    addNotification(target.id, 'new_subscriber', { from: me.nickname });
    return res.json({ subscribed: true });
  }
});
app.get('/api/subscriptions', authMiddleware, (req, res) => {
  db = loadDB();
  const me = db.users.find(u=>u.id===req.user.id);
  if (!me) return res.status(401).json({ error: 'Сессия недействительна' });
  const subs = db.users.filter(u=>(me.subscriptions||[]).includes(u.id)).map(u=>({ id: u.id, nickname: u.nickname, avatar: u.avatar ? `/uploads/avatars/${u.avatar}` : null, subscribers: u.subscribers.length }));
  res.json(subs);
});

// Search
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ videos: [], users: [] });
  db = loadDB();
  const videos = db.videos.filter(v => 
    v.title.toLowerCase().includes(q) || 
    (v.description && v.description.toLowerCase().includes(q)) ||
    v.authorNickname.toLowerCase().includes(q) ||
    (v.artist && v.artist.toLowerCase().includes(q)) ||   // поиск по артисту
    (v.album && v.album.toLowerCase().includes(q)) ||     // поиск по альбому
    (v.tags && v.tags.some(t=>t.toLowerCase().includes(q)))
  ).sort((a,b)=> (b.views||0)-(a.views||0)).slice(0,20).map(v=>{
    const author = db.users.find(u=>u.id===v.authorId);
    return { ...v, authorColor: author?.avatarColor, authorAvatar: author?.avatar ? `/uploads/avatars/${author.avatar}` : null };
  });
  const users = db.users.filter(u=>u.nickname.toLowerCase().includes(q) || (u.bio && u.bio.toLowerCase().includes(q))).slice(0,10).map(u=>({ id: u.id, nickname: u.nickname, avatar: u.avatar ? `/uploads/avatars/${u.avatar}` : null, bio: u.bio, subscribers: u.subscribers?.length||0 }));
  res.json({ videos, users });
});

// Videos - improved views counting (unique per user, not spam)
app.get('/api/videos', (req, res) => {
  db = loadDB();
  const type = req.query.type; // video, image, gif, music, all
  const sort = req.query.sort || 'new'; // new, popular, old
  let videos = [...db.videos];
  if (type && type!=='all') {
    if (type==='music') videos = videos.filter(v=>v.contentType==='music' || v.contentType==='artist_music');
    else videos = videos.filter(v=>v.contentType===type);
  }
  if (sort==='popular') videos.sort((a,b)=> (b.views||0)-(a.views||0));
  else if (sort==='old') videos.sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  else videos.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  videos = videos.map(v => {
    const author = db.users.find(u => u.id === v.authorId);
    return { 
      ...v, 
      authorColor: author?.avatarColor || '#7c3aed',
      authorAvatar: author?.avatar ? `/uploads/avatars/${author.avatar}` : null
    };
  });
  res.json(videos);
});

app.get('/api/videos/:id', optionalAuth, (req, res) => {
  db = loadDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  // Fix views: count only unique viewers, not every reload, and not author
  const viewerId = req.user?.id || req.ip;
  if (!video.viewedBy) video.viewedBy=[];
  if (video.authorId !== viewerId && !video.viewedBy.includes(viewerId)) {
    video.viewedBy.push(viewerId);
    video.views = video.viewedBy.length;
    // add to history
    if (req.user) {
      db.history = db.history.filter(h=>!(h.userId===req.user.id && h.videoId===video.id));
      db.history.push({ id: uuidv4(), userId: req.user.id, videoId: video.id, watchedAt: new Date().toISOString() });
      if (db.history.filter(h=>h.userId===req.user.id).length>100) {
        const userHist = db.history.filter(h=>h.userId===req.user.id).sort((a,b)=>new Date(b.watchedAt)-new Date(a.watchedAt));
        const toKeep = userHist.slice(0,100).map(h=>h.id);
        db.history = db.history.filter(h=>h.userId!==req.user.id || toKeep.includes(h.id));
      }
    }
    // add XP to author
    const author = db.users.find(u=>u.id===video.authorId);
    if (author) {
      author.totalViews = (author.totalViews||0)+1;
      author.xp = (author.xp||0)+1;
      author.level = Math.floor(author.xp/100)+1;
    }
    saveDB(db);
  }
  const author = db.users.find(u => u.id === video.authorId);
  // позиция просмотра для «продолжить с того же места»
  const myHist = req.user ? db.history.find(h => h.userId === req.user.id && h.videoId === video.id) : null;
  // parse chapters
  const chapters = parseChapters(video.description||'');
  res.json({ 
    ...video, 
    chapters,
    watchPosition: myHist ? (myHist.position || 0) : 0,
    watchDuration: myHist ? (myHist.duration || 0) : 0,
    authorColor: author?.avatarColor || '#7c3aed',
    authorAvatar: author?.avatar ? `/uploads/avatars/${author.avatar}` : null,
    authorBio: author?.bio,
    authorSubscribers: author?.subscribers?.length||0,
    authorIsFriend: req.user ? author?.friends?.includes(req.user.id) : false,
    authorIsSubscribed: req.user ? db.users.find(u=>u.id===req.user.id)?.subscriptions?.includes(author?.id) : false
  });
});

app.get('/api/users/:nickname/videos', (req, res) => {
  db = loadDB();
  const user = db.users.find(u => u.nickname.toLowerCase() === req.params.nickname.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Юзер не найден' });
  const videos = db.videos.filter(v => v.authorId === user.id).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  res.json({ 
    user: { 
      id: user.id, 
      nickname: user.nickname, 
      avatarColor: user.avatarColor,
      avatar: user.avatar ? `/uploads/avatars/${user.avatar}` : null,
      banner: user.banner ? `/uploads/banners/${user.banner}` : null,
      bio: user.bio,
      subscribers: user.subscribers?.length||0,
      subscriptions: user.subscriptions?.length||0,
      friends: user.friends?.length||0,
      level: user.level,
      xp: user.xp,
      badges: user.badges,
      totalViews: user.totalViews||0,
      createdAt: user.createdAt
    }, 
    videos 
  });
});

// Upload - now supports video, image, gif, music + Cloudinary for free persistent storage without card
app.post('/api/videos/upload', authMiddleware, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'content', maxCount: 1 }]), async (req, res) => {
  const { title, description, contentType, tags, artist, album } = req.body;
  db = loadDB();
  const currentUser = db.users.find(u => u.id === req.user.id);
  if (!currentUser) return res.status(404).json({ error: 'Не найден' });
  if (currentUser.nickname === 'test_account') {
    if (req.files) {
      try { if (req.files.video) fs.unlinkSync(path.join(UPLOADS_DIR, req.files.video[0].filename)); } catch {}
      try { if (req.files.thumbnail) fs.unlinkSync(path.join(THUMBS_DIR, req.files.thumbnail[0].filename)); } catch {}
      try { if (req.files.content) fs.unlinkSync(path.join(CONTENT_DIR, req.files.content[0].filename)); } catch {}
      try { if (req.files.cover) fs.unlinkSync(path.join(THUMBS_DIR, req.files.cover[0].filename)); } catch {}
    }
    return res.status(403).json({ error: 'Тестовый аккаунт не может загружать' });
  }
  if (!title || !title.trim()) return res.status(400).json({ error: 'Название обязательно' });
  
  let file = null;
  let type = contentType || 'video';
  if (req.files) {
    if (req.files.video) file = req.files.video[0];
    else if (req.files.content) file = req.files.content[0];
  }
  if (!file) return res.status(400).json({ error: 'Файл обязателен' });

  // Determine content type by mimetype
  if (!contentType) {
    if (file.mimetype.startsWith('image/')) {
      type = file.mimetype === 'image/gif' ? 'gif' : 'image';
    } else if (file.mimetype.startsWith('audio/')) {
      type = 'music';
    } else {
      type = 'video';
    }
  }

  const thumbFile = req.files.thumbnail ? req.files.thumbnail[0] : null;
  // МУЗЫКА АРТИСТА: обложка трека (статичное изображение вместо видео)
  const coverFile = req.files.cover ? req.files.cover[0] : (type === 'artist_music' ? thumbFile : null);
  const isArtistTrack = type === 'artist_music' || type === 'music';
  const parsedTags = tags ? (typeof tags === 'string' ? tags.split(',').map(t=>t.trim()).filter(Boolean) : tags) : [];

  // Cloudinary upload for persistent storage free without card (25GB free, no card needed)
  let cloudinaryUrl = null;
  let cloudinaryThumbUrl = null;
  if (useCloudinary) {
    const resourceType = type==='image' || type==='gif' ? 'image' : 'video'; // Cloudinary: audio идёт как video
    cloudinaryUrl = await uploadToCloudinary(file.path, resourceType);
    if (thumbFile) {
      cloudinaryThumbUrl = await uploadToCloudinary(thumbFile.path, 'image');
    }
    if (coverFile && coverFile !== thumbFile) {
      cloudinaryThumbUrl = await uploadToCloudinary(coverFile.path, 'image');
    }
  }

  const newVideo = {
    id: uuidv4(),
    title: title.trim(),
    description: (description || '').trim(),
    filename: cloudinaryUrl || file.filename, // if cloudinary, store URL, else local filename
    originalName: file.originalname,
    size: file.size,
    mimetype: file.mimetype,
    contentType: type,
    thumbnail: cloudinaryThumbUrl || (coverFile ? `thumbs/${coverFile.filename}` : thumbFile ? `thumbs/${thumbFile.filename}` : null),
    cover: cloudinaryThumbUrl || (coverFile ? `thumbs/${coverFile.filename}` : null), // обложка трека для МУЗЫКИ АРТИСТА
    cloudinaryUrl: cloudinaryUrl || null,
    cloudinaryThumbUrl: cloudinaryThumbUrl || null,
    artist: isArtistTrack ? (artist || '').toString().trim() || currentUser.nickname : null,
    album: isArtistTrack ? (album || '').toString().trim() || null : null,
    authorId: req.user.id,
    authorNickname: req.user.nickname,
    createdAt: new Date().toISOString(),
    views: 0,
    viewedBy: [],
    likes: [],
    dislikes: [],
    downloads: 0,
    tags: parsedTags,
    chapters: parseChapters(description||'')
  };
  db.videos.push(newVideo);
  // notify subscribers
  const author = db.users.find(u=>u.id===req.user.id);
  if (author && author.subscribers) {
    author.subscribers.forEach(subId => {
      addNotification(subId, 'new_video', { author: author.nickname, videoId: newVideo.id, title: newVideo.title });
    });
  }
  saveDB(db);
  addXP(req.user.id, 10);
  res.json(newVideo);
});

// Playlists
app.get('/api/playlists', (req, res) => {
  db = loadDB();
  const userId = req.query.userId;
  let pls = [...db.playlists];
  if (userId) pls = pls.filter(p=>p.authorId===userId);
  pls.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  res.json(pls);
});
app.post('/api/playlists', authMiddleware, (req, res) => {
  const { title, description, isPublic } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Название обязательно' });
  db = loadDB();
  const pl = {
    id: uuidv4(),
    title: title.trim(),
    description: (description||'').trim(),
    authorId: req.user.id,
    authorNickname: req.user.nickname,
    videos: [],
    isPublic: isPublic!==false,
    createdAt: new Date().toISOString()
  };
  db.playlists.push(pl);
  saveDB(db);
  res.json(pl);
});
app.post('/api/playlists/:id/add/:videoId', authMiddleware, (req, res) => {
  db = loadDB();
  const pl = db.playlists.find(p=>p.id===req.params.id);
  if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });
  if (pl.authorId!==req.user.id) return res.status(403).json({ error: 'Не твой' });
  if (!pl.videos.includes(req.params.videoId)) pl.videos.push(req.params.videoId);
  saveDB(db);
  res.json(pl);
});
app.delete('/api/playlists/:id/remove/:videoId', authMiddleware, (req, res) => {
  db = loadDB();
  const pl = db.playlists.find(p=>p.id===req.params.id);
  if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });
  if (pl.authorId!==req.user.id) return res.status(403).json({ error: 'Не твой' });
  pl.videos = pl.videos.filter(id=>id!==req.params.videoId);
  saveDB(db);
  res.json(pl);
});
app.delete('/api/playlists/:id', authMiddleware, (req, res) => {
  db = loadDB();
  const idx = db.playlists.findIndex(p=>p.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error: 'Не найден' });
  if (db.playlists[idx].authorId!==req.user.id) return res.status(403).json({ error: 'Не твой' });
  db.playlists.splice(idx,1);
  saveDB(db);
  res.json({ ok: true });
});

// History
app.get('/api/history', authMiddleware, (req, res) => {
  db = loadDB();
  const hist = db.history.filter(h=>h.userId===req.user.id).sort((a,b)=>new Date(b.watchedAt)-new Date(a.watchedAt)).slice(0,50);
  const videos = hist.map(h=>{
    const v = db.videos.find(vid=>vid.id===h.videoId);
    if (!v) return null;
    const author = db.users.find(u=>u.id===v.authorId);
    return { ...v, watchedAt: h.watchedAt, position: h.position || 0, duration: h.duration || 0, authorColor: author?.avatarColor, authorAvatar: author?.avatar ? `/uploads/avatars/${author.avatar}` : null };
  }).filter(Boolean);
  res.json(videos);
});
// «продолжить просмотр»: фронт шлёт позицию раз в ~10 сек
app.post('/api/videos/:id/watch-position', authMiddleware, (req, res) => {
  db = loadDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  const position = Number(req.body?.position) || 0;
  const duration = Number(req.body?.duration) || 0;
  let rec = db.history.find(h => h.userId === req.user.id && h.videoId === video.id);
  if (!rec) {
    rec = { id: uuidv4(), userId: req.user.id, videoId: video.id, watchedAt: new Date().toISOString() };
    db.history.push(rec);
  }
  rec.position = Math.max(0, position);
  if (duration > 0) rec.duration = duration;
  rec.watchedAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, position: rec.position, duration: rec.duration || 0 });
});

app.delete('/api/history', authMiddleware, (req, res) => {
  db = loadDB();
  db.history = db.history.filter(h=>h.userId!==req.user.id);
  saveDB(db);
  res.json({ ok: true });
});

// Favorites / Watch later (stored in user)
app.get('/api/favorites', authMiddleware, (req, res) => {
  db = loadDB();
  const user = db.users.find(u=>u.id===req.user.id);
  const favIds = user.favorites||[];
  const videos = db.videos.filter(v=>favIds.includes(v.id)).map(v=>{
    const author = db.users.find(u=>u.id===v.authorId);
    return { ...v, authorColor: author?.avatarColor };
  });
  res.json(videos);
});
app.post('/api/favorites/:videoId', authMiddleware, (req, res) => {
  db = loadDB();
  const user = db.users.find(u=>u.id===req.user.id);
  if (!user.favorites) user.favorites=[];
  if (user.favorites.includes(req.params.videoId)) {
    user.favorites = user.favorites.filter(id=>id!==req.params.videoId);
    saveDB(db);
    return res.json({ favorited: false });
  } else {
    user.favorites.push(req.params.videoId);
    saveDB(db);
    return res.json({ favorited: true });
  }
});

// Likes - improved with animation data
app.post('/api/videos/:id/like', authMiddleware, (req, res) => {
  db = loadDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  const userId = req.user.id;
  const type = req.body.type || 'like';
  video.likes = (video.likes || []).filter(id => id !== userId);
  video.dislikes = (video.dislikes || []).filter(id => id !== userId);
  if (type === 'like') video.likes.push(userId);
  else if (type === 'dislike') video.dislikes.push(userId);
  saveDB(db);
  if (type==='like' && video.authorId!==userId) {
    addNotification(video.authorId, 'like', { from: req.user.nickname, videoId: video.id });
  }
  res.json({ likes: video.likes.length, dislikes: video.dislikes.length, userLiked: video.likes.includes(userId), userDisliked: video.dislikes.includes(userId) });
});
app.get('/api/videos/:id/like-status', authMiddleware, (req, res) => {
  db = loadDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  const userId = req.user.id;
  res.json({
    likes: (video.likes||[]).length,
    dislikes: (video.dislikes||[]).length,
    userLiked: (video.likes||[]).includes(userId),
    userDisliked: (video.dislikes||[]).includes(userId)
  });
});

// Comments with replies
app.get('/api/videos/:id/comments', (req, res) => {
  db = loadDB();
  const comments = db.comments.filter(c => c.videoId === req.params.id).sort((a,b)=> new Date(a.createdAt)-new Date(b.createdAt));
  const enriched = comments.map(c => {
    const author = db.users.find(u => u.id === c.authorId);
    return { ...c, authorColor: author?.avatarColor || '#7c3aed', authorAvatar: author?.avatar ? `/uploads/avatars/${author.avatar}` : null, authorLevel: author?.level||1 };
  });
  res.json(enriched);
});
app.post('/api/videos/:id/comments', authMiddleware, (req, res) => {
  const { text, replyTo } = req.body;
  if (!text || text.trim().length < 1) return res.status(400).json({ error: 'Пусто' });
  if (text.length > 1000) return res.status(400).json({ error: 'Макс 1000' });
  db = loadDB();
  const video = db.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Видео не найдено' });
  const comment = {
    id: uuidv4(),
    videoId: req.params.id,
    authorId: req.user.id,
    authorNickname: req.user.nickname,
    text: text.trim(),
    replyTo: replyTo||null,
    likes: [],
    createdAt: new Date().toISOString()
  };
  db.comments.push(comment);
  saveDB(db);
  if (video.authorId!==req.user.id) {
    addNotification(video.authorId, 'comment', { from: req.user.nickname, videoId: video.id, text: text.trim().slice(0,50) });
  }
  if (replyTo) {
    const parent = db.comments.find(c=>c.id===replyTo);
    if (parent && parent.authorId!==req.user.id) {
      addNotification(parent.authorId, 'reply', { from: req.user.nickname, videoId: video.id });
    }
  }
  addXP(req.user.id, 2);
  const author = db.users.find(u => u.id === comment.authorId);
  res.json({ ...comment, authorColor: author?.avatarColor, authorAvatar: author?.avatar ? `/uploads/avatars/${author.avatar}` : null });
});
app.post('/api/comments/:id/like', authMiddleware, (req, res) => {
  db = loadDB();
  const c = db.comments.find(cm=>cm.id===req.params.id);
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!c.likes) c.likes=[];
  if (c.likes.includes(req.user.id)) c.likes = c.likes.filter(id=>id!==req.user.id);
  else c.likes.push(req.user.id);
  saveDB(db);
  res.json({ likes: c.likes.length, userLiked: c.likes.includes(req.user.id) });
});

// Download count
app.post('/api/videos/:id/download', authMiddleware, (req, res) => {
  db = loadDB();
  const video = db.videos.find(v=>v.id===req.params.id);
  if (!video) return res.status(404).json({ error: 'Не найдено' });
  video.downloads = (video.downloads||0)+1;
  saveDB(db);
  res.json({ downloads: video.downloads });
});

// Notifications
app.get('/api/notifications', authMiddleware, (req, res) => {
  db = loadDB();
  const notifs = db.notifications.filter(n=>n.userId===req.user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,30);
  res.json(notifs);
});
app.post('/api/notifications/read', authMiddleware, (req, res) => {
  db = loadDB();
  db.notifications.filter(n=>n.userId===req.user.id).forEach(n=>n.read=true);
  saveDB(db);
  res.json({ ok: true });
});

// Reports
app.post('/api/report/:videoId', authMiddleware, (req, res) => {
  const { reason } = req.body;
  db = loadDB();
  const report = { id: uuidv4(), videoId: req.params.videoId, reporterId: req.user.id, reason: reason||'other', createdAt: new Date().toISOString() };
  db.reports.push(report);
  saveDB(db);
  res.json({ ok: true });
});

// Live - TV-FANTOMAS
app.get('/api/live', (req, res) => {
  db = loadDB();
  res.json(db.live);
});
app.post('/api/live', authMiddleware, adminMiddleware, (req, res) => {
  const { isLive, hlsUrl, title } = req.body;
  db = loadDB();
  if (isLive!==undefined) db.live.isLive = isLive;
  if (hlsUrl!==undefined) db.live.hlsUrl = hlsUrl;
  if (title!==undefined) db.live.title = title;
  saveDB(db);
  res.json(db.live);
});
app.post('/api/live/view', (req, res) => {
  db = loadDB();
  db.live.viewerCount = (db.live.viewerCount||0)+1;
  saveDB(db);
  res.json({ viewerCount: db.live.viewerCount });
});

// Admin - max possibilities
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  db = loadDB();
  res.json({
    users: db.users.length,
    videos: db.videos.length,
    comments: db.comments.length,
    playlists: db.playlists.length,
    reports: db.reports.length,
    live: db.live,
    storage: {
      uploads: fs.readdirSync(UPLOADS_DIR).length,
      avatars: fs.readdirSync(AVATARS_DIR).length,
      thumbs: fs.readdirSync(THUMBS_DIR).length
    }
  });
});
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  db = loadDB();
  res.json(db.users.map(u=>({ id: u.id, nickname: u.nickname, isAdmin: u.isAdmin, level: u.level, xp: u.xp, createdAt: u.createdAt, videos: db.videos.filter(v=>v.authorId===u.id).length })));
});
app.get('/api/admin/videos', authMiddleware, adminMiddleware, (req, res) => {
  db = loadDB();
  res.json(db.videos);
});
app.delete('/api/admin/videos/:id', authMiddleware, adminMiddleware, (req, res) => {
  db = loadDB();
  const idx = db.videos.findIndex(v=>v.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error: 'Не найдено' });
  const vid = db.videos[idx];
  try { fs.unlinkSync(path.join(UPLOADS_DIR, vid.filename)); } catch {}
  if (vid.thumbnail) try { fs.unlinkSync(path.join(UPLOADS_DIR, vid.thumbnail)); } catch {}
  db.videos.splice(idx,1);
  saveDB(db);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  db = loadDB();
  const idx = db.users.findIndex(u=>u.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error: 'Не найден' });
  if (db.users[idx].isAdmin) return res.status(400).json({ error: 'Админа нельзя' });
  db.users.splice(idx,1);
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/videos/:id', authMiddleware, (req, res) => {
  db = loadDB();
  const idx = db.videos.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  const isOwner = db.videos[idx].authorId === req.user.id;
  const isAdmin = db.users.find(u=>u.id===req.user.id)?.isAdmin;
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Не твое' });
  const vid = db.videos[idx];
  try { fs.unlinkSync(path.join(UPLOADS_DIR, vid.filename)); } catch {}
  if (vid.thumbnail) try { fs.unlinkSync(path.join(UPLOADS_DIR, vid.thumbnail)); } catch {}
  db.videos.splice(idx,1);
  db.comments = db.comments.filter(c => c.videoId !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({ 
    name: 'LolTube',
    version: '2.0',
    developer: 'https://grapegg-developer.github.io/RoboBattle-Web/',
    features: ['friends','playlists','live','search','themes','admin','history','favorites','chapters','download','loop','screenshot'],
    storage: { cloudinary: !!useCloudinary, persistent: !!useCloudinary, backup: !!useCloudinary, lastBackupAt }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
  // Render free: диск эфемерный. Файла нет (рестарт/деплой) -> поднимаем базу из Cloudinary.
  let needRestore = !DB_EXISTED_AT_BOOT;
  if (!needRestore) {
    try { JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch { needRestore = true; } // файл повреждён
  }
  if (needRestore) {
    const okRestore = await restoreDBFromCloudinary();
    dbRestoreState = okRestore ? 'restored' : 'failed';
    db = loadDB();
    ensureAdmin();
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LolTube v2 running on http://0.0.0.0:${PORT}`);
    console.log(`Admin: first user is admin`);
    console.log(`Live TV-FANTOMAS: POST /api/live with HLS URL (SRT -> convert to HLS via OBS or restream.io)`);
    if (useCloudinary) {
      console.log('DB auto-backup: ENABLED (Cloudinary raw/authenticated, debounce ' + (DB_BACKUP_DEBOUNCE_MS / 1000) + 's, restore state: ' + dbRestoreState + ')');
      backupDBToCloudinary();
    } else {
      console.log('DB auto-backup: DISABLED (нет CLOUDINARY_* env vars)');
    }
  });
})();
