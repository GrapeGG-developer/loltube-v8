#!/usr/bin/env python3
"""Build a strictly isolated Render synthetic preview of maintenance cutover.

The result is test-only; real LOLTUBE backup, prefixes and traffic are excluded.
No Render, GitHub, Cloudinary or preview credentials are written to this bundle.
"""
from pathlib import Path
import shutil,subprocess
repo=Path(__file__).resolve().parent.parent
out=Path('/var/tmp/loltube-render-cutover-preview')
cutover=Path('/var/tmp/loltube-cutover-preview-server/server.js')
subprocess.run(['python3',str(repo/'loltube-combined/prepare-render-preview.py'),'--output',str(out)],check=True)
subprocess.run(['python3',str(repo/'loltube-combined/prepare-cutover-lab.py'),'--output',str(cutover)],check=True)
old=(out/'server.js').read_text();s=cutover.read_text()
# Reuse exactly the validated preview guard from the existing isolated bundle.
header=old[:old.index("const express = require('express');")]
s=header+s
def sub(old,new):
 global s
 if s.count(old)!=1:raise SystemExit('cutover_preview_patch_anchor_mismatch')
 s=s.replace(old,new,1)
sub('const app = express();\n', """const app = express();
app.use((req,res,next)=>{
  if (req.method === 'GET' && req.path === '/health') return next();
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
sub("    if (!manualCutover || manualCutover.status().state!=='ready') return socket.destroy();", "    if (!previewAllowed(req) || !manualCutover || manualCutover.status().state!=='ready') return socket.destroy();")
sub("    if (!gserverGateway.handleUpgrade(req,socket,head)) socket.destroy();", "    socket.destroy(); // legacy GSERVER cannot connect to the preview")
(out/'server.js').write_text(s)
shutil.copy2(repo/'loltube-combined/manual-cutover.js',out/'loltube-combined/manual-cutover.js')
print('isolated_render_cutover_preview_bundle_generated')
