'use strict';
/* No real cloud or Render account: verify the preview's independent access and namespace boundaries. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{mac,hash}=require('./manual-cutover');
const prefix='gplus-experimental-synthetic-cutover',key='k'.repeat(43),cloudSecret='synthetic-only-cloud-secret-456';
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function blob(root,id){return path.join(root,Buffer.from(id).toString('base64url')+'.blob');}
async function start(dir,cloud,port){
 const c=spawn(process.execPath,['--require',path.join(__dirname,'fake-cloudinary-lab.cjs'),'server.js'],{cwd:dir,env:{...process.env,PORT:String(port),LAB_CLOUD_DIR:cloud,CLOUDINARY_CLOUD_NAME:'synthetic',CLOUDINARY_API_KEY:'synthetic',CLOUDINARY_API_SECRET:cloudSecret,GPLUS_EXPERIMENTAL:'1',GPLUS_CLOUD_PREFIX:prefix,GPLUS_PREVIEW_KEY:key},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('preview_start_timeout')),9000);c.stdout.on('data',b=>{text+=b;if(text.includes('cutover lab listening')){clearTimeout(timer);resolve();}});c.once('exit',code=>{clearTimeout(timer);reject(Error('preview_exited_'+code));});});return c;
}
async function stop(c){if(c.exitCode!==null||c.signalCode)return;const done=new Promise(r=>c.once('exit',r));c.kill('SIGKILL');await done;}
async function call(base,method,url,body,authorized=true){const r=await fetch(base+url,{method,headers:{...(authorized?{'x-gplus-preview-key':key}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
async function state(base,want){for(let i=0;i<150;i++){const r=await call(base,'GET','/health',undefined,false);if(r.body.state===want)return r.body;await new Promise(r=>setTimeout(r,20));}throw Error('preview_state_timeout');}
test('real Render preview bundle protects synthetic cutover and cannot access legacy namespace',async t=>{
 execFileSync('python3',[path.join(__dirname,'prepare-render-cutover-preview.py')]);
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'cutover-preview-test-')),dir=path.join(tmp,'app'),cloud=path.join(tmp,'cloud');await fs.cp('/var/tmp/loltube-render-cutover-preview',dir,{recursive:true});await fs.mkdir(cloud);
 const db={users:[],videos:[],comments:[],playlists:[],notifications:[],history:[],reports:[],friends:[],live:{isLive:false,hlsUrl:'',title:'ISOLATED_SYNTHETIC',viewerCount:0}},raw=Buffer.from(JSON.stringify(db));await fs.writeFile(blob(cloud,prefix+'/combined/loltube-db.json'),raw);
 const port=await freePort(),base='http://127.0.0.1:'+port;let child;t.after(async()=>{if(child)await stop(child);await fs.rm(tmp,{recursive:true,force:true});});child=await start(dir,cloud,port);
 const waiting=await state(base,'awaiting');assert.equal((await call(base,'GET','/api/live',undefined,false)).status,403);assert.equal((await call(base,'GET','/api/live')).status,503);
 const derived=crypto.createHmac('sha256',key).update(cloudSecret).digest('hex'),auth={digest:hash(raw),proof:mac(derived,waiting.nonce,hash(raw)).toString('hex')};
 assert.equal((await call(base,'POST','/__internal/cutover',auth,false)).status,403);assert.equal((await call(base,'POST','/__internal/cutover',auth,true)).status,200);await state(base,'ready');assert.equal((await call(base,'GET','/api/live')).body.title,'ISOLATED_SYNTHETIC');
 for(const name of await fs.readdir(cloud)){if(name.endsWith('.blob'))assert.ok(Buffer.from(name.slice(0,-5),'base64url').toString().startsWith(prefix+'/combined/'));}
 await stop(child);child=null;await fs.rm(blob(cloud,prefix+'/combined/loltube-db.json'));child=await start(dir,cloud,port);await state(base,'ready');assert.equal((await call(base,'GET','/api/live')).body.title,'ISOLATED_SYNTHETIC');
});
