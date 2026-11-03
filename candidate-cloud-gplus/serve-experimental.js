'use strict';
// Opt-in experimental server, NOT a production release. See README.md.
// Never print credentials, Cloudinary URLs, data or request bodies.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const cloud=require('cloudinary').v2,{CloudinaryStore}=require('./cloudinary-store'),{createCloudGPlus}=require('./bootstrap');
(async()=>{
 if(process.env.GPLUS_EXPERIMENTAL!=='1')throw Error('experiment_not_enabled');
 const {CLOUDINARY_CLOUD_NAME:name,CLOUDINARY_API_KEY:key,CLOUDINARY_API_SECRET:secret,GPLUS_CLOUD_PREFIX:prefix}=process.env;
 if(!name||!key||!secret||!/^gplus-experimental-[a-z0-9-]{8,64}$/.test(prefix||''))throw Error('invalid_experimental_configuration');
 cloud.config({cloud_name:name,api_key:key,api_secret:secret,secure:true});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gplus-cloud-runtime-'));
 const store=new CloudinaryStore({cloudinary:cloud,prefix});let shutting=false,svc;
 const fatal=()=>{if(shutting)return;shutting=true;setTimeout(()=>process.exit(1),1000).unref();};
 svc=await createCloudGPlus({store,dataDir:dir,maxStorageBytes:64*1024*1024,reserveBytes:128*1024*1024,onFatal:fatal});
 svc.server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('gplus-cloud-experimental listening'));
 const stop=()=>{if(shutting)return;shutting=true;svc.close().then(()=>process.exit(0),()=>process.exit(1));setTimeout(()=>process.exit(1),55000).unref();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
})().catch(()=>{console.error('gplus-cloud-experimental failed to start');process.exitCode=1;});
