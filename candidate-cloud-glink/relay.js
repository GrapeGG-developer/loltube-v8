'use strict';
/* Experimental GLINK HTTP transport on SessionStore. It keeps ciphertext only.
 * Wi-Fi presence/offers, provider fencing, garbage collection and integration
 * are separate requirements; do not enable this handler in production yet. */
const {SessionStore,sessionHash,part,revision,MAX_CHUNKS,MAX_CHUNK}=require('./session-store');
function waitDrain(res){return new Promise(resolve=>{if(res.destroyed||res.writableEnded)return resolve();const done=()=>{res.off('drain',done);res.off('close',done);res.off('error',done);resolve();};res.once('drain',done);res.once('close',done);res.once('error',done);});}
function send(res,status,body){if(res.destroyed||res.writableEnded)return;const raw=Buffer.from(typeof body==='string'?body:JSON.stringify(body));res.writeHead(status,{'Content-Type':typeof body==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8','Content-Length':raw.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(raw);}
function readBody(req,max){return new Promise((resolve,reject)=>{
 const v=req.headers['content-length'];if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,8})$/.test(v)){req.resume();return reject(Error('length_required'));}
 const expected=Number(v);if(expected<1||expected>max){req.resume();return reject(Error('bad_chunk'));}
 let size=0,parts=[],finished=false;const done=(err,data)=>{if(finished)return;finished=true;parts=[];err?reject(err):resolve(data);};
 req.on('data',b=>{size+=b.length;if(size>expected||size>max){req.destroy();return done(Error('bad_chunk'));}parts.push(b);});
 req.on('end',()=>size===expected?done(null,Buffer.concat(parts,size)):done(Error('bad_chunk')));
 req.on('aborted',()=>done(Error('aborted')));req.on('error',()=>done(Error('aborted')));
});}
function readable(s,now){return !!s&&!s.done&&s.expires>now&&s.parts.every(Boolean);}
function parseRange(raw,size){
 if(!raw)return {start:0,end:size-1,status:200};const m=/^bytes=(\d+)-(\d*)$/.exec(raw);if(!m)return null;
 const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=size)return null;
 return {start,end,status:206};
}
function createRelay({store,now=Date.now,maxUploads=8}){
 if(!Number.isInteger(maxUploads)||maxUploads<1||maxUploads>64)throw Error('invalid_relay');
 const sessions=new SessionStore(store,{now}),progress=new Map(),readers=new Map();let uploading=0,inflight=0,sweeping=false,cursor=null,pendingIds=[];
 async function handler(req,res,next=()=>send(res,404,'not found')){
  let url;try{url=new URL(req.url,'http://relay.local');}catch{return send(res,400,'bad request');}
  const m=/^\/glink\/(chunk|chunks|meta|dl|done|prog|ttl|get)\/([A-Za-z0-9_-]{6,64})$/.exec(url.pathname);if(!m)return next();
  const op=m[1],token=m[2],id=sessionHash(token);
  if(sweeping){req.resume();return send(res,503,'cleanup in progress');}inflight++;
  try{
   if(op==='get'){req.resume();return send(res,410,'Public GLINK links are disabled');}
   if(op==='chunk'&&req.method==='POST'){
    const i=url.searchParams.get('i'),n=url.searchParams.get('n');
    if(!/^(0|[1-9][0-9]{0,5})$/.test(i||'')||!/^[1-9][0-9]{0,5}$/.test(n||'')||Number(n)>MAX_CHUNKS||Number(i)>=Number(n)){req.resume();return send(res,400,'bad chunk');}
    if(uploading>=maxUploads){req.resume();return send(res,503,'busy');}
    uploading++;
    try{const data=await readBody(req,MAX_CHUNK);const result=await sessions.put(token,Number(i),Number(n),url.searchParams.get('ttl'),data);return send(res,200,{ok:true,duplicate:result.duplicate,assembled:result.state.parts.every(Boolean)});}
    finally{uploading--;}
   }
   if(op==='chunks'&&req.method==='GET'){
    const state=await sessions.get(token);if(!state||state.done||state.expires<=now())return send(res,200,{have:[]});
    return send(res,200,{have:state.parts.flatMap((p,i)=>p?[i]:[])});
   }
   if(op==='done'&&req.method==='POST'){req.resume();await sessions.change(token,'done');progress.delete(id);return send(res,200,{ok:true});}
   if(op==='ttl'&&req.method==='POST'){req.resume();const h=url.searchParams.get('h');const state=await sessions.change(token,'ttl',h);return state?send(res,200,{ok:true}):send(res,404,'not found');}
   if(op==='prog'){
    if(req.method==='POST'){
     req.resume();const got=Number(url.searchParams.get('got')),total=Number(url.searchParams.get('total'));
     if(!Number.isSafeInteger(got)||!Number.isSafeInteger(total)||got<0||total<0||got>total)return send(res,400,'bad progress');
     if(progress.size>=10000&&!progress.has(id))return send(res,503,'busy');progress.set(id,{got,total,ts:now()});return send(res,200,{ok:true});
    }
    if(req.method==='GET'){const p=progress.get(id);if(!p||now()-p.ts>86400000){progress.delete(id);return send(res,404,'no progress');}return send(res,200,{got:p.got,total:p.total});}
   }
   if((op==='meta'||op==='dl')&&req.method==='GET'){
    const state=await sessions.get(token);if(!readable(state,now()))return send(res,404,'not ready');
    const size=state.parts.reduce((sum,p)=>sum+p.size,0);if(op==='meta')return send(res,200,{size});
    const range=parseRange(req.headers.range,size);if(!range){res.writeHead(416,{'Content-Range':'bytes */'+size,'Content-Length':0,'Cache-Control':'no-store'});return res.end();}
    let offset=0,started=false;readers.set(id,(readers.get(id)||0)+1);
    try{
     for(let i=0;i<state.parts.length;i++){
      const info=state.parts[i],start=offset,end=offset+info.size-1;offset+=info.size;
      if(end<range.start||start>range.end)continue;
      const data=await sessions.getPart(id,i,info);if(res.destroyed)return;
      if(!started){const h={'Content-Type':'application/octet-stream','Accept-Ranges':'bytes','Content-Length':range.end-range.start+1,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};if(range.status===206)h['Content-Range']=`bytes ${range.start}-${range.end}/${size}`;res.writeHead(range.status,h);started=true;}
      const first=Math.max(0,range.start-start),last=Math.min(info.size,range.end-start+1);
      if(!res.write(data.subarray(first,last)))await waitDrain(res);
      if(res.destroyed)return;
     }
     if(!started)throw Error('part_missing_or_corrupt');return res.end();
    }finally{const n=(readers.get(id)||1)-1;if(n)readers.set(id,n);else readers.delete(id);}
   }
   req.resume();return send(res,405,'method not allowed');
  }catch(e){
   if(res.headersSent){res.destroy();return;}req.resume();
   const status=e.message==='length_required'?411:e.message==='bad_chunk'?400:e.message==='chunk_conflict'||e.message==='session_closed'||e.message==='revision_conflict'?409:503;
   return send(res,status,status===503?'storage unavailable':e.message);
  }finally{inflight--;}
 }
 // Cleanup is deliberately serialized against *all* local relay requests.
 // It never expires incomplete uploads automatically and only deletes objects
 // in the session's private namespace. Revisions record cleanup progress so a
 // crash or ambiguous delete response can be retried safely.
 handler.sweep=async()=>{
  if(typeof store.listMarkers!=='function'||typeof store.removeMany!=='function')throw Error('cleanup_not_supported');
  if(sweeping||inflight)return {busy:true};sweeping=true;let id=null;
  try{
   if(!pendingIds.length){const page=await store.listMarkers(cursor);if(!page||!Array.isArray(page.ids))throw Error('cloud_list_failed');pendingIds=page.ids.slice();cursor=page.cursor||null;}
   if(!pendingIds.length)return {busy:false,scanned:0};id=pendingIds.shift();if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid_session');
   const outcome=await sessions.exclusive(id,async()=>{
    let cur=await sessions.load(id);if(!cur)return 'orphan_preserved';let s=cur.state;if(s.clean)return 'already_clean';
    if(!s.done){
     if(s.expires>now()||!s.parts.every(Boolean))return 'preserved';
     cur=await sessions.commit(id,cur,{...s,done:true,parts:Array(s.n).fill(null),gcPart:0,gcRev:1,gcCutoff:Math.max(0,s.seq-1)});s=cur.state;
    }
    if(s.gcPart<s.n){
     const end=Math.min(s.gcPart+100,s.n),keys=[];for(let i=s.gcPart;i<end;i++)keys.push(part(id,i));await store.removeMany(keys);
     cur=await sessions.commit(id,cur,{...s,gcPart:end});return 'pending';
    }
    if(s.gcRev<=s.gcCutoff){
     const end=Math.min(s.gcRev+100,s.gcCutoff+1),keys=[];for(let i=s.gcRev;i<end;i++)keys.push(revision(id,i));await store.removeMany(keys);
     cur=await sessions.commit(id,cur,{...s,gcRev:end});return 'pending';
    }
    await sessions.commit(id,cur,{...s,clean:true});return 'clean';
   });
   if(outcome==='pending')pendingIds.push(id);return {busy:false,scanned:1,outcome};
  }catch(e){if(id)pendingIds.unshift(id);throw e;}finally{sweeping=false;}
 };
 handler.sessions=sessions;handler.pendingWrites=()=>uploading;handler.pendingOperations=()=>inflight;handler.readers=()=>readers.size;return handler;
}
module.exports={createRelay,parseRange,readable};
