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
const {commitVerified,requireVerifiedBackup,validate} = require('./loltube-safety/verified-backup');
const {createBackupStore} = require('./loltube-combined/backup-store');
if (!useCloudinary || !process.env.JWT_SECRET) throw Error('verified storage and JWT secret required');
const backupStore = createBackupStore({cloudinary});
let lastBackupAt = null, dbRestoreState = 'unavailable';
const safetyGate = createDurableGate({
  snapshot: async () => fs.readFileSync(DB_PATH),
  commit: async bytes => { await commitVerified(backupStore, bytes); lastBackupAt = new Date().toISOString(); },
  onFatal: () => console.error('LOLTUBE durable backup unavailable; API remains fenced')
});
// Keep the host health check available without exposing speculative data.
app.use('/api', (req, res, next) => req.path === '/config' && req.method === 'GET' ? next() : safetyGate(req, res, next));
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
replace("    cloudinaryUrl = await uploadToCloudinary(file.path, resourceType);", """    cloudinaryUrl = await uploadToCloudinary(file.path, resourceType);
    if (!cloudinaryUrl) return res.status(503).json({error:'media_storage_unavailable'});""")
replace("      cloudinaryThumbUrl = await uploadToCloudinary(thumbFile.path, 'image');", """      cloudinaryThumbUrl = await uploadToCloudinary(thumbFile.path, 'image');
      if (!cloudinaryThumbUrl) return res.status(503).json({error:'media_storage_unavailable'});""")
replace("      cloudinaryThumbUrl = await uploadToCloudinary(coverFile.path, 'image');", """      cloudinaryThumbUrl = await uploadToCloudinary(coverFile.path, 'image');
      if (!cloudinaryThumbUrl) return res.status(503).json({error:'media_storage_unavailable'});""")
# A failed upload must not report a successful URL pointing to the ephemeral disk.
replace("  const newVideo = {\n", "  if (!cloudinaryUrl) return res.status(503).json({error:'media_storage_unavailable'});\n\n  const newVideo = {\n")
start = s.index('(async () => {\n', s.index("app.get('*'"))
s = s[:start] + """(async () => {
  // Never substitute an empty database when backup download or parsing fails.
  const backup = await requireVerifiedBackup(backupStore);
  const tmp = DB_PATH + '.restore-' + crypto.randomBytes(8).toString('hex');
  try { fs.writeFileSync(tmp, backup, {flag:'wx',mode:0o600}); fs.renameSync(tmp, DB_PATH); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  dbRestoreState = 'restored'; db = loadDB();
  // Failure of the new, isolated cloud router must not rewrite LOLTUBE data.
  try {
    const {CloudinaryStore} = require('./gplus-cloud/cloudinary-store');
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
