'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { LoltubeLedger } = require('./ledger-backup');
class Memory {
  constructor() { this.m = new Map(); this.fail = false; this.lost = false; }
  async get(k) { if (this.fail) throw Error('synthetic_outage'); return this.m.has(k) ? Buffer.from(this.m.get(k)) : null; }
  async putOnce(k, b) { if (this.fail) throw Error('synthetic_outage'); if (this.m.has(k)) return false;
    this.m.set(k, Buffer.from(b)); if (this.lost) { this.lost = false; throw Error('lost_response'); } return true; }
  async setHead(b) { if (this.fail) throw Error('synthetic_outage'); this.m.set('head.json', Buffer.from(b)); }
}
const db = label => Buffer.from(JSON.stringify({ users: [{ id: label }], videos: [] }));
test('one-time import and restart recover immutable state independently of legacy mutable backup', async () => {
  const store = new Memory(); let legacy = db('initial'); const first = new LoltubeLedger(store);
  assert.equal(await first.recover(), null); await first.importOnce(legacy); await first.commit(db('committed'));
  legacy = db('old-writer-overwrite'); const next = new LoltubeLedger(store);
  assert.deepEqual(await next.recover(), db('committed')); assert.notDeepEqual(await next.recover(), legacy);
  await assert.rejects(next.importOnce(legacy), /ledger_already_initialized/);
});
test('two initialized instances cannot both acknowledge competing states', async () => {
  const store = new Memory(), initial = new LoltubeLedger(store); await initial.recover(); await initial.importOnce(db('initial'));
  const a = new LoltubeLedger(store), b = new LoltubeLedger(store); await a.recover(); await b.recover();
  const outcomes = await Promise.allSettled([a.commit(db('writer-a')), b.commit(db('writer-b'))]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const recovered = new LoltubeLedger(store), bytes = await recovered.recover();
  const winner = outcomes[0].status === 'fulfilled' ? 'writer-a' : 'writer-b'; assert.deepEqual(bytes, db(winner));
  const loser = winner === 'writer-a' ? b : a; assert.equal(await loser.changedExternally(), true);
});
test('absent, invalid and unavailable data are never treated as an initialized empty database', async () => {
  const store = new Memory(), a = new LoltubeLedger(store); assert.equal(await a.recover(), null);
  await assert.rejects(a.importOnce(Buffer.from('{"users":[]}')), /invalid_backup/);
  await a.importOnce(db('initial')); const head = store.m.get('head.json'); store.m.set('head.json', Buffer.from('broken'));
  await assert.rejects(new LoltubeLedger(store).recover(), /invalid_head/); store.m.set('head.json', head);
  store.fail = true; await assert.rejects(new LoltubeLedger(store).recover(), /synthetic_outage/);
});
test('ambiguous immutable write is accepted only if its exact bytes can be recovered', async () => {
  const store = new Memory(), a = new LoltubeLedger(store); await a.recover(); await a.importOnce(db('initial'));
  store.lost = true; await a.commit(db('changed')); const b = new LoltubeLedger(store); assert.deepEqual(await b.recover(), db('changed'));
});
