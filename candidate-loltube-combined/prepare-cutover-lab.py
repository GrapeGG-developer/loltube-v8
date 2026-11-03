#!/usr/bin/env python3
"""Generate a maintenance-first combined LOLTUBE server for ISOLATED TESTS.

Never deploy this lab script directly. ManualCutover does not independently
prove the old writer exited, prevent provider CAS anomalies, or enforce a hard
workspace cost cap. No real user data or credentials are accepted by this
builder. Generated files go only to /var/tmp.
"""
from pathlib import Path
import argparse,subprocess
root=Path(__file__).resolve().parent.parent
upstream=Path('/var/tmp/loltube-combined-base/server.js')
parser=argparse.ArgumentParser()
parser.add_argument('--output',choices=['/var/tmp/loltube-cutover-lab/server.js','/var/tmp/loltube-cutover-preview-server/server.js'],default='/var/tmp/loltube-cutover-lab/server.js')
out=Path(parser.parse_args().output)
out.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['python3',str(root/'loltube-combined/patch-upstream.py'),str(upstream),str(out)],check=True)
s=out.read_text()
def replace(old,new):
 global s
 if s.count(old)!=1:raise SystemExit('cutover_lab_patch_anchor_mismatch')
 s=s.replace(old,new,1)
replace("const app = express();\n", """const app = express();
let manualCutover = null;
// A successful Render health response is intentionally NOT application
// readiness. All user routes and upgrades remain fenced until recovery/import.
app.get('/health', (req,res) => res.status(200).json({service:'loltube-cutover-lab',...(manualCutover ? manualCutover.status() : {state:'starting'})}));
app.post('/__internal/cutover', express.json({limit:'1kb'}), async (req,res) => {
  if (!manualCutover) return res.status(503).json({error:'unavailable'});
  try { const result=await manualCutover.unlock(req.body);return res.status(200).json(result); }
  catch (e) { const code=e.message==='cutover_unauthorized'?403:e.message==='legacy_backup_changed'?409:503;return res.status(code).json({error:'cutover_denied'}); }
});
app.use((req,res,next) => {
  if (!manualCutover || manualCutover.status().state!=='ready') { req.resume();return res.status(503).json({error:'maintenance'}); }
  return next();
});
""")
start=s.index('(async () => {\n',s.index("app.get('*'"))
s=s[:start]+"""const {ManualCutover}=require('./loltube-combined/manual-cutover');
// Derive a cutover-only HMAC key from two existing runtime secrets. Neither is
// returned or logged; the proof is tied to a fresh process nonce and DB hash.
const cutoverSecret=crypto.createHmac('sha256',process.env.JWT_SECRET).update(process.env.CLOUDINARY_API_SECRET).digest('hex');
const server=app.listen(PORT,'0.0.0.0',()=>console.log('LOLTUBE maintenance-first cutover lab listening'));
server.on('upgrade',async(req,socket,head)=>{
  try {
    if (!manualCutover || manualCutover.status().state!=='ready') return socket.destroy();
    if (cloudRouter && await cloudRouter.handleUpgrade(req,socket,head)) return;
    if (!gserverGateway.handleUpgrade(req,socket,head)) socket.destroy();
  } catch (_) { socket.destroy(); }
});
(async()=>{
  manualCutover=new ManualCutover({secret:cutoverSecret,ledger:durableLedger,readLegacy:()=>requireVerifiedBackup(backupStore),
    onReady:async backup=>{
      const tmp=DB_PATH+'.restore-'+crypto.randomBytes(8).toString('hex');
      try { fs.writeFileSync(tmp,backup,{flag:'wx',mode:0o600});fs.renameSync(tmp,DB_PATH); }
      finally { try { fs.unlinkSync(tmp); } catch (_) {} }
      db=loadDB();committedDb=validate(backup);dbRestoreState='verified-ledger';
      try {
        const {CloudinaryRelayStore}=require('./glink-cloud/cloudinary-store');
        const {createCloudRouter}=require('./loltube-combined/cloud-router');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'loltube-cloud-runtime-'));
        cloudRouter=await createCloudRouter({
          relayStore:new CloudinaryRelayStore({cloudinary,prefix:'glink-cloud-v1/relay'}),
          offersStore:new CloudinaryStore({cloudinary,prefix:'glink-cloud-v1/offers'}),
          gplusStore:new CloudinaryStore({cloudinary,prefix:'gplus-cloud-v1'}),
          dataDir:dir,webDir:path.join(__dirname,'glink-web'),cleanupIntervalMs:60000,
          onFatal:()=>console.error('GLINK/G+ cloud fenced after storage error')
        });
      } catch (_) { console.error('GLINK/G+ cloud unavailable in cutover lab'); }
    }});
  await manualCutover.start();
})().catch(()=>console.error('LOLTUBE cutover startup failed; remaining in maintenance'));
"""
out.write_text(s)
print('maintenance_first_cutover_lab_generated')
