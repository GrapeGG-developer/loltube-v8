'use strict';
/* Experimental G+ service assembly. Not yet a production release: Cloudinary
 * lacks a confirmed provider-level linearizability SLA, multi-instance fencing
 * and old ledger-block garbage collection are not complete. */
const path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http'),crypto=require('node:crypto');
const {Ledger}=require('./ledger'),{CloudFiles}=require('./cloud-files'),{snapshot,materialize}=require('./snapshot'),{createGateway}=require('./gateway');
const {createGPlus}=require('./app/index');
async function createCloudGPlus({store,dataDir,onFatal=()=>{},maxStorageBytes=5*1024**3,reserveBytes=256*1024**2,previewKey=null,now=Date.now,retentionMs,cleanupIntervalMs=60000}){
 if(!path.isAbsolute(dataDir)||!store||typeof now!=='function'||!Number.isInteger(cleanupIntervalMs)||cleanupIntervalMs<0||!(previewKey===null||typeof previewKey==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(previewKey)))throw Error('invalid_cloud_service');
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});if((await fs.readdir(dataDir)).length)throw Error('runtime_directory_must_be_empty');
 const ledger=new Ledger(store),restored=await ledger.recover();await materialize(dataDir,restored.files);
 const media=new CloudFiles(store),app=createGPlus({dataDir,maxStorageBytes,reserveBytes,restoreAsset:(...a)=>media.restore(...a),cloudManagedDeletion:true,now,...(retentionMs===undefined?{}:{retentionMs})});
 // Local timers must not mutate SQLite outside the serialized durable gateway.
 app.setFrozen(true);
 const gateway=createGateway({ledger,backend:(req,res)=>app(req,res,()=>{res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"not_found"}');}),
  snapshot:()=>snapshot(dataDir),publishAsset:(...a)=>media.publish(...a),dataDir,onFatal});
 let gcTask=null;
 async function cleanupOnce(){
  if(gcTask)return {busy:true};
  gcTask=gateway.maintenance(async checkpoint=>{
   // The app's normal timer is frozen; expiry must also be serialized and
   // checkpointed, or old message rows would accumulate indefinitely.
   if(app.purgeExpiredMessages())await checkpoint();
   const id=app.prepareCloudDeletion();if(!id)return {removed:false};
   await checkpoint(); // durable 'deleting' before any cloud object is removed
   await media.remove(id);await app.finishCloudDeletion(id);await checkpoint();
   return {removed:true};
  });
  try{return await gcTask;}finally{gcTask=null;}
 }
 const gcTimer=cleanupIntervalMs?setInterval(()=>{cleanupOnce().catch(()=>{});},cleanupIntervalMs):null;if(gcTimer)gcTimer.unref();
 function previewAllowed(req){
  if(previewKey===null)return true;
  const supplied=req.headers['x-gplus-preview-key'];if(typeof supplied!=='string'||supplied.length!==previewKey.length||!/^[A-Za-z0-9_-]+$/.test(supplied))return false;
  return crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(previewKey));
 }
 const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(gateway.isHealthy()?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:gateway.isHealthy(),service:'gplus-cloud-experimental'}));}
  if(!previewAllowed(req)){res.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});req.resume();return res.end('{"error":"experimental_access_required"}');}
  const prefix='/gsrv-v1';if((req.url||'').startsWith(prefix+'/'))req.url=req.url.slice(prefix.length);
  gateway(req,res);
 });
 server.on('upgrade',async(req,socket,head)=>{
  try{
   if(!previewAllowed(req)||!gateway.isHealthy()||await ledger.changedExternally())return socket.destroy();
   const prefix='/gsrv-v1';if((req.url||'').startsWith(prefix+'/'))req.url=req.url.slice(prefix.length);
   if(!app.handleUpgrade(req,socket,head))socket.destroy();
  }catch{socket.destroy();}
 });
 async function close(){if(gcTimer)clearInterval(gcTimer);app.closeCalls();await new Promise(resolve=>server.close(resolve));if(gcTask)try{await gcTask;}catch{}app.close();}
 return {server,app,gateway,ledger,cleanupOnce,close};
}
module.exports={createCloudGPlus};
