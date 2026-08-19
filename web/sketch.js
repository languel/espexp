// Force Trainer II — live visualization.
//
// Deliberately plain p5 so students can pull it apart. Acquisition and parsing
// happen upstream; this file only decides how numbers become pixels.
//
// Pedagogical rule followed throughout: never present a derived value as if it
// were a measurement. Raw counts are labelled as ADC units, not volts, and the
// eSense metrics are labelled as NeuroSky's proprietary algorithms.

const RAW_SECONDS = 4;          // width of the scrolling waveform window
const SAMPLE_RATE = 512;
const RAW_CAPACITY = RAW_SECONDS * SAMPLE_RATE;

const BANDS = [
  'delta', 'theta', 'lowAlpha', 'highAlpha',
  'lowBeta', 'highBeta', 'lowGamma', 'highGamma',
];
const BAND_LABEL = {
  delta: 'DELTA', theta: 'THETA', lowAlpha: 'LOW ALPHA', highAlpha: 'HIGH ALPHA',
  lowBeta: 'LOW BETA', highBeta: 'HIGH BETA', lowGamma: 'LOW GAMMA', highGamma: 'HIGH GAMMA',
};

let rawBuf = [];
let latest = null;             // most recent 1 Hz aggregate
let lastUpdateAt = 0;
let status = { readerConnected: false, streaming: false, stats: null };

// Bluetooth delivers samples in bursts (~8/sec, ~83 samples each), which makes
// the trace lurch forward in visible steps. So arrivals go into a jitter buffer
// and are drained at a steady rate tied to wall-clock time, giving smooth
// scrolling at the display's frame rate. Nothing is invented: every sample
// drawn is a real sample, just released on an even cadence.
let sampleQueue = [];
let lastPumpMs = null;
let pumpCarry = 0;             // fractional samples owed from the last frame
let consumeRate = SAMPLE_RATE; // adapts to keep the backlog near TARGET_LAG
// Observed arrival gaps reach ~172 ms, so keep a cushion comfortably above that
// or the buffer starves and the trace stalls. ~200 ms of latency is
// imperceptible here and buys reliably continuous motion.
const TARGET_LAG = SAMPLE_RATE * 0.2;
const MAX_LAG = SAMPLE_RATE * 1.5;      // hard cap (e.g. after a backgrounded tab)

// Smoothed display values so the 1 Hz bars glide instead of snapping.
let dispBands = {};
let dispAttention = 0;
let dispMeditation = 0;

// Auto-scaling for the waveform: track a decaying peak so the trace fills the
// space without constantly rescaling on every spike.
let peak = 64;

let ws = null;
let wsConnected = false;

function setup() {
  createCanvas(windowWidth, windowHeight);
  textFont('Menlo, Monaco, monospace');
  connect();
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { wsConnected = true; };
  ws.onclose = () => { wsConnected = false; setTimeout(connect, 1500); };
  ws.onerror = () => { ws.close(); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'raw') {
      for (const s of msg.samples) sampleQueue.push(s);
      // If we fall badly behind (tab was hidden), drop the oldest backlog
      // rather than fast-forwarding through minutes of stale signal.
      if (sampleQueue.length > MAX_LAG) {
        sampleQueue.splice(0, sampleQueue.length - Math.floor(TARGET_LAG));
      }
    } else if (msg.type === 'update') {
      latest = msg;
      lastUpdateAt = millis();
    } else if (msg.type === 'status') {
      status = msg;
    }
  };
}

/**
 * Release queued samples into the display buffer at a steady rate.
 *
 * The drain rate is nudged by how much backlog is waiting: too much and we
 * speed up slightly, too little and we ease off. This tracks the true sample
 * rate (which is only nominally 512 Hz) without ever stalling or racing.
 */
function pumpSamples() {
  const now = millis();
  if (lastPumpMs === null) { lastPumpMs = now; return; }
  const dt = Math.min((now - lastPumpMs) / 1000, 0.25); // clamp after a stall
  lastPumpMs = now;

  const err = sampleQueue.length - TARGET_LAG;
  consumeRate = constrain(SAMPLE_RATE + err * 1.5, SAMPLE_RATE * 0.7, SAMPLE_RATE * 1.4);

  const want = consumeRate * dt + pumpCarry;
  let n = Math.floor(want);
  pumpCarry = want - n;
  if (n <= 0) return;
  n = Math.min(n, sampleQueue.length);
  if (n <= 0) { pumpCarry = 0; return; }

  for (let i = 0; i < n; i++) rawBuf.push(sampleQueue[i]);
  sampleQueue.splice(0, n);
  if (rawBuf.length > RAW_CAPACITY) rawBuf.splice(0, rawBuf.length - RAW_CAPACITY);
}

/** Ease the 1 Hz values toward their targets so bars glide between updates. */
function smoothDisplayValues() {
  const k = 0.12;
  if (latest && latest.bands) {
    for (const b of BANDS) {
      const target = latest.bands[b] || 0;
      dispBands[b] = dispBands[b] === undefined ? target : lerp(dispBands[b], target, k);
    }
  }
  if (latest && typeof latest.attention === 'number') {
    dispAttention = lerp(dispAttention, latest.attention, k);
  }
  if (latest && typeof latest.meditation === 'number') {
    dispMeditation = lerp(dispMeditation, latest.meditation, k);
  }
}

function draw() {
  pumpSamples();
  smoothDisplayValues();

  background(10, 14, 20);
  const M = 40;
  const w = width - 2 * M;
  let y = M;

  y = drawSignalQuality(M, y, w);

  // Give the waveform whatever vertical space is left once the fixed-height
  // sections below it are accounted for, so nothing collides with the footer.
  const bandsH = 22 + BANDS.length * 20;
  const eSenseH = 42 + 2 * 46;
  const footerH = 40;
  const gaps = 28 + 34 + 30;
  const waveH = constrain(height - y - bandsH - eSenseH - footerH - gaps, 90, 240);

  y = drawWaveform(M, y + 28, w, waveH);
  y = drawBands(M, y + 34, w);
  drawESense(M, y + 30, w);
  drawFooter();
}

// ---------------------------------------------------------------- sections

function drawSignalQuality(x, y, w) {
  // poorSignal: 0 = good contact, 200 = electrodes not touching skin.
  const hasData = latest && typeof latest.poorSignal === 'number';
  const poor = hasData ? latest.poorSignal : null;

  let label, col;
  if (!status.streaming) { label = 'NO DATA FROM HEADSET'; col = color(90, 100, 115); }
  else if (poor === null) { label = 'WAITING…'; col = color(90, 100, 115); }
  else if (poor === 0) { label = 'GOOD CONTACT'; col = color(60, 220, 130); }
  else if (poor >= 200) { label = 'NO SKIN CONTACT'; col = color(255, 70, 70); }
  else if (poor >= 100) { label = 'VERY POOR CONTACT'; col = color(255, 120, 40); }
  else if (poor >= 50) { label = 'POOR CONTACT'; col = color(255, 190, 40); }
  else { label = 'FAIR CONTACT'; col = color(180, 220, 60); }

  noStroke();
  fill(120, 135, 150);
  textSize(13);
  textAlign(LEFT, TOP);
  text('SIGNAL QUALITY', x, y);

  fill(col);
  textSize(38);
  text(label, x, y + 20);

  // Quality bar: full and green at 0, empty and red at 200.
  const barY = y + 70, barH = 14;
  noFill(); stroke(40, 48, 60); strokeWeight(1);
  rect(x, barY, w, barH);
  if (poor !== null) {
    const frac = 1 - constrain(poor, 0, 200) / 200;
    noStroke(); fill(col);
    rect(x + 1, barY + 1, (w - 2) * frac, barH - 2);
  }

  noStroke(); fill(110, 125, 140); textSize(12);
  const detail = poor === null ? 'poorSignal —' : `poorSignal ${poor} / 200  (0 = perfect, 200 = no contact)`;
  text(detail, x, barY + barH + 8);

  // Say plainly what bad contact invalidates - but only claim what is true at
  // this particular level. The firmware zeroes eSense only at full 200.
  if (poor !== null && poor > 0) {
    fill(255, 150, 60);
    const msg = poor >= 200
      ? 'no electrode contact — band powers are noise and eSense metrics are forced to 0'
      : 'imperfect contact — treat band powers and derived metrics as unreliable';
    text(msg, x, barY + barH + 26);
    return barY + barH + 46;
  }
  return barY + barH + 26;
}

function drawWaveform(x, y, w, h) {
  noStroke(); fill(120, 135, 150); textSize(13);
  text('RAW EEG WAVEFORM', x, y);
  fill(80, 92, 105); textSize(11);
  textAlign(RIGHT, TOP);
  text(`${SAMPLE_RATE} Hz · ${RAW_SECONDS}s window · arbitrary ADC units, not volts`, x + w, y);
  textAlign(LEFT, TOP);

  const top = y + 20;
  noFill(); stroke(30, 38, 48); strokeWeight(1);
  rect(x, top, w, h);
  stroke(28, 35, 45);
  line(x, top + h / 2, x + w, top + h / 2);   // zero line

  if (rawBuf.length > 1) {
    // Decaying auto-scale: rise instantly to new peaks, fall back slowly.
    let localMax = 1;
    for (const s of rawBuf) localMax = Math.max(localMax, Math.abs(s));
    peak = localMax > peak ? localMax : peak * 0.995 + localMax * 0.005;
    const scale = (h / 2 - 6) / Math.max(peak, 1);

    stroke(90, 200, 255); strokeWeight(1.2); noFill();
    beginShape();
    for (let i = 0; i < rawBuf.length; i++) {
      const px = x + (i / RAW_CAPACITY) * w;
      vertex(px, top + h / 2 - rawBuf[i] * scale);
    }
    endShape();

    noStroke(); fill(80, 92, 105); textSize(11);
    text(`±${Math.round(peak)}`, x + 6, top + 4);
  } else {
    noStroke(); fill(70, 80, 92); textSize(12);
    text('no samples yet', x + 10, top + h / 2 - 6);
  }
  return top + h;
}

function drawBands(x, y, w) {
  noStroke(); fill(120, 135, 150); textSize(13);
  text('EEG BAND POWER', x, y);
  fill(80, 92, 105); textSize(11);
  textAlign(RIGHT, TOP);
  text('ASIC_EEG_POWER · logarithmic · arbitrary units', x + w, y);
  textAlign(LEFT, TOP);

  const top = y + 22;
  const rowH = 20;
  const labelW = 110;
  const bands = latest && latest.bands ? latest.bands : null;

  for (let i = 0; i < BANDS.length; i++) {
    const name = BANDS[i];
    const ry = top + i * rowH;
    noStroke(); fill(150, 165, 180); textSize(11);
    text(BAND_LABEL[name], x, ry + 3);

    const barX = x + labelW;
    const barW = w - labelW - 90;
    noFill(); stroke(26, 33, 42); strokeWeight(1);
    rect(barX, ry, barW, rowH - 6);

    if (bands) {
      const v = bands[name] || 0;                       // true latest value
      const shown = dispBands[name] === undefined ? v : dispBands[name]; // eased
      // Band powers span several orders of magnitude, so log scale.
      // log10(1e6) ~ 6 is a reasonable full-scale ceiling for this device.
      const frac = constrain(Math.log10(Math.max(shown, 1)) / 6, 0, 1);
      const hue = map(i, 0, BANDS.length - 1, 200, 330);
      colorMode(HSB, 360, 100, 100);
      noStroke(); fill(hue, 65, 85);
      rect(barX + 1, ry + 1, Math.max(0, (barW - 2) * frac), rowH - 8);
      colorMode(RGB, 255);
      fill(110, 125, 140); textSize(10);
      textAlign(RIGHT, TOP);
      text(v.toLocaleString(), x + w, ry + 3);
      textAlign(LEFT, TOP);
    }
  }
  return top + BANDS.length * rowH;
}

function drawESense(x, y, w) {
  noStroke(); fill(120, 135, 150); textSize(13);
  text('PROPRIETARY DERIVED METRICS', x, y);

  fill(255, 150, 60); textSize(11);
  text('NeuroSky algorithms — not direct measurements of mental states', x, y + 18);

  const items = [
    ['NeuroSky "Attention"', latest ? latest.attention : null, dispAttention],
    ['NeuroSky "Meditation"', latest ? latest.meditation : null, dispMeditation],
  ];
  items.forEach(([label, val, eased], i) => {
    const iy = y + 42 + i * 46;
    fill(150, 165, 180); textSize(12);
    text(label, x, iy + 12);

    const barX = x + 200;
    const barW = w - 200 - 70;
    noFill(); stroke(26, 33, 42); strokeWeight(1);
    rect(barX, iy, barW, 20);
    if (typeof val === 'number') {
      noStroke(); fill(val === 0 ? color(70, 80, 92) : color(120, 160, 255));
      rect(barX + 1, iy + 1, (barW - 2) * (eased / 100), 18);
      fill(200, 215, 230); textSize(15);
      textAlign(RIGHT, TOP);
      text(val, x + w, iy + 2);
      textAlign(LEFT, TOP);
    }
  });
}

function drawFooter() {
  const s = status.stats;
  noStroke(); textSize(11);
  fill(wsConnected ? color(60, 200, 120) : color(255, 80, 80));
  const link = !wsConnected ? 'browser ⇄ server: disconnected'
    : !status.readerConnected ? 'server ⇄ reader: not connected (is ForceTrainerReader.app running?)'
    : status.streaming ? 'streaming' : 'reader connected, no data (headset asleep?)';
  textAlign(LEFT, BOTTOM);
  text(link, 40, height - 14);
  if (s) {
    fill(70, 80, 92);
    textAlign(RIGHT, BOTTOM);
    const lagMs = Math.round((sampleQueue.length / SAMPLE_RATE) * 1000);
    text(`${Math.round(frameRate())} fps · buffer ${lagMs}ms · packets ${s.packets.toLocaleString()} · ` +
         `bad checksums ${s.badChecksums} · resync ${s.resyncBytes}`,
         width - 40, height - 14);
  }
  textAlign(LEFT, TOP);
}
