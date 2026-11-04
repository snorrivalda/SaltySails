import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandColor, bandForColor, timeKey, keyForUnix, featureKey, parseSources, arrowLayer, BANDS } from '../js/vg-waves.js';

test('band colours follow sjolag.is steps', () => {
  assert.equal(bandColor(0), '#f4f4f4');
  assert.equal(bandColor(0.5), '#CBF584');
  assert.equal(bandColor(2.4), '#00C665');
  assert.equal(bandColor(25), '#670800');
  assert.deepEqual(bandForColor('#00c665'), [2, 2.5]);
  assert.deepEqual(bandForColor('#670800'), [20, null]);
  assert.equal(bandForColor('#123456'), null);
  assert.equal(BANDS.length, 16);
});

test('both time spellings normalise to the same key', () => {
  assert.equal(timeKey('2026-11-04-15_00_00'), '2026110415');
  assert.equal(timeKey('2026-11-04 15:00:00'), '2026110415');
  assert.equal(keyForUnix(Date.parse('2026-11-04T15:00:00Z') / 1000), '2026110415');
  assert.equal(featureKey({ date: '2026-11-04-15_00_00' }), '2026110415');
  assert.equal(featureKey({ dt: '2026-11-04 15:00:00' }), '2026110415');
  assert.equal(timeKey(undefined), null);
});

test('sources from sjolag.is style, proxied, offshore first', () => {
  const style = {
    sources: {
      map: { type: 'vector', url: 'pmtiles://https://sjolag.is/static/tiles/base/map-v1.pmtiles' },
      waves_grindavik: { type: 'vector', url: 'pmtiles://https://sjolag.is/tiles/forecast/GRINDAVIK_2026-11-04_00_00_00_0.pmtiles' },
      waves: { type: 'vector', url: 'pmtiles://https://sjolag.is/tiles/forecast/uthaf_2026-11-04_00_00_00_0.pmtiles' },
      'coastal-areas': { type: 'geojson' },
    },
  };
  const s = parseSources(style);
  assert.deepEqual(
    s.map((x) => [x.area, x.url, x.minZoom]),
    [
      ['OFFSHORE', 'api/sjolag-pm?p=tiles/forecast/uthaf_2026-11-04_00_00_00_0.pmtiles', 0],
      ['GRINDAVIK', 'api/sjolag-pm?p=tiles/forecast/GRINDAVIK_2026-11-04_00_00_00_0.pmtiles', 7],
    ],
  );
  assert.equal(arrowLayer(s[0], 5), 'stefna_0');
  assert.equal(arrowLayer(s[0], 7), 'stefna_1');
  assert.equal(arrowLayer(s[0], 8), 'stefna_2');
  assert.equal(arrowLayer(s[1], 8), 'stefna_0');
});
