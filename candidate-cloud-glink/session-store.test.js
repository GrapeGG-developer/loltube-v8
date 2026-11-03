'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SessionStore,sessionHash,part,head,revision}=require('./session-store');
class Memory {
 constructor(){this.map=new Map();this.failHeadOnce=false;this.loseOnce=null;}
 async get(k){const v=this.map.get(k);return v===undefined?null:Buffer.from(v);}
 async putOnce(k,v){if(this.map.has(k))return false;this.map.set(k,Buffer.from(v));if(this.loseOnce&&k.includes(this.loseOnce)){this.loseOnce=null;throw Error('synthetic_timeout');}return true;}
 async replace(k,v){if(this.failHeadOnce&&k.endsWith('head.json')){this.failHeadOnce=false;throw Error('synthetic_timeout');}this.map.set(k,Buffer.from(v));}
}
const token='SESSIONabcdef1234',now=()=>1800000000000;
test('concurrent chunk uploads survive a fresh process, complete and close',async()=>{
 const store=new Memory(),s=new SessionStore(store,{now});const inputs=[Buffer.from('one'),Buffer.from('two'),Buffer.from('three'),Buffer.from('four')];
 await Promise.all(inputs.map((b,i)=>s.put(token,i,inputs.length,6,b)));
 const again=new SessionStore(store,{now}),state=await again.get(token);assert.equal(state.parts.length,4);assert.equal(state.parts.filter(Boolean).length,4);
 assert.equal(state.expires,now()+6*3600000);for(let i=0;i<4;i++)assert.deepEqual(await again.getPart(sessionHash(token),i,state.parts[i]),inputs[i]);
 assert.equal((await again.change(token,'done')).done,true);await assert.rejects(again.put(token,0,4,6,inputs[0]),/session_closed/);
 assert.ok([...store.map.keys()].every(k=>!k.includes(token)));
});
test('idempotent retries accept identical bytes and reject different ones',async()=>{
 const store=new Memory(),s=new SessionStore(store,{now});assert.equal((await s.put(token,0,1,1,Buffer.from('x'))).duplicate,false);
 assert.equal((await s.put(token,0,1,1,Buffer.from('x'))).duplicate,true);await assert.rejects(s.put(token,0,1,1,Buffer.from('y')),/chunk_conflict/);
 await assert.rejects(s.put(token,0,2,1,Buffer.from('x')),/chunk_conflict/);
});
test('lost upload response recovers by verifying immutable object',async()=>{
 const store=new Memory();store.loseOnce='/parts/';const s=new SessionStore(store,{now});
 const x=await s.put(token,0,1,1,Buffer.from('synthetic'));assert.equal(x.duplicate,false);assert.equal((await s.get(token)).parts.length,1);
});
test('a missing head update recovers the committed immutable revision',async()=>{
 const store=new Memory(),s=new SessionStore(store,{now});store.failHeadOnce=true;
 await assert.rejects(s.put(token,0,1,1,Buffer.from('x')),/synthetic_timeout/);
 const recovered=new SessionStore(store,{now}),before=await recovered.get(token);assert.equal(before.seq,1);assert.equal(before.parts[0],null);
 await recovered.put(token,0,1,1,Buffer.from('x'));assert.equal((await recovered.get(token)).parts[0].size,1);
});
test('missing or corrupted ciphertext fails verification',async()=>{
 const store=new Memory(),s=new SessionStore(store,{now});await s.put(token,0,1,1,Buffer.from('good'));const state=await s.get(token),id=sessionHash(token);
 store.map.set(part(id,0),Buffer.from('evil'));await assert.rejects(s.getPart(id,0,state.parts[0]),/part_missing_or_corrupt/);
 store.map.delete(revision(id,state.seq));await assert.rejects(s.get(token),/bad_head/);
});
test('competing independent writers do not both acknowledge different revision',async()=>{
 const store=new Memory(),a=new SessionStore(store,{now}),b=new SessionStore(store,{now});
 await a.put(token,0,3,1,Buffer.from('first'));
 const both=await Promise.allSettled([a.put(token,1,3,1,Buffer.from('second')),b.put(token,2,3,1,Buffer.from('third'))]);
 assert.equal(both.filter(x=>x.status==='fulfilled').length,1);assert.equal(both.filter(x=>x.status==='rejected').length,1);
 const c=new SessionStore(store,{now}),current=await c.get(token);const missing=current.parts[1]?2:1;
 await c.put(token,missing,3,1,missing===1?Buffer.from('second'):Buffer.from('third'));assert.equal((await c.get(token)).parts.filter(Boolean).length,3);
});
test('TTL changes persist and are constrained to 1, 6 or 24 hours',async()=>{
 const store=new Memory(),s=new SessionStore(store,{now});await s.put(token,0,1,1,Buffer.from('x'));
 assert.equal((await s.change(token,'ttl',24)).expires,now()+24*3600000);assert.equal((await s.change(token,'ttl',999)).expires,now()+3600000);
});
