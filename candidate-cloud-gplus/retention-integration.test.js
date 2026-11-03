'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createCloudGPlus}=require('./bootstrap'),P=require('./app/protocol'),{assetBlockPath,indexPath}=require('./cloud-files');
class Store{constructor(){this.m=new Map();this.failDelete=false;}async get(k){return this.m.has(k)?Buffer.from(this.m.get(k)):null;}async putOnce(k,v){if(this.m.has(k))return false;this.m.set(k,Buffer.from(v));return true;}async setHead(v){this.m.set('head.json',Buffer.from(v));}async removeMany(keys){if(this.failDelete){this.failDelete=false;this.m.delete(keys[0]);throw Error('synthetic_lost_delete_response');}for(const key of keys)this.m.delete(key);}}
function identity(){const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),der=publicKey.export({type:'spki',format:'der'});return {id:P.id(der),key:der.toString('base64url'),priv:privateKey};}
async function start(store,root,name,now){const s=await createCloudGPlus({store,dataDir:path.join(root,name),reserveBytes:0,maxStorageBytes:50*1024*1024,now,cleanupIntervalMs:0});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));s.base='http://127.0.0.1:'+s.server.address().port+'/gsrv-v1';return s;}
async function call(s,method,url,body,token,extra={}){const raw=Buffer.isBuffer(body),r=await fetch(s.base+url,{method,headers:{...(body===undefined?{}:{'Content-Type':raw?'application/octet-stream':'application/json'}),...(token?{Authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});const bytes=Buffer.from(await r.arrayBuffer());return {status:r.status,bytes,json:()=>JSON.parse(bytes.toString())};}
async function login(s,d,nickname){const challenge=await call(s,'POST','/gplus/auth/challenge',{public_key:d.key});assert.equal(challenge.status,200);const nonce=challenge.json().nonce,signature=crypto.sign('sha256',Buffer.concat([Buffer.from('G+ AUTH v1\0'),Buffer.from(nonce,'base64url')]),d.priv).toString('base64url');const r=await call(s,'POST','/gplus/auth/verify',{public_key:d.key,nonce,signature,nickname});assert.ok([200,201].includes(r.status));d.token=r.json().token;}
function event(sender,chat,ids){const id=crypto.randomBytes(16).toString('base64url'),boxes=ids.map(to=>{const ciphertext=crypto.randomBytes(60).toString('base64url'),d=P.messageDigest(chat,id,sender.id,to,Buffer.from(ciphertext,'base64url'));return {to,ciphertext,signature:crypto.sign('sha256',Buffer.concat([P.SIGN_DOMAIN,d]),sender.priv).toString('base64url')};});return {id,boxes};}
const eventId=()=>crypto.randomBytes(16).toString('base64url');
test('30-day cloud deletion needs explicit media receipt and survives interrupted delete',async(t)=>{
 let clock=1800000000000;const now=()=>clock,root=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-retention-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new Store(),a=identity(),b=identity(),encrypted=crypto.randomBytes(256),sha=crypto.createHash('sha256').update(encrypted).digest('hex'),ids=[eventId(),eventId(),eventId()];
 store.m.set('blocks/'+sha+'.json',Buffer.from(encrypted));let s=await start(store,root,'one',now);t.after(()=>s.server.close());await login(s,a,'alice_test');await login(s,b,'bobby_test');
 const d=await call(s,'POST','/gplus/chats/direct',{peer:b.id},a.token),chat=d.json().id;assert.equal(d.status,200);
 for(let i=0;i<3;i++){
  const upload=await call(s,'PUT',`/gplus/assets/${ids[i]}`,encrypted,a.token,{'X-GPlus-Chat':chat,'X-GPlus-Sha256':sha});assert.equal(upload.status,201);
  if(i<2){const item=event(a,chat,[a.id,b.id]);assert.equal((await call(s,'POST',`/gplus/chats/${chat}/events`,item,a.token)).status,200);assert.equal((await call(s,'POST',`/gplus/assets/${ids[i]}/bind`,{event:item.id},a.token)).status,200);
   if(i===0)assert.equal((await call(s,'POST',`/gplus/assets/${ids[i]}/received`,{event:item.id,sha256:sha},b.token)).status,200);}
 }
 clock+=29*24*3600000;assert.deepEqual(await s.cleanupOnce(),{removed:false});assert.ok(await store.get(assetBlockPath(ids[0],0,sha)));
 clock+=2*24*3600000;store.failDelete=true;await assert.rejects(s.cleanupOnce(),/synthetic_lost_delete_response/);assert.equal(s.gateway.isHealthy(),false);await s.close();
 s=await start(store,root,'two',now);assert.deepEqual(await s.cleanupOnce(),{removed:true});await login(s,a,'alice_test');await login(s,b,'bobby_test');
 assert.equal((await call(s,'GET',`/gplus/assets/${ids[0]}`,undefined,b.token)).status,404);
 assert.equal(await store.get(assetBlockPath(ids[0],0,sha)),null);assert.ok(await store.get(indexPath(ids[0])));
 for(const id of ids.slice(1)){const r=await call(s,'GET',`/gplus/assets/${id}`,undefined,b.token);assert.equal(r.status,200);assert.deepEqual(r.bytes,encrypted);assert.ok(await store.get(assetBlockPath(id,0,sha)));}
 assert.ok(await store.get('blocks/'+sha+'.json'));assert.deepEqual(await s.cleanupOnce(),{removed:false});
 const repeat=await call(s,'PUT',`/gplus/assets/${ids[0]}`,encrypted,a.token,{'X-GPlus-Chat':chat,'X-GPlus-Sha256':sha});assert.equal(repeat.status,409);
 await s.close();s=await start(store,root,'three',now);await login(s,b,'bobby_test');assert.equal((await call(s,'GET',`/gplus/assets/${ids[0]}`,undefined,b.token)).status,404);assert.deepEqual((await call(s,'GET',`/gplus/assets/${ids[1]}`,undefined,b.token)).bytes,encrypted);await s.close();
});
