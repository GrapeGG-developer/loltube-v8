'use strict';
/* Experimental Cloudinary-backed temporary GLINK relay state. A single session
 * is serialized locally; immutable, verified revisions detect conflicts. This
 * is not a fencing guarantee without an atomic provider-side conditional create.
 * It does not integrate Wi-Fi offer persistence or background cleanup yet. */
const crypto=require('node:crypto');
const MAX_CHUNKS=4096,MAX_CHUNK=8*1024*1024,MAX_JSON=2*1024*1024,MAX_REVISIONS=32768,MAX_FORWARD_SCAN=512;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const validSession=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{6,64}$/.test(s);
const validDigest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const base=id=>'relay/'+id+'/';
const revision=(id,n)=>base(id)+'revisions/'+String(n).padStart(6,'0')+'.json';
const part=(id,n)=>base(id)+'parts/'+String(n).padStart(6,'0')+'.json';
const head=id=>base(id)+'head.json';
const marker=id=>'relay-index/'+id+'.json';
const sessionHash=s=>{if(!validSession(s))throw Error('invalid_session');return hash(Buffer.from(s,'utf8'));};
function parse(raw,id,seq,parent){
 if(!Buffer.isBuffer(raw)||raw.length>MAX_JSON)throw Error('bad_revision');let x;try{x=JSON.parse(raw.toString('utf8'));}catch{throw Error('bad_revision');}
 if(!x||x.v!==1||x.id!==id||x.seq!==seq||x.parent!==parent||!Number.isSafeInteger(x.created)||x.created<1||!Number.isSafeInteger(x.expires)||x.expires<x.created||!Number.isInteger(x.n)||x.n<1||x.n>MAX_CHUNKS||typeof x.done!=='boolean'||typeof x.clean!=='boolean'||!Number.isInteger(x.gcPart)||x.gcPart<0||x.gcPart>x.n||!Number.isInteger(x.gcRev)||x.gcRev<1||!Number.isInteger(x.gcCutoff)||x.gcCutoff<0||x.gcCutoff>=x.seq||!Array.isArray(x.parts)||x.parts.length!==x.n)throw Error('bad_revision');
 if(x.gcRev>x.gcCutoff+1||(!x.done&&(x.clean||x.gcPart!==0||x.gcRev!==1||x.gcCutoff!==0))||(x.done&&x.parts.some(Boolean))||(x.clean&&(x.gcPart!==x.n||x.gcRev<=x.gcCutoff)))throw Error('bad_revision');
 let total=0;
 for(const p of x.parts){if(p!==null){if(!p||!validDigest(p.sha)||!Number.isInteger(p.size)||p.size<1||p.size>MAX_CHUNK)throw Error('bad_revision');total+=p.size;}}
 if(!Number.isSafeInteger(total))throw Error('bad_revision');return x;
}
function hours(h){const n=Number(h);return [1,6,24].includes(n)?n:1;}
class SessionStore{
 constructor(store,{now=Date.now}={}){
  if(!store||typeof store.get!=='function'||typeof store.putOnce!=='function'||typeof store.replace!=='function'||typeof now!=='function')throw Error('invalid_store');
  this.store=store;this.now=now;this.locks=new Map();
 }
 async exclusive(id,fn){
  const last=this.locks.get(id)||Promise.resolve();let release;const turn=new Promise(r=>{release=r;});const current=last.catch(()=>{}).then(()=>turn);this.locks.set(id,current);
  await last.catch(()=>{});try{return await fn();}finally{release();if(this.locks.get(id)===current)this.locks.delete(id);}
 }
 async load(id){
  if(!validDigest(id))throw Error('invalid_session');let seq=0,tip='',state=null;
  const hr=await this.store.get(head(id));
  if(hr!==null){
   if(!Buffer.isBuffer(hr)||hr.length>512)throw Error('bad_head');let h;try{h=JSON.parse(hr.toString('utf8'));}catch{throw Error('bad_head');}
   if(!h||h.v!==1||!Number.isSafeInteger(h.seq)||h.seq<1||h.seq>MAX_REVISIONS||!validDigest(h.hash))throw Error('bad_head');
   const b=await this.store.get(revision(id,h.seq));if(!b||hash(b)!==h.hash)throw Error('bad_head');
   let pre;try{pre=JSON.parse(b.toString('utf8'));}catch{throw Error('bad_revision');}
   const parent=h.seq===1?'':pre.parent;
   if(h.seq>1){if(!validDigest(parent))throw Error('bad_revision');const prev=await this.store.get(revision(id,h.seq-1));if(!prev||hash(prev)!==parent)throw Error('bad_revision');}
   state=parse(b,id,h.seq,parent);seq=h.seq;tip=h.hash;
  }
  for(let steps=0;steps<=MAX_FORWARD_SCAN;steps++){
   const n=seq+1;if(n>MAX_REVISIONS)break;const b=await this.store.get(revision(id,n));if(b===null)break;
   if(steps===MAX_FORWARD_SCAN)throw Error('revision_scan_limit');state=parse(b,id,n,tip);seq=n;tip=hash(b);
  }
  return state?{state,tip}:null;
 }
 async commit(id,previous,next){
  const seq=previous?previous.state.seq+1:1,parent=previous?previous.tip:'';if(seq>MAX_REVISIONS)throw Error('revision_limit');
  const x={...next,v:1,id,seq,parent},raw=Buffer.from(JSON.stringify(x));parse(raw,id,seq,parent);
  const key=revision(id,seq);let inserted=false;
  try{inserted=await this.store.putOnce(key,raw);}catch(e){const actual=await this.store.get(key);if(!actual||!actual.equals(raw))throw e;inserted=true;}
  const saved=await this.store.get(key);if(!saved||!saved.equals(raw))throw Error(inserted?'revision_verification_failed':'revision_conflict');
  const hb=Buffer.from(JSON.stringify({v:1,seq,hash:hash(raw)}));
  await this.store.replace(head(id),hb);const current=await this.store.get(head(id));if(!current||!current.equals(hb))throw Error('head_verification_failed');
  return {state:x,tip:hash(raw)};
 }
 async get(token){const id=sessionHash(token);return this.exclusive(id,async()=>{const x=await this.load(id);return x?structuredClone(x.state):null;});}
 async put(token,index,count,ttl,data){
  const id=sessionHash(token);
  if(!Number.isInteger(index)||!Number.isInteger(count)||count<1||count>MAX_CHUNKS||index<0||index>=count||!Buffer.isBuffer(data)||data.length<1||data.length>MAX_CHUNK)throw Error('bad_chunk');
  return this.exclusive(id,async()=>{
   let cur=await this.load(id);const now=this.now();if(!Number.isSafeInteger(now)||now<1)throw Error('clock_unavailable');
   if(!cur){
    const m=Buffer.from(JSON.stringify({v:1,id,created:now})),k=marker(id);
    try{await this.store.putOnce(k,m);}catch(e){const old=await this.store.get(k);if(!old)throw e;}
    const old=await this.store.get(k);let obj;try{obj=JSON.parse(old.toString('utf8'));}catch{throw Error('bad_marker');}
    if(!obj||obj.v!==1||obj.id!==id||!Number.isSafeInteger(obj.created)||obj.created<1)throw Error('bad_marker');
    cur=await this.commit(id,null,{n:count,created:now,expires:now+hours(ttl)*3600000,done:false,clean:false,gcPart:0,gcRev:1,gcCutoff:0,parts:Array(count).fill(null)});
   }
   if(cur.state.done)throw Error('session_closed');if(cur.state.n!==count)throw Error('chunk_conflict');
   const sum=hash(data),current=cur.state.parts[index];
   if(current){if(current.sha!==sum||current.size!==data.length)throw Error('chunk_conflict');const check=await this.store.get(part(id,index));if(!check||check.length!==data.length||hash(check)!==sum)throw Error('part_missing_or_corrupt');return {duplicate:true,state:cur.state};}
   const key=part(id,index);let inserted;try{inserted=await this.store.putOnce(key,data);}catch(e){const b=await this.store.get(key);if(!b||!b.equals(data))throw e;inserted=true;}
   const b=await this.store.get(key);if(!b||b.length!==data.length||hash(b)!==sum)throw Error(inserted?'part_verification_failed':'chunk_conflict');
   const parts=cur.state.parts.slice();parts[index]={sha:sum,size:data.length};
   cur=await this.commit(id,cur,{...cur.state,parts,expires:now+hours(ttl)*3600000});
   return {duplicate:false,state:cur.state};
  });
 }
 async change(token,action,ttl){
  const id=sessionHash(token);return this.exclusive(id,async()=>{
   const cur=await this.load(id);if(!cur)return null;if(cur.state.done)return cur.state;
   const now=this.now();if(!Number.isSafeInteger(now)||now<1)throw Error('clock_unavailable');
   if(action==='done')return (await this.commit(id,cur,{...cur.state,done:true,parts:Array(cur.state.n).fill(null),gcPart:0,gcRev:1,gcCutoff:Math.max(0,cur.state.seq-1)})).state;
   if(action==='ttl')return (await this.commit(id,cur,{...cur.state,expires:now+hours(ttl)*3600000})).state;
   throw Error('invalid_action');
  });
 }
 async getPart(id,index,info){
  const data=await this.store.get(part(id,index));if(!data||data.length!==info.size||hash(data)!==info.sha)throw Error('part_missing_or_corrupt');return data;
 }
}
module.exports={SessionStore,sessionHash,parse,revision,part,head,marker,hash,hours,MAX_CHUNKS,MAX_CHUNK};
