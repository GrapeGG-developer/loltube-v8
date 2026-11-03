'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Ledger}=require('./ledger'),{createGateway}=require('./gateway');
class Store{constructor(){this.m=new Map();this.failWrites=false}async get(k){return this.m.has(k)?Buffer.from(this.m.get(k)):null}async putOnce(k,v){if(this.failWrites)throw Error('unavailable');if(this.m.has(k))return false;this.m.set(k,Buffer.from(v));return true}async setHead(v){this.m.set('head.json',Buffer.from(v))}}
async function launch(store,{synchronize}={}){
 const ledger=new Ledger(store),restored=await ledger.recover();let value=restored.files['accounts-v1.json']?.toString()||'initial';let fatals=0;
 const backend=async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'text/plain'});return res.end(value);}
  let chunks=[];for await(const c of req)chunks.push(c);value=Buffer.concat(chunks).toString();if(synchronize)await synchronize();
  res.writeHead(200,{'content-type':'text/plain','content-length':2});res.end('ok');
 };
 const gateway=createGateway({ledger,backend,snapshot:async()=>({'accounts-v1.json':Buffer.from(value)}),publishAsset:async()=>{},dataDir:'/tmp/test',onFatal:()=>{fatals++;}});
 const server=http.createServer(gateway);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {server,gateway,get fatals(){return fatals},base:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
test('success acknowledged only after immutable snapshot is restorable',async(t)=>{
 const s=new Store(),a=await launch(s);t.after(()=>a.server.close());
 let r=await fetch(a.base+'/change',{method:'POST',body:'important'});assert.equal(r.status,200);assert.equal(await r.text(),'ok');
 const ledger=new Ledger(s),saved=await ledger.recover();assert.equal(saved.files['accounts-v1.json'].toString(),'important');
 await a.close();const b=await launch(s);t.after(()=>b.server.close());r=await fetch(b.base+'/read');assert.equal(await r.text(),'important');await b.close();
});
test('remote write failure returns 503 and does not expose uncommitted local state',async(t)=>{
 const s=new Store(),a=await launch(s);t.after(()=>a.server.close());s.failWrites=true;
 let r=await fetch(a.base+'/change',{method:'POST',body:'not-committed'});assert.equal(r.status,503);assert.equal(a.fatals,1);
 r=await fetch(a.base+'/read');assert.equal(r.status,503);assert.equal((await new Ledger(s).recover()).seq,0);await a.close();
});
test('two instances competing for one revision: one wins; loser returns 503',async(t)=>{
 const store=new Store();let release,ready=0;const gate=new Promise(r=>release=r);
 const barrier=async()=>{if(++ready===2)release();await gate;};const a=await launch(store,{synchronize:barrier}),b=await launch(store,{synchronize:barrier});
 t.after(()=>{a.server.close();b.server.close()});
 const results=await Promise.all([fetch(a.base+'/change',{method:'POST',body:'a'}),fetch(b.base+'/change',{method:'POST',body:'b'})]);
 assert.deepEqual(results.map(x=>x.status).sort(),[200,503]);const restored=await new Ledger(store).recover();
 assert.ok(['a','b'].includes(restored.files['accounts-v1.json'].toString()));assert.equal(a.fatals+b.fatals,1);
 await Promise.all([a.close(),b.close()]);
});
test('an externally advanced store fences an outdated instance before serving',async(t)=>{
 const store=new Store(),a=await launch(store);t.after(()=>a.server.close());
 const other=new Ledger(store);await other.recover();await other.commit({'accounts-v1.json':Buffer.from('newer')});
 const response=await fetch(a.base+'/read');assert.equal(response.status,503);assert.equal(a.fatals,1);await a.close();
});
