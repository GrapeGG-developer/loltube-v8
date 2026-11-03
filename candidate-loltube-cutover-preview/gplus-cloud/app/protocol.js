'use strict';
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const SIGN_DOMAIN = Buffer.from('G+ SIGNATURE v1\0');
const CONTACT_DOMAIN = Buffer.from('G+ CONTACT v1\0');
const MESSAGE_DOMAIN = Buffer.from('G+ MESSAGE v1\0');
const BOX_DOMAIN = Buffer.from('G+ BOX v1\0');
const DIRECT_DOMAIN = Buffer.from('G+ DIRECT v1\0');
const GROUP_DOMAIN = Buffer.from('G+ GROUP v1\0');
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{4}(?:-[A-Za-z0-9_-]{4}){3}$/.test(s);
const validChat = s => typeof s === 'string' && /^[dgc]_[A-Za-z0-9_-]{22,43}$/.test(s);
const validEvent = s => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);
function b64(v, max = 200000) {
  if(typeof v!=='string'||v.length>max||!/^[A-Za-z0-9_-]+$/.test(v))throw Error('bad encoding');
  const b=Buffer.from(v,'base64url');if(b.toString('base64url')!==v)throw Error('noncanonical');return b;
}
function pack(domain,...values) {
  const out=[domain];for(const value of values){const b=Buffer.isBuffer(value)?value:Buffer.from(value,'utf8');const n=Buffer.alloc(4);n.writeUInt32BE(b.length);out.push(n,b);}return Buffer.concat(out);
}
function hash(v){return crypto.createHash('sha256').update(v).digest();}
function id(pub){const s=hash(pub).subarray(0,12).toString('base64url');return [0,4,8,12].map(i=>s.slice(i,i+4)).join('-');}
function key(pub) {
 const k=crypto.createPublicKey({key:pub,type:'spki',format:'der'});
 if(k.asymmetricKeyType!=='ec'||k.asymmetricKeyDetails.namedCurve!=='prime256v1')throw Error('bad curve');return k;
}
function verify(pub,digest,sig){return crypto.verify('sha256',Buffer.concat([SIGN_DOMAIN,digest]),key(pub),sig);}
function context(chat,event,from,to){if(!validChat(chat)||!validEvent(event)||!validId(from)||!validId(to))throw Error('bad context');return pack(BOX_DOMAIN,chat,event,from,to);}
function messageDigest(chat,event,from,to,cipher) {
 if(!Buffer.isBuffer(cipher)||cipher.length<20||cipher.length>131072)throw Error('bad ciphertext');
 return hash(pack(MESSAGE_DOMAIN,context(chat,event,from,to),cipher));
}
function directChat(a,b){if(!validId(a)||!validId(b)||a===b)throw Error('bad members');const [x,y]=[a,b].sort();return 'd_'+hash(pack(DIRECT_DOMAIN,x,y)).subarray(0,16).toString('base64url');}
function decodeCard(raw){
 if(!Buffer.isBuffer(raw)||raw.length<4||raw.length>8192||raw.subarray(0,4).toString()!=='GPC1')throw Error('bad card');
 let offset=4;const field=max=>{if(offset+4>raw.length)throw Error('short card');const n=raw.readUInt32BE(offset);offset+=4;if(n>max||offset+n>raw.length)throw Error('bad field');const b=raw.subarray(offset,offset+n);offset+=n;return b;};
 const dec=new TextDecoder('utf-8',{fatal:true});const str=max=>dec.decode(field(max));
 const card={id:str(80),nick:str(160),display:str(400),bio:str(2400),city:str(400),website:str(1024),identity:field(160),enc:field(2048),sig:field(160)};
 if(offset!==raw.length||!validId(card.id)||id(card.identity)!==card.id||card.identity.length<80||card.enc.length<50||card.sig.length<8)throw Error('bad card');
 const norm=card.nick.trim().replace(/^@/,'').normalize('NFKC').toLowerCase();
 if(norm!==card.nick||!/^\p{L}[\p{L}\p{N}_]{2,31}$/u.test(card.nick) && !/^[\p{L}\p{N}_]{3,32}$/u.test(card.nick))throw Error('bad nick');
 function clean(s,n){return s.length<=n&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s);}
 if(!clean(card.display,80)||!card.display.trim()||!clean(card.bio,500)||!clean(card.city,80)||!clean(card.website,256)||(card.website&&!/^https:\/\/[^\s]+$/i.test(card.website)))throw Error('bad profile');
 const digest=hash(pack(CONTACT_DOMAIN,card.id,card.nick,card.display,card.bio,card.city,card.website,card.identity,card.enc));
 if(!verify(card.identity,digest,card.sig))throw Error('bad signature');
 return card;
}
function groupDigest(chat,kind,title,owner,cards){
 if(!validChat(chat)||!(kind==='group'&&chat.startsWith('g_')||kind==='channel'&&chat.startsWith('c_'))||!validId(owner)||typeof title!=='string'||title.length>80||!title.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title)||!Array.isArray(cards)||cards.length<2||cards.length>50)throw Error('bad group');
 let previous='',hasOwner=false;for(const raw of cards){const c=decodeCard(raw);if(c.id<=previous)throw Error('noncanonical membership');previous=c.id;if(c.id===owner)hasOwner=true;}if(!hasOwner)throw Error('missing owner');
 return hash(pack(GROUP_DOMAIN,chat,kind,title,owner,...cards));
}
module.exports={SIGN_DOMAIN,validId,validChat,validEvent,b64,pack,hash,id,key,verify,context,messageDigest,directChat,decodeCard,groupDigest};
