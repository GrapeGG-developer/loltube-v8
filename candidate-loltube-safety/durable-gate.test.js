'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createDurableGate}=require('./durable-gate');
async function server({commit,delay,preflight}={}){
 let state=0,fatals=0,stored=0,commits=0;
 const gate=createDurableGate({snapshot:async()=>Buffer.from(String(state)),commit:async b=>{commits++;if(delay)await delay();if(commit)await commit(b);stored=Number(b.toString());},...(preflight?{preflight}:{}),onFatal:()=>fatals++});
 const s=http.createServer((req,res)=>gate(req,res,()=>{
  if(req.url==='/mutate'){state++;gate.markMutation();res.writeHead(200,{'content-type':'text/plain','content-length':2});res.end('ok');}
  else{res.writeHead(200,{'content-type':'text/plain'});res.end(String(state));}
 }));await new Promise(r=>s.listen(0,'127.0.0.1',r));
 return {s,gate,get stored(){return stored},get fatals(){return fatals},get commits(){return commits},base:'http://127.0.0.1:'+s.address().port,close:()=>new Promise(r=>s.close(r))};
}
test('mutation response waits until state is durable',async(t)=>{
 let finish;const delay=new Promise(r=>finish=r),x=await server({delay:()=>delay});t.after(()=>x.s.close());
 let arrived=false;const p=fetch(x.base+'/mutate',{method:'POST'}).then(r=>{arrived=true;return r});
 await new Promise(r=>setTimeout(r,30));assert.equal(arrived,false);assert.equal(x.stored,0);finish();const r=await p;assert.equal(r.status,200);assert.equal(x.stored,1);await x.close();
});
test('serialized readers cannot observe uncommitted mutation',async(t)=>{
 let finish;const delay=new Promise(r=>finish=r),x=await server({delay:()=>delay});t.after(()=>x.s.close());
 const a=fetch(x.base+'/mutate',{method:'POST'});await new Promise(r=>setTimeout(r,20));let readDone=false;const b=fetch(x.base+'/read').then(r=>{readDone=true;return r});
 await new Promise(r=>setTimeout(r,20));assert.equal(readDone,false);finish();assert.equal((await a).status,200);assert.equal(await (await b).text(),'1');assert.equal(x.commits,1);await x.close();
});
test('failed backup returns 503, suppresses local state and fences process',async(t)=>{
 const x=await server({commit:async()=>{throw Error('remote_down')}});t.after(()=>x.s.close());
 const r=await fetch(x.base+'/mutate',{method:'POST'});assert.equal(r.status,503);assert.equal(x.fatals,1);assert.equal(x.stored,0);
 const after=await fetch(x.base+'/read');assert.equal(after.status,503);await x.close();
});
test('pure reads do not write remote backups',async(t)=>{
 const x=await server();t.after(()=>x.s.close());assert.equal(await (await fetch(x.base+'/read')).text(),'0');assert.equal(x.commits,0);await x.close();
});
