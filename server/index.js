'use strict';
//
// Bridge: raw bytes (TCP from the Swift reader) -> ThinkGear parse -> browser.
//
// Serves the static page and a WebSocket feed on the same port, with a
// hand-rolled WebSocket server so the whole project stays dependency-free.
//
// Raw waveform and 1 Hz aggregates are sent as separate message types. The
// browser is never handed a merged object pretending everything arrived at
// the same instant.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ThinkGearParser } = require('./thinkgear-parser');

const HTTP_PORT = 8080;
const READER_HOST = '127.0.0.1';
const READER_PORT = 9000;
const WEB_DIR = path.join(__dirname, '..', 'web');

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
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

  socket.on('close', () => { clients.delete(socket); });
  socket.on('error', () => { clients.delete(socket); });
  socket.resume(); // drain incoming frames; we never read from the browser
});

/** Encode a text frame. Payloads here stay well under 64 KB. */
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
    if (c.writable) c.write(buf);
    else clients.delete(c);
  }
}

// ------------------------------------------------------------- reader link

const parser = new ThinkGearParser();
let readerSocket = null;
let connected = false;

// Raw samples are forwarded as soon as they are parsed. Bluetooth already
// delivers them in bursts (~8-15 chunks/sec), so this costs few messages, and
// any extra batching here would only add latency - the browser re-spaces the
// bursts into smooth motion on its own.

// Periodic link status so the UI can distinguish "no reader" from "no data".
let lastDataAt = 0;
setInterval(() => {
  broadcast({
    type: 'status',
    readerConnected: connected,
    streaming: Date.now() - lastDataAt < 2000,
    stats: parser.stats,
  });
}, 1000);

function connectReader() {
  readerSocket = net.connect(READER_PORT, READER_HOST, () => {
    connected = true;
    console.log('connected to reader on :' + READER_PORT);
  });
  readerSocket.setNoDelay(true);

  readerSocket.on('data', (chunk) => {
    lastDataAt = Date.now();
    const { raw, updates } = parser.push(chunk);
    if (raw.length) broadcast({ type: 'raw', samples: raw, sampleRate: 512 });
    for (const u of updates) broadcast({ type: 'update', ...u });
  });

  // 'error' and 'close' both fire for a failed socket, so guard against
  // scheduling two reconnect chains (which doubles on every cycle).
  let retryScheduled = false;
  const retry = () => {
    if (retryScheduled) return;
    retryScheduled = true;
    if (connected) console.log('reader link lost; retrying');
    connected = false;
    readerSocket.destroy();
    setTimeout(connectReader, 1500);
  };
  readerSocket.on('error', retry);
  readerSocket.on('close', retry);
}

server.listen(HTTP_PORT, () => {
  console.log(`open http://localhost:${HTTP_PORT}`);
  connectReader();
});
