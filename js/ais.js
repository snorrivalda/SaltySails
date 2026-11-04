// AIS: decoding (NMEA AIVDM/AIVDO, Signal K deltas, aisstream.io JSON),
// a target store, SAR-relevant classification and CPA/TCPA.
// Pure functions (no DOM) so they can be unit-tested.

import { distanceNm, bearing } from './geo.js';

// ---------------------------------------------------------------------------
// NMEA 0183 AIVDM/AIVDO
// ---------------------------------------------------------------------------

/** XOR checksum of an NMEA sentence (between ! or $ and *). */
export function nmeaChecksumOk(line) {
  const m = /^[!$]([^*]*)\*([0-9A-F]{2})\s*$/i.exec(line.trim());
  if (!m) return false;
  let x = 0;
  for (const c of m[1]) x ^= c.charCodeAt(0);
  return x === parseInt(m[2], 16);
}

/** Bit reader over a 6-bit armoured AIS payload. */
function bits(payload, fill = 0) {
  const arr = [];
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    for (let b = 5; b >= 0; b--) arr.push((v >> b) & 1);
  }
  if (fill) arr.length = Math.max(0, arr.length - fill);
  const u = (start, len) => {
    let v = 0;
    for (let i = start; i < start + len; i++) v = v * 2 + (arr[i] ?? 0);
    return v;
  };
  const s = (start, len) => {
    const v = u(start, len);
    return v >= 2 ** (len - 1) ? v - 2 ** len : v;
  };
  const text = (start, len) => {
    let out = '';
    for (let i = start; i + 6 <= start + len && i + 6 <= arr.length; i += 6) {
      const c = u(i, 6);
      out += String.fromCharCode(c < 32 ? c + 64 : c);
    }
    return out.replace(/@.*$/, '').trim();
  };
  return { u, s, text, length: arr.length };
}

const pos = (lonRaw, latRaw) => {
  const lon = lonRaw / 600000;
  const lat = latRaw / 600000;
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? { lat, lon } : { lat: null, lon: null };
};
const sogTenths = (v) => (v === 1023 ? null : v / 10);
const cogTenths = (v) => (v >= 3600 ? null : v / 10);
const hdg = (v) => (v === 511 ? null : v);

/** Decode one complete AIS binary payload into a plain message object (or null). */
export function decodePayload(payload, fill = 0) {
  const b = bits(payload, fill);
  const type = b.u(0, 6);
  const mmsi = b.u(8, 30);
  const base = { type, mmsi };
  switch (type) {
    case 1:
    case 2:
    case 3:
      return {
        ...base,
        status: b.u(38, 4),
        sog: sogTenths(b.u(50, 10)),
        ...pos(b.s(61, 28), b.s(89, 27)),
        cog: cogTenths(b.u(116, 12)),
        heading: hdg(b.u(128, 9)),
        classB: false,
      };
    case 5:
      return {
        ...base,
        imo: b.u(40, 30) || null,
        callsign: b.text(70, 42),
        name: b.text(112, 120),
        shipType: b.u(232, 8),
        dim: [b.u(240, 9), b.u(249, 9), b.u(258, 6), b.u(264, 6)],
        draught: b.u(294, 8) / 10 || null,
        destination: b.text(302, 120),
        classB: false,
      };
    case 9:
      return {
        ...base,
        altitude: b.u(38, 12) === 4095 ? null : b.u(38, 12),
        sog: b.u(50, 10) === 1023 ? null : b.u(50, 10), // whole knots for aircraft
        ...pos(b.s(61, 28), b.s(89, 27)),
        cog: cogTenths(b.u(116, 12)),
        heading: null,
        aircraft: true,
      };
    case 18:
      return {
        ...base,
        sog: sogTenths(b.u(46, 10)),
        ...pos(b.s(57, 28), b.s(85, 27)),
        cog: cogTenths(b.u(112, 12)),
        heading: hdg(b.u(124, 9)),
        classB: true,
      };
    case 19:
      return {
        ...base,
        sog: sogTenths(b.u(46, 10)),
        ...pos(b.s(57, 28), b.s(85, 27)),
        cog: cogTenths(b.u(112, 12)),
        heading: hdg(b.u(124, 9)),
        name: b.text(143, 120),
        shipType: b.u(263, 8),
        dim: [b.u(271, 9), b.u(280, 9), b.u(289, 6), b.u(295, 6)],
        classB: true,
      };
    case 21:
      return {
        ...base,
        aidType: b.u(38, 5),
        name: b.text(43, 120),
        ...pos(b.s(164, 28), b.s(192, 27)),
        aton: true,
      };
    case 24: {
      const part = b.u(38, 2);
      if (part === 0) return { ...base, part, name: b.text(40, 120), classB: true };
      return {
        ...base,
        part,
        shipType: b.u(40, 8),
        callsign: b.text(90, 42),
        dim: [b.u(132, 9), b.u(141, 9), b.u(150, 6), b.u(156, 6)],
        classB: true,
      };
    }
    default:
      return null; // other types (base stations, binary messages…) aren't needed here
  }
}

/**
 * Stateful NMEA AIS sentence decoder: feed lines, get decoded messages.
 * Handles multi-sentence messages (e.g. type 5) and drops bad checksums.
 */
export function createNmeaDecoder() {
  const parts = new Map(); // key -> { total, got: [], at }
  return function feed(line, now = Date.now()) {
    line = line.trim();
    const m = /^!(AI|AB|BS)(VDM|VDO),(\d),(\d),(\d*),([AB12]?),([^,]*),(\d)\*[0-9A-F]{2}$/i.exec(line);
    if (!m || !nmeaChecksumOk(line)) return null;
    const [, , kind, totalS, numS, seq, channel, payload, fillS] = m;
    const total = Number(totalS);
    const num = Number(numS);
    const own = kind.toUpperCase() === 'VDO';
    if (total === 1) {
      const msg = decodePayload(payload, Number(fillS));
      return msg && { ...msg, own };
    }
    const key = `${seq}:${channel}:${total}`;
    let p = parts.get(key);
    if (!p || num === 1 || now - p.at > 10000) {
      p = { total, got: [], at: now };
      parts.set(key, p);
    }
    p.got[num - 1] = { payload, fill: Number(fillS) };
    if (p.got.filter(Boolean).length < total) return null;
    parts.delete(key);
    const msg = decodePayload(p.got.map((x) => x.payload).join(''), p.got[total - 1].fill);
    return msg && { ...msg, own };
  };
}

// ---------------------------------------------------------------------------
// Signal K deltas (onboard server: /signalk/v1/stream)
// ---------------------------------------------------------------------------

const RAD = 180 / Math.PI;
const MS_TO_KN = 1.943844;

/**
 * Convert one Signal K delta into AIS-like messages (one per context).
 * `selfContext` is from the server's hello message (e.g. "vessels.urn:mrn:imo:mmsi:251…").
 */
export function fromSignalK(delta, selfContext) {
  if (!delta?.updates || !delta.context) return [];
  const ctx = delta.context;
  const m = /mmsi:(\d+)/.exec(ctx);
  const own = ctx === 'vessels.self' || (selfContext && ctx === selfContext);
  if (!m && !own) return [];
  const msg = { mmsi: m ? Number(m[1]) : 0, own, aircraft: ctx.startsWith('aircraft.'), aton: ctx.startsWith('atons.') };
  for (const u of delta.updates) {
    for (const { path, value } of u.values ?? []) {
      if (value == null) continue;
      switch (path) {
        case 'navigation.position':
          msg.lat = value.latitude;
          msg.lon = value.longitude;
          break;
        case 'navigation.speedOverGround':
          msg.sog = value * MS_TO_KN;
          break;
        case 'navigation.courseOverGroundTrue':
          msg.cog = (value * RAD + 360) % 360;
          break;
        case 'navigation.headingTrue':
          msg.heading = (value * RAD + 360) % 360;
          break;
        case 'navigation.state':
          msg.state = value;
          break;
        case 'design.aisShipType':
          msg.shipType = value.id;
          break;
        case 'communication.callsignVhf':
          msg.callsign = value;
          break;
        case 'navigation.destination.commonName':
          msg.destination = value;
          break;
        case 'sensors.ais.class':
          msg.classB = value === 'B';
          break;
        case '':
          if (value.name) msg.name = value.name;
          if (value.mmsi) msg.mmsi = Number(value.mmsi);
          break;
        default:
      }
    }
  }
  return [msg];
}

// ---------------------------------------------------------------------------
// aisstream.io JSON (relayed by /api/ais)
// ---------------------------------------------------------------------------

/** Convert one aisstream.io message into an AIS-like message (or null). */
export function fromAisstream(j) {
  const md = j?.MetaData ?? {};
  const type = j?.MessageType;
  const body = j?.Message?.[type];
  if (!type || !body) return null;
  const mmsi = Number(body.UserID ?? md.MMSI);
  const num = (v, na) => (v == null || v === na ? null : v);
  const base = { mmsi };
  const p = { lat: num(body.Latitude ?? md.latitude, 91), lon: num(body.Longitude ?? md.longitude, 181) };
  switch (type) {
    case 'PositionReport':
      return { ...base, ...p, sog: num(body.Sog, 102.3), cog: num(body.Cog, 360), heading: num(body.TrueHeading, 511), status: body.NavigationalStatus, classB: false };
    case 'StandardClassBPositionReport':
      return { ...base, ...p, sog: num(body.Sog, 102.3), cog: num(body.Cog, 360), heading: num(body.TrueHeading, 511), classB: true };
    case 'ExtendedClassBPositionReport':
      return { ...base, ...p, sog: num(body.Sog, 102.3), cog: num(body.Cog, 360), heading: num(body.TrueHeading, 511), name: body.Name?.trim(), shipType: body.Type, classB: true };
    case 'ShipStaticData':
      return { ...base, name: body.Name?.trim(), callsign: body.CallSign?.trim(), shipType: body.Type, destination: body.Destination?.trim(), imo: body.ImoNumber || null };
    case 'StaticDataReport':
      return {
        ...base,
        name: body.ReportA?.Valid ? body.ReportA.Name?.trim() : undefined,
        callsign: body.ReportB?.Valid ? body.ReportB.CallSign?.trim() : undefined,
        shipType: body.ReportB?.Valid ? body.ReportB.ShipType : undefined,
        classB: true,
      };
    case 'StandardSearchAndRescueAircraftReport':
      return { ...base, ...p, sog: num(body.Sog, 1023), cog: num(body.Cog, 360), altitude: num(body.Altitude, 4095), aircraft: true };
    case 'AidsToNavigationReport':
      return { ...base, ...p, name: body.Name?.trim(), aton: true };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What a target is, with SAR first: AIS-SART (970…), MOB device (972…),
 * EPIRB-AIS (974…), SAR aircraft (type 9 / 111MIDxxx), SAR vessel (ship type 51).
 */
export function classify(t) {
  const s = String(t.mmsi ?? '');
  if (s.startsWith('970')) return 'sart';
  if (s.startsWith('972')) return 'mob';
  if (s.startsWith('974')) return 'epirb';
  if (t.aircraft || /^111\d{6}$/.test(s)) return 'sar-aircraft';
  if (t.aton || /^99\d{7}$/.test(s)) return 'aton';
  const st = t.shipType;
  if (st === 51) return 'sar';
  if (st === 30) return 'fishing';
  if (st === 50) return 'pilot';
  if (st === 31 || st === 32 || st === 52) return 'tug';
  if (st === 55) return 'law';
  if (st === 36 || st === 37) return 'pleasure';
  if (st >= 60 && st <= 69) return 'passenger';
  if (st >= 70 && st <= 79) return 'cargo';
  if (st >= 80 && st <= 89) return 'tanker';
  return 'other';
}
/** Distress beacons: show an alarm. */
export const isDistress = (kind) => kind === 'sart' || kind === 'mob' || kind === 'epirb';

export const KIND_LABEL = {
  sart: 'AIS-SART (distress)',
  mob: 'MOB beacon',
  epirb: 'EPIRB-AIS',
  'sar-aircraft': 'SAR aircraft',
  sar: 'SAR vessel',
  aton: 'Aid to navigation',
  fishing: 'Fishing',
  pilot: 'Pilot',
  tug: 'Tug',
  law: 'Law enforcement',
  pleasure: 'Pleasure craft',
  passenger: 'Passenger',
  cargo: 'Cargo',
  tanker: 'Tanker',
  other: 'Vessel',
};

export const NAV_STATUS = [
  'Under way using engine',
  'At anchor',
  'Not under command',
  'Restricted manoeuvrability',
  'Constrained by draught',
  'Moored',
  'Aground',
  'Engaged in fishing',
  'Under way sailing',
  null,
  null,
  'Towing astern',
  'Pushing ahead / towing alongside',
  null,
  'AIS-SART / MOB / EPIRB active',
  null,
];

// ---------------------------------------------------------------------------
// Target store
// ---------------------------------------------------------------------------

export const STALE_MS = 3 * 60 * 1000; // shown faded after this
export const LOST_MS = 15 * 60 * 1000; // dropped after this (distress beacons: 60 min)

/** Merge messages per MMSI (position and static data arrive separately). */
export function createStore() {
  const targets = new Map();
  return {
    targets,
    /** Apply a decoded message; returns the updated target (or null). */
    update(msg, source, now = Date.now()) {
      if (!msg || !msg.mmsi || msg.own) return null;
      const t = targets.get(msg.mmsi) ?? { mmsi: msg.mmsi, firstSeen: now, sources: new Set() };
      for (const [k, v] of Object.entries(msg)) {
        if (v === undefined || v === null || v === '') continue;
        if (k === 'lat' || k === 'lon') continue;
        t[k] = v;
      }
      if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        t.lat = msg.lat;
        t.lon = msg.lon;
        t.lastPos = now;
      }
      t.lastSeen = now;
      t.sources.add(source);
      t.kind = classify(t);
      targets.set(msg.mmsi, t);
      return t;
    },
    /** Remove targets not heard from for too long. */
    prune(now = Date.now()) {
      for (const [k, t] of targets) {
        const limit = isDistress(t.kind) ? 60 * 60 * 1000 : LOST_MS;
        if (now - (t.lastPos ?? t.lastSeen) > limit) targets.delete(k);
      }
    },
    list() {
      return [...targets.values()].filter((t) => Number.isFinite(t.lat));
    },
  };
}

// ---------------------------------------------------------------------------
// CPA / TCPA
// ---------------------------------------------------------------------------

/** East/north velocity in knots from SOG/COG. */
const vel = (sog, cog) => {
  if (!Number.isFinite(sog) || !Number.isFinite(cog)) return [0, 0];
  const a = (cog * Math.PI) / 180;
  return [sog * Math.sin(a), sog * Math.cos(a)];
};

/**
 * Closest point of approach between own ship and a target, on a local flat
 * projection (fine over the few NM that matter). Returns
 * { range NM, bearing °T, cpa NM, tcpa minutes } — tcpa < 0 means the
 * closest point is already past (they are opening).
 */
export function cpaTcpa(own, target) {
  const range = distanceNm(own, target);
  const brg = bearing(own, target);
  const a = (brg * Math.PI) / 180;
  const rx = range * Math.sin(a);
  const ry = range * Math.cos(a);
  const [ox, oy] = vel(own.sog, own.cog);
  const [tx, ty] = vel(target.sog, target.cog);
  const vx = tx - ox;
  const vy = ty - oy;
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-9) return { range, bearing: brg, cpa: range, tcpa: Infinity };
  const tH = -(rx * vx + ry * vy) / v2;
  const cpa = Math.hypot(rx + vx * tH, ry + vy * tH);
  return { range, bearing: brg, cpa, tcpa: tH * 60 };
}
