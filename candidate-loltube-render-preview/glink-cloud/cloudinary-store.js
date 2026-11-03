'use strict';
/* Experimental authenticated raw Cloudinary store for GLINK. No credentials,
 * signed URLs or payloads are logged. This adapter does not prove provider-side
 * linearizability or prevent concurrent-instance races. */
const MAX=8*1024*1024;
class CloudinaryRelayStore{
 constructor({cloudinary,prefix,fetchImpl=globalThis.fetch,timeoutMs=45000}){
  if(!cloudinary||!cloudinary.uploader||!cloudinary.utils||!cloudinary.api||typeof fetchImpl!=='function'||typeof prefix!=='string'||!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)||prefix.length>100||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw Error('invalid_store');
  this.cloud=cloudinary;this.prefix=prefix;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
 }
 id(key){
  if(typeof key!=='string'||!/^relay-index\/[a-f0-9]{64}\.json$|^relay\/[a-f0-9]{64}\/(?:head\.json|(?:revisions|parts)\/[0-9]{6}\.json)$/.test(key))throw Error('invalid_object');
  return this.prefix+'/'+key;
 }
 async get(key){
  const id=this.id(key),url=this.cloud.utils.private_download_url(id,'',{resource_type:'raw',type:'authenticated',expires_at:Math.floor(Date.now()/1000)+120});
  let r;try{r=await this.fetch(url,{signal:AbortSignal.timeout(this.timeoutMs),redirect:'follow',cache:'no-store'});}catch{throw Error('cloud_read_failed');}
  if(r.status===404)return null;if(r.status!==200)throw Error('cloud_read_failed');
  const length=Number(r.headers.get('content-length'));if(Number.isFinite(length)&&length>MAX)throw Error('cloud_object_too_large');
  const reader=r.body?.getReader();if(!reader)throw Error('cloud_read_failed');const chunks=[];let n=0;
  try{for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>MAX)throw Error('cloud_object_too_large');chunks.push(Buffer.from(x.value));}}
  catch(e){try{await reader.cancel();}catch{}throw e;}return Buffer.concat(chunks,n);
 }
 async upload(key,data,overwrite){
  if(!Buffer.isBuffer(data)||data.length<1||data.length>MAX)throw Error('invalid_object');const id=this.id(key);
  let out;try{out=await this.cloud.uploader.upload('data:application/json;base64,'+data.toString('base64'),{resource_type:'raw',type:'authenticated',public_id:id,overwrite,unique_filename:false,invalidate:false,timeout:this.timeoutMs});}catch{throw Error('cloud_write_failed');}
  if(!out||out.public_id!==id||out.resource_type!=='raw'||out.type!=='authenticated')throw Error('cloud_write_failed');
  return !(out.existing===true||out.existing==='true');
 }
 async putOnce(key,data){return this.upload(key,data,false);}
 async replace(key,data){if(!/^relay\/[a-f0-9]{64}\/head\.json$/.test(key))throw Error('invalid_object');await this.upload(key,data,true);}
 async remove(key){
  const id=this.id(key);let out;try{out=await this.cloud.uploader.destroy(id,{resource_type:'raw',type:'authenticated',invalidate:false,timeout:this.timeoutMs});}catch{throw Error('cloud_delete_failed');}
  if(!out||!['ok','not found'].includes(out.result))throw Error('cloud_delete_failed');
 }
 async removeMany(keys){
  if(!Array.isArray(keys)||keys.length<1||keys.length>100)throw Error('invalid_object');const ids=keys.map(k=>this.id(k));
  if(new Set(ids).size!==ids.length)throw Error('invalid_object');let result;
  try{result=await this.cloud.api.delete_resources(ids,{resource_type:'raw',type:'authenticated',invalidate:false});}catch{throw Error('cloud_delete_failed');}
  if(!result||!result.deleted||typeof result.deleted!=='object'||ids.some(id=>!['deleted','not_found','not found'].includes(result.deleted[id])))throw Error('cloud_delete_failed');
 }
 async listMarkers(cursor=null){
  if(cursor!==null&&(typeof cursor!=='string'||cursor.length>2048))throw Error('invalid_cursor');
  let result;try{result=await this.cloud.api.resources({resource_type:'raw',type:'authenticated',prefix:this.prefix+'/relay-index/',max_results:500,...(cursor?{next_cursor:cursor}:{})});}catch{throw Error('cloud_list_failed');}
  if(!result||!Array.isArray(result.resources))throw Error('cloud_list_failed');
  const ids=[];for(const r of result.resources){const prefix=this.prefix+'/relay-index/';if(!r||typeof r.public_id!=='string'||!r.public_id.startsWith(prefix))throw Error('cloud_list_failed');const id=r.public_id.slice(prefix.length).replace(/\.json$/,'');if(!/^[a-f0-9]{64}$/.test(id))throw Error('cloud_list_failed');ids.push(id);}
  return {ids,cursor:result.next_cursor||null};
 }
}
module.exports={CloudinaryRelayStore,MAX};
