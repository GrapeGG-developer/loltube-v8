'use strict';
/* Synthetic local test fixture only. This module MUST NOT be loaded in production. */
const Module = require('node:module'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const original = Module._load, originalFetch = global.fetch;
const root = process.env.LAB_CLOUD_DIR;
if (!root || !path.isAbsolute(root)) throw Error('LAB_CLOUD_DIR required');
fs.mkdirSync(root, { recursive: true });
const file = id => path.join(root, Buffer.from(id).toString('base64url') + '.blob');
const flag = name => fs.existsSync(path.join(root, name));
const fake = {
  config() {},
  utils: { private_download_url(id) { return 'https://fake-cloudinary.invalid/' + Buffer.from(id).toString('base64url'); } },
  uploader: {
    async upload(source, opts) {
      if (flag('fail-write')) throw Error('synthetic_write_failure');
      if (opts.resource_type !== 'raw') {
        if (flag('fail-media')) throw Error('synthetic_media_failure');
        if (flag('delay-media')) { fs.writeFileSync(path.join(root, 'media-started'), '1'); await new Promise(r => setTimeout(r, 1500)); }
        return { public_id: opts.public_id || 'synthetic/' + crypto.randomBytes(12).toString('hex'), secure_url: 'https://synthetic-media.invalid/' + crypto.randomBytes(12).toString('hex') };
      }
      const b = typeof source === 'string' && source.startsWith('data:') ? Buffer.from(source.split(',')[1], 'base64') : fs.readFileSync(source);
      const target = file(opts.public_id); let existing = false;
      if (opts.overwrite === false) {
        try { fs.writeFileSync(target, b, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; existing = true; }
      } else {
        const tmp = target + '.' + crypto.randomBytes(8).toString('hex'); fs.writeFileSync(tmp, b, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, target);
      }
      if (flag('lost-response')) throw Error('synthetic_response_lost');
      return { public_id: opts.public_id, resource_type: 'raw', type: 'authenticated', existing };
    },
    async destroy(id) { try { fs.unlinkSync(file(id)); return { result: 'ok' }; } catch (e) { if (e.code === 'ENOENT') return { result: 'not found' }; throw e; } }
  },
  api: {
    async resources() { return { resources: [] }; },
    async delete_resources(ids) { const deleted = {}; for (const id of ids) { try { fs.unlinkSync(file(id)); deleted[id] = 'deleted'; } catch (e) { if (e.code !== 'ENOENT') throw e; deleted[id] = 'not_found'; } } return { deleted }; }
  }
};
Module._load = function(request, parent, isMain) { if (request === 'cloudinary') return { v2: fake }; return original.call(this, request, parent, isMain); };
global.fetch = async function(url, init) {
  const target = typeof url === 'string' ? url : url.url;
  if (target.startsWith('https://fake-cloudinary.invalid/')) {
    if (flag('fail-read')) return new Response(null, { status: 503 });
    let id; try { id = Buffer.from(new URL(target).pathname.slice(1), 'base64url').toString(); } catch (_) { return new Response(null, { status: 400 }); }
    let b; try { b = fs.readFileSync(file(id)); } catch (e) { if (e.code === 'ENOENT') return new Response(null, { status: 404 }); throw e; }
    return new Response(b, { status: 200, headers: { 'Content-Length': String(b.length) } });
  }
  return originalFetch(url, init);
};
