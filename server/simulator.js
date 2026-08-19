'use strict';
//
// Synthetic ThinkGear source - lets the whole stack run with no headset.
//
// It emits REAL ThinkGear byte frames (correct sync, length, and checksum)
// rather than pre-parsed values, so the parser, the bridge, and the browser
// all behave exactly as they do with hardware. It also mimics the Bluetooth
// delivery pattern: bursts of ~64 samples about 8 times a second.
//
// The signal alternates between two states so the display actually does
// something teachable:
//   "eyes open"   - low alpha, more beta
//   "eyes closed" - strong ~10 Hz alpha, the classic EEG demonstration
//
// This is a plausible-looking synthesis, NOT recorded brain activity. It is
// labelled as simulated everywhere it surfaces in the UI.

const SAMPLE_RATE = 512;
const BURST_MS = 125;                      // ~8 bursts/sec, like the real link
const SAMPLES_PER_BURST = SAMPLE_RATE * BURST_MS / 1000;
const PHASE_SECONDS = 10;                  // how long each state lasts

/** Wrap a payload in a ThinkGear frame: AA AA len payload checksum. */
function frame(payload) {
  let sum = 0;
  for (const b of payload) sum += b;
  return Buffer.from([0xaa, 0xaa, payload.length, ...payload, (~sum) & 0xff]);
}

function rawPacket(value) {
  const v = Math.max(-32768, Math.min(32767, Math.round(value)));
  return frame([0x80, 0x02, (v >> 8) & 0xff, v & 0xff]);
}

function aggregatePacket({ poorSignal, bands, attention, meditation }) {
  const payload = [0x02, poorSignal & 0xff, 0x83, 0x18];
  for (const v of bands) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(v)));
    payload.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  payload.push(0x04, attention & 0xff, 0x05, meditation & 0xff);
  return frame(payload);
}

class Simulator {
  /** @param onChunk called with Buffers of ThinkGear bytes */
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.timer = null;
    this.aggTimer = null;
    this.n = 0;          // sample counter, drives phase
    this.attention = 50;
    this.meditation = 50;
  }

  get active() { return this.timer !== null; }

  /** True during the "eyes closed" half of the cycle. */
  eyesClosed() {
    return Math.floor(this.n / SAMPLE_RATE / PHASE_SECONDS) % 2 === 1;
  }

  start() {
    if (this.active) return { ok: false, error: 'already running' };
    this.timer = setInterval(() => this._burst(), BURST_MS);
    this.aggTimer = setInterval(() => this._aggregate(), 1000);
    return { ok: true };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.aggTimer) clearInterval(this.aggTimer);
    this.timer = null;
    this.aggTimer = null;
  }

  _burst() {
    const closed = this.eyesClosed();
    const bufs = [];
    for (let i = 0; i < SAMPLES_PER_BURST; i++) {
      const t = this.n / SAMPLE_RATE;
      // Sum of band-ish oscillators plus noise, in arbitrary ADC-like units.
      const v =
        60 * Math.sin(2 * Math.PI * 2.0 * t) +          // delta
        30 * Math.sin(2 * Math.PI * 6.0 * t) +          // theta
        (closed ? 90 : 12) * Math.sin(2 * Math.PI * 10.0 * t) + // alpha
        (closed ? 6 : 20) * Math.sin(2 * Math.PI * 20.0 * t) +  // beta
        8 * Math.sin(2 * Math.PI * 38.0 * t) +          // gamma
        (Math.random() - 0.5) * 24;                     // noise
      bufs.push(rawPacket(v));
      this.n++;
    }
    this.onChunk(Buffer.concat(bufs));
  }

  _aggregate() {
    const closed = this.eyesClosed();
    const jitter = (base) => base * (0.75 + Math.random() * 0.5);

    // Band powers in the same rough magnitudes the real ASIC reports.
    const bands = [
      jitter(90000),                        // delta
      jitter(35000),                        // theta
      jitter(closed ? 120000 : 6000),       // lowAlpha
      jitter(closed ? 60000 : 4000),        // highAlpha
      jitter(closed ? 5000 : 22000),        // lowBeta
      jitter(closed ? 4000 : 15000),        // highBeta
      jitter(6000),                         // lowGamma
      jitter(3000),                         // highGamma
    ];

    // Drift the eSense values instead of jumping, and push them in opposite
    // directions per state, mirroring how the real metrics tend to behave.
    const pull = (v, target) =>
      Math.max(0, Math.min(100, Math.round(v + (target - v) * 0.25 + (Math.random() - 0.5) * 6)));
    this.attention = pull(this.attention, closed ? 35 : 70);
    this.meditation = pull(this.meditation, closed ? 75 : 40);

    this.onChunk(aggregatePacket({
      poorSignal: 0,
      bands,
      attention: this.attention,
      meditation: this.meditation,
    }));
  }
}

module.exports = { Simulator };
