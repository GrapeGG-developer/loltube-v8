'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CloudinaryStore}=require('./cloudinary-store');
function fixture(){
 const files=new Map();let status=null,uploads=0;
 const cloud={utils:{private_download_url(id){return 'https://fake.invalid/'+encodeURIComponent(id);}},uploader:{
  async upload(source,o){uploads++;const body=Buffer.from(source.split(',')[1],'base64');const had=files.has(o.public_id);if(!had||o.overwrite)files.set(o.public_id,body);return {public_id:o.public_id,resource_type:'raw',type:'authenticated',existing:had&&!o.overwrite};}
 }};
 async function fetcher(u){const id=decodeURIComponent(u.split('/').pop()),body=files.get(id);const code=status||(!body?404:200);return new Response(code===200?body:null,{status:code});}
 return {store:new CloudinaryStore({cloudinary:cloud,prefix:'gplus-test/ns',fetchImpl:fetcher}),files,fail(code){status=code;},get uploads(){return uploads;}};
}
test('private raw objects retain first bytes and head is replaceable',async()=>{
 const f=fixture(),key='blocks/'+'a'.repeat(64)+'.json';assert.equal(await f.store.get(key),null);
 assert.equal(await f.store.putOnce(key,Buffer.from('first')),true);assert.equal(await f.store.putOnce(key,Buffer.from('other')),false);
 assert.equal((await f.store.get(key)).toString(),'first');await f.store.setHead(Buffer.from('one'));await f.store.setHead(Buffer.from('two'));
 assert.equal((await f.store.get('head.json')).toString(),'two');
});
test('only 404 is missing; errors, traversal and arbitrary names fail closed',async()=>{
 const f=fixture();f.fail(503);await assert.rejects(f.store.get('head.json'),/cloud_read_failed/);
 await assert.rejects(f.store.get('../loltube/db.json'),/invalid_cloud_object/);
 await assert.rejects(f.store.putOnce('other.json',Buffer.from('bad')),/invalid_cloud_object/);
 assert.equal(f.uploads,0);
});
test('corrupt SDK response and upload errors do not echo sensitive details',async()=>{
 const cloud={utils:{private_download_url(){return 'https://fake.invalid/';}},uploader:{async upload(){throw Error('sensitive-provider-response');}}};
 const s=new CloudinaryStore({cloudinary:cloud,prefix:'safe',fetchImpl:async()=>new Response(null,{status:404})});
 await assert.rejects(s.putOnce('revisions/0000000000000001.json',Buffer.from('x')),e=>e.message==='cloud_write_failed');
});
