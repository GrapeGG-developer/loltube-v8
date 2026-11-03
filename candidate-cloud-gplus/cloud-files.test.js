'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {CloudFiles,SIZE,indexPath,assetBlockPath}=require('./cloud-files'),{digest}=require('./ledger');
class Store{constructor(){this.m=new Map()}async get(k){const v=this.m.get(k);return v?Buffer.from(v):null}async putOnce(k,v){if(this.m.has(k))return false;this.m.set(k,Buffer.from(v));return true}async removeMany(keys){for(const k of keys)this.m.delete(k);}}
const id='aBcD0123_-aBcD0123_-XY';
test('encrypted synthetic media split, restart and exact restoration',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-cloud-file-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const data=crypto.randomBytes(SIZE+77),h=digest(data),source=path.join(dir,'source'),dest=path.join(dir,'dest');await fs.writeFile(source,data);
 const store=new Store();await new CloudFiles(store).publish(id,source,data.length,h);await new CloudFiles(store).restore(id,dest,data.length,h);
 assert.deepEqual(await fs.readFile(dest),data);
 assert.equal(JSON.parse((await store.get(indexPath(id))).toString()).blocks.length,2);
});
test('existing asset id mismatch, local target and missing remote block fail closed',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-cloud-file-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(),files=new CloudFiles(store),data=Buffer.from('synthetic data'),h=digest(data),source=path.join(dir,'source'),dest=path.join(dir,'dest');await fs.writeFile(source,data);
 await files.publish(id,source,data.length,h);await assert.rejects(files.publish(id,source,data.length,'f'.repeat(64)),/asset_conflict/);
 await fs.writeFile(dest,'do not overwrite');await assert.rejects(files.restore(id,dest,data.length,h),/local_asset_exists/);assert.equal((await fs.readFile(dest)).toString(),'do not overwrite');
 store.m.delete(assetBlockPath(id,0,h));await assert.rejects(files.publish(id,source,data.length,h),/asset_block_missing_or_corrupt/);
 await fs.unlink(dest);await assert.rejects(files.restore(id,dest,data.length,h),/asset_block_missing_or_corrupt/);
 assert.equal((await fs.readdir(dir)).filter(x=>x.startsWith('.gplus-restore-')).length,0);
});
test('invalid ids, digest and changed local input do not produce an index',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-cloud-file-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new Store(),files=new CloudFiles(store),file=path.join(dir,'f');await fs.writeFile(file,'actual');
 await assert.rejects(files.publish('../bad',file,6,digest(Buffer.from('actual'))),/invalid_asset/);
 await assert.rejects(files.publish(id,file,6,'0'.repeat(64)),/asset_changed/);
 assert.equal(await store.get(indexPath(id)),null);
});
test('deleting one asset retains another asset and ledger blocks with identical bytes',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gplus-cloud-delete-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const other='ZY_-3210DcBa_-3210DcBa',data=Buffer.from('identical encrypted bytes'),h=digest(data),file=path.join(dir,'source'),dest=path.join(dir,'dest');await fs.writeFile(file,data);
 const store=new Store(),files=new CloudFiles(store);store.m.set('blocks/'+h+'.json',Buffer.from(data));
 await files.publish(id,file,data.length,h);await files.publish(other,file,data.length,h);assert.equal(await files.remove(id),1);assert.equal(await files.remove(id),1);
 assert.equal(await store.get(assetBlockPath(id,0,h)),null);assert.ok(await store.get(indexPath(id)));assert.ok(await store.get('blocks/'+h+'.json'));
 await files.restore(other,dest,data.length,h);assert.deepEqual(await fs.readFile(dest),data);await assert.rejects(files.restore(id,path.join(dir,'deleted'),data.length,h),/asset_block_missing_or_corrupt/);
});
