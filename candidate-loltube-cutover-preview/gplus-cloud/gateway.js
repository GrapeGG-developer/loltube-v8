'use strict';
/* Experimental serialized G+ gateway. A mutating response is held until
 * content and a verified immutable state revision are on the backing store.
 * Provider-level conditional-create semantics, retention and production
 * integration still require independent validation. */
const path=require('node:path'),crypto=require('node:crypto');
const fingerprint=files=>Object.keys(files).sort().map(k=>k+':'+crypto.createHash('sha256').update(files[k]).digest('hex')).join('|');
function createGateway({ledger,backend,snapshot,publishAsset,dataDir,onFatal=()=>{},maxQueue=100}){
 if(!ledger||typeof backend!=='function'||typeof snapshot!=='function'||typeof publishAsset!=='function'||!path.isAbsolute(dataDir)||typeof onFatal!=='function')throw Error('invalid_gateway');
 let tail=Promise.resolve(),queued=0,healthy=true;let persisted=fingerprint(ledger.files);
 async function checkpoint(){const files=await snapshot(),current=fingerprint(files);if(current!==persisted){await ledger.commit(files);persisted=current;}}
 function fatal(){if(!healthy)return;healthy=false;try{onFatal();}catch{}}
 function unavailable(res){if(res.destroyed||res.writableEnded)return;try{res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"durable_storage_unavailable"}');}catch{try{res.destroy();}catch{}}}
 function serve(req,res){
  if(!healthy||queued>=maxQueue){unavailable(res);req.resume();return;}
  queued++;
  const run=async()=>{
   if(!healthy||res.destroyed){if(!res.destroyed)unavailable(res);return;}
   try{if(await ledger.changedExternally()){unavailable(res);fatal();return;}}catch{unavailable(res);fatal();return;}
   if(req.method==='GET'||req.method==='HEAD'){
    await new Promise(resolve=>{
     let settled=false;const done=()=>{if(settled)return;settled=true;resolve();};
     res.once('finish',done);res.once('close',done);
     try{backend(req,res);}catch{unavailable(res);fatal();done();}
    });return;
   }
   await new Promise(resolve=>{
    let started=false,settled=false;
    const originalHead=res.writeHead.bind(res),originalEnd=res.end.bind(res);
    const done=()=>{if(settled)return;settled=true;resolve();};
    res.once('close',()=>{if(!started){fatal();done();}});
    res.writeHead=function(status,arg,third){
     if(started)throw Error('double_response');res.statusCode=status;
     const headers=(arg&&typeof arg==='object'?arg:(third&&typeof third==='object'?third:null));
     if(headers)for(const [name,value] of Object.entries(headers))res.setHeader(name,value);
     return res;
    };
    res.write=function(){throw Error('mutating_stream_unsupported');};
    res.end=function(chunk,encoding,callback){
     if(started)return res;started=true;
     if(typeof chunk==='function'){callback=chunk;chunk=undefined;encoding=undefined;}
     if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
     const body=chunk===undefined||chunk===null?Buffer.alloc(0):(Buffer.isBuffer(chunk)?Buffer.from(chunk):Buffer.from(chunk,typeof encoding==='string'?encoding:'utf8'));
     const status=res.statusCode;
     (async()=>{
      try{
       if(body.length>1024*1024)throw Error('response_too_large');
       const match=(req.url||'').split('?')[0].match(/^\/gplus\/assets\/([A-Za-z0-9_-]{22})$/);
       if(req.method==='PUT'&&match&&status>=200&&status<300){
        await publishAsset(match[1],path.join(dataDir,'encrypted-assets',match[1]+'.bin'),Number(req.headers['content-length']),req.headers['x-gplus-sha256']);
       }
       await checkpoint();
       res.writeHead=originalHead;res.end=originalEnd;
       if(!res.destroyed){originalHead(status);originalEnd(body,callback);}
      }catch{
       res.writeHead=originalHead;res.end=originalEnd;
       // Never acknowledge a mutation unless both media and revision committed.
       if(!res.destroyed){try{res.removeHeader('Content-Length');res.removeHeader('Content-Type');unavailable(res);}catch{try{res.destroy();}catch{}}}
       fatal();
      }finally{done();}
     })();return res;
    };
    try{backend(req,res);}catch{
     res.writeHead=originalHead;res.end=originalEnd;unavailable(res);fatal();done();
    }
   });
  };
  tail=tail.then(run,run).catch(()=>{unavailable(res);fatal();}).finally(()=>{queued--;});
 }
 serve.maintenance=fn=>{
  if(typeof fn!=='function')return Promise.reject(Error('invalid_maintenance'));
  if(!healthy||queued>=maxQueue)return Promise.reject(Error('storage_unavailable'));queued++;
  const run=async()=>{if(!healthy||await ledger.changedExternally())throw Error('storage_unavailable');return fn(checkpoint);};
  const result=tail.then(run,run);tail=result.then(()=>{},()=>{fatal();}).finally(()=>{queued--;});return result;
 };
 serve.isHealthy=()=>healthy;serve.queued=()=>queued;return serve;
}
module.exports={createGateway,fingerprint};
