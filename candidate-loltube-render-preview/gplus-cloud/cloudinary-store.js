'use strict';
/* Cloudinary raw/authenticated adapter for the experimental immutable ledger.
 * Never logs credentials, signed URLs or payloads. A 404 alone means missing;
 * all other remote failures are errors. Only a dedicated prefix is supported. */
class CloudinaryStore {
 constructor({cloudinary,prefix,fetchImpl=globalThis.fetch,timeoutMs=30000}) {
  if(!cloudinary||!cloudinary.uploader||!cloudinary.utils||typeof fetchImpl!=='function'||
     typeof prefix!=='string'||!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)||prefix.length>160||
     !Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw Error('invalid_cloud_store');
  this.cloud=cloudinary;this.prefix=prefix;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
 }
 _id(name) {
  if(typeof name!=='string'||!/^((?:revisions\/[0-9]{16}|blocks\/[0-9a-f]{64}|assets\/[A-Za-z0-9_-]{22}\/index|assets\/[A-Za-z0-9_-]{22}\/blocks\/[0-9]{6}-[0-9a-f]{64})\.json|head\.json)$/.test(name))throw Error('invalid_cloud_object');
  return this.prefix+'/'+name;
 }
 async get(name) {
  const id=this._id(name),url=this.cloud.utils.private_download_url(id,'',{resource_type:'raw',type:'authenticated',expires_at:Math.floor(Date.now()/1000)+120});
  let response;try{response=await this.fetch(url,{signal:AbortSignal.timeout(this.timeoutMs),redirect:'follow',cache:'no-store'});}catch{throw Error('cloud_read_failed');}
  if(response.status===404)return null;
  if(response.status!==200)throw Error('cloud_read_failed');
  const size=Number(response.headers.get('content-length'));
  if(Number.isFinite(size)&&size>4*1024*1024)throw Error('cloud_object_too_large');
  const reader=response.body?.getReader();if(!reader)throw Error('cloud_read_failed');
  const parts=[];let total=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>4*1024*1024)throw Error('cloud_object_too_large');parts.push(Buffer.from(value));} }
  catch(e){try{await reader.cancel();}catch{}throw e;}
  return Buffer.concat(parts,total);
 }
 async _upload(name,data,overwrite) {
  if(!Buffer.isBuffer(data)||data.length>4*1024*1024)throw Error('invalid_cloud_object');
  const id=this._id(name),source='data:application/json;base64,'+data.toString('base64');
  let result;try{result=await this.cloud.uploader.upload(source,{public_id:id,resource_type:'raw',type:'authenticated',overwrite,unique_filename:false,invalidate:false,timeout:this.timeoutMs});}catch{throw Error('cloud_write_failed');}
  if(!result||result.public_id!==id||result.resource_type!=='raw'||result.type!=='authenticated')throw Error('cloud_write_failed');
  return !(result.existing===true||result.existing==='true');
 }
 async putOnce(name,data) { return this._upload(name,data,false); }
 async setHead(data) { await this._upload('head.json',data,true); }
 async removeMany(names) {
  if(!this.cloud.api||typeof this.cloud.api.delete_resources!=='function'||!Array.isArray(names)||names.length<1||names.length>100||names.some(n=>!/^assets\/[A-Za-z0-9_-]{22}\/blocks\/[0-9]{6}-[0-9a-f]{64}\.json$/.test(n)))throw Error('invalid_cloud_delete');
  const ids=names.map(n=>this._id(n));if(new Set(ids).size!==ids.length)throw Error('invalid_cloud_delete');
  let out;try{out=await this.cloud.api.delete_resources(ids,{resource_type:'raw',type:'authenticated',invalidate:false});}catch{throw Error('cloud_delete_failed');}
  if(!out||!out.deleted||typeof out.deleted!=='object'||ids.some(id=>!['deleted','not_found','not found'].includes(out.deleted[id])))throw Error('cloud_delete_failed');
 }
}
module.exports={CloudinaryStore};
