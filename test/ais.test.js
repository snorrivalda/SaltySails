import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  nmeaChecksumOk,
  createNmeaDecoder,
  fromSignalK,
  fromAisstream,
  classify,
  isDistress,
  createStore,
  cpaTcpa,
} from '../js/ais.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

// Sentences generated with pyais (independent reference implementation), with its decoded values.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/ais-nmea.json', import.meta.url)));

test('NMEA checksum', () => {
  assert.equal(nmeaChecksumOk(fixtures[0].sentences[0]), true);
  assert.equal(nmeaChecksumOk(fixtures[0].sentences[0].replace(/\*..$/, '*00')), false);
});

for (const fx of fixtures) {
  test(`decode matches pyais: ${fx.name}`, () => {
    const feed = createNmeaDecoder();
    let msg = null;
    for (const s of fx.sentences) msg = feed(s) ?? msg;
    assert.ok(msg, 'decoded');
    const e = fx.expected;
    assert.equal(msg.type, e.msg_type);
    assert.equal(msg.mmsi, e.mmsi);
    if ('status' in e) assert.equal(msg.status, e.status);
    if ('lat' in e) near(msg.lat, e.lat, 1e-5, 'lat');
    if ('lon' in e) near(msg.lon, e.lon, 1e-5, 'lon');
    if ('speed' in e) near(msg.sog, e.speed, 1e-9, 'sog');
    if ('course' in e) {
      if (e.course >= 360) assert.equal(msg.cog, null);
      else near(msg.cog, e.course, 1e-9, 'cog');
    }
    if ('heading' in e) assert.equal(msg.heading, e.heading === 511 ? null : e.heading);
    if (e.shipname) assert.equal(msg.name, e.shipname);
    if (e.name) assert.equal(msg.name, e.name);
    if ('ship_type' in e) assert.equal(msg.shipType, e.ship_type);
    if (e.callsign) assert.equal(msg.callsign, e.callsign);
    if (e.destination) assert.equal(msg.destination, e.destination);
    if ('alt' in e) assert.equal(msg.altitude, e.alt);
  });
}

test('multi-part message out of order is not decoded early; garbage ignored', () => {
  const type5 = fixtures.find((f) => f.expected.msg_type === 5);
  const feed = createNmeaDecoder();
  assert.equal(feed(type5.sentences[0]), null);
  assert.equal(feed('!AIVDM,garbage'), null);
  assert.equal(feed('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47'), null);
  assert.equal(feed(type5.sentences[1]).name, 'THOR');
});

test('store merges static and position data; classification', () => {
  const feed = createNmeaDecoder();
  const store = createStore();
  const at = 1_000_000;
  for (const fx of fixtures) for (const s of fx.sentences) store.update(feed(s), 'nmea', at);
  const thor = store.targets.get(251999000);
  assert.equal(thor.name, 'THOR');
  assert.equal(thor.kind, 'sar');
  near(thor.sog, 22, 1e-9);
  assert.equal(store.targets.get(970012345).kind, 'sart');
  assert.ok(isDistress(store.targets.get(970012345).kind));
  assert.equal(store.targets.get(111251100).kind, 'sar-aircraft');
  assert.equal(store.targets.get(992516001).kind, 'aton');
  const b = store.targets.get(251555000); // class B: position + 24A name + 24B type
  assert.equal(b.name, 'HAFORNINN');
  assert.equal(b.kind, 'pleasure');
  // pruning: ordinary targets go after 15 min, the SART stays for an hour
  store.prune(at + 20 * 60 * 1000);
  assert.equal(store.targets.has(251999000), false);
  assert.equal(store.targets.has(970012345), true);
  store.prune(at + 61 * 60 * 1000);
  assert.equal(store.targets.has(970012345), false);
});

test('classify by MMSI prefix and ship type', () => {
  assert.equal(classify({ mmsi: 972123456 }), 'mob');
  assert.equal(classify({ mmsi: 974123456 }), 'epirb');
  assert.equal(classify({ mmsi: 251000000, shipType: 30 }), 'fishing');
  assert.equal(classify({ mmsi: 251000000, shipType: 72 }), 'cargo');
  assert.equal(classify({ mmsi: 251000000 }), 'other');
});

test('Signal K delta: units converted, self excluded', () => {
  const delta = {
    context: 'vessels.urn:mrn:imo:mmsi:251123000',
    updates: [
      {
        values: [
          { path: 'navigation.position', value: { latitude: 64.1, longitude: -22.1 } },
          { path: 'navigation.speedOverGround', value: 5 }, // m/s
          { path: 'navigation.courseOverGroundTrue', value: Math.PI / 2 },
          { path: '', value: { name: 'SIGRUN' } },
          { path: 'design.aisShipType', value: { id: 30, name: 'Fishing' } },
        ],
      },
    ],
  };
  const [m] = fromSignalK(delta, 'vessels.urn:mrn:imo:mmsi:251000999');
  assert.equal(m.mmsi, 251123000);
  near(m.sog, 9.72, 0.01);
  near(m.cog, 90, 1e-9);
  assert.equal(m.name, 'SIGRUN');
  assert.equal(m.own, false);
  const [self] = fromSignalK({ ...delta, context: 'vessels.urn:mrn:imo:mmsi:251000999' }, 'vessels.urn:mrn:imo:mmsi:251000999');
  assert.equal(self.own, true);
  assert.deepEqual(fromSignalK({ context: 'vessels.foo', updates: [] }), []);
});

test('aisstream.io messages', () => {
  const pr = fromAisstream({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 251123000, ShipName: 'SIGRUN ', latitude: 64.1, longitude: -22.1 },
    Message: { PositionReport: { UserID: 251123000, Latitude: 64.1, Longitude: -22.1, Sog: 7.5, Cog: 120, TrueHeading: 511, NavigationalStatus: 7 } },
  });
  assert.equal(pr.mmsi, 251123000);
  assert.equal(pr.heading, null);
  assert.equal(pr.sog, 7.5);
  const st = fromAisstream({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: 251999000 },
    Message: { ShipStaticData: { UserID: 251999000, Name: 'THOR      ', CallSign: 'TFXY', Type: 51, Destination: 'REYKJAVIK' } },
  });
  assert.equal(st.name, 'THOR');
  assert.equal(classify(st), 'sar');
  assert.equal(fromAisstream({ MessageType: 'Unknown', Message: {} }), null);
});

test('CPA/TCPA: head-on and crossing', () => {
  const own = { lat: 64, lon: -22, sog: 10, cog: 0 };
  // target 2 NM due north, coming south at 10 kn: closing at 20 kn -> CPA 0 in 6 min
  const t = { lat: 64 + 2 / 60, lon: -22, sog: 10, cog: 180 };
  const r = cpaTcpa(own, t);
  near(r.range, 2, 0.01);
  near(r.cpa, 0, 0.01);
  near(r.tcpa, 6, 0.05);
  // stationary target 1 NM east of a northbound ship: CPA 1 NM, now (tcpa ~0)
  const r2 = cpaTcpa(own, { lat: 64, lon: -22 + 1 / 60 / Math.cos((64 * Math.PI) / 180), sog: 0, cog: 0 });
  near(r2.cpa, 1, 0.01);
  near(r2.tcpa, 0, 0.1);
  // opening: target astern moving away
  assert.ok(cpaTcpa(own, { lat: 64 - 1 / 60, lon: -22, sog: 10, cog: 180 }).tcpa < 0);
  // same speed and course: no relative motion
  assert.equal(cpaTcpa(own, { lat: 64.1, lon: -22, sog: 10, cog: 0 }).tcpa, Infinity);
});
