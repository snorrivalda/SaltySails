import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import handler, { parseBbox } from '../api/ais.js';

test('bbox is clamped to Icelandic waters and ordered', () => {
  assert.deepEqual(parseBbox('64,-23,65,-21'), { south: 64, west: -23, north: 65, east: -21 });
  assert.deepEqual(parseBbox('65,-21,64,-23'), { south: 64, west: -23, north: 65, east: -21 });
  assert.deepEqual(parseBbox('-90,-180,90,180'), { south: 60, west: -32, north: 70, east: -8 });
  assert.deepEqual(parseBbox('nonsense'), { south: 60, west: -32, north: 70, east: -8 });
});

test('relay answers 503 without an API key', async () => {
  delete process.env.AISSTREAM_API_KEY;
  const srv = createServer(handler).listen(0);
  const port = srv.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/ais`);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not configured/);
  srv.close();
});

import { WebSocketServer } from 'ws';

test('relay subscribes with key + bbox and streams messages as SSE', async () => {
  const wss = new WebSocketServer({ port: 0 });
  let subscription = null;
  wss.on('connection', (sock) => {
    sock.on('message', (m) => {
      subscription = JSON.parse(m.toString());
      sock.send(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 251123000 }, Message: { PositionReport: { UserID: 251123000, Latitude: 64.1, Longitude: -22.1, Sog: 7, Cog: 90, TrueHeading: 91 } } }));
    });
  });
  process.env.AISSTREAM_API_KEY = 'test-key';
  process.env.AISSTREAM_URL = `ws://127.0.0.1:${wss.address().port}`;
  const srv = createServer(handler).listen(0);
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/ais?bbox=63,-24,65,-20`, { signal: ctrl.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('PositionReport')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  srv.close();
  wss.close();
  assert.equal(subscription.APIKey, 'test-key');
  assert.deepEqual(subscription.BoundingBoxes, [[[63, -24], [65, -20]]]);
  assert.match(text, /event: status\ndata: \{"connected":true/);
  assert.match(text, /\ndata: \{"MessageType":"PositionReport"/);
  delete process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_URL;
});

test('probe summarises the upstream stream as JSON', async () => {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) =>
    sock.on('message', () => {
      for (let i = 0; i < 3; i++)
        sock.send(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 251000000 + i, ShipName: `S${i}  ` }, Message: { PositionReport: {} } }));
      sock.close();
    }),
  );
  process.env.AISSTREAM_API_KEY = 'k';
  process.env.AISSTREAM_URL = `ws://127.0.0.1:${wss.address().port}`;
  const srv = createServer(handler).listen(0);
  const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/ais?probe=1`)).json();
  srv.close();
  wss.close();
  assert.equal(r.connected, true);
  assert.equal(r.messages, 3);
  assert.equal(r.sample[0].name, 'S0');
  delete process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_URL;
});
