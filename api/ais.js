// AIS relay: aisstream.io -> Server-Sent Events for the SaltySails app.
//
// aisstream.io must not be called from browsers (the API key would be exposed),
// so this Vercel function holds the key (env AISSTREAM_API_KEY), opens the
// aisstream WebSocket for the requested area and streams the messages to the
// browser as SSE. Each response lasts up to MAX_SECONDS; EventSource reconnects.
//
// GET /api/ais?bbox=south,west,north,east   (clamped to Icelandic waters)

export const config = { maxDuration: 300 };

const MAX_SECONDS = 270;
// Icelandic SAR region, roughly; requests outside it are clamped to it.
const LIMIT = { south: 60, north: 70, west: -32, east: -8 };
const TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
  'StandardSearchAndRescueAircraftReport',
  'AidsToNavigationReport',
];

export function parseBbox(q) {
  const v = String(q || '')
    .split(',')
    .map(Number);
  const [s, w, n, e] = v.length === 4 && v.every(Number.isFinite) ? v : [LIMIT.south, LIMIT.west, LIMIT.north, LIMIT.east];
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const south = clamp(Math.min(s, n), LIMIT.south, LIMIT.north);
  const north = clamp(Math.max(s, n), LIMIT.south, LIMIT.north);
  const west = clamp(Math.min(w, e), LIMIT.west, LIMIT.east);
  const east = clamp(Math.max(w, e), LIMIT.west, LIMIT.east);
  return { south, west, north, east };
}

export default async function handler(req, res) {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'AIS relay not configured (AISSTREAM_API_KEY missing)' }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const b = parseBbox(url.searchParams.get('bbox'));
  if (url.searchParams.has('probe')) return probe(key, b, res);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);

  const ws = new WebSocket(process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream');
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(ping);
    try {
      ws.close();
    } catch {}
    res.end();
  };
  const timer = setTimeout(finish, MAX_SECONDS * 1000);
  const ping = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', finish);

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        APIKey: key,
        BoundingBoxes: [
          [
            [b.south, b.west],
            [b.north, b.east],
          ],
        ],
        FilterMessageTypes: TYPES,
      }),
    );
    res.write(`event: status\ndata: ${JSON.stringify({ connected: true, bbox: b })}\n\n`);
  });
  ws.addEventListener('message', async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text();
    if (text.includes('"error"')) res.write(`event: status\ndata: ${text.replace(/\n/g, ' ')}\n\n`);
    else res.write(`data: ${text.replace(/\n/g, ' ')}\n\n`);
  });
  ws.addEventListener('close', finish);
  ws.addEventListener('error', () => {
    res.write(`event: status\ndata: ${JSON.stringify({ error: 'upstream connection failed' })}\n\n`);
    finish();
  });
}

/**
 * Health check: connect for up to 8 s and summarise what arrives (no message
 * content beyond MMSI, name and type). GET /api/ais?probe=1&bbox=…
 */
function probe(key, b, res) {
  const started = Date.now();
  const out = { connected: false, messages: 0, types: {}, sample: [], bbox: b };
  const ws = new WebSocket(process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream');
  let done = false;
  const finish = (error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      ws.close();
    } catch {}
    out.ms = Date.now() - started;
    if (error) out.error = error;
    console.log('ais probe', JSON.stringify({ connected: out.connected, messages: out.messages, error: out.error }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
  };
  const timer = setTimeout(() => finish(), 8000);
  ws.addEventListener('open', () => {
    out.connected = true;
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[b.south, b.west], [b.north, b.east]]], FilterMessageTypes: TYPES }));
  });
  ws.addEventListener('message', async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return;
    }
    if (j.error) return finish(String(j.error));
    out.messages++;
    out.types[j.MessageType] = (out.types[j.MessageType] || 0) + 1;
    if (out.sample.length < 5) out.sample.push({ mmsi: j.MetaData?.MMSI, name: j.MetaData?.ShipName?.trim(), type: j.MessageType });
    if (out.messages >= 25) finish();
  });
  ws.addEventListener('error', () => finish('upstream connection failed'));
  ws.addEventListener('close', () => finish());
}
