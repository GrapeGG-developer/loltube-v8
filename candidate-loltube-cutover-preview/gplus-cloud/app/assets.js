'use strict';
// Encrypted binary object storage. Cleanup only starts after every intended
// recipient explicitly confirms receipt; unbound and undelivered data stays.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Transform,pipeline}=require('node:stream');const {promisify}=require('node:util');const pipe=promisify(pipeline);
const Database=require('better-sqlite3');const P=require('./protocol');
function reply(res,status,body){if(res.destroyed||res.writableEnded)return;const b=Buffer.from(JSON.stringify(body));res.writeHead(status,{'Content-Type':'application/json','Content-Length':b.length,'Cache-Control':'no-store'});res.end(b);}
function smallJson(req){return new Promise((resolve,reject)=>{let n=0,parts=[],failed=false;
 req.on('data',b=>{n+=b.length;if(n>4096){failed=true;parts=[];}else if(!failed)parts.push(b);});
 req.on('end',()=>{if(failed)return reject(Error('bad_body'));try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(Error('bad_body'));}});
 req.on('error',reject);req.on('aborted',()=>reject(Error('bad_body')));
});}
const DEFAULT_RETENTION_MS=30*24*60*60*1000;
function createAssets({dataDir,authenticate,isMember,eventRecipients=()=>null,maxStorageBytes=0,reserveBytes=0,now=Date.now,retentionMs=DEFAULT_RETENTION_MS,restoreAsset=null,cloudManagedDeletion=false}){
 if(!path.isAbsolute(dataDir)||typeof authenticate!=='function'||typeof isMember!=='function'||typeof eventRecipients!=='function'||typeof now!=='function'||typeof cloudManagedDeletion!=='boolean')throw Error('invalid asset configuration');
 if(!Number.isSafeInteger(maxStorageBytes)||maxStorageBytes<0||!Number.isSafeInteger(reserveBytes)||reserveBytes<0||!Number.isSafeInteger(retentionMs)||retentionMs<1)throw Error('invalid asset limits');
 const dir=path.join(dataDir,'encrypted-assets');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const db=new Database(path.join(dataDir,'gplus-assets.sqlite3'));db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');db.pragma('foreign_keys = ON');
 let activeUploads=0,activeSweeps=0;const readers=new Map();
 db.exec(`CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,chat TEXT NOT NULL,owner TEXT NOT NULL,size INTEGER NOT NULL,sha TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS asset_bindings(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,event_id TEXT NOT NULL,bound INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS asset_receipts(asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,recipient TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(asset_id,recipient));
 CREATE INDEX IF NOT EXISTS asset_receipt_asset ON asset_receipts(asset_id,received);`);
 // Interrupted writes are not delivered media; clean only their temporary files/rows.
 for(const a of db.prepare("SELECT id FROM assets WHERE state='uploading'").all()){
  if(!P.validEvent(a.id))throw Error('invalid_asset_id_in_store');
  try{fs.unlinkSync(path.join(dir,a.id+'.tmp'));}catch{}try{fs.unlinkSync(path.join(dir,a.id+'.bin'));}catch{}
 }
 db.prepare("DELETE FROM assets WHERE state='uploading'").run();
 const receiptsSummary=db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN received=0 THEN 1 ELSE 0 END) AS missing, MAX(received) AS last FROM asset_receipts WHERE asset_id=?');
 const binding=db.prepare('SELECT event_id FROM asset_bindings WHERE asset_id=?');
 function eligibleAt(id,t){
  if(!binding.get(id)||!Number.isSafeInteger(t)||t<=0)return false;
  const r=receiptsSummary.get(id);
  return r.total>0&&r.missing===0&&Number.isSafeInteger(r.last)&&r.last>0&&t>=r.last&&t-r.last>=retentionMs;
 }
 // A crash may occur after marking a file for deletion. Revalidate all receipts
 // and the deadline before completing; otherwise return the row to service.
 if(!cloudManagedDeletion)for(const a of db.prepare("SELECT id FROM assets WHERE state='deleting'").all()){
  if(!P.validEvent(a.id))throw Error('invalid_asset_id_in_store');
  let removed=false;
  if(eligibleAt(a.id,now()))try{fs.unlinkSync(path.join(dir,a.id+'.bin'));removed=true;}catch(e){if(e.code==='ENOENT')removed=true;}
  if(removed)db.prepare("DELETE FROM assets WHERE id=? AND state='deleting'").run(a.id);
  else db.prepare("UPDATE assets SET state='complete' WHERE id=? AND state='deleting'").run(a.id);
 }
 const bind=db.transaction((id,event,people,t)=>{
  const old=binding.get(id);if(old)return old.event_id===event?'already':'conflict';
  db.prepare('INSERT INTO asset_bindings(asset_id,event_id,bound) VALUES(?,?,?)').run(id,event,t);
  const add=db.prepare('INSERT INTO asset_receipts(asset_id,recipient) VALUES(?,?)');for(const person of people)add.run(id,person);
  return 'new';
 });
 const reserve=db.transaction((id,chat,owner,size,sha)=>{
  const old=db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  if(old){if(old.state==='complete'&&old.chat===chat&&old.owner===owner&&old.size===size&&old.sha===sha)return 'already';return 'conflict';}
  const used=db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM assets WHERE state!='tombstone'").get().n;
  if(maxStorageBytes===0||used+size>maxStorageBytes)return 'full';
  const stat=fs.statfsSync(dir);if(Number(stat.bavail)*Number(stat.bsize)<size+reserveBytes)return 'full';
  db.prepare("INSERT INTO assets(id,chat,owner,size,sha,state,created) VALUES(?,?,?,?,?,'uploading',?)").run(id,chat,owner,size,sha,now());return 'new';
 });
 const api=async function(req,res,next=()=>reply(res,404,{error:'not_found'})){
  const pathname=(req.url||'').split('?')[0];if(!pathname.startsWith('/gplus/assets/'))return next();
  const match=pathname.match(/^\/gplus\/assets\/([A-Za-z0-9_-]{22})(?:\/(bind|received))?$/);if(!match)return reply(res,404,{error:'not_found'});
  const id=match[1],action=match[2]||'',who=authenticate(req);if(!who)return reply(res,401,{error:'unauthorized'});
  if(action){
   if(req.method!=='POST')return reply(res,405,{error:'method_not_allowed'});
   const item=db.prepare("SELECT * FROM assets WHERE id=? AND state='complete'").get(id);
   if(!item||!isMember(item.chat,who.id))return reply(res,404,{error:'asset_not_found'});
   let body;try{body=await smallJson(req);}catch{return reply(res,400,{error:'bad_body'});}
   // A slow request must not bind or acknowledge a removed or replaced object.
   const current=db.prepare("SELECT * FROM assets WHERE id=? AND state='complete'").get(id);
   if(!current||current.chat!==item.chat||current.owner!==item.owner||current.sha!==item.sha||current.size!==item.size)return reply(res,404,{error:'asset_not_found'});
   const t=now();if(!Number.isSafeInteger(t)||t<1)return reply(res,503,{error:'clock_unavailable'});
   if(action==='bind'){
    if(who.id!==item.owner)return reply(res,403,{error:'not_owner'});
    if(!body||!P.validEvent(body.event))return reply(res,400,{error:'bad_event'});
    let list;try{list=eventRecipients(item.chat,body.event,who.id);}catch{return reply(res,503,{error:'event_unavailable'});}
    if(!Array.isArray(list))return reply(res,404,{error:'event_not_found'});
    const recipients=[...new Set(list.filter(x=>x!==item.owner))];
    if(recipients.length<1||recipients.length>99||recipients.some(x=>!P.validId(x))||!list.includes(item.owner))return reply(res,409,{error:'invalid_recipients'});
    try{const result=bind(id,body.event,recipients,t);if(result==='conflict')return reply(res,409,{error:'asset_already_bound'});return reply(res,200,{ok:true});}
    catch{return reply(res,503,{error:'storage_unavailable'});}
   }
   if(!body||body.sha256!==item.sha)return reply(res,400,{error:'digest_mismatch'});
   if(!P.validEvent(body.event))return reply(res,400,{error:'bad_event'});
   const tied=binding.get(id);if(!tied)return reply(res,409,{error:'asset_not_bound'});
   // A delayed receipt for an older use of an asset id cannot acknowledge a
   // new event, even if the encrypted bytes and their digest happen to match.
   if(tied.event_id!==body.event)return reply(res,409,{error:'event_mismatch'});
   const row=db.prepare('SELECT received FROM asset_receipts WHERE asset_id=? AND recipient=?').get(id,who.id);
   if(!row)return reply(res,404,{error:'recipient_not_found'});
   db.prepare('UPDATE asset_receipts SET received=CASE WHEN received=0 THEN ? ELSE received END WHERE asset_id=? AND recipient=?').run(t,id,who.id);
   return reply(res,200,{ok:true});
  }
  if(req.method==='GET'){
   const item=db.prepare("SELECT * FROM assets WHERE id=? AND state='complete'").get(id);
   if(!item||!isMember(item.chat,who.id))return reply(res,404,{error:'asset_not_found'});
   const file=path.join(dir,id+'.bin');try{
    let stat;try{stat=await fsp.lstat(file);}catch(e){
     if(e.code!=='ENOENT'||typeof restoreAsset!=='function')throw e;
     await restoreAsset(id,file,item.size,item.sha);stat=await fsp.lstat(file);
    }
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==item.size)return reply(res,503,{error:'storage_unavailable'});
    if(!db.prepare("SELECT id FROM assets WHERE id=? AND state='complete'").get(id))return reply(res,404,{error:'asset_not_found'});
    readers.set(id,(readers.get(id)||0)+1);let held=true;
    const release=()=>{if(!held)return;held=false;const n=(readers.get(id)||1)-1;if(n)readers.set(id,n);else readers.delete(id);};
    const stream=fs.createReadStream(file);stream.on('close',release);stream.on('error',()=>{release();res.destroy();});res.on('close',()=>{stream.destroy();release();});
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':item.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    stream.pipe(res);return;
   }catch{return reply(res,503,{error:'storage_unavailable'});}
  }
  if(req.method!=='PUT')return reply(res,405,{error:'method_not_allowed'});
  const chat=req.headers['x-gplus-chat'],sha=req.headers['x-gplus-sha256'],raw=req.headers['content-length'];
  const size=Number(raw);
  if(!P.validChat(chat)||!P.validEvent(id)||!/^\d+$/.test(raw||'')||!Number.isSafeInteger(size)||size<1||!(/^[0-9a-f]{64}$/.test(sha||'')))return reply(res,400,{error:'bad_upload'});
  if(!isMember(chat,who.id))return reply(res,404,{error:'chat_not_found'});
  let result;try{result=reserve(id,chat,who.id,size,sha);}catch{return reply(res,503,{error:'storage_unavailable'});}
  if(result==='already'){req.resume();return reply(res,200,{id,size,duplicate:true});}
  if(result==='conflict'){req.resume();return reply(res,409,{error:'asset_conflict'});}
  if(result==='full'){req.resume();return reply(res,507,{error:'storage_full'});}
  const temp=path.join(dir,id+'.tmp'),final=path.join(dir,id+'.bin'),hash=crypto.createHash('sha256');let count=0;
  activeUploads++;
  const meter=new Transform({transform(chunk,encoding,cb){count+=chunk.length;if(count>size)return cb(Error('too_large'));hash.update(chunk);cb(null,chunk);}});
  try{
   await pipe(req,meter,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
   if(count!==size||hash.digest('hex')!==sha)throw Error('bad_upload');
   const fd=await fsp.open(temp,'r+');try{await fd.sync();}finally{await fd.close();}
   await fsp.rename(temp,final);try{const d=await fsp.open(dir,'r');try{await d.sync();}finally{await d.close();}}catch{}
   db.prepare("UPDATE assets SET state='complete' WHERE id=? AND state='uploading'").run(id);
   return reply(res,201,{id,size,duplicate:false});
  }catch(e){try{await fsp.unlink(temp);}catch{}try{await fsp.unlink(final);}catch{}db.prepare("DELETE FROM assets WHERE id=? AND state='uploading'").run(id);return reply(res,400,{error:e.message==='bad_upload'?'invalid_digest':'upload_failed'});}
  finally{activeUploads--;}
 };
 // These hooks are called only by the serialized Cloudinary gateway, not from
 // the normal timer. A persisted 'deleting' row survives every restart.
 api.prepareCloudDeletion=()=>{
  if(!cloudManagedDeletion)throw Error('cloud_deletion_not_enabled');const t=now();if(!Number.isSafeInteger(t)||t<=0)return null;
  const pending=db.prepare("SELECT id FROM assets WHERE state='deleting' ORDER BY id").all();
  for(const row of pending){if(!P.validEvent(row.id))throw Error('invalid_asset_id_in_store');if(!readers.has(row.id)&&eligibleAt(row.id,t))return row.id;}
  const candidates=db.prepare(`SELECT a.id,MAX(r.received) AS last FROM assets a
   JOIN asset_bindings b ON b.asset_id=a.id JOIN asset_receipts r ON r.asset_id=a.id
   WHERE a.state='complete' GROUP BY a.id HAVING MIN(r.received)>0 AND MAX(r.received)<=?
   ORDER BY last,a.id LIMIT 64`).all(t-retentionMs);
  for(const row of candidates){if(!P.validEvent(row.id))throw Error('invalid_asset_id_in_store');if(readers.has(row.id)||!eligibleAt(row.id,t))continue;
   if(db.prepare("UPDATE assets SET state='deleting' WHERE id=? AND state='complete'").run(row.id).changes)return row.id;}
  return null;
 };
 api.finishCloudDeletion=async(id)=>{
  if(!cloudManagedDeletion||!P.validEvent(id))throw Error('invalid_cloud_deletion');
  const t=now(),row=db.prepare("SELECT id FROM assets WHERE id=? AND state='deleting'").get(id);
  if(!row||readers.has(id)||!eligibleAt(id,t))throw Error('cloud_deletion_not_ready');
  try{await fsp.unlink(path.join(dir,id+'.bin'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!db.prepare("UPDATE assets SET state='tombstone' WHERE id=? AND state='deleting'").run(id).changes)throw Error('cloud_deletion_conflict');
 };
 api.purgeDelivered=async(limit=64)=>{
  if(cloudManagedDeletion)throw Error('cloud_deletion_requires_gateway');
  if(!Number.isSafeInteger(limit)||limit<1||limit>1024)throw Error('invalid_sweep_limit');
  if(activeSweeps)return 0;activeSweeps++;
  let removed=0;
  try{
   const t=now();if(!Number.isSafeInteger(t)||t<=0)return 0;
   const candidates=db.prepare(`SELECT a.id,MAX(r.received) AS last FROM assets a
    JOIN asset_bindings b ON b.asset_id=a.id JOIN asset_receipts r ON r.asset_id=a.id
    WHERE a.state='complete' GROUP BY a.id HAVING MIN(r.received)>0 AND MAX(r.received)<=?
    ORDER BY last,a.id LIMIT 4096`).all(t-retentionMs);
   for(const row of candidates){
    if(removed>=limit)break;
    const id=row.id;if(!P.validEvent(id))throw Error('invalid_asset_id_in_store');
    if(readers.has(id)||!eligibleAt(id,t))continue;
    if(!db.prepare("UPDATE assets SET state='deleting' WHERE id=? AND state='complete'").run(id).changes)continue;
    let gone=false;
    try{await fsp.unlink(path.join(dir,id+'.bin'));gone=true;}catch(e){if(e.code==='ENOENT')gone=true;}
    if(gone){db.prepare("DELETE FROM assets WHERE id=? AND state='deleting'").run(id);removed++;}
    else db.prepare("UPDATE assets SET state='complete' WHERE id=? AND state='deleting'").run(id);
   }
   return removed;
  }finally{activeSweeps--;}
 };
 api.pendingWrites=()=>activeUploads+activeSweeps;
 api.close=()=>db.close();return api;
}
module.exports={createAssets,DEFAULT_RETENTION_MS};
