import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeAlert,
  activeWarnings,
  parsePolygon,
  pointInPolygon,
  distanceToPolygonNm,
  warningDistanceNm,
  messageUrl,
  inForce,
} from '../js/warnings.js';

// Real IMO CAP messages from 12–14 Oct 2026.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/cap-2026-10.json', import.meta.url)));

test('normalise a CAP message: English and Icelandic, colour, times, polygon', () => {
  const [w] = normalizeAlert(fixtures[0]);
  assert.equal(w.colour, 'yellow');
  assert.equal(w.event, 'Weather Warning: Snow Storm');
  assert.equal(w.eventIs, 'Veðurviðvörun: Hríð');
  assert.equal(w.area, 'Westfjords');
  assert.equal(w.areaIs, 'Vestfirðir');
  assert.equal(w.onset, Date.parse('2026-10-14T11:00:00Z'));
  assert.equal(w.expires, Date.parse('2026-10-14T17:00:00Z'));
  assert.ok(w.polygons[0].length > 10);
  assert.match(w.description, /15-25 m\/s/);
});

test('orange update carries references to the messages it replaces', () => {
  const [w] = normalizeAlert(fixtures[1]);
  assert.equal(w.colour, 'orange');
  assert.equal(w.msgType, 'Update');
  assert.ok(w.references.length >= 1);
  assert.match(w.references[0], /^is-IMO-/);
});

test('active set: expired dropped, superseded dropped, cancels dropped, sorted by level', () => {
  const during = Date.parse('2026-10-14T06:00:00Z');
  const ws = activeWarnings(fixtures, during);
  assert.ok(ws.length >= 1);
  assert.equal(ws[0].colour, 'orange'); // most severe first
  assert.equal(activeWarnings(fixtures, Date.parse('2026-10-20T00:00:00Z')).length, 0);
  // an Update that references the yellow alert removes it
  const upd = structuredClone(fixtures[1]);
  upd.alert.references = `${fixtures[0].alert.sender},${fixtures[0].alert.identifier},${fixtures[0].alert.sent}`;
  const ids = activeWarnings([fixtures[0], upd], during).map((w) => w.identifier);
  assert.ok(!ids.includes(fixtures[0].alert.identifier));
  const cancel = structuredClone(fixtures[0]);
  cancel.alert.msgType = 'Cancel';
  assert.equal(activeWarnings([cancel], during).length, 0);
  const t = structuredClone(fixtures[0]);
  t.alert.status = 'Test';
  assert.equal(activeWarnings([t], during).length, 0);
});

test('in force vs upcoming', () => {
  const [w] = normalizeAlert(fixtures[0]);
  assert.equal(inForce(w, Date.parse('2026-10-14T10:00:00Z')), false);
  assert.equal(inForce(w, Date.parse('2026-10-14T12:00:00Z')), true);
});

test('geometry: inside, outside and distance to the Westfjords polygon', () => {
  const [w] = normalizeAlert(fixtures[0]);
  const isafjordur = { lat: 66.07, lon: -23.13 };
  const reykjavik = { lat: 64.15, lon: -21.94 };
  assert.equal(warningDistanceNm(w, isafjordur), 0);
  const d = warningDistanceNm(w, reykjavik);
  assert.ok(d > 60 && d < 150, `RVK to Westfjords ${d} NM`);
  const sq = parsePolygon('64,-22 64,-21 65,-21 65,-22 64,-22');
  assert.equal(pointInPolygon([64.5, -21.5], sq), true);
  assert.equal(pointInPolygon([63.9, -21.5], sq), false);
  // 0.1° south of the square = 6 NM
  assert.ok(Math.abs(distanceToPolygonNm({ lat: 63.9, lon: -21.5 }, sq) - 6) < 0.3);
});

test('message URL is encoded', () => {
  const u = messageUrl({ sender: 'IMO-Icelandic_Met_Office', identifier: 'is-IMO-1', sent: '2026-10-12T12:42:47-00:00' });
  assert.equal(u, 'https://api.vedur.is/cap/capbroker/sender/IMO-Icelandic_Met_Office/identifier/is-IMO-1/sent/2026-10-12T12%3A42%3A47-00%3A00/json');
});
