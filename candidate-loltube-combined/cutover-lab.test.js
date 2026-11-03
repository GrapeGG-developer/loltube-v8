'use strict';
/* Isolated full-server synthetic cutover regression: local fake Cloudinary only. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {mac,hash}=require('./manual-cutover');
const root=path.resolve(__dirname,'..'),upstream='/var/tmp/loltube-combined-base',fixture=path.join(__dirname,'fake-cloudinary-lab.cjs');
const jwtSecret='synthetic-only-jwt-secret-123',cloudSecret='synthetic-only-cloud-secret-456';
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function blob(cloud,id){return path.join(cloud,Buffer.from(id).toString('base64url')+'.blob');}
async function start(lab,cloud,port){
 const env={...process.env,PORT:String(port),LAB_CLOUD_DIR:cloud,CLOUDINARY_CLOUD_NAME:'synthetic',CLOUDINARY_API_KEY:'synthetic',CLOUDINARY_API_SECRET:cloudSecret,JWT_SECRET:jwtSecret};
 const c=spawn(process.execPath,['--require',fixture,'server.js'],{cwd:lab,env,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('cutover_lab_start_timeout')),9000);c.stdout.on('data',b=>{text+=b;if(text.includes('cutover lab listening')){clearTimeout(timer);resolve();}});c.once('exit',code=>{clearTimeout(timer);reject(Error('cutover_lab_exited_'+code));});});return c;
}
async function kill(c){if(c.exitCode!==null||c.signalCode)return;const ended=new Promise(r=>c.once('exit',r));c.kill('SIGKILL');await ended;}
async function call(base,method,route,body){const r=await fetch(base+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
async function state(base,want){for(let i=0;i<150;i++){const r=await call(base,'GET','/health');if(r.body.state===want)return r.body;await new Promise(r=>setTimeout(r,20));}throw Error('cutover_state_timeout');}
test('maintenance-first cutover waits for authorization and recovers final synthetic backup',async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'loltube-cutover-test-')),lab=path.join(tmp,'app'),cloud=path.join(tmp,'cloud');await fs.cp(upstream,lab,{recursive:true});await fs.mkdir(cloud);
 for(const d of ['glink-cloud','gplus-cloud','loltube-safety','loltube-combined'])await fs.symlink(path.join(root,d),path.join(lab,d),'dir');await fs.symlink(path.join(root,'glink-relay'),path.join(lab,'glink-web'),'dir');
 execFileSync('python3',[path.join(__dirname,'prepare-cutover-lab.py')]);await fs.copyFile('/var/tmp/loltube-cutover-lab/server.js',path.join(lab,'server.js'));
 const old={users:[],videos:[],comments:[],playlists:[],notifications:[],history:[],reports:[],friends:[],live:{isLive:false,hlsUrl:'',title:'OLD_SYNTHETIC',viewerCount:0}};
 const latest={...old,live:{...old.live,title:'LATEST_SYNTHETIC'}};const oldRaw=Buffer.from(JSON.stringify(old)),latestRaw=Buffer.from(JSON.stringify(latest));await fs.writeFile(blob(cloud,'loltube/db.json'),oldRaw);
 const port=await freePort(),base='http://127.0.0.1:'+port;let child;
 t.after(async()=>{if(child)await kill(child);await fs.rm(tmp,{recursive:true,force:true});});
 child=await start(lab,cloud,port);const waiting=await state(base,'awaiting');assert.equal((await call(base,'GET','/api/live')).status,503);
 const derived=crypto.createHmac('sha256',jwtSecret).update(cloudSecret).digest('hex');const proof=b=>({digest:hash(b),proof:mac(derived,waiting.nonce,hash(b)).toString('hex')});
 assert.equal((await call(base,'POST','/__internal/cutover',{digest:hash(oldRaw),proof:'0'.repeat(64)})).status,403);
 await fs.writeFile(blob(cloud,'loltube/db.json'),latestRaw);assert.equal((await call(base,'POST','/__internal/cutover',proof(oldRaw))).status,409);
 await assert.rejects(fs.access(blob(cloud,'loltube-ledger-v1/revisions/0000000000000001.json')));
 assert.equal((await call(base,'POST','/__internal/cutover',proof(latestRaw))).status,200);await state(base,'ready');assert.equal((await call(base,'GET','/api/live')).body.title,'LATEST_SYNTHETIC');
 await kill(child);child=null;await fs.writeFile(blob(cloud,'loltube/db.json'),oldRaw);child=await start(lab,cloud,port);await state(base,'ready');assert.equal((await call(base,'GET','/api/live')).body.title,'LATEST_SYNTHETIC');
});
