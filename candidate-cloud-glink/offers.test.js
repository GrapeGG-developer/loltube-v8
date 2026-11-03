'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createOffers}=require('./offers'),web=require('../glink-relay/glink-crypto-v2');
class Memory{constructor(){this.map=new Map();this.failWrites=false;}async get(k){const v=this.map.get(k);return v===undefined?null:Buffer.from(v);}async putOnce(k,v){if(this.failWrites)throw Error('outage');if(this.map.has(k))return false;this.map.set(k,Buffer.from(v));return true;}async setHead(v){if(this.failWrites)throw Error('outage');this.map.set('head.json',Buffer.from(v));}}
const pair=()=>crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pub=k=>k.publicKey.export({format:'der',type:'spki'}).toString('base64url');
async function boot(store,root,name){const dir=path.join(root,name);await fs.mkdir(dir);let fatal=0;const offers=await createOffers({store,dataDir:dir,onFatal:()=>fatal++});
 const s=http.createServer((req,res)=>offers(req,res,()=>{res.statusCode=404;res.end();}));await new Promise(r=>s.listen(0,'127.0.0.1',r));return {offers,s,base:'http://127.0.0.1:'+s.address().port,get fatal(){return fatal},close:()=>new Promise(r=>s.close(r))};}
async function request(x,p,{method='GET',body,token}={}){const r=await fetch(x.base+p,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};}
async function auth(x,sign=pair(),transport=pair()){
 const c=await request(x,'/glink/device/challenge',{method:'POST',body:{publicKey:pub(sign)}});assert.equal(c.status,200);
 const msg=Buffer.concat([Buffer.from('GLINK-WIFI-AUTH-2\0'),Buffer.from(c.json.nonce,'base64url'),Buffer.from(pub(transport),'base64url')]);
 const r=await request(x,'/glink/device/auth',{method:'POST',body:{nonce:c.json.nonce,transportKey:pub(transport),signature:crypto.sign('sha256',msg,sign.privateKey).toString('base64url'),name:'synthetic'}});
 assert.equal(r.status,200);return {sign,transport,id:r.json.id,token:r.json.token};
}
test('encrypted Wi-Fi offer is committed before ACK and survives restart; bearer must reauthenticate',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glink-offers-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new Memory(),a=await boot(store,root,'a');t.after(()=>a.close());
 const recipient=await auth(a),secret=crypto.randomBytes(32),session='0123456789abcdef01',k=await web.seal(pub(recipient.transport),secret,session,recipient.id);
 assert.equal((await request(a,'/glink/offer',{method:'POST',body:{to:recipient.id,s:session,k,from:'synthetic'}})).status,200);
 assert.ok(store.map.has('head.json'));assert.ok([...store.map.values()].every(b=>!b.includes(secret.toString('base64url'))));
 await a.close();const b=await boot(store,root,'b');t.after(()=>b.close());
 assert.equal((await request(b,'/glink/offers/'+recipient.id,{token:recipient.token})).status,401);
 const again=await auth(b,recipient.sign,recipient.transport);assert.equal(again.id,recipient.id);
 const poll=await request(b,'/glink/offers/'+again.id,{token:again.token});assert.equal(poll.status,200);assert.equal(poll.json.offers.length,1);assert.equal(poll.json.offers[0].k,k);
 assert.equal((await request(b,'/glink/offer-ack',{method:'POST',token:again.token,body:{to:again.id,s:session}})).status,200);
 await b.close();const c=await boot(store,root,'c');t.after(()=>c.close());const last=await auth(c,recipient.sign,recipient.transport);
 assert.deepEqual((await request(c,'/glink/offers/'+last.id,{token:last.token})).json.offers,[]);await c.close();
});
test('failed offer backup returns 503 and blocks further requests',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'glink-offers-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new Memory(),a=await boot(store,root,'a');t.after(()=>a.close());
 const recipient=await auth(a),session='fedcba987654321000',k=await web.seal(pub(recipient.transport),crypto.randomBytes(32),session,recipient.id);
 store.failWrites=true;const r=await request(a,'/glink/offer',{method:'POST',body:{to:recipient.id,s:session,k,from:'synthetic'}});assert.equal(r.status,503);assert.equal(a.fatal,1);assert.equal((await request(a,'/glink/devices')).status,503);
 await a.close();store.failWrites=false;const b=await boot(store,root,'b');t.after(()=>b.close());const rec=await auth(b,recipient.sign,recipient.transport);
 assert.deepEqual((await request(b,'/glink/offers/'+rec.id,{token:rec.token})).json.offers,[]);await b.close();
});
