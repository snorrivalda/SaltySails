// AIS relay for a Landhelgisgæslan (Icelandic Coast Guard) feed -> Server-Sent Events.
//
// LHG has no public AIS service; this adapter is for a data-sharing agreement.
// It speaks the usual way AIS is shared between authorities: NMEA 0183
// !AIVDM/!AIVDO sentences (optionally with IEC 61162 TAG blocks), over
//   tcp://host:port   tls://host:port   ws://…   wss://…
// configured in Vercel environment variables (never in the app):
//   LHG_AIS_URL       feed address (required)
//   LHG_AIS_LOGIN     optional line sent after connecting (if the feed wants one)
//   LHG_RELAY_TOKEN   access code the app must send (required: shared data
//                     is likely restricted, so the relay refuses to run open)
//
// GET /api/ais-lhg?token=…&bbox=south,west,north,east      SSE stream of decoded messages
// GET /api/ais-lhg?token=…&probe=1                         8-second health check (JSON)
//
// Decoding happens here, so only ships in the requested area are sent, plus
// distress beacons (AIS-SART/MOB/EPIRB) and SAR aircraft anywhere in Icelandic waters.

import net from 'node:net';
import tls from 'node:tls';
import { timingSafeEqual } from 'node:crypto';
import { createNmeaDecoder, classify, isDistress } from '../js/ais.js';
import { parseBbox } from './ais.js';

export const config = { maxDuration: 300 };
const MAX_SECONDS = 270;

/** Constant-time comparison of the access code. */
function tokenOk(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

/** Strip an IEC 61162-450 TAG block ("\s:LHG,c:1700000000*5A\!AIVDM,…"). */
export function stripTag(line) {
  const m = /^\\[^\\]*\\(.*)$/.exec(line.trim());
  return m ? m[1] : line.trim();
}

/**
 * Open the upstream feed and call onLine for every text line.
 * Returns a close() function.
 */
export function openFeed(url, login, { onOpen, onLine, onError, onClose }) {
  const u = new URL(url);
  let buf = '';
  const lines = (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const l of parts) if (l.trim()) onLine(l);
  };
  if (u.protocol === 'ws:' || u.protocol === 'wss:') {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      if (login) ws.send(login);
      onOpen();
    });
    ws.addEventListener('message', async (ev) => lines(`${typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text()}\n`));
    ws.addEventListener('error', () => onError('upstream connection failed'));
    ws.addEventListener('close', onClose);
    return () => ws.close();
  }
  if (u.protocol !== 'tcp:' && u.protocol !== 'tls:') throw new Error(`unsupported feed protocol ${u.protocol}`);
  const opts = { host: u.hostname, port: Number(u.port) };
  const sock = u.protocol === 'tls:' ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
  sock.setEncoding('ascii');
  sock.setTimeout(60000, () => sock.destroy(new Error('feed silent for 60 s')));
  sock.on(u.protocol === 'tls:' ? 'secureConnect' : 'connect', () => {
    if (login) sock.write(`${login}\r\n`);
    onOpen();
  });
  sock.on('data', lines);
  sock.on('error', (e) => onError(e.message));
  sock.on('close', onClose);
  return () => sock.destroy();
}

/**
 * Filter decoded messages for a viewing area: positions inside the box, the
 * latest static data of ships once they are in the box, and distress beacons
 * and SAR aircraft wherever they are (the feed itself covers Icelandic waters).
 */
export function createAreaFilter(box) {
  const statics = new Map(); // mmsi -> latest static message
  const inBox = new Set();
  const inside = (m) => m.lat >= box.south && m.lat <= box.north && m.lon >= box.west && m.lon <= box.east;
  return function filter(msg) {
    if (!msg || !msg.mmsi || msg.own) return [];
    const kind = classify(msg);
    const hasPos = Number.isFinite(msg.lat) && Number.isFinite(msg.lon);
    if (!hasPos) {
      statics.set(msg.mmsi, { ...(statics.get(msg.mmsi) ?? {}), ...msg });
      return inBox.has(msg.mmsi) ? [msg] : [];
    }
    if (isDistress(kind) || kind === 'sar-aircraft' || inside(msg)) {
      const out = [];
      if (!inBox.has(msg.mmsi) && statics.has(msg.mmsi)) out.push(statics.get(msg.mmsi));
      inBox.add(msg.mmsi);
      out.push(msg);
      return out;
    }
    inBox.delete(msg.mmsi);
    return [];
  };
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const feedUrl = process.env.LHG_AIS_URL;
  const token = process.env.LHG_RELAY_TOKEN;
  if (!feedUrl || !token) return json(res, 503, { error: 'Landhelgisgæslan AIS feed not configured' });
  const url = new URL(req.url, 'http://x');
  if (!tokenOk(url.searchParams.get('token'), token)) return json(res, 401, { error: 'access code required' });
  const box = parseBbox(url.searchParams.get('bbox'));
  const decode = createNmeaDecoder();

  if (url.searchParams.has('probe')) {
    const out = { connected: false, lines: 0, decoded: 0, types: {}, ms: 0 };
    const t0 = Date.now();
    let done = false;
    let close = () => {};
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      close();
      out.ms = Date.now() - t0;
      if (error) out.error = error;
      json(res, 200, out);
    };
    const timer = setTimeout(() => finish(), 8000);
    try {
      close = openFeed(feedUrl, process.env.LHG_AIS_LOGIN, {
        onOpen: () => (out.connected = true),
        onLine: (l) => {
          out.lines++;
          const m = decode(stripTag(l));
          if (m) {
            out.decoded++;
            out.types[m.type] = (out.types[m.type] || 0) + 1;
          }
        },
        onError: (e) => finish(e),
        onClose: () => finish(),
      });
    } catch (e) {
      finish(e.message);
    }
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const filter = createAreaFilter(box);
  let closed = false;
  let close = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(ping);
    close();
    res.end();
  };
  const timer = setTimeout(finish, MAX_SECONDS * 1000);
  const ping = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', finish);
  try {
    close = openFeed(feedUrl, process.env.LHG_AIS_LOGIN, {
      onOpen: () => res.write(`event: status\ndata: ${JSON.stringify({ connected: true, bbox: box })}\n\n`),
      onLine: (l) => {
        for (const m of filter(decode(stripTag(l)))) res.write(`data: ${JSON.stringify(m)}\n\n`);
      },
      onError: (e) => {
        res.write(`event: status\ndata: ${JSON.stringify({ error: e })}\n\n`);
        finish();
      },
      onClose: finish,
    });
  } catch (e) {
    res.write(`event: status\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    finish();
  }
}
