'use strict';
//
// ThinkGear packet parser.
//
// Frame format:
//   AA AA <payloadLength> <payload...> <checksum>
//   checksum = (~(sum of payload bytes & 0xFF)) & 0xFF
//
// Inside the payload, values are a series of (code, value) pairs. Codes below
// 0x80 carry a single byte; codes >= 0x80 are preceded by an explicit length.
// 0x55 bytes are "extended code" prefixes; this device never uses them, but we
// skip them anyway for correctness.
//
// Two very different rates arrive on the same wire, and we deliberately do NOT
// merge them into a single object:
//   - RAW_VALUE (0x80) at ~512 Hz: the actual sampled waveform
//   - everything else at ~1 Hz: signal quality, band powers, eSense metrics
//
// This device (Force Trainer II) was observed to emit exactly these codes:
//   0x80 RAW_VALUE, 0x02 POOR_SIGNAL, 0x83 ASIC_EEG_POWER,
//   0x04 ATTENTION, 0x05 MEDITATION.
// Notably it does NOT send 0x81 (EEG_POWER). We only report what arrives.

const CODES = {
  POOR_SIGNAL: 0x02,
  ATTENTION: 0x04,
  MEDITATION: 0x05,
  RAW_VALUE: 0x80,
  ASIC_EEG_POWER: 0x83,
};

const BAND_NAMES = [
  'delta', 'theta', 'lowAlpha', 'highAlpha',
  'lowBeta', 'highBeta', 'lowGamma', 'highGamma',
];

const SYNC = 0xaa;
const MAX_PAYLOAD = 169; // per spec; longer means we are misaligned

class ThinkGearParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.stats = { packets: 0, badChecksums: 0, resyncBytes: 0 };
  }

  /**
   * Feed arbitrary bytes.
   * Returns { raw, updates } where `raw` is the ~512 Hz waveform samples in
   * this chunk and `updates` are ~1 Hz aggregate readings (often empty).
   */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const raw = [];
    const updates = [];
    const b = this.buf;
    let i = 0;

    while (i < b.length - 1) {
      // 1. find sync
      if (!(b[i] === SYNC && b[i + 1] === SYNC)) {
        i++;
        this.stats.resyncBytes++;
        continue;
      }
      if (i + 2 >= b.length) break;

      // 2. payload length
      const len = b[i + 2];
      if (len > MAX_PAYLOAD) { i++; continue; }

      // 3. need whole payload + checksum before proceeding
      if (i + 3 + len >= b.length) break;

      const payload = b.subarray(i + 3, i + 3 + len);
      const checksum = b[i + 3 + len];

      // 4. validate checksum
      let sum = 0;
      for (const byte of payload) sum += byte;
      if (((~sum) & 0xff) !== checksum) {
        this.stats.badChecksums++;
        i++;               // resync from the next byte
        continue;
      }

      this.stats.packets++;
      this._parsePayload(payload, raw, updates);
      i += 3 + len + 1;
    }

    // keep the unconsumed tail for next time
    this.buf = i > 0 ? b.subarray(i) : b;
    return { raw, updates };
  }

  _parsePayload(payload, raw, updates) {
    let j = 0;
    const update = {};
    let hasUpdate = false;

    while (j < payload.length) {
      while (j < payload.length && payload[j] === 0x55) j++; // extended code prefix
      if (j >= payload.length) break;

      const code = payload[j++];
      let value;
      if (code >= 0x80) {
        if (j >= payload.length) break;
        const vlen = payload[j++];
        value = payload.subarray(j, j + vlen);
        j += vlen;
      } else {
        value = payload.subarray(j, j + 1);
        j++;
      }

      switch (code) {
        case CODES.RAW_VALUE:
          if (value.length === 2) raw.push(value.readInt16BE(0));
          break;
        case CODES.POOR_SIGNAL:
          update.poorSignal = value[0];
          hasUpdate = true;
          break;
        case CODES.ATTENTION:
          update.attention = value[0];
          hasUpdate = true;
          break;
        case CODES.MEDITATION:
          update.meditation = value[0];
          hasUpdate = true;
          break;
        case CODES.ASIC_EEG_POWER:
          if (value.length === 24) {
            const bands = {};
            for (let k = 0; k < 8; k++) {
              // 3-byte big-endian unsigned, arbitrary ASIC units (NOT volts)
              bands[BAND_NAMES[k]] =
                (value[k * 3] << 16) | (value[k * 3 + 1] << 8) | value[k * 3 + 2];
            }
            update.bands = bands;
            hasUpdate = true;
          }
          break;
        default:
          // Unknown code: record it rather than silently dropping, so we
          // notice if this device ever sends something undocumented.
          if (!update.unknownCodes) update.unknownCodes = {};
          update.unknownCodes[`0x${code.toString(16)}`] = Array.from(value);
          hasUpdate = true;
          break;
      }
    }

    if (hasUpdate) {
      update.timestamp = Date.now();
      updates.push(update);
    }
  }
}

module.exports = { ThinkGearParser, CODES, BAND_NAMES };
