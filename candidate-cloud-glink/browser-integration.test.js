'use strict';
// DOM/WebCrypto/IndexedDB integration test; not a substitute for a real browser or phone.
// Requires jsdom 26 and fake-indexeddb 6; see README.md.
const test = require('node:test'), assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const { webcrypto } = require('node:crypto');
const http = require('node:http'), os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glink-browser-'));
process.env.GLINK_RELAY_DIR = dir;
const {createRelay}=require('./relay');const {createOffers}=require('./offers');
class Memory { constructor(){this.map=new Map();}async get(k){const x=this.map.get(k);return x===undefined?null:Buffer.from(x);}async putOnce(k,b){if(this.map.has(k))return false;this.map.set(k,Buffer.from(b));return true;}async replace(k,b){this.map.set(k,Buffer.from(b));}async setHead(b){this.map.set('head.json',Buffer.from(b));} }
const relay=createRelay({store:new Memory()}),offerStore=new Memory();let offers;
const assets={};for(const [u,file] of [['/glink/send','glink-send.html'],['/glink/crypto-v2.js','glink-crypto-v2.js'],['/glink/send-v2.js','glink-send-v2.js']])assets[u]=fs.readFileSync(path.join(__dirname,'../glink-relay',file));
let server, base, pages = [];
async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = check(); if (r) return r; } catch (_) {} await new Promise(r => setTimeout(r, 50)); }
  throw Error('Timed out waiting for UI state');
}
async function page(db, prefix = '') {
  const errors = [], blobs = new Map(), requests = [], paths = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = await JSDOM.fromURL(base + prefix + '/glink/send', {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      Object.defineProperty(window, 'indexedDB', { value: db, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder; window.Blob = Blob;
      window.fetch = (url, options = {}) => {
        const absolute = new URL(url, base).href; paths.push(new URL(absolute).pathname);
        if (absolute.endsWith('/glink/offer') && options.body) requests.push(JSON.parse(options.body));
        return fetch(absolute, options);
      };
      let counter = 0;
      window.URL.createObjectURL = b => { const id = 'blob:local-' + (++counter); blobs.set(id, b); return id; };
      const interval = window.setInterval.bind(window);
      window.setInterval = (fn, delay) => interval(fn, delay === 5000 ? 100 : delay);
    }
  });
  pages.push(dom);
  await waitFor(() => dom.window.document.getElementById('status').textContent.includes('готов'));
  return { dom, doc: dom.window.document, errors, blobs, requests, paths };
}
test.before(async () => {
  offers=await createOffers({store:offerStore,dataDir:path.join(dir,'cloud-offers')});
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/gsrv-v1/glink/')) req.url = req.url.slice('/gsrv-v1'.length);
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(assets[pathname]){res.setHeader('content-type',pathname.endsWith('.js')?'application/javascript':'text/html; charset=utf-8');return res.end(assets[pathname]);}
    offers(req,res,()=>relay(req,res,()=>{res.statusCode=404;res.end('missing');}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { for (const dom of pages) dom.window.close(); if (server) await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test('two independent browser identities send and receive encrypted file without plaintext key offers', async () => {
  const a = await page(new IDBFactory()), b = await page(new IDBFactory());
  assert.notEqual(a.doc.getElementById('identity').textContent, b.doc.getElementById('identity').textContent);
  a.doc.getElementById('refresh').click();
  const target = await waitFor(() => a.doc.querySelector('#devices button'));
  const contents = new TextEncoder().encode('GLINK: проверка реальной передачи');
  const file = { name: 'hello.txt', type: 'text/plain', size: contents.length, arrayBuffer: async () => contents.buffer.slice(0) };
  const input = a.doc.getElementById('files'); Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new a.dom.window.Event('change'));
  target.click();
  await waitFor(() => a.doc.getElementById('status').textContent.includes('Предложение отправлено'));
  assert.equal(a.requests.length, 1); assert.match(a.requests[0].k, /^g2\./);
  const accept = await waitFor(() => [...b.doc.querySelectorAll('#incoming button')].find(x => x.textContent === 'Принять'));
  accept.click();
  const link = await waitFor(() => b.doc.querySelector('#incoming a.download'));
  assert.equal(link.download, 'hello.txt');
  const blob = b.blobs.get(link.href); assert.ok(blob); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from(contents));
  await waitFor(() => b.doc.getElementById('status').textContent.startsWith('Готово.'));
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
});

test('browser device identity persists in IndexedDB across page reload', async () => {
  const db = new IDBFactory(); const first = await page(db);
  const id = first.doc.getElementById('identity').textContent;
  first.dom.window.close();
  const second = await page(db);
  assert.equal(second.doc.getElementById('identity').textContent, id);
});

test('versioned PC web route keeps all encrypted traffic under its own prefix', async () => {
  const a=await page(new IDBFactory(),'/gsrv-v1'), b=await page(new IDBFactory(),'/gsrv-v1');
  const own=a.doc.getElementById('identity').textContent.split(' · ')[1],peer=b.doc.getElementById('identity').textContent.split(' · ')[1];
  const listed=(await (await fetch(base+'/gsrv-v1/glink/devices')).json()).devices.filter(d=>d.id!==own),index=listed.findIndex(d=>d.id===peer);
  assert(index>=0);a.doc.getElementById('refresh').click();
  const target=await waitFor(()=>{const buttons=a.doc.querySelectorAll('#devices button');return buttons.length===listed.length?buttons[index]:null;});
  const contents=new TextEncoder().encode('versioned encrypted message');
  const file={name:'v2.txt',type:'text/plain',size:contents.length,arrayBuffer:async()=>contents.buffer.slice(0)};
  const input=a.doc.getElementById('files');Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new a.dom.window.Event('change'));target.click();
  await waitFor(()=>a.doc.getElementById('status').textContent.includes('Предложение отправлено'));
  const accept=await waitFor(()=>[...b.doc.querySelectorAll('#incoming button')].find(x=>x.textContent==='Принять'));accept.click();
  const link=await waitFor(()=>b.doc.querySelector('#incoming a.download'));const blob=b.blobs.get(link.href);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()),Buffer.from(contents));
  assert(a.paths.length>2&&b.paths.length>2);assert(a.paths.every(p=>p.startsWith('/gsrv-v1/glink/')));assert(b.paths.every(p=>p.startsWith('/gsrv-v1/glink/')));
  assert.match(a.requests[0].k,/^g2\./);assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
});

test('large browser upload reads bounded slices and is interoperable with GSENC1', async () => {
  const a=await page(new IDBFactory()), b=await page(new IDBFactory());
  const own=a.doc.getElementById('identity').textContent.split(' · ')[1], peer=b.doc.getElementById('identity').textContent.split(' · ')[1];
  const listed=(await (await fetch(base+'/glink/devices')).json()).devices.filter(d=>d.id!==own), index=listed.findIndex(d=>d.id===peer);
  assert(index>=0);a.doc.getElementById('refresh').click();const target=await waitFor(()=>{const buttons=a.doc.querySelectorAll('#devices button');return buttons.length===listed.length?buttons[index]:null;});
  const original=new Uint8Array(require('node:crypto').randomBytes(9*1024*1024+9));let maxRead=0,reads=0;
  const file={name:'large.bin',type:'application/octet-stream',size:original.length,
    arrayBuffer:async()=>{throw Error('the entire file must not be read at once');},
    slice(start,end){maxRead=Math.max(maxRead,end-start);reads++;return {arrayBuffer:async()=>original.slice(start,end).buffer};}};
  const input=a.doc.getElementById('files');Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new a.dom.window.Event('change'));target.click();
  await waitFor(()=>a.doc.getElementById('status').textContent.includes('Предложение отправлено'),20000);
  assert.ok(reads>100);assert.ok(maxRead<=65536);assert.ok(a.paths.filter(p=>p.startsWith('/glink/chunk/')).length>=3);
  const accept=await waitFor(()=>[...b.doc.querySelectorAll('#incoming button')].find(x=>x.textContent==='Принять'));accept.click();
  const link=await waitFor(()=>b.doc.querySelector('#incoming a.download'),20000),received=Buffer.from(await b.blobs.get(link.href).arrayBuffer());
  assert.deepEqual(received,Buffer.from(original));await waitFor(()=>b.doc.getElementById('status').textContent.startsWith('Готово.'));
  assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
});
