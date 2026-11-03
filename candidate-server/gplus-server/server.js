'use strict';
// Optional standalone test process; Render TLS must terminate at the proxy.
const http=require('node:http');const {createGPlus}=require('./index');
const dir=process.env.GPLUS_DATA_DIR;if(!dir)throw Error('Set GPLUS_DATA_DIR to an absolute persistent path');
const limit=Number(process.env.GPLUS_MAX_ASSET_BYTES||0),reserve=Number(process.env.GPLUS_DISK_RESERVE_BYTES||0);
const gplus=createGPlus({dataDir:dir,maxStorageBytes:limit,reserveBytes:reserve});
let glink=null;if(process.env.GLINK_RELAY_MODULE)glink=require(process.env.GLINK_RELAY_MODULE);
const server=http.createServer((req,res)=>{
 if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end('{"ok":true,"service":"gplus-development"}');}
 const fallback=()=>{res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"not_found"}');};
 gplus(req,res,()=>glink?glink(req,res,fallback):fallback());
});
server.on('upgrade',(req,socket,head)=>{if(!gplus.handleUpgrade(req,socket,head))socket.destroy();});
server.listen(Number(process.env.PORT||8080),'0.0.0.0');
function stop(){gplus.closeCalls();server.close(()=>{gplus.close();process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
