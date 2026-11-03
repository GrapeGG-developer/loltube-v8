'use strict';
/* Experimental durable wrapper for GLINK Wi-Fi v2 offers. Session tokens,
 * challenges and presence are intentionally ephemeral; only encrypted offers
 * are snapshotted. Requires exclusive logical writer and provider fencing. */
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const {Ledger}=require('../gplus-cloud/ledger'),{createDurableGate}=require('../loltube-safety/durable-gate'),{createDeviceV2}=require('./device-v2');
const fileName='wifi-offers-v2.json',ledgerName='accounts-v1.json';
async function createOffers({store,dataDir,onFatal=()=>{},maxQueue=100}){
 if(!path.isAbsolute(dataDir)||!store||typeof onFatal!=='function')throw Error('invalid_offers');
 await fsp.mkdir(dataDir,{recursive:true,mode:0o700});const offerFile=path.join(dataDir,fileName);
 try{await fsp.lstat(offerFile);throw Error('runtime_file_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const ledger=new Ledger(store),restored=await ledger.recover(),raw=restored.files[ledgerName];
 if(raw){if(raw.length>4*1024*1024)throw Error('offer_file_too_large');const fh=await fsp.open(offerFile,'wx',0o600);try{await fh.writeFile(raw);await fh.sync();}finally{await fh.close();}}
 let fatal=false;const fail=()=>{if(fatal)return;fatal=true;onFatal();};
 const gate=createDurableGate({snapshot:async()=>fsp.readFile(offerFile),commit:async bytes=>ledger.commit({[ledgerName]:bytes}),onFatal:fail,maxQueue});
 const device=createDeviceV2({offerFile,onMutation:()=>gate.markMutation()});
 const known=p=>p==='/glink/device/challenge'||p==='/glink/device/auth'||p==='/glink/presence'||p==='/glink/devices'||p==='/glink/offer'||p.startsWith('/glink/offers/')||p==='/glink/offer-ack';
 function handler(req,res,next){
  let pathname;try{pathname=new URL(req.url,'http://relay.local').pathname;}catch{return next();}if(!known(pathname))return next();
  gate(req,res,()=>{
   (async()=>{
    try{if(fatal||await ledger.changedExternally())throw Error('conflict');if(!device.handle(req,res))throw Error('unknown_route');}
    catch{if(!res.destroyed&&!res.writableEnded){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end('{"error":"storage_unavailable"}');}fail();}
   })();
  });
 }
 handler.healthy=()=>gate.isHealthy()&&!fatal;handler.ledger=ledger;handler.pending=()=>gate.pending();return handler;
}
module.exports={createOffers};
