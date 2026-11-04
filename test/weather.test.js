import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorAt,
  SCALES,
  beaufort,
  compass,
  latticeFor,
  latticePoints,
  openMeteoUrls,
  mergeSeries,
  timeIndex,
  toVector,
  sampleGrid,
  vectorMean,
} from '../js/weather.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('colour scale interpolates and clamps', () => {
  assert.deepEqual(colorAt(SCALES.kn, -5), SCALES.kn[0][1]);
  assert.deepEqual(colorAt(SCALES.kn, 999), SCALES.kn[SCALES.kn.length - 1][1]);
  assert.deepEqual(colorAt(SCALES.kn, 20), [225, 214, 52]);
  assert.equal(colorAt(SCALES.kn, NaN), null);
});

test('beaufort and compass', () => {
  assert.equal(beaufort(0.5), 0);
  assert.equal(beaufort(16.9), 4);
  assert.equal(beaufort(17), 5);
  assert.equal(beaufort(70), 12);
  assert.equal(compass(228), 'SW');
  assert.equal(compass(359), 'N');
  assert.equal(compass(NaN), '—');
});

test('lattice is snapped, stable and bounded', () => {
  const b = { south: 63.9, north: 64.6, west: -23.1, east: -21.4 };
  const g = latticeFor(b);
  assert.ok(g.nLat <= 13 && g.nLon <= 13, `${g.nLat}x${g.nLon}`);
  assert.ok(g.lat0 <= b.south && g.lon0 <= b.west);
  assert.ok(g.lat0 + (g.nLat - 1) * g.dlat >= b.north);
  // a small pan reuses the same lattice points
  const g2 = latticeFor({ south: 63.92, north: 64.62, west: -23.05, east: -21.35 });
  assert.equal(g2.dlat, g.dlat);
  const a = new Set(latticePoints(g).map((p) => `${p.lat},${p.lon}`));
  const shared = latticePoints(g2).filter((p) => a.has(`${p.lat},${p.lon}`)).length;
  assert.ok(shared > latticePoints(g2).length * 0.7);
  // whole of Iceland's waters stays within the cap
  const big = latticeFor({ south: 62, north: 68, west: -28, east: -10 });
  assert.ok(big.nLat * big.nLon <= 200, `${big.nLat * big.nLon} points`);
});

test('Open-Meteo URLs', () => {
  const u = openMeteoUrls([{ lat: 64.2, lon: -22.5 }, { lat: 65, lon: -24 }]);
  assert.match(u.forecast, /latitude=64\.2000,65\.0000&longitude=-22\.5000,-24\.0000/);
  assert.match(u.forecast, /wind_speed_unit=kn/);
  assert.match(u.marine, /cell_selection=sea/);
  assert.match(u.marine, /ocean_current_velocity/);
});

test('merge forecast + marine, converting current to knots', () => {
  const f = { hourly: { time: [0, 3600], wind_speed_10m: [10, 12], wind_direction_10m: [200, 210] } };
  const m = { hourly: { time: [3600, 0], ocean_current_velocity: [3.704, 1.852], ocean_current_direction: [90, 80], wave_height: [2, 1] } };
  const [s] = mergeSeries(f, m);
  assert.deepEqual(s.wind_speed_10m, [10, 12]);
  assert.deepEqual(s.wave_height, [1, 2]); // aligned by time
  near(s.current_kn[0], 1, 1e-9);
  near(s.current_kn[1], 2, 1e-9);
});

test('time index', () => {
  const t = [0, 3600, 7200];
  assert.equal(timeIndex(t, 3500), 1);
  assert.equal(timeIndex(t, -3600), -1);
  assert.equal(timeIndex(t, 7200 + 1700), 2);
});

test('vectors: wind FROM the north blows south', () => {
  const [e, n] = toVector(10, 0, true);
  near(e, 0, 1e-9);
  near(n, -10, 1e-9);
  const [e2, n2] = toVector(1, 90, false); // current TOWARDS east
  near(e2, 1, 1e-9);
  near(n2, 0, 1e-9);
});

test('bilinear sampling ignores missing corners', () => {
  const g = { lat0: 64, lon0: -23, dlat: 1, dlon: 1, nLat: 2, nLon: 2 };
  near(sampleGrid(g, [0, 10, 20, 30], 64.5, -22.5), 15, 1e-9);
  near(sampleGrid(g, [0, 10, 20, 30], 64, -23), 0, 1e-9);
  near(sampleGrid(g, [NaN, 10, NaN, 30], 64.5, -22.5), 20, 1e-9);
  assert.ok(Number.isNaN(sampleGrid(g, [1, 2, 3, 4], 66, -22)));
});

test('vector mean of directions across north', () => {
  const s = { time: [0, 3600], spd: [10, 10], dir: [350, 10] };
  const m = vectorMean(s, 'spd', 'dir', 0, 3600);
  near(m.dir < 180 ? m.dir : m.dir - 360, 0, 1e-6);
  near(m.speed, 10 * Math.cos((10 * Math.PI) / 180), 1e-6);
  assert.equal(vectorMean(s, 'spd', 'dir', 99999, 99999), null);
});

import { fillGaps } from '../js/weather.js';
test('gap filling spreads valid neighbours into missing cells', () => {
  const g = { nLat: 3, nLon: 3 };
  const out = fillGaps(g, [1, 1, NaN, 1, NaN, NaN, NaN, NaN, NaN], 3);
  assert.ok(out.every(Number.isFinite));
  assert.ok(out.every((v) => Math.abs(v - 1) < 1e-9));
  assert.deepEqual(fillGaps(g, Array(9).fill(NaN)).filter(Number.isFinite), []);
});
