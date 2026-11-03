'use strict';
const {createAuth}=require('./auth');const {createMessages}=require('./messages');const {createAssets}=require('./assets');const {createCallRelay}=require('./call-relay');
/** Mount before body parsers and SPA fallback. Single process only. */
function createGPlus({dataDir,maxStorageBytes=0,reserveBytes=0,restoreAsset=null,cloudManagedDeletion=false,now=Date.now,retentionMs}={}){
 const auth=createAuth({dataDir,now});
 const messages=createMessages({dataDir,authenticate:auth.authenticate,lookup:auth.lookup,now});
 const assets=createAssets({dataDir,authenticate:auth.authenticate,isMember:messages.isMember,eventRecipients:messages.assetRecipients,maxStorageBytes,reserveBytes,restoreAsset,cloudManagedDeletion,now,...(retentionMs===undefined?{}:{retentionMs})});
 const calls=createCallRelay({authenticate:auth.authenticate,isDirectMember:messages.isDirectMember});
 let sweepSuspended=false;
 // Message TTL is explicit; media cleanup requires a binding to a signed event
 // and receipts from every intended recipient, then a 30-day grace period.
 const sweep=setInterval(()=>{
  if(sweepSuspended)return;
  try{messages.purgeExpired();}catch(_){console.error('G+ message expiry cleanup failed');}
  assets.purgeDelivered().catch(()=>console.error('G+ media cleanup failed; it will be retried'));
 },60000);sweep.unref();
 let activeOperations=0;
 const handler=function(req,res,next){
  activeOperations++;
  Promise.resolve().then(()=>assets(req,res,()=>messages(req,res,()=>auth(req,res,next)))).catch(e=>{
   console.error('G+ request error:',e.message);if(!res.headersSent){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"internal_error"}');}else res.destroy();
  }).finally(()=>{activeOperations--;});
 };
 handler.pendingOperations=()=>activeOperations+assets.pendingWrites();
 handler.setFrozen=value=>{sweepSuspended=!!value;};
 handler.purgeDelivered=()=>assets.purgeDelivered();handler.purgeExpiredMessages=()=>messages.purgeExpired();
 handler.prepareCloudDeletion=()=>assets.prepareCloudDeletion();handler.finishCloudDeletion=id=>assets.finishCloudDeletion(id);
 handler.handleUpgrade=calls.handleUpgrade;handler.closeCalls=()=>calls.close();
 handler.close=()=>{clearInterval(sweep);calls.close();assets.close();messages.close();};return handler;
}
module.exports={createGPlus};
