'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createCloudGPlus}=require('./bootstrap'),P=require('./app/protocol');
class Store{constructor(){this.m=new Map()}async get(k){return this.m.has(k)?Buffer.from(this.m.get(k)):null}async putOnce(k,v){if(this.m.has(k))return false;this.m.set(k,Buffer.from(v));return true}async setHead(v){this.m.set('head.json',Buffer.from(v))}}
function identity(){const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const der=publicKey.export({type:'spki',format:'der'});return {id:P.id(der),key:der.toString('base64url'),priv:privateKey};}
async function start(store,root,name){const service=await createCloudGPlus({store,dataDir:path.join(root,name),reserveBytes:0,maxStorageBytes:50*1024*1024});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));service.base='http://127.0.0.1:'+service.server.address().port+'/gsrv-v1';return service;}
async function call(s,method,url,body,token,extra={}){const raw=Buffer.isBuffer(body);const response=await fetch(s.base+url,{method,headers:{...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),...(token?{Authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});const data=await response.arrayBuffer();return {status:response.status,bytes:Buffer.from(data),json:()=>JSON.parse(Buffer.from(data).toString())};}
async function login(s,d,nickname){
 const c=await call(s,'POST','/gplus/auth/challenge',{public_key:d.key});assert.equal(c.status,200);const nonce=c.json().nonce;
 const signature=crypto.sign('sha256',Buffer.concat([Buffer.from('G+ AUTH v1\0'),Buffer.from(nonce,'base64url')]),d.priv).toString('base64url');
 const r=await call(s,'POST','/gplus/auth/verify',{public_key:d.key,nonce,signature,nickname});assert.ok([200,201].includes(r.status));d.token=r.json().token;
}
function event(sender,chat,ids){const id=crypto.randomBytes(16).toString('base64url');const boxes=ids.map(to=>{const ciphertext=crypto.randomBytes(60).toString('base64url'),d=P.messageDigest(chat,id,sender.id,to,Buffer.from(ciphertext,'base64url'));return {to,ciphertext,signature:crypto.sign('sha256',Buffer.concat([P.SIGN_DOMAIN,d]),sender.priv).toString('base64url')}});return {id,boxes};}
test('real G+ registration, encrypted message, media and restart recover from immutable objects',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-cloud-integration-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new Store(),a=identity(),b=identity();let s=await start(store,root,'runtime-1');t.after(()=>s.server.close());
 await login(s,a,'alice_test');await login(s,b,'bobby_test');
 const direct=await call(s,'POST','/gplus/chats/direct',{peer:b.id},a.token);assert.equal(direct.status,200);const chat=direct.json().id;
 const item=event(a,chat,[a.id,b.id]),sent=await call(s,'POST',`/gplus/chats/${chat}/events`,item,a.token);assert.equal(sent.status,200);const seq=sent.json().seq;
 const asset=crypto.randomBytes(16).toString('base64url'),encrypted=crypto.randomBytes(2*1024*1024+13),sha=crypto.createHash('sha256').update(encrypted).digest('hex');
 const uploaded=await call(s,'PUT',`/gplus/assets/${asset}`,encrypted,a.token,{'X-GPlus-Chat':chat,'X-GPlus-Sha256':sha});assert.equal(uploaded.status,201);
 const bound=await call(s,'POST',`/gplus/assets/${asset}/bind`,{event:item.id},a.token);assert.equal(bound.status,200);
 const before=(await call(s,'GET',`/gplus/chats/${chat}/events`,undefined,b.token)).json();assert.equal(before.events[0].id,item.id);
 await s.close();s=await start(store,root,'runtime-2');await login(s,b,'bobby_test');
 const after=(await call(s,'GET',`/gplus/chats/${chat}/events`,undefined,b.token)).json();assert.equal(after.events[0].id,item.id);assert.equal(after.events[0].seq,seq);
 const downloaded=await call(s,'GET',`/gplus/assets/${asset}`,undefined,b.token);assert.equal(downloaded.status,200);assert.deepEqual(downloaded.bytes,encrypted);
 assert.equal((await call(s,'POST',`/gplus/assets/${asset}/received`,{event:item.id,sha256:sha},b.token)).status,200);
 // Server sessions and private identity keys must not be included in snapshots.
 const joined=Buffer.concat([...store.m.values()]);assert.equal(joined.includes(Buffer.from(a.token)),false);assert.equal(joined.includes(Buffer.from('PRIVATE KEY')),false);
 await s.close();
});
