'use strict';
/* Encrypted media blocks on Cloudinary. Each asset owns its blocks, so a
 * delivered-and-expired asset can be deleted without touching shared ledger
 * snapshots or any other asset. Indexes are retained as deletion tombstones. */
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {digest}=require('./ledger');
const SIZE=2*1024*1024,MAX=8*1024**3,MAX_BLOCKS=Math.ceil(MAX/SIZE);
function validId(id){return typeof id==='string'&&/^[A-Za-z0-9_-]{22}$/.test(id);}
function validHash(h){return typeof h==='string'&&/^[a-f0-9]{64}$/.test(h);}
function indexPath(id){if(!validId(id))throw Error('invalid_asset');return 'assets/'+id+'/index.json';}
function assetBlockPath(id,index,sha){if(!validId(id)||!Number.isInteger(index)||index<0||index>=MAX_BLOCKS||!validHash(sha))throw Error('invalid_asset');return 'assets/'+id+'/blocks/'+String(index).padStart(6,'0')+'-'+sha+'.json';}
function parseIndex(raw,id){
 if(!Buffer.isBuffer(raw)||raw.length>2*1024*1024)throw Error('invalid_asset_index');let a;
 try{a=JSON.parse(raw.toString('utf8'));}catch{throw Error('invalid_asset_index');}
 if(!a||a.v!==1||a.id!==id||!Number.isSafeInteger(a.size)||a.size<1||a.size>MAX||!validHash(a.sha256)||!Array.isArray(a.blocks)||a.blocks.length<1||a.blocks.length>MAX_BLOCKS)throw Error('invalid_asset_index');
 let total=0;
 for(let i=0;i<a.blocks.length;i++){const b=a.blocks[i];if(!b||!validHash(b.sha256)||!Number.isInteger(b.size)||b.size<1||b.size>SIZE||(i<a.blocks.length-1&&b.size!==SIZE))throw Error('invalid_asset_index');total+=b.size;}
 if(total!==a.size)throw Error('invalid_asset_index');return a;
}
class CloudFiles {
 constructor(store){if(!store||typeof store.get!=='function'||typeof store.putOnce!=='function')throw Error('invalid_store');this.store=store;}
 async publish(id,file,size,sha256){
  const key=indexPath(id);if(!Number.isSafeInteger(size)||size<1||size>MAX||!validHash(sha256))throw Error('invalid_asset');
  const existing=await this.store.get(key);
  if(existing!==null){
   const a=parseIndex(existing,id);if(a.size!==size||a.sha256!==sha256)throw Error('asset_conflict');
   const whole=crypto.createHash('sha256');for(let i=0;i<a.blocks.length;i++){const part=a.blocks[i],b=await this.store.get(assetBlockPath(id,i,part.sha256));if(!b||b.length!==part.size||digest(b)!==part.sha256)throw Error('asset_block_missing_or_corrupt');whole.update(b);}
   if(whole.digest('hex')!==sha256)throw Error('asset_digest_mismatch');return;
  }
  const handle=await fsp.open(file,'r');let position=0;const whole=crypto.createHash('sha256'),blocks=[];
  try{
   const stat=await handle.stat();if(!stat.isFile()||stat.size!==size)throw Error('asset_changed');
   while(position<size){
    const len=Math.min(SIZE,size-position),data=Buffer.allocUnsafe(len);let offset=0;
    while(offset<len){const r=await handle.read(data,offset,len-offset,position+offset);if(!r.bytesRead)throw Error('asset_changed');offset+=r.bytesRead;}
    position+=len;whole.update(data);const h=digest(data),k=assetBlockPath(id,blocks.length,h);
    try{await this.store.putOnce(k,data);}catch(e){const b=await this.store.get(k);if(!b||b.length!==len||digest(b)!==h)throw e;}
    const b=await this.store.get(k);if(!b||b.length!==len||digest(b)!==h)throw Error('asset_block_verification_failed');
    blocks.push({sha256:h,size:len});
   }
   if((await handle.stat()).size!==size||whole.digest('hex')!==sha256)throw Error('asset_changed');
  }finally{await handle.close();}
  const raw=Buffer.from(JSON.stringify({v:1,id,size,sha256,blocks}));parseIndex(raw,id);
  let inserted;try{inserted=await this.store.putOnce(key,raw);}catch(e){const b=await this.store.get(key);if(!b||!b.equals(raw))throw e;inserted=true;}
  if(!inserted){const b=await this.store.get(key);const a=parseIndex(b,id);if(a.size!==size||a.sha256!==sha256)throw Error('asset_conflict');}
  const b=await this.store.get(key);const a=parseIndex(b,id);if(a.size!==size||a.sha256!==sha256)throw Error('asset_conflict');
 }
 async restore(id,file,size,sha256){
  const raw=await this.store.get(indexPath(id));if(!raw)throw Error('asset_missing');const a=parseIndex(raw,id);
  if(a.size!==size||a.sha256!==sha256)throw Error('asset_conflict');
  const dir=path.dirname(file),temp=path.join(dir,'.gplus-restore-'+crypto.randomBytes(16).toString('hex')+'.tmp');
  await fsp.mkdir(dir,{recursive:true,mode:0o700});let fd,created=false;const whole=crypto.createHash('sha256');
  try{
   fd=await fsp.open(temp,'wx',0o600);created=true;
   for(let i=0;i<a.blocks.length;i++){const part=a.blocks[i],b=await this.store.get(assetBlockPath(id,i,part.sha256));if(!b||b.length!==part.size||digest(b)!==part.sha256)throw Error('asset_block_missing_or_corrupt');whole.update(b);await fd.writeFile(b);}
   if(whole.digest('hex')!==sha256)throw Error('asset_digest_mismatch');
   await fd.sync();await fd.close();fd=null;
   try{await fsp.link(temp,file);}catch(e){if(e.code!=='EEXIST')throw e;throw Error('local_asset_exists');}
  }finally{if(fd)try{await fd.close();}catch{}if(created)try{await fsp.unlink(temp);}catch{}}
 }
 async remove(id){
  if(typeof this.store.removeMany!=='function')throw Error('asset_deletion_unavailable');
  const raw=await this.store.get(indexPath(id));if(!raw)throw Error('asset_index_missing');const a=parseIndex(raw,id),keys=a.blocks.map((b,i)=>assetBlockPath(id,i,b.sha256));
  for(let i=0;i<keys.length;i+=100)await this.store.removeMany(keys.slice(i,i+100));
  // Keep the small, immutable index: it permits idempotent recovery after a
  // crash and prevents accidentally reusing an asset ID with missing data.
  return keys.length;
 }
}
module.exports={CloudFiles,parseIndex,indexPath,assetBlockPath,SIZE,MAX};
