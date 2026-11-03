'use strict';
/* Separate GLINK + G+ experimental backend. It never reads or writes LOLTUBE's
 * database or media namespace. One Render instance only; do not run concurrent
 * public writers. Preview credentials and Cloudinary secrets remain in env. */
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const cloudinary=require('cloudinary').v2;
const {CloudinaryRelayStore}=require('./cloudinary-store');
const {CloudinaryStore}=require('../gplus-cloud/cloudinary-store');
const {createCloudRouter}=require('../loltube-combined/cloud-router');
const mode=process.env.GLINK_CLOUD_MODE||'preview',previewKey=process.env.GPLUS_PREVIEW_KEY||'',labPrefix=process.env.GPLUS_CLOUD_PREFIX||'';
if(!['preview','public'].includes(mode))throw Error('invalid_cloud_mode');
if(mode==='preview'&&(process.env.GPLUS_EXPERIMENTAL!=='1'||!/^gplus-experimental-[a-f0-9]{16,64}$/.test(labPrefix)||!/^[A-Za-z0-9_-]{32,128}$/.test(previewKey)))throw Error('invalid_preview');
if(!process.env.CLOUDINARY_CLOUD_NAME||!process.env.CLOUDINARY_API_KEY||!process.env.CLOUDINARY_API_SECRET)throw Error('cloud_configuration_missing');
cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});
const prefix=mode==='preview'?labPrefix+'/standalone':'glink-gplus-standalone-v1';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glink-gplus-runtime-'));
function allowed(req){if(mode==='public')return true;const s=req.headers['x-gplus-preview-key'];return typeof s==='string'&&s.length===previewKey.length&&/^[A-Za-z0-9_-]+$/.test(s)&&crypto.timingSafeEqual(Buffer.from(s),Buffer.from(previewKey));}
function json(res,status,data){const b=Buffer.from(JSON.stringify(data));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(b);}
let router=null;
const server=http.createServer((req,res)=>{
 try{
  const p=new URL(req.url,'http://local').pathname;
  if(p==='/health'&&req.method==='GET')return json(res,router&&router.healthy()?200:503,{ok:!!router&&router.healthy(),service:'glink-gplus-experimental',mode});
  if(!allowed(req)){req.resume();return json(res,403,{error:'experimental_access_required'});}
  if(!router||!router.healthy()){req.resume();return json(res,503,{error:'cloud_unavailable'});}
  if(p==='/'&&req.method==='GET')return json(res,200,{service:'GLINK / G+',gplus:'EXP',web:'/gsrv-v1/glink/send'});
  return router.handler(req,res,()=>{req.resume();json(res,404,{error:'not_found'});});
 }catch(_){if(!res.headersSent&&!res.writableEnded)json(res,500,{error:'internal_error'});else res.destroy();}
});
server.on('upgrade',async(req,socket,head)=>{try{if(!allowed(req)||!router||!router.healthy())return socket.destroy();if(!await router.handleUpgrade(req,socket,head))socket.destroy();}catch(_){socket.destroy();}});
(async()=>{
 router=await createCloudRouter({
  relayStore:new CloudinaryRelayStore({cloudinary,prefix:prefix+'/relay'}),
  offersStore:new CloudinaryStore({cloudinary,prefix:prefix+'/offers'}),
  gplusStore:new CloudinaryStore({cloudinary,prefix:prefix+'/gplus'}),
  dataDir:dir,webDir:path.join(__dirname,'../glink-web'),
  maxStorageBytes:1024*1024*1024,reserveBytes:256*1024*1024,cleanupIntervalMs:60000,
  onFatal:()=>console.error('cloud_storage_fenced_restart_required')
 });
 // Expired completed GLINK sessions are pruned only in their own namespace;
 // incomplete uploads are deliberately preserved for resume.
 const gc=setInterval(()=>{router.relay.sweep().catch(()=>console.error('glink_gc_failed'));},60000);gc.unref();
 server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('GLINK and G+ experimental backend listening'));
 const stop=()=>{clearInterval(gc);server.close(()=>{router.close().finally(()=>process.exit(0));});setTimeout(()=>process.exit(1),25000).unref();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
})().catch(()=>{console.error('cloud_startup_failed');process.exitCode=1;});
