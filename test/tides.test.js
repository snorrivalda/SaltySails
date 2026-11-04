import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heightAt, tideState, secondaryEvents, buildStations, nearestStations } from '../js/tides.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const min = (iso) => Date.parse(iso) / 60000;

// Worked examples printed in the LHG tide tables (Dæmi 1 and 2), which use the
// Table III method between a low and a high water.
test('Dæmi 1: Stykkishólmur 15:30 → 0.5 m', () => {
  const ev = [
    [min('2026-04-09T14:18Z'), 0.1, 'L'],
    [min('2026-04-09T20:28Z'), 4.8, 'H'],
  ];
  near(heightAt(ev, min('2026-04-09T15:30Z')), 0.5, 0.05);
});

test('Dæmi 2: Patreksfjörður 20:00 → 3.0 m', () => {
  const ev = [
    [min('2026-08-05T15:04Z'), 0.4, 'L'],
    [min('2026-08-05T21:01Z'), 3.2, 'H'],
  ];
  near(heightAt(ev, min('2026-08-05T20:00Z')), 3.0, 0.05);
});

test('height equals the table value at high and low water', () => {
  const ev = [
    [0, 0.2, 'L'],
    [370, 4.0, 'H'],
    [745, 0.4, 'L'],
  ];
  near(heightAt(ev, 0), 0.2, 1e-9);
  near(heightAt(ev, 370), 4.0, 1e-9);
  near(heightAt(ev, 185), 2.1, 1e-9); // half-way = mean of the two
  assert.equal(heightAt(ev, -1), null);
  assert.equal(heightAt(ev, 800), null);
});

test('state: rising/falling and rate peak at mid-tide', () => {
  const ev = [
    [0, 0.2, 'L'],
    [360, 4.0, 'H'],
    [720, 0.2, 'L'],
  ];
  const s = tideState(ev, 180);
  assert.equal(s.rising, true);
  // max rate = range * π / (2 * duration) per minute
  near(s.rate, ((3.8 * Math.PI) / (2 * 360)) * 60, 1e-9);
  assert.equal(tideState(ev, 400).rising, false);
});

test('secondary port: time shift and spring/neap height interpolation (Table II)', () => {
  const lv = { mhws: 4.0, mhwn: 3.0, mlwn: 1.3, mlws: 0.2 }; // Reykjavík
  const stykk = { dt: 30, dh: [0.4, 0.3, 0.2, 0.1] };
  const [hw, lw] = secondaryEvents(
    [
      [1000, 4.0, 'H'],
      [1370, 0.2, 'L'],
    ],
    lv,
    stykk,
  );
  assert.deepEqual(hw, [1030, 4.4, 'H']); // spring HW → spring difference
  assert.deepEqual(lw, [1400, 0.3, 'L']);
  const [hwNeap] = secondaryEvents([[0, 3.0, 'H']], lv, stykk);
  near(hwNeap[1], 3.3, 1e-9); // neap HW → neap difference
  const [hwMid] = secondaryEvents([[0, 3.5, 'H']], lv, stykk);
  near(hwMid[1], 3.85, 1e-9); // half-way between neap and spring
});

test('real 2026 data: Reykjavík 1 Jan matches Table I', () => {
  const data = JSON.parse(readFileSync(new URL('../data/tides-2026.json', import.meta.url)));
  const stations = buildStations(data);
  const rvk = stations.find((s) => s.id === 'reykjavik');
  assert.deepEqual(rvk.events.slice(0, 4), [
    [min('2026-01-01T04:15Z'), 3.8, 'H'],
    [min('2026-01-01T10:41Z'), 0.9, 'L'],
    [min('2026-01-01T16:43Z'), 3.5, 'H'],
    [min('2026-01-01T22:55Z'), 0.7, 'L'],
  ]);
  assert.equal(stations.length, 5 + 45);
  const [first] = nearestStations(stations, { lat: 65.08, lon: -22.72 });
  assert.equal(first.station.name, 'Stykkishólmur');
  // Stykkishólmur HW = Reykjavík HW + 30 min
  const st = first.station;
  assert.equal(st.events[0][0], rvk.events[0][0] + 30);
});
