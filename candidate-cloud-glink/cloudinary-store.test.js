'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {CloudinaryRelayStore}=require('./cloudinary-store');
const id='a'.repeat(64),key=`relay/${id}/parts/000000.json`,prefix='glink-synthetic';
function setup(){const data=new Map(),cloud={utils:{private_download_url:(id)=>id},uploader:{
 async upload(dataUrl,o){const body=Buffer.from(dataUrl.split(',')[1],'base64');if(!o.overwrite&&data.has(o.public_id))return {public_id:o.public_id,resource_type:'raw',type:'authenticated',existing:true};data.set(o.public_id,body);return {public_id:o.public_id,resource_type:'raw',type:'authenticated'};},
 async destroy(id){const existed=data.delete(id);return {result:existed?'ok':'not found'};}
 },api:{async resources(opts){return {resources:[...data.keys()].filter(k=>k.startsWith(opts.prefix)).map(public_id=>({public_id}))};},async delete_resources(ids){return {deleted:Object.fromEntries(ids.map(id=>[id,data.delete(id)?'deleted':'not_found']))};}}};
 const fetchImpl=async url=>data.has(url)?new Response(data.get(url),{status:200}):new Response(null,{status:404});return {data,store:new CloudinaryRelayStore({cloudinary:cloud,prefix,fetchImpl})};}
test('put-once, authenticated read and narrow deletes',async()=>{
 const {store}=setup();assert.equal(await store.get(key),null);assert.equal(await store.putOnce(key,Buffer.from('one')),true);assert.equal(await store.putOnce(key,Buffer.from('two')),false);
 assert.equal((await store.get(key)).toString(),'one');await assert.rejects(store.replace(key,Buffer.from('three')),/invalid_object/);await store.removeMany([key]);assert.equal(await store.get(key),null);await store.remove(key);
});
test('only strictly scoped relay identifiers are accepted',async()=>{
 const {store}=setup();for(const k of ['../loltube/db.json','relay/not-a-hash/head.json',`relay/${id}/parts/0.json`,`relay/${id}/other.json`])await assert.rejects(store.get(k),/invalid_object/);
 assert.throws(()=>new CloudinaryRelayStore({cloudinary:{},prefix:'../loltube'}),/invalid_store/);
});
test('list returns only synthetic relay marker IDs',async()=>{
 const {store}=setup();await store.putOnce(`relay-index/${id}.json`,Buffer.from('{}'));assert.deepEqual((await store.listMarkers()).ids,[id]);
});
