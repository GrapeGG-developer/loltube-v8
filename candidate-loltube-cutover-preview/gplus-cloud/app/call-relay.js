'use strict';
// Ephemeral transport only. The relay MUST NOT receive plaintext media or keys.
// One process, direct chats only; not an audited or deployed calling service.
const { WebSocketServer,WebSocket }=require('ws');
const P=require('./protocol');
function createCallRelay({authenticate,isDirectMember,maxRooms=100,maxFrameBytes=96*1024,maxBytesPerSecond=2*1024*1024}={}){
 if(typeof authenticate!=='function'||typeof isDirectMember!=='function'||!Number.isInteger(maxRooms)||maxRooms<1)throw Error('invalid call relay configuration');
 const wss=new WebSocketServer({noServer:true,maxPayload:maxFrameBytes,perMessageDeflate:false,clientTracking:true});
 const rooms=new Map(),active=new Map();let closed=false;
 const reject=(socket,status)=>{if(!socket.destroyed){socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);socket.destroy();}};
 const pathOf=req=>{try{return new URL(req.url,'http://gplus.local').pathname;}catch{return '';}};
 function handleUpgrade(req,socket,head){
  if(pathOf(req)!=='/gplus/call-relay')return false;
  if(closed){reject(socket,'503 Service Unavailable');return true;}
  let url;try{url=new URL(req.url,'http://gplus.local');}catch{reject(socket,'400 Bad Request');return true;}
  const chat=url.searchParams.get('chat'),call=url.searchParams.get('call');let who;try{who=authenticate(req);}catch{}
  if(!who||!P.validId(who.id)){reject(socket,'401 Unauthorized');return true;}
  if(!P.validChat(chat)||!chat.startsWith('d_')||!P.validEvent(call)||!isDirectMember(chat,who.id)){reject(socket,'404 Not Found');return true;}
  const roomKey=chat+'/'+call,room=rooms.get(roomKey);
  if(active.has(who.id)||(room&&room.has(who.id))){reject(socket,'409 Conflict');return true;}
  if((room&&room.size>=2)||(!room&&rooms.size>=maxRooms)){reject(socket,'503 Service Unavailable');return true;}
  wss.handleUpgrade(req,socket,head,ws=>{
   const participants=rooms.get(roomKey)||new Map();rooms.set(roomKey,participants);participants.set(who.id,ws);active.set(who.id,ws);
   ws.isAlive=true;ws.rateAt=Date.now();ws.rateBytes=0;ws.nextAuth=Date.now()+30000;
   const signal=(target,type)=>{if(target.readyState===WebSocket.OPEN)target.send(JSON.stringify({type}),{binary:false});};
   if(participants.size===2)for(const peer of participants.values())signal(peer,'peer_joined');
   ws.on('pong',()=>{ws.isAlive=true;});
   ws.on('message',(data,isBinary)=>{
    if(!isBinary){ws.close(1003,'binary required');return;}
    const now=Date.now();if(now>=ws.nextAuth){let still;try{still=authenticate(req);}catch{}if(!still||still.id!==who.id){ws.close(1008,'session expired');return;}ws.nextAuth=now+30000;}if(now-ws.rateAt>=1000){ws.rateAt=now;ws.rateBytes=0;}ws.rateBytes+=data.length;if(!data.length||ws.rateBytes>maxBytesPerSecond){ws.close(1008,'rate limit');return;}
    for(const [id,peer] of participants){if(id===who.id||peer.readyState!==WebSocket.OPEN)continue;if(peer.bufferedAmount>2*1024*1024){peer.close(1013,'backpressure');continue;}peer.send(data,{binary:true});}
   });
   ws.on('error',()=>{});
   ws.on('close',()=>{if(active.get(who.id)===ws)active.delete(who.id);if(participants.get(who.id)===ws)participants.delete(who.id);if(!participants.size)rooms.delete(roomKey);else for(const peer of participants.values())signal(peer,'peer_left');});
  });return true;
 }
 const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;try{ws.ping();}catch{ws.terminate();}}},30000);heartbeat.unref();
 return {handleUpgrade,close(){if(closed)return;closed=true;clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();rooms.clear();active.clear();},stats(){return {rooms:rooms.size,connections:active.size};}};
}
module.exports={createCallRelay};
