'use strict';
// Multiplex a bounded number of loopback TCP streams over one authenticated WSS.
// Each direction permits one <=64 KiB unacknowledged DATA frame per stream,
// preventing large file transfers from buffering entire objects in either peer.
const net = require('node:net');
const OPEN = 1, DATA = 2, ACK = 3, END = 4, RESET = 5;
const CHUNK = 64 * 1024, MAX_FRAME = CHUNK + 5;
class TunnelMux {
  constructor(ws, { connectPort = 0, maxStreams = 64 } = {}) {
    this.ws = ws; this.connectPort = connectPort; this.maxStreams = maxStreams;
    this.streams = new Map(); this.nextId = 1; this.closed = false;
    ws.on('message', (data, binary) => { if (binary) this.receive(Buffer.from(data)); else this.abort(); });
    ws.on('close', () => this.shutdown());
    ws.on('error', () => this.shutdown());
  }
  frame(type, id, payload) {
    if (this.closed || this.ws.readyState !== 1) return false;
    if (payload && payload.length > CHUNK) { this.abort(); return false; }
    const b = Buffer.allocUnsafe(5 + (payload ? payload.length : 0));
    b[0] = type; b.writeUInt32BE(id, 1); if (payload) payload.copy(b, 5);
    try { this.ws.send(b, { binary: true }, err => { if (err) this.abort(); }); return true; }
    catch (_) { this.abort(); return false; }
  }
  abort() { if (!this.closed) { this.shutdown(); try { this.ws.terminate(); } catch (_) {} } }
  shutdown() {
    if (this.closed) return; this.closed = true;
    for (const s of this.streams.values()) s.socket.destroy();
    this.streams.clear();
  }
  attach(id, socket) {
    const s = { id, socket, queued: [], inFlight: false, rxPending: false,
      localEnd: false, remoteEnd: false, endSent: false, reset: false };
    this.streams.set(id, s); socket.setNoDelay(true);
    socket.on('data', data => {
      socket.pause();
      for (let p = 0; p < data.length; p += CHUNK) s.queued.push(data.subarray(p, p + CHUNK));
      this.pump(s);
    });
    socket.on('end', () => { s.localEnd = true; this.pump(s); });
    socket.on('error', () => this.reset(s, true));
    socket.on('close', () => {
      if (!s.reset && !(s.localEnd && s.remoteEnd && s.endSent)) this.frame(RESET, id);
      this.streams.delete(id);
    });
    return s;
  }
  pump(s) {
    if (this.closed || s.reset || s.inFlight) return;
    if (s.queued.length) {
      s.inFlight = true;
      if (!this.frame(DATA, s.id, s.queued.shift())) this.reset(s, false);
    } else if (s.localEnd) {
      if (!s.endSent) { s.endSent = true; this.frame(END, s.id); }
    } else if (!s.socket.destroyed) s.socket.resume();
  }
  reset(s, notify) {
    if (!s || s.reset) return; s.reset = true;
    if (notify) this.frame(RESET, s.id);
    this.streams.delete(s.id); s.socket.destroy();
  }
  open(socket) {
    if (this.closed || this.connectPort || this.streams.size >= this.maxStreams) { socket.destroy(); return false; }
    let id = this.nextId++ >>> 0; if (!id) id = this.nextId++ >>> 0;
    while (this.streams.has(id)) { id = this.nextId++ >>> 0; if (!id) id = this.nextId++ >>> 0; }
    this.attach(id, socket);
    if (!this.frame(OPEN, id)) { this.reset(this.streams.get(id), false); return false; }
    return true;
  }
  receive(b) {
    if (this.closed || b.length < 5 || b.length > MAX_FRAME) return this.abort();
    const type = b[0], id = b.readUInt32BE(1), data = b.subarray(5);
    if (!id || (type !== DATA && data.length) || (type === DATA && !data.length)) return this.abort();
    let s = this.streams.get(id);
    if (type === OPEN) {
      if (!this.connectPort || s || this.streams.size >= this.maxStreams) { this.frame(RESET, id); return; }
      const socket = net.connect({ host: '127.0.0.1', port: this.connectPort, allowHalfOpen: true });
      this.attach(id, socket); return;
    }
    if (!s) { if (type !== RESET) this.frame(RESET, id); return; }
    if (type === DATA) {
      if (s.remoteEnd || s.rxPending) return this.reset(s, true);
      s.rxPending = true;
      try { s.socket.write(data, err => {
        if (err || s.reset || s.socket.destroyed) return this.reset(s, true);
        s.rxPending = false; this.frame(ACK, id);
      }); } catch (_) { this.reset(s, true); }
    } else if (type === ACK) {
      if (!s.inFlight) return this.reset(s, true);
      s.inFlight = false; this.pump(s);
    } else if (type === END) {
      if (s.remoteEnd) return this.reset(s, true);
      s.remoteEnd = true; s.socket.end();
    } else if (type === RESET) this.reset(s, false);
    else this.abort();
  }
}
module.exports = { TunnelMux, CHUNK, MAX_FRAME };
