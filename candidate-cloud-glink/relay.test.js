'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createRelay}=require('./relay');const {part,sessionHash}=require('./session-store');
class Memory{
 constructor(){this.map=new Map();this.fail=false;this.removeFail=false;this.blockPart=null;}
 async get(k){if(this.fail)throw Error('outage');if(this.blockPart&&k.includes('/parts/'))await this.blockPart;const x=this.map.get(k);return x===undefined?null:Buffer.from(x);}
 async putOnce(k,b){if(this.fail)throw Error('outage');if(this.map.has(k))return false;this.map.set(k,Buffer.from(b));return true;}
 async replace(k,b){if(this.fail)throw Error('outage');this.map.set(k,Buffer.from(b));}
 async listMarkers(){return {ids:[...this.map.keys()].filter(k=>k.startsWith('relay-index/')).map(k=>k.slice(12,-5)),cursor:null};}
 async removeMany(keys){if(this.removeFail){this.removeFail=false;this.map.delete(keys[0]);throw Error('synthetic_delete_timeout');}for(const k of keys)this.map.delete(k);}
}
async function boot(store,now=()=>1800000000000){const relay=createRelay({store,now}),server=http.createServer((q,r)=>{relay(q,r)});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {relay,base:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};}
const id='test_session_A1';const url=(base,op)=>`${base}/glink/${op}/${id}`;
async function upload(base,i,n,b){return fetch(url(base,'chunk')+`?i=${i}&n=${n}&ttl=6`,{method:'POST',body:b});}
test('HTTP concurrent upload, restart, full and cross-chunk Range downloads',async(t)=>{
 const m=new Memory(),a=await boot(m);t.after(()=>a.close());const bytes=[Buffer.from('abc'),Buffer.from('defg'),Buffer.from('hijkl')];
 const uploaded=await Promise.all(bytes.map((b,i)=>upload(a.base,i,bytes.length,b)));assert.ok(uploaded.every(x=>x.status===200));
 assert.deepEqual((await (await fetch(url(a.base,'chunks'))).json()).have,[0,1,2]);assert.equal((await (await fetch(url(a.base,'meta'))).json()).size,12);
 await a.close();const b=await boot(m);t.after(()=>b.close());assert.deepEqual(Buffer.from(await (await fetch(url(b.base,'dl'))).arrayBuffer()),Buffer.concat(bytes));
 const partial=await fetch(url(b.base,'dl'),{headers:{Range:'bytes=2-8'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 2-8/12');assert.equal(await partial.text(),'cdefghi');
 const remainder=await fetch(url(b.base,'dl'),{headers:{Range:'bytes=7-'}});assert.equal(await remainder.text(),'hijkl');
 assert.equal((await fetch(url(b.base,'dl'),{headers:{Range:'bytes=15-'}})).status,416);
 assert.equal((await fetch(url(b.base,'get'))).status,410);await b.close();
});
test('incomplete, conflicting, expired and completed sessions fail closed',async(t)=>{
 let clock=1800000000000;const m=new Memory(),x=await boot(m,()=>clock);t.after(()=>x.close());
 assert.equal((await upload(x.base,0,2,Buffer.from('hello'))).status,200);assert.equal((await fetch(url(x.base,'meta'))).status,404);
 assert.equal((await upload(x.base,0,2,Buffer.from('different'))).status,409);assert.equal((await upload(x.base,1,2,Buffer.from('world'))).status,200);
 clock+=7*3600000;assert.equal((await fetch(url(x.base,'dl'))).status,404);assert.equal((await fetch(url(x.base,'ttl')+'?h=24',{method:'POST'})).status,200);
 assert.equal((await fetch(url(x.base,'dl'))).status,200);assert.equal((await fetch(url(x.base,'done'),{method:'POST'})).status,200);assert.equal((await fetch(url(x.base,'meta'))).status,404);
 await x.close();
});
test('outage and corrupt chunk never become a successful full download',async(t)=>{
 const m=new Memory(),x=await boot(m);t.after(()=>x.close());m.fail=true;assert.equal((await upload(x.base,0,1,Buffer.from('payload'))).status,503);m.fail=false;
 assert.equal((await upload(x.base,0,1,Buffer.from('payload'))).status,200);m.map.set(part(sessionHash(id),0),Buffer.from('broken!'));
 assert.equal((await fetch(url(x.base,'dl'))).status,503);await x.close();
});
test('progress is advisory and does not survive restart',async(t)=>{
 const m=new Memory(),x=await boot(m);t.after(()=>x.close());assert.equal((await fetch(url(x.base,'prog')+'?got=3&total=12',{method:'POST'})).status,200);
 assert.deepEqual(await (await fetch(url(x.base,'prog'))).json(),{got:3,total:12});await x.close();const y=await boot(m);t.after(()=>y.close());assert.equal((await fetch(url(y.base,'prog'))).status,404);await y.close();
});
test('cleanup preserves expired incomplete uploads and unrelated objects',async(t)=>{
 let clock=1800000000000;const m=new Memory(),x=await boot(m,()=>clock);t.after(()=>x.close());m.map.set('unrelated/user-data',Buffer.from('preserve'));
 assert.equal((await upload(x.base,0,2,Buffer.from('partial'))).status,200);clock+=7*3600000;
 const r=await x.relay.sweep();assert.equal(r.outcome,'preserved');assert.equal((await m.get(part(sessionHash(id),0))).toString(),'partial');assert.equal(m.map.get('unrelated/user-data').toString(),'preserve');await x.close();
});
test('cleanup waits for active download; expired full uploads are deleted in resumable steps',async(t)=>{
 let clock=1800000000000;const m=new Memory(),x=await boot(m,()=>clock);t.after(()=>x.close());
 assert.equal((await upload(x.base,0,2,Buffer.from('hello'))).status,200);assert.equal((await upload(x.base,1,2,Buffer.from('world'))).status,200);
 let release;const gate=new Promise(r=>{release=r});m.blockPart=gate;const dl=fetch(url(x.base,'dl'));await new Promise(r=>setTimeout(r,25));assert.deepEqual(await x.relay.sweep(),{busy:true});release();assert.equal(await (await dl).text(),'helloworld');m.blockPart=null;
 clock+=7*3600000;m.removeFail=true;await assert.rejects(x.relay.sweep(),/synthetic_delete_timeout/);assert.equal((await fetch(url(x.base,'meta'))).status,404);
 // A new server can resume deletion after an ambiguous partial delete.
 await x.close();const y=await boot(m,()=>clock);t.after(()=>y.close());for(let i=0;i<8;i++){await y.relay.sweep();if((await y.relay.sessions.get(id)).clean)break;}
 assert.equal((await y.relay.sessions.get(id)).clean,true);assert.equal(await m.get(part(sessionHash(id),0)),null);assert.equal(await m.get(part(sessionHash(id),1)),null);await y.close();
});
