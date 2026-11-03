#!/usr/bin/env python3
"""Create an experimental combined server from the exact public upstream.

This is a lab patch, NOT permission to deploy. It requires independently
verified storage fencing, an abuse/cost cap, a verified no-overlap cutover,
load/device tests and an owner-approved deployment procedure. No user data or
credentials are accepted. The caller copies modules beside the generated file.
"""
import argparse
import hashlib
from pathlib import Path

UPSTREAM = '462dc1ab2e7117dfe93ac6085f6e0390b5e8cd74efd06f83d14c1916a1c038b9'
parser = argparse.ArgumentParser()
parser.add_argument('input', type=Path)
parser.add_argument('output', type=Path)
a = parser.parse_args()
raw = a.input.read_bytes()
if hashlib.sha256(raw).hexdigest() != UPSTREAM:
    raise SystemExit('unexpected upstream server; refusing patch')
s = raw.decode('utf-8')

def replace(old, new, count=1):
    global s
    if s.count(old) != count:
        raise SystemExit('upstream patch anchor mismatch')
    s = s.replace(old, new, count)

replace("const app = express();\n", """const app = express();
// Only /gsrv-v1 GLINK/G+ requests are routed here; legacy routes stay separate.
let cloudRouter = null;
app.use((req, res, next) => {
  if (cloudRouter) return cloudRouter.handler(req, res, next);
  const p = (req.url || '').split('?')[0];
  if (/^\\/gsrv-v1\\/(?:glink|gplus)(?:\\/|$)/.test(p)) {
    req.resume(); return res.status(503).json({error:'cloud_storage_unavailable'});
  }
  if (p === '/gsrv-v1/gserver/status' && req.method === 'GET')
    return res.status(200).json({mode:'GLINK-S',state:'unavailable'});
  return next();
});
""")
replace("const DB_PATH = path.join(DATA_DIR, 'db.json');\n", """const DB_PATH = path.join(DATA_DIR, 'db.json');
const crypto = require('node:crypto'), os = require('node:os');
const {createDurableGate} = require('./loltube-safety/durable-gate');
const {requireVerifiedBackup,validate} = require('./loltube-safety/verified-backup');
const {createBackupStore} = require('./loltube-combined/backup-store');
const {LoltubeLedger} = require('./loltube-combined/ledger-backup');
const {CloudinaryStore} = require('./gplus-cloud/cloudinary-store');
if (!useCloudinary || !process.env.JWT_SECRET) throw Error('verified storage and JWT secret required');
const backupStore = createBackupStore({cloudinary});
const durableLedger = new LoltubeLedger(new CloudinaryStore({cloudinary,prefix:'loltube-ledger-v1'}));
let lastBackupAt = null, dbRestoreState = 'unavailable', committedDb = null;
const safetyGate = createDurableGate({
  snapshot: async () => fs.readFileSync(DB_PATH),
  preflight: async () => { if (await durableLedger.changedExternally()) throw Error('ledger_stale'); },
  commit: async bytes => { await durableLedger.commit(bytes); committedDb = validate(bytes); lastBackupAt = new Date().toISOString(); },
  onFatal: () => console.error('LOLTUBE durable ledger unavailable; API remains fenced')
});
// Keep the health check available. Media bytes are staged before the API gate,
// then their metadata and response go through that same durable gate.
app.use('/api', (req, res, next) => {
  const staged = req.method === 'POST' && ['/me/avatar','/me/banner','/videos/upload'].includes(req.path);
  if (staged || (req.path === '/config' && req.method === 'GET')) return next();
  return safetyGate(req, res, next);
});
""")
start = s.index('  if (!fs.existsSync(DB_PATH)) {', s.index('function loadDB()'))
end = s.index('  try {\n    const data = JSON.parse', start)
s = s[:start] + "  if (!fs.existsSync(DB_PATH)) throw Error('verified_backup_required');\n" + s[end:]
replace("    return { users: [], videos: [], comments: [], playlists: [], notifications: [], history: [], reports: [], friends: [], live: { isLive: false, hlsUrl: '', title: 'ТВ-ФАНТОМАС', viewerCount: 0 } };",
        "    throw Error('local_database_invalid');")
replace("""  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  scheduleDBBackup();""", """  const raw = Buffer.from(JSON.stringify(db, null, 2)); validate(raw);
  const tmp = DB_PATH + '.tmp-' + crypto.randomBytes(8).toString('hex'); let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, DB_PATH); safetyGate.markMutation();
  } catch (e) { throw Error('local_database_write_failed'); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} }""")
start = s.index('// ---------- АВТО-БЭКАП БАЗЫ В CLOUDINARY ----------')
end = s.index('// CORS\n', start)
s = s[:start] + "let db = null; // restored from verified authenticated backup before listening\n\n" + s[end:]
replace("console.error('Cloudinary upload error:', e.message);", "console.error('Cloudinary upload failed');")
replace("// Auth\napp.post('/api/login'", """// Media can take minutes to arrive from a client and to upload to Cloudinary.
// Stage it before serializing state changes, then re-authenticate inside the
// normal gate before saving the reference and acknowledging the request.
async function preMediaAuth(req,res,next) {
  if (!safetyGate.isHealthy() || !committedDb) return res.status(503).json({error:'backup_unavailable'});
  let decoded;
  try { const token = (req.headers.authorization || '').split(' ')[1] || ''; decoded = jwt.verify(token, JWT_SECRET); }
  catch (_) { return res.status(401).json({error:'unauthorized'}); }
  const user = committedDb.users.find(u => u.id === decoded.id);
  if (!user) return res.status(401).json({error:'unauthorized'});
  if (user.nickname === 'test_account') return res.status(403).json({error:'upload_forbidden'});
  try { if (await durableLedger.changedExternally()) return res.status(503).json({error:'backup_unavailable'}); }
  catch (_) { return res.status(503).json({error:'backup_unavailable'}); }
  return next();
}
function discardMediaTemps(req) {
  const all = req.file ? [req.file] : Object.values(req.files || {}).flat();
  for (const file of all) {
    if (!file || typeof file.path !== 'string') continue;
    const resolved=path.resolve(file.path), root=path.resolve(UPLOADS_DIR)+path.sep;
    if (resolved.startsWith(root)) try { fs.unlinkSync(resolved); } catch (_) {}
  }
}
async function stageImage(req,res,next) {
  if (!req.file) return res.status(400).json({error:'file_required'});
  req.stagedImage = await uploadToCloudinary(req.file.path,'image');
  discardMediaTemps(req);
  if (!req.stagedImage) return res.status(503).json({error:'media_storage_unavailable'});
  return next();
}
async function stageVideo(req,res,next) {
  const {title,contentType} = req.body || {};
  if (typeof title !== 'string' || !title.trim()) { discardMediaTemps(req); return res.status(400).json({error:'title_required'}); }
  const f=req.files || {}, file=f.video?.[0] || f.content?.[0];
  if (!file) { discardMediaTemps(req); return res.status(400).json({error:'file_required'}); }
  let type=contentType || 'video';
  if (!contentType) type=file.mimetype.startsWith('image/') ? (file.mimetype==='image/gif'?'gif':'image') : file.mimetype.startsWith('audio/') ? 'music' : 'video';
  const thumb=f.thumbnail?.[0] || null, cover=f.cover?.[0] || (type==='artist_music' ? thumb : null);
  req.stagedVideo=await uploadToCloudinary(file.path,type==='image'||type==='gif'?'image':'video');
  if (!req.stagedVideo) { discardMediaTemps(req); return res.status(503).json({error:'media_storage_unavailable'}); }
  req.stagedThumb=null;
  if (thumb) { req.stagedThumb=await uploadToCloudinary(thumb.path,'image'); if (!req.stagedThumb) { discardMediaTemps(req); return res.status(503).json({error:'media_storage_unavailable'}); } }
  if (cover && cover!==thumb) { req.stagedThumb=await uploadToCloudinary(cover.path,'image'); if (!req.stagedThumb) { discardMediaTemps(req); return res.status(503).json({error:'media_storage_unavailable'}); } }
  discardMediaTemps(req); return next();
}

// Auth
app.post('/api/login'""")
replace("app.post('/api/me/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {",
        "app.post('/api/me/avatar', preMediaAuth, upload.single('avatar'), stageImage, safetyGate, authMiddleware, async (req, res) => {")
replace("app.post('/api/me/banner', authMiddleware, upload.single('banner'), async (req, res) => {",
        "app.post('/api/me/banner', preMediaAuth, upload.single('banner'), stageImage, safetyGate, authMiddleware, async (req, res) => {")
replace("app.post('/api/videos/upload', authMiddleware, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'content', maxCount: 1 }]), async (req, res) => {",
        "app.post('/api/videos/upload', preMediaAuth, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'content', maxCount: 1 }]), stageVideo, safetyGate, authMiddleware, async (req, res) => {")
replace("""  let avatarUrl = null;
  if (useCloudinary) {
    avatarUrl = await uploadToCloudinary(req.file.path, 'image');
  }""", "  const avatarUrl = req.stagedImage;")
replace("""  let bannerUrl = null;
  if (useCloudinary) {
    bannerUrl = await uploadToCloudinary(req.file.path, 'image');
  }""", "  const bannerUrl = req.stagedImage;")
# Never delete a previously referenced local object before the database is durable.
replace("""  if (user.avatar && !user.avatar.startsWith('http')) {
    try { fs.unlinkSync(path.join(AVATARS_DIR, user.avatar)); } catch {}
  }
""", "")
replace("""  if (user.banner && !user.banner.startsWith('http')) {
    try { fs.unlinkSync(path.join(BANNERS_DIR, user.banner)); } catch {}
  }
""", "")
replace("""  try { fs.unlinkSync(path.join(UPLOADS_DIR, vid.filename)); } catch {}
  if (vid.thumbnail) try { fs.unlinkSync(path.join(UPLOADS_DIR, vid.thumbnail)); } catch {}
""", "", 2)
replace("  user.avatar = avatarUrl || req.file.filename;", """  if (!avatarUrl) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(503).json({error:'media_storage_unavailable'}); }
  user.avatar = avatarUrl;""")
replace("  user.banner = bannerUrl || req.file.filename;", """  if (!bannerUrl) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(503).json({error:'media_storage_unavailable'}); }
  user.banner = bannerUrl;""")
replace("""  let cloudinaryUrl = null;
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
  }""", """  const cloudinaryUrl = req.stagedVideo;
  const cloudinaryThumbUrl = req.stagedThumb;""")
# A failed upload must not report a successful URL pointing to the ephemeral disk.
replace("  const newVideo = {\n", "  if (!cloudinaryUrl) return res.status(503).json({error:'media_storage_unavailable'});\n\n  const newVideo = {\n")
start = s.index('(async () => {\n', s.index("app.get('*'"))
s = s[:start] + """(async () => {
  // First import is for an isolated lab only. A real cutover must quiesce the
  // old writer and verify its final backup before doing this exactly once.
  let backup = await durableLedger.recover();
  if (backup === null) {
    backup = await requireVerifiedBackup(backupStore); await durableLedger.importOnce(backup);
    dbRestoreState = 'imported';
  } else dbRestoreState = 'ledger';
  const tmp = DB_PATH + '.restore-' + crypto.randomBytes(8).toString('hex');
  try { fs.writeFileSync(tmp, backup, {flag:'wx',mode:0o600}); fs.renameSync(tmp, DB_PATH); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  db = loadDB(); committedDb = validate(backup);
  // Failure of the new, isolated cloud router must not rewrite LOLTUBE data.
  try {
    const {CloudinaryRelayStore} = require('./glink-cloud/cloudinary-store');
    const {createCloudRouter} = require('./loltube-combined/cloud-router');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loltube-cloud-runtime-'));
    cloudRouter = await createCloudRouter({
      relayStore:new CloudinaryRelayStore({cloudinary,prefix:'glink-cloud-v1/relay'}),
      offersStore:new CloudinaryStore({cloudinary,prefix:'glink-cloud-v1/offers'}),
      gplusStore:new CloudinaryStore({cloudinary,prefix:'gplus-cloud-v1'}),
      dataDir:dir,webDir:path.join(__dirname,'glink-web'),cleanupIntervalMs:60000,
      onFatal:()=>console.error('GLINK/G+ cloud fenced after a storage error')
    });
  } catch (_) { console.error('GLINK/G+ cloud initialization failed; routes remain unavailable'); }
  const server = app.listen(PORT, '0.0.0.0', () => console.log('LOLTUBE verified-backup lab running'));
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (cloudRouter && await cloudRouter.handleUpgrade(req, socket, head)) return;
      if (!gserverGateway.handleUpgrade(req, socket, head)) socket.destroy();
    } catch (_) { socket.destroy(); }
  });
})().catch(() => { console.error('Verified LOLTUBE backup unavailable; refusing to start'); try { gserverGateway.close(); } catch (_) {} process.exit(1); });
"""
a.output.parent.mkdir(parents=True, exist_ok=True)
a.output.write_text(s, encoding='utf-8')
print('experimental_combined_lab_server_generated', hashlib.sha256(s.encode()).hexdigest())
