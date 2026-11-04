import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import handler, { allowedPath } from '../api/sjolag-pm.js';

test('only sjolag.is PMTiles and the style file are allowed', () => {
  assert.ok(allowedPath('tiles/forecast/GRINDAVIK_2026-11-04_00_00_00_0.pmtiles'));
  assert.ok(allowedPath('static/tiles/base/map-v1.pmtiles'));
  assert.ok(allowedPath('tiles/style.json'));
  for (const bad of ['api/buoys', '../etc/passwd', 'tiles/forecast/../../x.pmtiles', 'https://evil.example/x.pmtiles', 'tiles/forecast/a.js', null])
    assert.equal(allowedPath(bad), false, String(bad));
});

test('Range is forwarded and the 206 + Content-Range come back unchanged', async () => {
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const up = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) return res.writeHead(200, { 'content-length': data.length }).end(data);
    const [a, b] = [Number(m[1]), Number(m[2])];
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${data.length}`, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' });
    res.end(data.subarray(a, b + 1));
  }).listen(0);
  process.env.SJOLAG_ORIGIN = `http://127.0.0.1:${up.address().port}`;
  const srv = createServer(handler).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/sjolag-pm`;
  const r = await fetch(`${base}?p=tiles/forecast/VIK_2026-11-04_00_00_00_0.pmtiles`, { headers: { range: 'bytes=100-149' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-149/1000');
  assert.match(r.headers.get('cache-control'), /^private/);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.length, 50);
  assert.equal(body[0], 100);
  assert.equal((await fetch(`${base}?p=api/buoys/measurements`)).status, 400);
  srv.close();
  up.close();
  delete process.env.SJOLAG_ORIGIN;
});
