'use strict';
/* Experimental G+ service assembly. Not enabled in production or deployable as
 * a release: the Cloudinary adapter has no provider-level linearizability SLA,
 * and remote media/ledger garbage collection is not implemented. */
const path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http'),crypto=require('node:crypto');
const {Ledger}=require('./ledger'),{CloudFiles}=require('./cloud-files'),{snapshot,materialize}=require('./snapshot'),{createGateway}=require('./gateway');
const {createGPlus}=require('./app/index');
async function createCloudGPlus({store,dataDir,onFatal=()=>{},maxStorageBytes=5*1024**3,reserveBytes=256*1024**2,previewKey=null}){
 if(!path.isAbsolute(dataDir)||!store||!(previewKey===null||typeof previewKey==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(previewKey)))throw Error('invalid_cloud_service');
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});if((await fs.readdir(dataDir)).length)throw Error('runtime_directory_must_be_empty');
 const ledger=new Ledger(store),restored=await ledger.recover();await materialize(dataDir,restored.files);
 const media=new CloudFiles(store),app=createGPlus({dataDir,maxStorageBytes,reserveBytes,restoreAsset:(...a)=>media.restore(...a)});
 // Do not remove history or media until Cloudinary retention/GC is transactional.
 app.setFrozen(true);
 const gateway=createGateway({ledger,backend:(req,res)=>app(req,res,()=>{res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"not_found"}');}),
  snapshot:()=>snapshot(dataDir),publishAsset:(...a)=>media.publish(...a),dataDir,onFatal});
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
 async function close(){app.closeCalls();await new Promise(resolve=>server.close(resolve));app.close();}
 return {server,app,gateway,ledger,close};
}
module.exports={createCloudGPlus};
