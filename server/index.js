'use strict';
//
// Bridge: raw bytes -> ThinkGear parse -> browser.
//
// Bytes come from one of three sources, switchable at runtime:
//   live      - the Swift reader over TCP :9000
//   playback  - a recorded byte stream replayed with its original timing
//   simulated - synthesised ThinkGear frames, so the demo runs with no hardware
//
// Either way they go through the same parser, so playback is a faithful
// stand-in for the hardware. Raw waveform and 1 Hz aggregates are sent as
// separate message types; nothing pretends they arrived together.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ThinkGearParser } = require('./thinkgear-parser');
const { Recorder, Player } = require('./recording');
const { Simulator } = require('./simulator');

const HTTP_PORT = 8080;
const READER_HOST = '127.0.0.1';
const READER_PORT = 9000;
const WEB_DIR = path.join(__dirname, '..', 'web');
const REC_DIR = path.join(__dirname, '..', 'recordings');

let mode = 'live';              // 'live' | 'playback' | 'simulated'
let parser = new ThinkGearParser();

// ------------------------------------------------------------ byte routing

/** Every byte from either source funnels through here. */
function feed(chunk, from) {
  if (from !== mode) return;    // ignore the source we are not listening to
  if (from === 'live') recorder.write(chunk);
  lastDataAt = Date.now();
  const { raw, updates } = parser.push(chunk);
  if (raw.length) broadcast({ type: 'raw', samples: raw, sampleRate: 512 });
  for (const u of updates) broadcast({ type: 'update', ...u });
}

const recorder = new Recorder(REC_DIR);
const player = new Player(REC_DIR, (buf) => feed(buf, 'playback'));
const simulator = new Simulator((buf) => feed(buf, 'simulated'));

/** Switching sources resets the parser so a half-packet can't bridge them. */
function setMode(next) {
  if (next === mode) return;
  mode = next;
  parser = new ThinkGearParser();
  if (next !== 'playback') player.stop();
  if (next !== 'simulated') simulator.stop();
  console.log(`mode -> ${next}`);
}

// ---------------------------------------------------------------- http api

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    switch (url) {
      case '/api/state':
        return json(res, state());
      case '/api/recordings':
        return json(res, { recordings: player.list() });
      case '/api/record/start': {
        if (mode !== 'live') return json(res, { ok: false, error: 'switch to live to record' }, 400);
        return json(res, recorder.start(body.name));
      }
      case '/api/record/stop':
        return json(res, recorder.stop());
      case '/api/play': {
        setMode('playback');
        const r = player.start(body.file, body.loop);
        if (!r.ok) setMode('live');
        return json(res, r);
      }
      case '/api/live':
        setMode('live');
        return json(res, { ok: true });
      case '/api/simulate':
        setMode('simulated');
        simulator.start();
        return json(res, { ok: true });
      default:
        return json(res, { error: 'unknown endpoint' }, 404);
    }
  }

  const rel = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ------------------------------------------------------- websocket (RFC 6455)

const clients = new Set();
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  console.log(`browser connected (${clients.size} total)`);
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
  socket.resume();
});

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(obj) {
  if (!clients.size) return;
  const buf = frame(JSON.stringify(obj));
  for (const c of clients) {
    if (c.writable) c.write(buf); else clients.delete(c);
  }
}

// ------------------------------------------------------------ status + link

let readerConnected = false;
let lastDataAt = 0;

function state() {
  return {
    mode,
    readerConnected,
    streaming: Date.now() - lastDataAt < 2000,
    recording: recorder.status(),
    playback: player.status(),
    stats: parser.stats,
  };
}

setInterval(() => broadcast({ type: 'status', ...state() }), 500);

function connectReader() {
  const sock = net.connect(READER_PORT, READER_HOST, () => {
    readerConnected = true;
    console.log('connected to reader on :' + READER_PORT);
  });
  sock.setNoDelay(true);
  sock.on('data', (chunk) => feed(chunk, 'live'));

  // 'error' and 'close' both fire for a failed socket, so guard against
  // scheduling two reconnect chains (which doubles on every cycle).
  let retryScheduled = false;
  const retry = () => {
    if (retryScheduled) return;
    retryScheduled = true;
    if (readerConnected) console.log('reader link lost; retrying');
    readerConnected = false;
    sock.destroy();
    setTimeout(connectReader, 1500);
  };
  sock.on('error', retry);
  sock.on('close', retry);
}

server.listen(HTTP_PORT, () => {
  console.log(`open http://localhost:${HTTP_PORT}`);
  connectReader();
});
