'use strict';
/* LAB ONLY. Manual first-import fence for a new LOLTUBE instance. The caller
 * MUST start in maintenance, independently verify that every legacy writer has
 * exited, and authorize only after the final legacy backup has been captured.
 * A correctly authenticated request cannot itself prove writer quiescence or
 * provider CAS. No credentials, backup contents or proof values are logged. */
const crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const mac=(secret,nonce,digest)=>crypto.createHmac('sha256',secret).update('LOLTUBE-CUTOVER-V1\0'+nonce+'\0'+digest,'utf8').digest();
class ManualCutover {
 constructor({secret,ledger,readLegacy,onReady,random=()=>crypto.randomBytes(32),now=Date.now}){
  if(typeof secret!=='string'||secret.length<16||!ledger||typeof ledger.recover!=='function'||typeof ledger.importOnce!=='function'||typeof readLegacy!=='function'||typeof onReady!=='function'||typeof random!=='function'||typeof now!=='function')throw Error('invalid_cutover');
  this.secret=secret;this.ledger=ledger;this.readLegacy=readLegacy;this.onReady=onReady;this.now=now;this.state='new';this.pending=false;this.attempts=[];
  const n=random();if(!Buffer.isBuffer(n)||n.length!==32)throw Error('invalid_cutover_nonce');this.nonce=n.toString('base64url');
 }
 status(){return {state:this.state,...(this.state==='awaiting'?{nonce:this.nonce}:{})};}
 async start(){
  if(this.state!=='new')throw Error('invalid_state');this.state='recovering';
  try{const restored=await this.ledger.recover();if(restored===null){this.state='awaiting';return this.status();}
   if(!Buffer.isBuffer(restored))throw Error('invalid_snapshot');await this.onReady(restored);this.state='ready';return this.status();
  }catch(e){this.state='failed';throw e;}
 }
 async unlock({digest,proof}={}){
  if(this.state!=='awaiting'||this.pending)throw Error('cutover_not_available');
  const now=this.now();this.attempts=this.attempts.filter(t=>now-t<60000);if(this.attempts.length>=10)throw Error('cutover_rate_limited');this.attempts.push(now);
  if(typeof digest!=='string'||!/^[0-9a-f]{64}$/.test(digest)||typeof proof!=='string'||!/^[0-9a-f]{64}$/.test(proof))throw Error('cutover_unauthorized');
  const wanted=mac(this.secret,this.nonce,digest),provided=Buffer.from(proof,'hex');if(!crypto.timingSafeEqual(wanted,provided))throw Error('cutover_unauthorized');
  this.pending=true;
  try{
   const first=await this.readLegacy(),second=await this.readLegacy();
   if(!Buffer.isBuffer(first)||!Buffer.isBuffer(second)||hash(first)!==digest||!first.equals(second))throw Error('legacy_backup_changed');
   await this.ledger.importOnce(first);
   const recovered=await this.ledger.recover();if(!Buffer.isBuffer(recovered)||!recovered.equals(first))throw Error('ledger_readback_mismatch');
   await this.onReady(recovered);this.state='ready';return {ok:true};
  }catch(e){
   // If initial import may have committed, never retry in this process: only a
   // fresh recovery can discover the authoritative revision after an error.
   if(!['legacy_backup_changed','cutover_unauthorized'].includes(e.message))this.state='failed';
   throw e;
  }finally{this.pending=false;}
 }
}
module.exports={ManualCutover,mac,hash};
