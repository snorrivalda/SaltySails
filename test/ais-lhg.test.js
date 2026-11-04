import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import handler, { stripTag, createAreaFilter } from '../api/ais-lhg.js';
import { createNmeaDecoder } from '../js/ais.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/ais-nmea.json', import.meta.url)));
const all = fixtures.flatMap((f) => f.sentences);

test('TAG blocks are stripped', () => {
  assert.equal(stripTag('\\s:LHG,c:1700000000*5A\\!AIVDM,1,1,,A,abc,0*00'), '!AIVDM,1,1,,A,abc,0*00');
  assert.equal(stripTag('!AIVDM,1,1,,A,abc,0*00'), '!AIVDM,1,1,,A,abc,0*00');
});

test('area filter: in-box ships, their static data, distress and SAR aircraft anywhere', () => {
  // small box around Reykjavík: THOR (64.16,-21.95) is in; the SART (66.1,-23.1) and
  // SAR aircraft (64.5,-22.5) are outside but must still pass; the vessel off Reykjanes is out.
  const filter = createAreaFilter({ south: 64.1, north: 64.25, west: -22.1, east: -21.8 });
  const decode = createNmeaDecoder();
  const passed = [];
  // static (type 5) first: held back until THOR shows up in the box
  const type5 = fixtures.find((f) => f.expected.msg_type === 5);
  for (const s of type5.sentences) passed.push(...filter(decode(s)));
  assert.equal(passed.length, 0);
  for (const s of all.filter((s) => !type5.sentences.includes(s))) passed.push(...filter(decode(s)));
  const mmsis = passed.map((m) => m.mmsi);
  assert.ok(mmsis.includes(251999000), 'THOR position');
  assert.ok(passed.some((m) => m.mmsi === 251999000 && m.name === 'THOR'), 'THOR static sent when it entered the box');
  assert.ok(mmsis.includes(970012345), 'SART outside the box still sent');
  assert.ok(mmsis.includes(111251100), 'SAR aircraft outside the box still sent');
  assert.ok(!mmsis.includes(251123000), 'vessel off Reykjanes filtered out');
});

function mockFeed(lines, { requireLogin } = {}) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      const send = () => sock.write(lines.map((l) => `\\s:LHG,c:1762257600*00\\${l}`).join('\r\n') + '\r\n');
      if (!requireLogin) return send();
      sock.once('data', (d) => (d.toString().trim() === requireLogin ? send() : sock.destroy()));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function withRelay(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const srv = createServer(handler).listen(0);
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/api/ais-lhg`);
  } finally {
    srv.close();
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('relay refuses without configuration or with a wrong access code', async () => {
  await withRelay({ LHG_AIS_URL: '', LHG_RELAY_TOKEN: '' }, async (u) => {
    assert.equal((await fetch(u)).status, 503);
  });
  await withRelay({ LHG_AIS_URL: 'tcp://127.0.0.1:1', LHG_RELAY_TOKEN: 'secret' }, async (u) => {
    assert.equal((await fetch(u)).status, 401);
    assert.equal((await fetch(`${u}?token=wrong`)).status, 401);
  });
});

test('relay: TCP feed with login line, TAG blocks, probe and SSE stream', async () => {
  const feed = await mockFeed(all, { requireLogin: 'LOGIN saltysails pw' });
  const env = { LHG_AIS_URL: `tcp://127.0.0.1:${feed.address().port}`, LHG_AIS_LOGIN: 'LOGIN saltysails pw', LHG_RELAY_TOKEN: 'secret' };
  await withRelay(env, async (u) => {
    const p = await (await fetch(`${u}?token=secret&probe=1`)).json();
    assert.equal(p.connected, true);
    assert.equal(p.lines, all.length);
    assert.equal(p.decoded, fixtures.length);

    const ctrl = new AbortController();
    const r = await fetch(`${u}?token=secret&bbox=64.1,-22.1,64.25,-21.8`, { signal: ctrl.signal });
    const reader = r.body.getReader();
    let text = '';
    while (!(text.includes('970012345') && text.includes('"THOR"'))) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    assert.match(text, /event: status\ndata: \{"connected":true/);
    assert.ok(!text.includes('251123000'), 'out-of-area vessel not streamed');
  });
  feed.close();
});
