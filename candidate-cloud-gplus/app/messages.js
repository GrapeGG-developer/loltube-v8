'use strict';
// Single-process SQLite encrypted-message relay. This is a development build,
// not a security-reviewed or horizontally scalable production service.
const fs=require('node:fs');
const path=require('node:path');
const Database=require('better-sqlite3');
const P=require('./protocol');

function fail(res, status, error) {const b=Buffer.from(JSON.stringify({error}));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':b.length});res.end(b);}
function ok(res, code, value){const b=Buffer.from(JSON.stringify(value));res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':b.length});res.end(b);}
function jsonBody(req,max=8*1024*1024){return new Promise((resolve,reject)=>{let parts=[],n=0,failed=false;req.on('data',c=>{n+=c.length;if(n>max){failed=true;parts=[];}else if(!failed)parts.push(c);});req.on('end',()=>{if(failed)return reject(Error('body_too_large'));try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(Error('bad_json'));}});req.on('error',reject);});}

function createMessages({dataDir, authenticate, lookup, now=()=>Date.now(), maxBodyBytes=8*1024*1024}) {
 if(typeof authenticate!=='function'||typeof lookup!=='function')throw Error('authenticate and lookup required');
 if(!path.isAbsolute(dataDir))throw Error('dataDir must be absolute');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const db=new Database(path.join(dataDir,'gplus-messages.sqlite3'));
 db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');db.pragma('foreign_keys = ON');
 db.exec(`
 CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,kind TEXT NOT NULL,creator TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS members(chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,user_id TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',joined INTEGER NOT NULL,last_read INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,user_id));
 CREATE INDEX IF NOT EXISTS members_user ON members(user_id,chat_id);
 CREATE TABLE IF NOT EXISTS group_states(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,sender TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,seq);
 CREATE TABLE IF NOT EXISTS boxes(seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,recipient TEXT NOT NULL,ciphertext TEXT NOT NULL,signature TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(seq,recipient));
 `);
 const presence=new Map();
 const member=db.prepare('SELECT * FROM members WHERE chat_id=? AND user_id=?');
 const members=db.prepare('SELECT user_id,role,last_read FROM members WHERE chat_id=? ORDER BY user_id');
 const chat=db.prepare('SELECT * FROM chats WHERE id=?');
 const insertDirect=db.transaction((id,a,b,t)=>{
  db.prepare("INSERT OR IGNORE INTO chats(id,kind,creator,created) VALUES(?,'direct',?,?)").run(id,a,t);
  const insert=db.prepare('INSERT OR IGNORE INTO members(chat_id,user_id,role,joined) VALUES(?,?,?,?)');
  insert.run(id,a,'member',t);insert.run(id,b,'member',t);
 });
 const insertGroup=db.transaction((state,memberCards,t)=>{
  const previous=db.prepare('SELECT state FROM group_states WHERE chat_id=?').get(state.id);
  if(previous){if(previous.state!==JSON.stringify(state))throw Error('group_conflict');return false;}
  if(chat.get(state.id))throw Error('group_conflict');
  db.prepare('INSERT INTO chats(id,kind,creator,title,created) VALUES(?,?,?,?,?)').run(state.id,state.kind,state.owner,state.title,t);
  const add=db.prepare('INSERT INTO members(chat_id,user_id,role,joined) VALUES(?,?,?,?)');
  for(const c of memberCards)add.run(state.id,c.id,c.id===state.owner?'owner':'member',t);
  db.prepare('INSERT INTO group_states(chat_id,state) VALUES(?,?)').run(state.id,JSON.stringify(state));return true;
 });
 const insertEvent=db.transaction((id,eventId,sender,boxes,t,expires)=>{
  const prior=db.prepare('SELECT * FROM events WHERE event_id=?').get(eventId);
  if(prior){
   if(prior.chat_id!==id||prior.sender!==sender||prior.expires!==expires && expires!==0)throw Error('event_conflict');
   const stored=db.prepare('SELECT recipient,ciphertext,signature FROM boxes WHERE seq=? ORDER BY recipient').all(prior.seq);
   const incoming=boxes.map(b=>({recipient:b.to,ciphertext:b.ciphertext,signature:b.signature})).sort((a,b)=>a.recipient<b.recipient?-1:a.recipient>b.recipient?1:0);
   if(JSON.stringify(stored)!==JSON.stringify(incoming))throw Error('event_conflict');return {seq:prior.seq,created:prior.created,expires:prior.expires,duplicate:true};
  }
  const info=db.prepare('INSERT INTO events(event_id,chat_id,sender,created,expires) VALUES(?,?,?,?,?)').run(eventId,id,sender,t,expires);
  const add=db.prepare('INSERT INTO boxes(seq,recipient,ciphertext,signature) VALUES(?,?,?,?)');
  for(const b of boxes)add.run(info.lastInsertRowid,b.to,b.ciphertext,b.signature);
  return {seq:Number(info.lastInsertRowid),created:t,expires,duplicate:false};
 });
 const api=async function(req,res,next=()=>fail(res,404,'not_found')){
  let url;try{url=new URL(req.url,'http://gplus.local');}catch{return fail(res,400,'bad_url');}
  if(!url.pathname.startsWith('/gplus/chats'))return next();
  try{
   const who=authenticate(req);if(!who)return fail(res,401,'unauthorized');
   const t=now();presence.set(who.id,t);
   if(req.method==='POST'&&url.pathname==='/gplus/chats/direct'){
    const body=await jsonBody(req,4096);const peer=body.peer;
    if(!P.validId(peer)||peer===who.id)return fail(res,400,'bad_peer');
    if(!lookup(peer))return fail(res,404,'peer_not_found');
    const id=P.directChat(who.id,peer);insertDirect(id,who.id,peer,t);
    return ok(res,200,{id,kind:'direct',peer});
   }
   if(req.method==='POST'&&url.pathname==='/gplus/chats/group'){
    const body=await jsonBody(req,600000);let cardBytes,people,digest,signature;
    try{
     if(!body||body.owner!==who.id||!Array.isArray(body.cards)||body.cards.length>50)throw Error();
     cardBytes=body.cards.map(x=>P.b64(x,11000));people=cardBytes.map(P.decodeCard);
     digest=P.groupDigest(body.id,body.kind,body.title,body.owner,cardBytes);signature=P.b64(body.signature,256);
     if(!P.verify(P.b64(who.public_key,512),digest,signature))throw Error();
     for(const person of people){const account=lookup(person.id);if(!account||account.nickname!==person.nick||!P.b64(account.public_key,512).equals(person.identity))throw Error();}
    }catch{return fail(res,400,'invalid_group');}
    const state={id:body.id,kind:body.kind,title:body.title,owner:body.owner,cards:body.cards,signature:body.signature};
    try{return ok(res,200,{created:insertGroup(state,people,t),state});}catch(e){if(e.message==='group_conflict')return fail(res,409,'group_conflict');throw e;}
   }
   if(req.method==='GET'&&url.pathname==='/gplus/chats'){
    const rows=db.prepare('SELECT c.id,c.kind,c.title,c.created,m.last_read FROM chats c JOIN members m ON c.id=m.chat_id WHERE m.user_id=? ORDER BY c.created DESC LIMIT 1000').all(who.id);
    return ok(res,200,{chats:rows.map(r=>({...r,members:members.all(r.id)}))});
   }
   const m=url.pathname.match(/^\/gplus\/chats\/([A-Za-z0-9_-]+)(?:\/(events|read|ack|members|state))?$/);
   if(!m||!P.validChat(m[1]))return fail(res,404,'not_found');
   const chatId=m[1],action=m[2]||'';
   if(!chat.get(chatId)||!member.get(chatId,who.id))return fail(res,404,'chat_not_found');
   if(req.method==='GET'&&action==='state'){
    const state=db.prepare('SELECT state FROM group_states WHERE chat_id=?').get(chatId);if(!state)return fail(res,404,'state_not_found');
    return ok(res,200,{state:JSON.parse(state.state)});
   }
   if(req.method==='GET'&&action==='members'){
    return ok(res,200,{members:members.all(chatId).map(x=>({...x,online:(presence.get(x.user_id)||0)>t-60000}))});
   }
   if(req.method==='POST'&&action==='events'){
    const current=chat.get(chatId),selfMembership=member.get(chatId,who.id);
    const body=await jsonBody(req,maxBodyBytes), event=body.id, boxes=body.boxes, ttl=body.ttl_seconds===undefined?0:body.ttl_seconds;
    // Subscribers may react/vote. Recipients also check the decrypted type;
    // the relay cannot inspect ciphertext and must not be trusted for this.
    if(current.kind==='channel'&&selfMembership.role!=='owner'&&!['vote','reaction'].includes(body.operation))return fail(res,403,'channel_read_only');
    if(!P.validEvent(event)||!Array.isArray(boxes)||!Number.isSafeInteger(ttl)||ttl<0||ttl>31536000)return fail(res,400,'bad_event');
    const all=members.all(chatId).map(x=>x.user_id).sort();
    if(boxes.length!==all.length||boxes.length>100)return fail(res,400,'wrong_recipients');
    const recipients=[];let pub;try{pub=P.b64(who.public_key,512);P.key(pub);}catch{return fail(res,400,'bad_identity');}
    for(const box of boxes){
     if(!box||typeof box!=='object'||!P.validId(box.to)||recipients.includes(box.to))return fail(res,400,'bad_box');
     recipients.push(box.to);
     try{const cipher=P.b64(box.ciphertext,180000),sig=P.b64(box.signature,256);if(!P.verify(pub,P.messageDigest(chatId,event,who.id,box.to,cipher),sig))throw Error();}
     catch{return fail(res,400,'bad_signature_or_ciphertext');}
    }
    if(JSON.stringify(recipients.sort())!==JSON.stringify(all))return fail(res,400,'wrong_recipients');
    // Calculate expiry only on first insert. On retries, preserve the original deadline.
    const existing=db.prepare('SELECT expires FROM events WHERE event_id=?').get(event);
    const expires=existing?existing.expires:(ttl?t+ttl*1000:0);
    try{return ok(res,200,insertEvent(chatId,event,who.id,boxes,t,expires));}
    catch(e){if(e.message==='event_conflict')return fail(res,409,'event_conflict');throw e;}
   }
   if(req.method==='GET'&&action==='events'){
    const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)return fail(res,400,'bad_cursor');
    const rows=db.prepare(`SELECT e.seq,e.event_id AS id,e.sender,e.created,e.expires,b.recipient,b.ciphertext,b.signature,b.delivered
      FROM events e JOIN boxes b ON b.seq=e.seq WHERE e.chat_id=? AND b.recipient=? AND e.seq>? AND (e.expires=0 OR e.expires>?) ORDER BY e.seq LIMIT 21`).all(chatId,who.id,after,t);
    const has_more=rows.length>20;return ok(res,200,{events:rows.slice(0,20),has_more});
   }
   if(req.method==='POST'&&(action==='read'||action==='ack')){
    const b=await jsonBody(req,4096);if(!Number.isSafeInteger(b.seq)||b.seq<1)return fail(res,400,'bad_cursor');
    const found=db.prepare('SELECT e.seq FROM events e JOIN boxes b ON e.seq=b.seq WHERE e.seq=? AND e.chat_id=? AND b.recipient=? AND (e.expires=0 OR e.expires>?)').get(b.seq,chatId,who.id,t);
    if(!found)return fail(res,404,'event_not_found');
    if(action==='read')db.prepare('UPDATE members SET last_read=MAX(last_read,?) WHERE chat_id=? AND user_id=?').run(b.seq,chatId,who.id);
    else db.prepare('UPDATE boxes SET delivered=CASE WHEN delivered=0 THEN ? ELSE delivered END WHERE recipient=? AND seq IN (SELECT seq FROM events WHERE chat_id=? AND seq<=?)').run(t,who.id,chatId,b.seq);
    return ok(res,200,{ok:true});
   }
   return fail(res,404,'not_found');
  }catch(e){if(e.message==='body_too_large')return fail(res,413,'body_too_large');if(e.message==='bad_json')return fail(res,400,'bad_json');console.error('G+ messages internal error:',e.message);return fail(res,500,'internal_error');}
 };
 api.isMember=(chatId,userId)=>!!member.get(chatId,userId);
 api.isDirectMember=(chatId,userId)=>{const c=chat.get(chatId);return !!c&&c.kind==='direct'&&!!member.get(chatId,userId);};
 // Internal lookup only: recipients are taken from the signed, already-stored
 // event rather than today's potentially changed group membership.
 api.assetRecipients=(chatId,eventId,senderId)=>{
  if(!P.validChat(chatId)||!P.validEvent(eventId)||!P.validId(senderId))return null;
  const e=db.prepare('SELECT seq FROM events WHERE chat_id=? AND event_id=? AND sender=?').get(chatId,eventId,senderId);
  if(!e)return null;return db.prepare('SELECT recipient FROM boxes WHERE seq=? ORDER BY recipient').all(e.seq).map(x=>x.recipient);
 };
 api.close=()=>db.close();
 // Explicit expiry is selected by the sender. No ordinary media/history cleanup is performed.
 api.purgeExpired=()=>db.prepare('DELETE FROM events WHERE expires>0 AND expires<=?').run(now()).changes;
 return api;
}
module.exports={createMessages};
