#!/usr/bin/env python3
"""Build an isolated, preview-key-protected Render experiment bundle.

Synthetic data only; NEVER use this bundle as production. All Cloudinary paths
must be inside the existing strictly named gplus-experimental-.../combined/
prefix. The experiment's preview key is read from Render environment at runtime,
never written to this bundle. No real LOLTUBE backup is read or overwritten.
"""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess

repo = Path(__file__).resolve().parent.parent
upstream = Path('/var/tmp/loltube-combined-base')
lockdir = repo/'loltube-combined'
parser=argparse.ArgumentParser()
parser.add_argument('--output',choices=['/var/tmp/loltube-render-bundle','/var/tmp/loltube-render-cutover-preview'],default='/var/tmp/loltube-render-bundle')
out = Path(parser.parse_args().output)
if hashlib.sha256((upstream/'server.js').read_bytes()).hexdigest() != '462dc1ab2e7117dfe93ac6085f6e0390b5e8cd74efd06f83d14c1916a1c038b9':
    raise SystemExit('unexpected upstream')
if out.exists(): shutil.rmtree(out)
out.mkdir(parents=True)
subprocess.run(['python3', str(repo/'loltube-combined/patch-upstream.py'), str(upstream/'server.js'), str(out/'server.js')], check=True)
for folder in ['gserver','public']:
    shutil.copytree(upstream/folder, out/folder)
shutil.copy2(upstream/'glink-relay.js', out/'glink-relay.js')
for folder, files in {
    'loltube-combined':['cloud-router.js','backup-store.js','ledger-backup.js'],
    'loltube-safety':['durable-gate.js','verified-backup.js'],
    'glink-cloud':['cloudinary-store.js','device-v2.js','offers.js','relay.js','session-store.js'],
    'gplus-cloud':['bootstrap.js','cloud-files.js','cloudinary-store.js','gateway.js','ledger.js','snapshot.js'],
    'glink-web':['glink-send.html','glink-crypto-v2.js','glink-send-v2.js'],
}.items():
    (out/folder).mkdir(exist_ok=True)
    source=repo/('glink-relay' if folder=='glink-web' else folder)
    for file in files: shutil.copy2(source/file, out/folder/file)
shutil.copytree(repo/'gplus-cloud/app',out/'gplus-cloud/app')
for name in ['package.json','package-lock.json']: shutil.copy2(lockdir/('preview-'+name),out/name)
(out/'.node-version').write_text('24.22.2\n')
server=(out/'server.js').read_text()
def sub(old,new,count=1):
    global server
    if server.count(old)!=count: raise SystemExit('preview patch anchor mismatch')
    server=server.replace(old,new,count)
header="""'use strict';
// This experiment only serves synthetic data and refuses all traffic without
// its existing Render preview key. It does not use the live LOLTUBE namespace.
const experimentPrefix = process.env.GPLUS_CLOUD_PREFIX || '';
const experimentKey = process.env.GPLUS_PREVIEW_KEY || '';
if (process.env.GPLUS_EXPERIMENTAL !== '1' || !/^gplus-experimental-[a-z0-9-]{8,64}$/.test(experimentPrefix) || !/^[A-Za-z0-9_-]{32,128}$/.test(experimentKey)) throw Error('invalid_experiment');
process.env.JWT_SECRET = experimentKey; // synthetic accounts only
const labPrefix = experimentPrefix + '/combined';
function previewAllowed(req) {
  const s=req.headers['x-gplus-preview-key'];
  return typeof s==='string' && s.length===experimentKey.length && /^[A-Za-z0-9_-]+$/.test(s) && require('node:crypto').timingSafeEqual(Buffer.from(s),Buffer.from(experimentKey));
}
"""
server=header+server
sub('const app = express();\n', """const app = express();
app.use((req,res,next)=>{
  if (req.method === 'GET' && req.path === '/health') return res.status(200).json({ok:true, service:'combined-synthetic-preview'});
  if (!previewAllowed(req)) { req.resume(); return res.status(403).json({error:'experimental_access_required'}); }
  return next();
});
""")
sub("console.log('Cloudinary enabled - videos will be persistent for free without card (25GB free)');", "console.log('Synthetic experiment storage configured');")
sub("""folder: 'loltube',
      use_filename: true,
      unique_filename: true""", """public_id: labPrefix+'/media/'+crypto.randomBytes(16).toString('hex'),
      overwrite: false,
      unique_filename: false""")
sub("    // delete local file after upload to save space", "    if (!result.public_id || !result.public_id.startsWith(labPrefix+'/media/')) throw Error('unexpected_preview_media');\n    // delete local file after upload to save space")
sub("prefix:'loltube-ledger-v1'", "prefix:labPrefix+'/loltube-ledger'")
sub("prefix:'glink-cloud-v1/relay'", "prefix:labPrefix+'/glink-relay'")
sub("prefix:'glink-cloud-v1/offers'", "prefix:labPrefix+'/glink-offers'")
sub("prefix:'gplus-cloud-v1'", "prefix:labPrefix+'/gplus'")
sub("""      if (cloudRouter && await cloudRouter.handleUpgrade(req, socket, head)) return;
      if (!gserverGateway.handleUpgrade(req, socket, head)) socket.destroy();""", """      if (!previewAllowed(req)) return socket.destroy();
      if (cloudRouter && await cloudRouter.handleUpgrade(req, socket, head)) return;
      socket.destroy(); // no legacy GSERVER connection in this experiment""")
(out/'server.js').write_text(server)
store=out/'loltube-combined/backup-store.js'
s=store.read_text();old="const MAX = 10 * 1024 * 1024, ID = 'loltube/db.json';"
if s.count(old)!=1: raise SystemExit('preview backup anchor mismatch')
s=s.replace(old,"""const prefix = process.env.GPLUS_CLOUD_PREFIX || '';
if (process.env.GPLUS_EXPERIMENTAL !== '1' || !/^gplus-experimental-[a-z0-9-]{8,64}$/.test(prefix) || !/^[A-Za-z0-9_-]{32,128}$/.test(process.env.GPLUS_PREVIEW_KEY || '')) throw Error('invalid_experiment');
const MAX = 10 * 1024 * 1024, ID = prefix + '/combined/loltube-db.json';""")
store.write_text(s)
package=json.loads((out/'package.json').read_text())
assert package['dependencies']['better-sqlite3'] in ('12.11.1','^12.11.1')
print('synthetic_preview_bundle_files', len([p for p in out.rglob('*') if p.is_file()]))
