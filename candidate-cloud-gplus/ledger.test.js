'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Ledger,Conflict,BLOCK,seqPath,blockPath,digest}=require('./ledger');
class FakeStore {
 constructor(){this.objects=new Map();this.failAfterPut=null;this.failGet=null;this.writes=0;}
 async get(k){if(this.failGet===k)throw Error('remote_unavailable');const v=this.objects.get(k);return v?Buffer.from(v):null;}
 async putOnce(k,v){
  if(this.objects.has(k))return false;
  this.objects.set(k,Buffer.from(v));this.writes++;
  if(this.failAfterPut===k){this.failAfterPut=null;throw Error('response_lost');}
  return true;
 }
 async setHead(v){this.objects.set('head.json',Buffer.from(v));}
}
const body=(v)=>({'accounts-v1.json':Buffer.from(v)});
test('empty bootstrap and complete block-verified restore',async()=>{
 const store=new FakeStore(),a=new Ledger(store);assert.equal((await a.recover()).seq,0);
 const files={'accounts-v1.json':crypto.randomBytes(BLOCK+19),'gplus-messages.sqlite3':Buffer.from('sample encrypted messages')};
 assert.equal((await a.commit(files)).seq,1);const b=new Ledger(store),restored=await b.recover();
 assert.equal(restored.seq,1);assert.deepEqual(restored.files,files);
});
test('two writers based on one revision cannot both commit distinct states',async()=>{
 const store=new FakeStore(),base=new Ledger(store);await base.recover();await base.commit(body('old'));
 const a=new Ledger(store),b=new Ledger(store);await Promise.all([a.recover(),b.recover()]);
 const [x,y]=await Promise.allSettled([a.commit(body('from-a')),b.commit(body('from-b'))]);
 assert.equal([x,y].filter(z=>z.status==='fulfilled').length,1);
 assert.equal([x,y].filter(z=>z.status==='rejected'&&z.reason instanceof Conflict).length,1);
 const c=new Ledger(store),latest=await c.recover();assert.equal(latest.seq,2);
 assert.ok(['from-a','from-b'].includes(latest.files['accounts-v1.json'].toString()));
});
test('lost success response is resolved by comparing exact immutable revision',async()=>{
 const store=new FakeStore(),a=new Ledger(store);await a.recover();store.failAfterPut=seqPath(1);
 assert.equal((await a.commit(body('once'))).seq,1);const r=await new Ledger(store).recover();assert.equal(r.seq,1);
});
test('stale mutable head is only a hint and cannot hide newer committed data',async()=>{
 const store=new FakeStore(),a=new Ledger(store);await a.recover();await a.commit(body('one'));
 const old=Buffer.from(store.objects.get('head.json'));await a.commit(body('two'));await a.commit(body('three'));store.objects.set('head.json',old);
 const latest=await new Ledger(store).recover();assert.equal(latest.seq,3);assert.equal(latest.files['accounts-v1.json'].toString(),'three');
});
test('missing or corrupt content fails closed instead of starting empty',async()=>{
 const store=new FakeStore(),a=new Ledger(store);await a.recover();await a.commit(body('important'));
 store.objects.delete(blockPath(digest(Buffer.from('important'))));await assert.rejects(new Ledger(store).recover(),/missing_or_corrupt_block/);
 store.objects.set(blockPath(digest(Buffer.from('important'))),Buffer.from('tampered'));await assert.rejects(new Ledger(store).recover(),/missing_or_corrupt_block/);
});
test('unavailable storage is not treated as an empty or missing store',async()=>{
 const store=new FakeStore();store.failGet='head.json';await assert.rejects(new Ledger(store).recover(),/remote_unavailable/);
 store.failGet=null;const a=new Ledger(store);await a.recover();store.failGet=seqPath(1);await assert.rejects(a.changedExternally(),/remote_unavailable/);
});
test('head and manifest corruption fail closed',async()=>{
 const store=new FakeStore(),a=new Ledger(store);await a.recover();await a.commit(body('important'));
 store.objects.set('head.json',Buffer.from('{broken'));await assert.rejects(new Ledger(store).recover(),/invalid_head/);
});
test('file whitelist and bounded snapshots',async()=>{
 const store=new FakeStore(),a=new Ledger(store);await a.recover();
 await assert.rejects(a.commit({'../db':Buffer.from('x')}),/invalid_snapshot/);
 await assert.rejects(a.commit({'accounts-v1.json':'not-bytes'}),/invalid_snapshot/);
});
test('existing equal blocks are reused, and modified blocks are individually verified',async()=>{
 const store=new FakeStore(),a=new Ledger(store);await a.recover();const common=crypto.randomBytes(BLOCK);
 await a.commit({'accounts-v1.json':Buffer.concat([common,Buffer.from('a')])});const before=store.writes;
 await a.commit({'accounts-v1.json':Buffer.concat([common,Buffer.from('b')])});
 assert.equal(store.writes-before,2); // one new block and one revision
 assert.deepEqual((await new Ledger(store).recover()).files['accounts-v1.json'],Buffer.concat([common,Buffer.from('b')]));
});
