'use strict';
// WebCrypto implementation shared by the browser and Node interoperability tests.
(function (root) {
  const c = root.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
  const te = new TextEncoder();
  function cat(...parts) {
    const size = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(size);
    let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out;
  }
  function b64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    let s = ''; for (const v of bytes) s += String.fromCharCode(v);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Некорректный ключ');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'));
    const s = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(s, ch => ch.charCodeAt(0));
  }
  function context(session, recipient) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(session) || !/^[A-Za-z0-9_-]{6,64}$/.test(recipient)) throw Error('Некорректный получатель');
    return te.encode('GLINK-WIFI-SEALED-2\0' + session + '\0' + recipient);
  }
  async function importedPublic(encoded) {
    const der = unb64(encoded);
    if (der.length < 80 || der.length > 150) throw Error('Некорректный ключ устройства');
    return c.subtle.importKey('spki', der, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }
  async function derive(privateKey, publicKey, iv, aad, usage) {
    const bits = await c.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const ikm = await c.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return c.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: iv, info: aad }, ikm,
      { name: 'AES-GCM', length: 256 }, false, [usage]);
  }
  async function seal(publicKey, raw, session, recipient) {
    if (raw.length !== 32) throw Error('Некорректный ключ передачи');
    const peer = await importedPublic(publicKey);
    const eph = await c.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ep = new Uint8Array(await c.subtle.exportKey('spki', eph.publicKey));
    const iv = c.getRandomValues(new Uint8Array(12)), aad = context(session, recipient);
    const key = await derive(eph.privateKey, peer, iv, aad, 'encrypt');
    const encrypted = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, raw));
    return 'g2.' + b64(cat(Uint8Array.of(2, ep.length >> 8, ep.length & 255), ep, iv, encrypted));
  }
  async function open(privateKey, envelope, session, recipient) {
    if (typeof envelope !== 'string' || !envelope.startsWith('g2.') || envelope.length > 512) throw Error('Нужна обновлённая версия GLINK');
    const x = unb64(envelope.slice(3));
    if (x.length < 3 || x[0] !== 2) throw Error('Некорректное предложение');
    const n = (x[1] << 8) | x[2];
    if (n < 80 || n > 150 || x.length !== 3 + n + 12 + 48) throw Error('Некорректное предложение');
    const peer = await importedPublic(b64(x.slice(3, 3 + n)));
    const iv = x.slice(3 + n, 3 + n + 12), aad = context(session, recipient);
    const key = await derive(privateKey, peer, iv, aad, 'decrypt');
    const raw = new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, x.slice(3 + n + 12)));
    if (raw.length !== 32) throw Error('Некорректный ключ передачи');
    return raw;
  }
  const api = { cat, b64, unb64, seal, open, context };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GlinkCryptoV2 = api;
})(globalThis);
