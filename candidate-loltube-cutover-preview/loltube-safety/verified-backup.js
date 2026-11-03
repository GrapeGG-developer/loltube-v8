'use strict';
/* Experimental LOLTUBE backup verifier. The store API must be scoped to the
 * owner-provided authenticated raw object. Does not solve multi-instance fencing. */
const crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(raw){
 if(!Buffer.isBuffer(raw)||raw.length<2||raw.length>10*1024*1024)throw Error('invalid_backup');
 let db;try{db=JSON.parse(raw.toString('utf8'));}catch{throw Error('invalid_backup');}
 if(!db||!Array.isArray(db.users)||!Array.isArray(db.videos))throw Error('invalid_backup');return db;
}
async function commitVerified(store,raw){
 if(!store||typeof store.replace!=='function'||typeof store.read!=='function')throw Error('invalid_store');validate(raw);const wanted=hash(raw);
 let uploadError=null;try{await store.replace(raw);}catch(e){uploadError=e;}
 let downloaded;try{downloaded=await store.read();}catch{throw Error('backup_verification_failed');}
 if(!Buffer.isBuffer(downloaded)||downloaded.length!==raw.length||hash(downloaded)!==wanted)throw Error('backup_verification_failed');
 // If upload returned an error but exact bytes are durable, it was an ambiguous
 // response or the same content already existed. Never surface provider details.
 return {sha256:wanted,wasAmbiguous:!!uploadError};
}
async function requireVerifiedBackup(store){
 if(!store||typeof store.read!=='function')throw Error('invalid_store');
 let raw;try{raw=await store.read();}catch{throw Error('backup_unavailable');}
 validate(raw);return raw;
}
module.exports={commitVerified,requireVerifiedBackup,validate};
