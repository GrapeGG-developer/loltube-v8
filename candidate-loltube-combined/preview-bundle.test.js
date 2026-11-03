'use strict';
/* Synthetic local test of the isolated, preview-key-protected Render bundle.
 * No real cloud credentials, accounts, data, or HTTP host are used. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const prefix='gplus-experimental-synthetic-preview', key='k'.repeat(43);
const repo=path.resolve(__dirname,'..'),bundle='/var/tmp/loltube-render-bundle';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function blob(cloud,id){return path.join(cloud,Buffer.from(id).toString('base64url')+'.blob');}
async function kill(c){if(c.exitCode!==null||c.signalCode)return;const done=new Promise(r=>c.once('exit',r));c.kill('SIGKILL');await done;}
async function start(dir,cloud,p){
 const c=spawn(process.execPath,['--require',path.join(__dirname,'fake-cloudinary-lab.cjs'),'server.js'],{cwd:dir,env:{...process.env,PORT:String(p),LAB_CLOUD_DIR:cloud,CLOUDINARY_CLOUD_NAME:'synthetic',CLOUDINARY_API_KEY:'synthetic',CLOUDINARY_API_SECRET:'synthetic',GPLUS_EXPERIMENTAL:'1',GPLUS_CLOUD_PREFIX:prefix,GPLUS_PREVIEW_KEY:key},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('preview_start_timeout')),9000);c.stdout.on('data',b=>{out+=b;if(out.includes('LOLTUBE verified-backup lab running')){clearTimeout(timer);resolve();}});c.once('exit',code=>{clearTimeout(timer);reject(Error('preview_start_failed_'+code));});});return c;
}
async function request(base,method,url,body,authorized=true,token){
 const r=await fetch(base+url,{method,headers:{...(authorized?{'x-gplus-preview-key':key}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'})},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});
 return {status:r.status,bytes:Buffer.from(await r.arrayBuffer())};
}
test('render preview bundle rejects public traffic and stays inside the synthetic namespace',async t=>{
 execFileSync('python3',[path.join(__dirname,'prepare-render-preview.py')]);
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'combined-preview-test-')),dir=path.join(tmp,'app'),cloud=path.join(tmp,'cloud');await fs.cp(bundle,dir,{recursive:true});await fs.mkdir(cloud);
 const seed={users:[],videos:[],comments:[],playlists:[],notifications:[],history:[],reports:[],friends:[],live:{isLive:false,hlsUrl:'',title:'SYNTHETIC',viewerCount:0}};
 await fs.writeFile(blob(cloud,prefix+'/combined/loltube-db.json'),JSON.stringify(seed));
 const p=await port(),base='http://127.0.0.1:'+p;let child;
 t.after(async()=>{if(child)await kill(child);await fs.rm(tmp,{recursive:true,force:true});});
 child=await start(dir,cloud,p);
 assert.equal((await request(base,'GET','/health',undefined,false)).status,200);
 assert.equal((await request(base,'GET','/api/config',undefined,false)).status,403);
 assert.equal((await request(base,'GET','/gsrv-v1/gserver/status',undefined,false)).status,403);
 assert.equal((await request(base,'GET','/api/config')).status,200);
 assert.equal(JSON.parse((await request(base,'GET','/gsrv-v1/gserver/status')).bytes).state,'online');
 const login=await request(base,'POST','/api/login',{nickname:'synthetic_user',password:'123'});assert.equal(login.status,200);const token=JSON.parse(login.bytes).token;
 assert.equal((await request(base,'PUT','/api/me',{bio:'synthetic durable data'},true,token)).status,200);
 const payload=Buffer.from('synthetic bytes'),sid='syntheticSession123';assert.equal((await request(base,'POST',`/gsrv-v1/glink/chunk/${sid}?i=0&n=1`,payload)).status,200);
 const media=new FormData();media.set('title','synthetic image');media.set('content',new Blob(['synthetic bytes'],{type:'image/png'}),'synthetic.png');
 const uploaded=await fetch(base+'/api/videos/upload',{method:'POST',headers:{'x-gplus-preview-key':key,Authorization:'Bearer '+token},body:media});assert.equal(uploaded.status,200);
 const source=await fs.readFile(path.join(dir,'server.js'),'utf8');assert.match(source,/public_id: labPrefix\+'\/media\//);
 await kill(child);child=await start(dir,cloud,p);
 const loginAgain=await request(base,'POST','/api/login',{nickname:'synthetic_user',password:'123'});assert.equal(loginAgain.status,200);
 assert.equal(JSON.parse((await request(base,'GET','/api/me',undefined,true,JSON.parse(loginAgain.bytes).token)).bytes).bio,'synthetic durable data');
 assert.deepEqual((await request(base,'GET',`/gsrv-v1/glink/dl/${sid}`)).bytes,payload);
 for(const name of await fs.readdir(cloud)){if(!name.endsWith('.blob'))continue;assert.ok(Buffer.from(name.slice(0,-5),'base64url').toString().startsWith(prefix+'/combined/'));}
});
