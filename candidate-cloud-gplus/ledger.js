'use strict';
/* Immutable, content-addressed snapshot ledger for a single logical G+ store.
 * This component alone does not make the G+ HTTP server durable. It needs
 * serialized transactions, SQLite checkpoints, asset persistence and fencing.
 * Never point it at the LOLTUBE namespace. No automatic deletion is performed. */
const crypto = require('node:crypto');
const BLOCK = 64 * 1024, MAX_FILE = 512 * 1024 * 1024, MAX_SCAN = 10000;
const FILES = new Set(['accounts-v1.json', 'gplus-messages.sqlite3', 'gplus-assets.sqlite3']);
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const seqPath = n => 'revisions/' + String(n).padStart(16, '0') + '.json';
const blockPath = h => 'blocks/' + h + '.json';
const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function parseRevision(raw, expected, parent) {
  if (!Buffer.isBuffer(raw) || raw.length > 4 * 1024 * 1024) throw Error('invalid_revision');
  let r; try { r=JSON.parse(raw.toString('utf8')); } catch { throw Error('invalid_revision'); }
  if (!r || r.v!==1 || r.seq!==expected || r.parent!==parent || !/^[0-9a-f]{32}$/.test(r.commit||'') ||
      !r.files || typeof r.files!=='object' || Array.isArray(r.files) || Object.keys(r.files).some(k=>!FILES.has(k))) throw Error('invalid_revision');
  for (const f of Object.values(r.files)) {
    if (!f || !Number.isSafeInteger(f.size) || f.size<0 || f.size>MAX_FILE || !isHash(f.sha256) || !Array.isArray(f.blocks)) throw Error('invalid_revision');
    let total=0;
    for (let i=0;i<f.blocks.length;i++) {
      const b=f.blocks[i];if(!b || !isHash(b.sha256) || !Number.isInteger(b.size) || b.size<1 || b.size>BLOCK || (i<f.blocks.length-1 && b.size!==BLOCK))throw Error('invalid_revision');
      total+=b.size;if(total>MAX_FILE)throw Error('invalid_revision');
    }
    if(total!==f.size || (f.size===0 && f.blocks.length!==0))throw Error('invalid_revision');
  }
  return r;
}
class Conflict extends Error { constructor(){super('revision_conflict');this.name='RevisionConflict';} }
class Ledger {
  constructor(store) {
    if(!store || typeof store.get!=='function' || typeof store.putOnce!=='function' || typeof store.setHead!=='function')throw Error('invalid_store');
    this.store=store;this.seq=0;this.tip='';this.files={};this.known=new Set();
  }
  async _revision(n,parent) {
    const raw=await this.store.get(seqPath(n));if(raw===null)return null;
    const revision=parseRevision(raw,n,parent);return {raw,revision,hash:digest(raw)};
  }
  async recover() {
    // The mutable head is only a hint. Validate it and scan immutable revisions
    // forward, so a delayed head update cannot hide a committed transaction.
    let seq=0,tip='',last=null;
    const headRaw=await this.store.get('head.json');
    if(headRaw!==null) {
      let h;try{h=JSON.parse(headRaw.toString('utf8'));}catch{throw Error('invalid_head');}
      if(!h||h.v!==1||!Number.isSafeInteger(h.seq)||h.seq<1||!isHash(h.sha256))throw Error('invalid_head');
      const raw=await this.store.get(seqPath(h.seq));if(!raw||digest(raw)!==h.sha256)throw Error('invalid_head');
      let claimed;try{claimed=JSON.parse(raw.toString('utf8'));}catch{throw Error('invalid_revision');}
      const parent=h.seq===1?'':claimed.parent;
      if(h.seq>1) {
        if(!isHash(parent))throw Error('invalid_revision');
        const before=await this.store.get(seqPath(h.seq-1));if(!before||digest(before)!==parent)throw Error('invalid_revision');
      }
      last=parseRevision(raw,h.seq,parent);seq=h.seq;tip=h.sha256;
    }
    for(let steps=0;steps<=MAX_SCAN;steps++) {
      const found=await this._revision(seq+1,tip);
      if(!found)break;
      if(steps===MAX_SCAN)throw Error('revision_scan_limit');
      seq++;tip=found.hash;last=found.revision;
    }
    const restored={};const known=new Set();
    if(last)for(const [name,f] of Object.entries(last.files)) {
      const parts=[];
      for(const b of f.blocks) {
        const content=await this.store.get(blockPath(b.sha256));
        if(!Buffer.isBuffer(content)||content.length!==b.size||digest(content)!==b.sha256)throw Error('missing_or_corrupt_block');
        parts.push(content);known.add(b.sha256);
      }
      const body=Buffer.concat(parts);if(body.length!==f.size||digest(body)!==f.sha256)throw Error('snapshot_checksum_mismatch');
      restored[name]=body;
    }
    this.seq=seq;this.tip=tip;this.files=restored;this.known=known;return {seq,files:restored};
  }
  async changedExternally() { return (await this._revision(this.seq+1,this.tip)) !== null; }
  async commit(files) {
    if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).some(x=>!FILES.has(x)))throw Error('invalid_snapshot');
    const newFiles={},newKnown=new Set();
    for(const [name,body] of Object.entries(files)) {
      if(!Buffer.isBuffer(body)||body.length>MAX_FILE)throw Error('invalid_snapshot');
      const blocks=[];
      for(let at=0;at<body.length;at+=BLOCK) {
        const chunk=body.subarray(at,Math.min(body.length,at+BLOCK)),hash=digest(chunk);
        if(!this.known.has(hash)) {
          try { await this.store.putOnce(blockPath(hash),chunk); } catch(e) {
            const after=await this.store.get(blockPath(hash));if(!after || digest(after)!==hash)throw e;
          }
          const stored=await this.store.get(blockPath(hash));
          if(!Buffer.isBuffer(stored)||stored.length!==chunk.length||digest(stored)!==hash)throw Error('block_verification_failed');
        }
        newKnown.add(hash);blocks.push({sha256:hash,size:chunk.length});
      }
      newFiles[name]={size:body.length,sha256:digest(body),blocks};
    }
    const revision={v:1,seq:this.seq+1,parent:this.tip,commit:crypto.randomBytes(16).toString('hex'),files:newFiles};
    const raw=Buffer.from(JSON.stringify(revision));parseRevision(raw,this.seq+1,this.tip);
    let inserted;
    try { inserted=await this.store.putOnce(seqPath(revision.seq),raw); }
    catch(e) {
      const actual=await this.store.get(seqPath(revision.seq));
      if(!actual || !actual.equals(raw))throw e;
      inserted=true; // request succeeded but its response was lost
    }
    if(!inserted) {
      const existing=await this.store.get(seqPath(revision.seq));
      if(!existing || !existing.equals(raw))throw new Conflict();
    }
    const stored=await this.store.get(seqPath(revision.seq));
    if(!stored || !stored.equals(raw))throw Error('revision_verification_failed');
    this.seq=revision.seq;this.tip=digest(raw);this.files={...files};this.known=newKnown;
    // A failed or stale head never establishes authority and does not affect success.
    try { await this.store.setHead(Buffer.from(JSON.stringify({v:1,seq:this.seq,sha256:this.tip}))); } catch {}
    return {seq:this.seq,sha256:this.tip};
  }
}
module.exports={Ledger,Conflict,BLOCK,seqPath,blockPath,digest};
