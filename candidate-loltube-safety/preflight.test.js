'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createDurableGate}=require('./durable-gate');
test('stale or unavailable ledger fences both reads and writes before handler observes state',async t=>{
 let reached=0,fatals=0,stale=false;const gate=createDurableGate({snapshot:async()=>Buffer.from('x'),commit:async()=>{},
  preflight:async()=>{if(stale)throw Error('stale');},onFatal:()=>fatals++});
 const s=http.createServer((req,res)=>gate(req,res,()=>{reached++;res.end('safe');}));await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>s.close());
 const url='http://127.0.0.1:'+s.address().port;assert.equal((await fetch(url)).status,200);assert.equal(reached,1);
 stale=true;assert.equal((await fetch(url)).status,503);assert.equal(fatals,1);assert.equal(reached,1);
 stale=false;assert.equal((await fetch(url,{method:'POST'})).status,503);assert.equal(reached,1);await new Promise(r=>s.close(r));
});
