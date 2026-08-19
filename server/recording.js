'use strict';
//
// Record and replay the raw headset byte stream.
//
// We deliberately capture the RAW BYTES rather than parsed values, so replay
// exercises the identical parser path and reproduces real Bluetooth timing -
// including the bursty ~83-samples-every-~120ms delivery. A recording is
// therefore a faithful stand-in for the hardware, which is what makes it
// useful for developing visuals without wearing the headset.
//
// Format (.jsonl, deliberately human-inspectable for classroom use):
//   line 1  {"format":"espexp-raw-v1","createdAt":"...","sampleRate":512}
//   line n  {"t":<ms since start>,"d":"<hex bytes>"}

const fs = require('fs');
const path = require('path');

const FORMAT = 'espexp-raw-v1';

class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.stream = null;
    this.file = null;
    this.startedAt = 0;
    this.bytes = 0;
    this.chunks = 0;
  }

  get active() { return this.stream !== null; }

  start(name) {
    if (this.active) return { ok: false, error: 'already recording' };
    fs.mkdirSync(this.dir, { recursive: true });

    // Timestamped filename; a supplied name is sanitized to stay in this dir.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = (name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const base = safe ? `${stamp}_${safe}` : stamp;
    this.file = path.join(this.dir, `${base}.jsonl`);

    this.stream = fs.createWriteStream(this.file);
    this.startedAt = Date.now();
    this.bytes = 0;
    this.chunks = 0;
    this.stream.write(JSON.stringify({
      format: FORMAT,
      createdAt: new Date().toISOString(),
      sampleRate: 512,
    }) + '\n');
    return { ok: true, file: path.basename(this.file) };
  }

  write(chunk) {
    if (!this.active) return;
    this.bytes += chunk.length;
    this.chunks++;
    this.stream.write(JSON.stringify({
      t: Date.now() - this.startedAt,
      d: chunk.toString('hex'),
    }) + '\n');
  }

  stop() {
    if (!this.active) return { ok: false, error: 'not recording' };
    const file = path.basename(this.file);
    const ms = Date.now() - this.startedAt;
    this.stream.end();
    this.stream = null;
    return { ok: true, file, ms, bytes: this.bytes, chunks: this.chunks };
  }

  status() {
    return {
      active: this.active,
      file: this.file ? path.basename(this.file) : null,
      ms: this.active ? Date.now() - this.startedAt : 0,
      bytes: this.bytes,
    };
  }
}

class Player {
  /** @param onChunk called with a Buffer, on the recording's original timing */
  constructor(dir, onChunk) {
    this.dir = dir;
    this.onChunk = onChunk;
    this.timer = null;
    this.events = [];
    this.index = 0;
    this.file = null;
    this.loop = false;
    this.startedAt = 0;
    this.durationMs = 0;
  }

  get active() { return this.timer !== null || this.index > 0; }

  list() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const st = fs.statSync(path.join(this.dir, f));
          return { file: f, bytes: st.size, modified: st.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {
      return [];
    }
  }

  start(file, loop) {
    this.stop();
    // Keep the path inside the recordings dir.
    const full = path.join(this.dir, path.basename(file));
    if (!full.startsWith(this.dir) || !fs.existsSync(full)) {
      return { ok: false, error: 'no such recording' };
    }

    const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
    let header = null;
    const events = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.format) { header = obj; continue; }
      if (typeof obj.t === 'number' && typeof obj.d === 'string') {
        events.push({ t: obj.t, buf: Buffer.from(obj.d, 'hex') });
      }
    }
    if (!header || header.format !== FORMAT) {
      return { ok: false, error: 'unrecognized recording format' };
    }
    if (!events.length) return { ok: false, error: 'recording is empty' };

    this.events = events;
    this.file = path.basename(full);
    this.loop = !!loop;
    this.durationMs = events[events.length - 1].t;
    this.index = 0;
    this.startedAt = Date.now();
    this._schedule();
    return { ok: true, file: this.file, durationMs: this.durationMs, chunks: events.length };
  }

  _schedule() {
    if (this.index >= this.events.length) {
      if (this.loop) {
        this.index = 0;
        this.startedAt = Date.now();
      } else {
        this.timer = null;
        this.index = 0;
        this.file = null;
        return;
      }
    }
    const ev = this.events[this.index];
    const due = ev.t - (Date.now() - this.startedAt);
    this.timer = setTimeout(() => {
      // Emit every chunk that has come due, so we stay on schedule even if
      // the timer fires late.
      const elapsed = Date.now() - this.startedAt;
      while (this.index < this.events.length && this.events[this.index].t <= elapsed) {
        this.onChunk(this.events[this.index].buf);
        this.index++;
      }
      this._schedule();
    }, Math.max(0, due));
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.index = 0;
    this.file = null;
  }

  status() {
    return {
      active: this.timer !== null,
      file: this.file,
      posMs: this.timer ? Math.min(Date.now() - this.startedAt, this.durationMs) : 0,
      durationMs: this.durationMs,
      loop: this.loop,
    };
  }
}

module.exports = { Recorder, Player, FORMAT };
