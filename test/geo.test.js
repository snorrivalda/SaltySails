import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceNm,
  bearing,
  destination,
  crossTrackNm,
  formatPosition,
  parsePosition,
  expandingSquare,
  sectorSearch,
  parallelSearch,
  routeLengthNm,
  estimateDatum,
  toGpx,
} from '../js/geo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

const REYKJAVIK = { lat: 64.15, lon: -21.95 };

test('one minute of latitude is one nautical mile', () => {
  near(distanceNm({ lat: 64, lon: -22 }, { lat: 64 + 1 / 60, lon: -22 }), 1, 0.005);
});

test('bearing cardinal directions', () => {
  near(bearing(REYKJAVIK, { lat: 65, lon: -21.95 }), 0, 1e-6);
  near(bearing(REYKJAVIK, { lat: 63, lon: -21.95 }), 180, 1e-6);
  near(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 1e-6);
});

test('destination round-trips with distance and bearing', () => {
  const d = destination(REYKJAVIK, 237, 12.3);
  near(distanceNm(REYKJAVIK, d), 12.3, 1e-6);
  near(bearing(REYKJAVIK, d), 237, 1e-4);
});

test('cross-track sign: starboard is positive', () => {
  const a = { lat: 64, lon: -22 };
  const b = { lat: 65, lon: -22 }; // heading north
  near(crossTrackNm(a, b, { lat: 64.5, lon: -21.9 }), 2.6, 0.1); // east = starboard
  assert.ok(crossTrackNm(a, b, { lat: 64.5, lon: -22.1 }) < 0);
});

test('format DDM', () => {
  assert.equal(formatPosition({ lat: 64.141667, lon: -21.938333 }), "64°08.500'N 021°56.300'W");
  assert.equal(formatPosition({ lat: 63.9999999, lon: -22 }), "64°00.000'N 022°00.000'W");
});

test('format DMS and DD', () => {
  assert.equal(formatPosition({ lat: 64.141667, lon: -21.938333 }, 'dms'), `64°08'30.0"N 021°56'18.0"W`);
  assert.equal(formatPosition({ lat: 64.141667, lon: -21.938333 }, 'dd'), '64.14167°N 21.93833°W');
});

test('parse many formats', () => {
  const cases = [
    "64°08.500'N 021°56.300'W",
    '64 08.5N 021 56.3W',
    '64 08.5 N, 21 56.3 W',
    '64 08 30 N 021 56 18 W',
    '64.141667, -21.938333',
    '64,141667 -21,938333'.replace(' ', ';'),
    '64 08.5N 021 56.3V',
  ];
  for (const c of cases) {
    const p = parsePosition(c);
    assert.ok(p, `failed to parse ${c}`);
    near(p.lat, 64.141667, 1e-4, c);
    near(p.lon, -21.938333, 1e-4, c);
  }
  assert.equal(parsePosition('nonsense'), null);
  assert.equal(parsePosition('95 00N 021 00W'), null);
  assert.equal(parsePosition('64 75N 021 00W'), null);
});

test('expanding square leg lengths', () => {
  const pts = expandingSquare({ datum: REYKJAVIK, track: 0, spacing: 0.5, legs: 6 });
  assert.equal(pts.length, 7);
  const lens = pts.slice(1).map((p, i) => distanceNm(pts[i], p));
  [0.5, 0.5, 1, 1, 1.5, 1.5].forEach((L, i) => near(lens[i], L, 1e-3, `leg ${i + 1}`));
  near(bearing(pts[1], pts[2]), 90, 0.5); // right turn
});

test('sector search returns to datum every third leg with six radials', () => {
  const pts = sectorSearch({ datum: REYKJAVIK, track: 30, radius: 2 });
  assert.equal(pts.length, 10);
  for (const i of [0, 3, 6, 9]) near(distanceNm(pts[i], REYKJAVIK), 0, 1e-6, `pt ${i}`);
  const radials = [1, 2, 4, 5, 7, 8].map((i) => Math.round(bearing(REYKJAVIK, pts[i]))).sort((a, b) => a - b);
  // Outbound legs 30, 270, 150; crosslegs end at 90, 330, 210 → six radials 60° apart.
  assert.deepEqual(radials, [30, 90, 150, 210, 270, 330]);
});

test('parallel search geometry', () => {
  const pts = parallelSearch({ csp: REYKJAVIK, track: 90, spacing: 1, legLength: 5, legs: 4 });
  assert.equal(pts.length, 8); // csp + 4 legs + 3 steps
  near(routeLengthNm(pts), 4 * 5 + 3 * 1, 0.05);
  near(bearing(pts[1], pts[2]), 180, 0.5); // step to the right of an eastbound track = south
});

test('datum estimate combines leeway and current', () => {
  // Wind from north → leeway towards south 1 kn; current towards east 1 kn; 2 h.
  const { datum, driftBearing, driftNm } = estimateDatum({
    lkp: REYKJAVIK,
    hours: 2,
    windFrom: 0,
    leewayKn: 1,
    currentSet: 90,
    currentKn: 1,
  });
  near(driftBearing, 135, 1e-6);
  near(driftNm, 2 * Math.SQRT2, 1e-9);
  near(distanceNm(REYKJAVIK, datum), 2 * Math.SQRT2, 1e-6);
});

test('gpx escapes names', () => {
  const gpx = toGpx({ waypoints: [{ lat: 64, lon: -22, name: 'MOB <1> & co' }] });
  assert.match(gpx, /MOB &lt;1&gt; &amp; co/);
  assert.match(gpx, /<wpt lat="64.000000" lon="-22.000000">/);
});
