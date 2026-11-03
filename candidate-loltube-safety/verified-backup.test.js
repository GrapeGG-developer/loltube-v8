'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{commitVerified,requireVerifiedBackup}=require('./verified-backup');
const good=Buffer.from('{"users":[],"videos":[],"history":[]}');
test('successful write is read back and verified byte-for-byte',async()=>{
 let current;const store={replace:async b=>{current=Buffer.from(b)},read:async()=>current};
 const r=await commitVerified(store,good);assert.equal(r.wasAmbiguous,false);assert.deepEqual(await requireVerifiedBackup(store),good);
});
test('ambiguous write success is accepted only after exact readback',async()=>{
 let current;const store={replace:async b=>{current=Buffer.from(b);throw Error('timeout')},read:async()=>current};
 assert.equal((await commitVerified(store,good)).wasAmbiguous,true);
});
test('unavailable, invalid or mismatching data fail closed',async()=>{
 await assert.rejects(commitVerified({replace:async()=>{},read:async()=>Buffer.from('old')},good),/backup_verification_failed/);
 await assert.rejects(requireVerifiedBackup({read:async()=>{throw Error('down')}}),/backup_unavailable/);
 await assert.rejects(requireVerifiedBackup({read:async()=>Buffer.from('{}')}),/invalid_backup/);
 await assert.rejects(commitVerified({replace:async()=>{},read:async()=>null},Buffer.from('not json')),/invalid_backup/);
});
