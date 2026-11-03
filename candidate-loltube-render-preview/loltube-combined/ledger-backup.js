'use strict';
/* Experimental isolated LOLTUBE ledger. The legacy mutable backup is used only
 * for a separately coordinated, one-time import; it is never overwritten here.
 * Store must have a new namespace, never the old loltube/db.json namespace.
 * Correctness still depends on provider conditional-create and read consistency. */
const { Ledger } = require('../gplus-cloud/ledger');
const { validate } = require('../loltube-safety/verified-backup');
const FILE = 'accounts-v1.json'; // private ledger slot; contents are LOLTUBE DB
class LoltubeLedger {
  constructor(store) { this.ledger = new Ledger(store); this.ready = false; }
  async recover() {
    this.ready = false;
    const restored = await this.ledger.recover();
    if (restored.seq === 0) { this.ready = false; return null; }
    if (Object.keys(restored.files).length !== 1 || !restored.files[FILE]) throw Error('invalid_loltube_ledger');
    validate(restored.files[FILE]); this.ready = true; return Buffer.from(restored.files[FILE]);
  }
  async importOnce(legacyBackup) {
    validate(legacyBackup);
    if (this.ready || this.ledger.seq !== 0 || await this.ledger.changedExternally()) throw Error('ledger_already_initialized');
    const result = await this.ledger.commit({ [FILE]: Buffer.from(legacyBackup) }); this.ready = true; return result;
  }
  async changedExternally() { if (!this.ready) throw Error('ledger_not_initialized'); return this.ledger.changedExternally(); }
  async commit(raw) {
    if (!this.ready) throw Error('ledger_not_initialized'); validate(raw);
    if (await this.ledger.changedExternally()) throw Error('ledger_stale');
    return this.ledger.commit({ [FILE]: Buffer.from(raw) });
  }
}
module.exports = { LoltubeLedger, FILE };
