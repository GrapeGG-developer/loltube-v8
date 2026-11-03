'use strict';
/* SQLite WAL must be checkpointed while all G+ requests and sweeps are paused. */
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const Database=require('better-sqlite3');
const NAMES=['accounts-v1.json','gplus-messages.sqlite3','gplus-assets.sqlite3'];
const MAX=32*1024*1024;
async function materialize(dataDir,files){
 if(!path.isAbsolute(dataDir)||!files||Object.keys(files).some(x=>!NAMES.includes(x)))throw Error('invalid_snapshot');
 await fsp.mkdir(dataDir,{recursive:true,mode:0o700});
 for(const [name,body] of Object.entries(files)){
  if(!Buffer.isBuffer(body)||body.length>MAX)throw Error('snapshot_too_large');
  const fd=await fsp.open(path.join(dataDir,name),'wx',0o600);try{await fd.writeFile(body);await fd.sync();}finally{await fd.close();}
 }
}
async function snapshot(dataDir){
 if(!path.isAbsolute(dataDir))throw Error('invalid_snapshot');const out={};
 for(const name of NAMES){
  const file=path.join(dataDir,name);let stat;try{stat=await fsp.lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX)throw Error('unsafe_snapshot_file');
  if(name.endsWith('.sqlite3')){
   const db=new Database(file,{fileMustExist:true,timeout:5000});
   try{const result=db.pragma('wal_checkpoint(TRUNCATE)');if(!Array.isArray(result)||result.some(x=>x.busy!==0))throw Error('checkpoint_busy');}finally{db.close();}
  }
  const b=await fsp.readFile(file);if(b.length>MAX)throw Error('snapshot_too_large');out[name]=b;
 }
 return out;
}
module.exports={snapshot,materialize,MAX};
