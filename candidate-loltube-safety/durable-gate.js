'use strict';
/* Experimental LOLTUBE response barrier. Never run against production until
 * integrated with fail-closed boot, no-overlap cutover and real-load testing.
 * All state-mutating /api requests must pass through this serialized gate and
 * call markMutation immediately after the local DB write. */
function createDurableGate({snapshot,commit,preflight=async()=>{},onFatal=()=>{},maxQueue=100}){
 if(typeof snapshot!=='function'||typeof commit!=='function'||typeof preflight!=='function'||typeof onFatal!=='function'||!Number.isInteger(maxQueue)||maxQueue<1)throw Error('invalid_gate');
 let tail=Promise.resolve(),queued=0,healthy=true,sequence=0,durable=0;
 function fail(){if(!healthy)return;healthy=false;try{onFatal();}catch{}}
 function unavailable(res){if(res.destroyed||res.writableEnded)return;try{res.statusCode=503;res.removeHeader('Content-Length');res.removeHeader('Content-Type');res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end('{"error":"backup_unavailable"}');}catch{try{res.destroy();}catch{}}}
 function middleware(req,res,next){
  if(!healthy||queued>=maxQueue){req.resume();unavailable(res);return;}
  queued++;
  const run=async()=>{
   if(!healthy||res.destroyed){if(!res.destroyed)unavailable(res);return;}
   try{await preflight();}catch{unavailable(res);fail();return;}
   if(!healthy||res.destroyed){if(!res.destroyed)unavailable(res);return;}
   await new Promise(resolve=>{
    let begun=false,finished=false;
    const originalEnd=res.end.bind(res),originalWrite=res.write.bind(res),originalHead=res.writeHead.bind(res);
    const restore=()=>{res.end=originalEnd;res.write=originalWrite;res.writeHead=originalHead;};
    const done=()=>{if(finished)return;finished=true;resolve();};
    res.once('close',()=>{if(!begun){fail();done();}});
    res.writeHead=function(status,arg,third){
     if(begun)throw Error('double_response');res.statusCode=status;
     const headers=arg&&typeof arg==='object'?arg:third&&typeof third==='object'?third:null;
     if(headers)for(const [name,value] of Object.entries(headers))res.setHeader(name,value);return res;
    };
    res.write=function(){throw Error('streaming_api_not_supported');};
    res.end=function(chunk,encoding,callback){
     if(begun)return res;begun=true;
     if(typeof chunk==='function'){callback=chunk;chunk=undefined;encoding=undefined;}
     if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
     const body=chunk==null?Buffer.alloc(0):Buffer.isBuffer(chunk)?Buffer.from(chunk):Buffer.from(chunk,typeof encoding==='string'?encoding:'utf8');
     (async()=>{
      try{
       if(res.headersSent)throw Error('headers_already_sent');
       if(sequence>durable){const target=sequence,bytes=await snapshot();if(!Buffer.isBuffer(bytes))throw Error('invalid_snapshot');await commit(bytes);durable=target;}
       restore();if(!res.destroyed)originalEnd(body,callback);
      }catch{
       restore();if(!res.destroyed)unavailable(res);fail();
      }finally{done();}
     })();return res;
    };
    try{next();}catch{restore();unavailable(res);fail();done();}
   });
  };
  tail=tail.then(run,run).catch(()=>{unavailable(res);fail();}).finally(()=>{queued--;});
 }
 middleware.markMutation=()=>{if(!healthy)throw Error('gate_unavailable');sequence++;};
 middleware.isHealthy=()=>healthy;middleware.pending=()=>queued;
 return middleware;
}
module.exports={createDurableGate};
