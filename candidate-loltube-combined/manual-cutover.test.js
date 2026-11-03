'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ManualCutover,mac,hash}=require('./manual-cutover');
const secret='synthetic-only-secret-not-used-in-production',fixedNonce=()=>Buffer.alloc(32,7);
function fakeLedger(initial=null){let data=initial&&Buffer.from(initial),imports=0;return {async recover(){return data&&Buffer.from(data);},async importOnce(b){if(data)throw Error('already_initialized');data=Buffer.from(b);imports++;},get imports(){return imports;}};}
function proof(c,b){const digest=hash(b);return {digest,proof:mac(secret,c.status().nonce,digest).toString('hex')};}
test('manual cutover rejects unauthenticated traffic without reading or importing',async()=>{
 let reads=0,ready=0;const ledger=fakeLedger(),c=new ManualCutover({secret,ledger,readLegacy:async()=>{reads++;return Buffer.from('synthetic');},onReady:async()=>{ready++;},random:fixedNonce});
 assert.equal((await c.start()).state,'awaiting');await assert.rejects(c.unlock({digest:'0'.repeat(64),proof:'0'.repeat(64)}),/unauthorized/);
 assert.equal(reads,0);assert.equal(ledger.imports,0);assert.equal(ready,0);assert.equal(c.status().state,'awaiting');
});
test('manual cutover refuses a changing legacy backup and imports only verified final bytes',async()=>{
 const old=Buffer.from('{"users":[1],"videos":[]}'),latest=Buffer.from('{"users":[1,2],"videos":[]}');let reads=0,stable=false,ready;
 const ledger=fakeLedger(),c=new ManualCutover({secret,ledger,readLegacy:async()=>{reads++;return stable?latest:reads%2?old:latest;},onReady:async b=>{ready=Buffer.from(b);},random:fixedNonce});
 await c.start();await assert.rejects(c.unlock(proof(c,old)),/legacy_backup_changed/);assert.equal(ledger.imports,0);assert.equal(c.status().state,'awaiting');
 stable=true;assert.deepEqual(await c.unlock(proof(c,latest)),{ok:true});assert.deepEqual(ready,latest);assert.deepEqual(await ledger.recover(),latest);assert.equal(ledger.imports,1);assert.equal(c.status().state,'ready');
 await assert.rejects(c.unlock({}),/not_available/);
});
test('manual cutover serializes concurrent unlock attempts',async()=>{
 let release;const blocked=new Promise(r=>{release=r;}),raw=Buffer.from('synthetic'),ledger=fakeLedger();let reads=0;
 const c=new ManualCutover({secret,ledger,readLegacy:async()=>{reads++;if(reads===1)await blocked;return raw;},onReady:async()=>{},random:fixedNonce});await c.start();const p=proof(c,raw),first=c.unlock(p);
 await assert.rejects(c.unlock(p),/not_available/);release();await first;assert.equal(ledger.imports,1);
});
test('recovering an existing ledger bypasses legacy import and restores exact bytes',async()=>{
 const raw=Buffer.from('existing_synthetic'),ledger=fakeLedger(raw);let ready,reads=0;const c=new ManualCutover({secret,ledger,readLegacy:async()=>{reads++;throw Error('unexpected');},onReady:async b=>{ready=b;},random:fixedNonce});
 assert.equal((await c.start()).state,'ready');assert.deepEqual(ready,raw);assert.equal(reads,0);assert.equal(ledger.imports,0);
});
test('failed durable readback fences the new process until restart',async()=>{
 const raw=Buffer.from('synthetic'),ledger=fakeLedger();let n=0;const base=ledger.recover.bind(ledger);ledger.recover=async()=>{n++;return n===2?Buffer.from('different'):base();};
 const c=new ManualCutover({secret,ledger,readLegacy:async()=>raw,onReady:async()=>{throw Error('must_not_run');},random:fixedNonce});await c.start();await assert.rejects(c.unlock(proof(c,raw)),/ledger_readback_mismatch/);assert.equal(c.status().state,'failed');await assert.rejects(c.unlock({}),/not_available/);
});
