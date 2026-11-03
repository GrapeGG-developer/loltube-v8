'use strict';

// G+ foundation: device-key challenge/response and a durable single-instance
// account registry. This module does NOT implement chats, NFC, media or calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DOMAIN = Buffer.from('G+ AUTH v1\0', 'utf8');
const MAX_BODY = 16 * 1024;
const CHALLENGE_TTL = 2 * 60 * 1000;
const SESSION_TTL = 60 * 60 * 1000;
const MAX_IN_FLIGHT = 10000;

function publicIdentity(bytes) {
  const key = crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
    throw new Error('Expected a P-256 public key');
  }
  const canonical = key.export({ type: 'spki', format: 'der' });
  const digest = crypto.createHash('sha256').update(canonical).digest().subarray(0, 12).toString('base64url');
  return { key, der: canonical, id: digest.match(/.{4}/g).join('-') };
}

function normalizeNickname(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/^@/, '').normalize('NFKC').toLowerCase();
  return /^[\p{L}\p{N}_]{3,32}$/u.test(name) ? name : null;
}

function json(res, status, object) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(object));
}

function readJson(req, res, callback) {
  let size = 0, chunks = [], finished = false;
  req.on('data', chunk => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      finished = true;
      chunks = [];
      json(res, 413, { error: 'body_too_large' });
      req.resume();
    } else chunks.push(chunk);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
      callback(value);
    } catch (e) { json(res, 400, { error: 'invalid_json' }); }
  });
  req.on('error', () => {
    if (!finished && !res.headersSent) { finished = true; json(res, 400, { error: 'invalid_request' }); }
  });
}

function decodeBytes(value, min, max) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const buf = Buffer.from(value, 'base64url');
  if (buf.length < min || buf.length > max || buf.toString('base64url') !== value) throw new Error('Invalid length');
  return buf;
}

function createAuth({ dataDir, now = Date.now } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('GPLUS_DATA_DIR must point to an absolute persistent path');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'accounts-v1.json');
  let db = { version: 1, accounts: {} };
  if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    if (!db || db.version !== 1 || !db.accounts || typeof db.accounts !== 'object') throw new Error('Invalid G+ accounts database');
  }
  const challenges = new Map();
  const sessions = new Map();
  const keyRates = new Map();

  function persist(next) {
    const temp = path.join(dataDir, `.accounts-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, dbPath);
      // Persist the directory entry on filesystems that support directory fsync.
      try { const dirFd = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch (_) {}
      db = next;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
    }
  }

  function cleanup() {
    const time = now();
    for (const [k, item] of challenges) if (item.expires <= time) challenges.delete(k);
    for (const [k, item] of sessions) if (item.expires <= time) sessions.delete(k);
    for (const [k, item] of keyRates) if (item.until <= time) keyRates.delete(k);
  }

  function authenticated(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    if (!match) return null;
    const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
    const session = sessions.get(tokenHash);
    if (!session || session.expires <= now()) { sessions.delete(tokenHash); return null; }
    return db.accounts[session.id] || null;
  }

  const gplusAuth = function gplusAuth(req, res, next) {
    const requestPath = (req.url || '').split('?')[0];
    if (!requestPath.startsWith('/gplus/auth/') && requestPath !== '/gplus/me'
        && requestPath !== '/gplus/me/profile') return next();
    cleanup();
    if (req.method === 'POST' && requestPath === '/gplus/auth/challenge') {
      return readJson(req, res, body => {
        let identity;
        try { identity = publicIdentity(decodeBytes(body.public_key, 70, 160)); }
        catch (_) { return json(res, 400, { error: 'invalid_public_key' }); }
        const rate = keyRates.get(identity.id) || { count: 0, until: now() + 60_000 };
        if (rate.count >= 30 || challenges.size >= MAX_IN_FLIGHT) return json(res, 429, { error: 'rate_limited' });
        rate.count++; keyRates.set(identity.id, rate);
        const nonce = crypto.randomBytes(32).toString('base64url');
        challenges.set(nonce, { publicKey: identity.der.toString('base64url'), expires: now() + CHALLENGE_TTL });
        return json(res, 200, { nonce, expires_in_seconds: CHALLENGE_TTL / 1000 });
      });
    }
    if (req.method === 'POST' && requestPath === '/gplus/auth/verify') {
      return readJson(req, res, body => {
        let identity, nonce, signature;
        try {
          identity = publicIdentity(decodeBytes(body.public_key, 70, 160));
          nonce = decodeBytes(body.nonce, 32, 32);
          signature = decodeBytes(body.signature, 8, 160);
        } catch (_) { return json(res, 400, { error: 'invalid_auth_data' }); }
        const nonceText = nonce.toString('base64url');
        const challenge = challenges.get(nonceText);
        challenges.delete(nonceText); // one use, even after a failed signature
        if (!challenge || challenge.expires <= now() || challenge.publicKey !== identity.der.toString('base64url')) {
          return json(res, 401, { error: 'invalid_or_expired_challenge' });
        }
        const message = Buffer.concat([DOMAIN, nonce]);
        if (!crypto.verify('sha256', message, identity.key, signature)) return json(res, 401, { error: 'invalid_signature' });
        let account = db.accounts[identity.id];
        let created = false;
        if (!account) {
          const nickname = normalizeNickname(body.nickname);
          if (!nickname) return json(res, 400, { error: 'nickname_required_or_invalid' });
          if (Object.values(db.accounts).some(a => a.nickname === nickname)) return json(res, 409, { error: 'nickname_taken' });
          account = { id: identity.id, nickname, public_key: identity.der.toString('base64url'), display_name: nickname, created_at: now() };
          const nextDb = { version: 1, accounts: { ...db.accounts, [identity.id]: account } };
          try { persist(nextDb); } catch (_) { return json(res, 503, { error: 'storage_unavailable' }); }
          created = true;
        } else if (account.public_key !== identity.der.toString('base64url')) {
          // Even an unlikely truncated fingerprint collision must never change account ownership.
          return json(res, 409, { error: 'identity_collision' });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        if (sessions.size >= MAX_IN_FLIGHT) return json(res, 503, { error: 'too_many_sessions' });
        sessions.set(hash, { id: identity.id, expires: now() + SESSION_TTL });
        return json(res, created ? 201 : 200, { id: identity.id, nickname: account.nickname, token, expires_in_seconds: SESSION_TTL / 1000 });
      });
    }
    if (req.method === 'GET' && requestPath === '/gplus/me') {
      const account = authenticated(req);
      if (!account) return json(res, 401, { error: 'authentication_required' });
      return json(res, 200, { id: account.id, nickname: account.nickname,
        display_name: account.display_name, profile: account.profile || {} });
    }
    if (req.method === 'POST' && requestPath === '/gplus/me/profile') {
      const account = authenticated(req);
      if (!account) return json(res, 401, { error: 'authentication_required' });
      return readJson(req, res, body => {
        // Deliberately limited, text-only profile. Avatars and contact sharing are not implemented.
        const limits = { display_name: 80, bio: 500, city: 80, website: 256 };
        if (Object.keys(body).some(k => !Object.hasOwn(limits, k))) return json(res, 400, { error: 'invalid_profile_field' });
        const profile = { ...(account.profile || {}) };
        let display = account.display_name;
        for (const [k, limit] of Object.entries(limits)) {
          if (!Object.hasOwn(body, k)) continue;
          if (typeof body[k] !== 'string' || body[k].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body[k])) {
            return json(res, 400, { error: 'invalid_profile' });
          }
          const value = body[k].trim();
          if (k === 'display_name') { if (!value) return json(res, 400, { error: 'invalid_profile' }); display = value; }
          else if (k === 'website' && value && !/^https:\/\/[^\s]+$/i.test(value)) return json(res, 400, { error: 'invalid_profile' });
          else profile[k] = value;
        }
        const updated = { ...account, display_name: display, profile };
        const nextDb = { version: 1, accounts: { ...db.accounts, [account.id]: updated } };
        try { persist(nextDb); } catch (_) { return json(res, 503, { error: 'storage_unavailable' }); }
        return json(res, 200, { id: updated.id, nickname: updated.nickname, display_name: display, profile });
      });
    }
    return json(res, 404, { error: 'not_found' });
  };
  // Internal adapter for the chat service; token hashes remain private and in memory only.
  gplusAuth.authenticate = req => {
    const account = authenticated(req);
    return account ? { ...account, profile: { ...(account.profile || {}) } } : null;
  };
  gplusAuth.lookup = id => {
    const account = db.accounts[id];
    return account ? { id: account.id, nickname: account.nickname, public_key: account.public_key,
      display_name: account.display_name, profile: { ...(account.profile || {}) } } : null;
  };
  return gplusAuth;
}

module.exports = { createAuth, publicIdentity, normalizeNickname, DOMAIN };
