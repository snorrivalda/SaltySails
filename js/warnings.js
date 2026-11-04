// Weather warnings from the Icelandic Met Office (Veðurstofa Íslands) CAP feed.
// https://api.vedur.is/cap — Common Alerting Protocol 1.2, JSON.
// Pure functions (no DOM) so they can be unit-tested.

import { distanceNm } from './geo.js';

export const CAP_BASE = 'https://api.vedur.is/cap/capbroker';

const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** URL of the full JSON message for an identifier entry from the active list. */
export function messageUrl({ sender, identifier, sent }) {
  const e = encodeURIComponent;
  return `${CAP_BASE}/sender/${e(sender)}/identifier/${e(identifier)}/sent/${e(sent)}/json`;
}

/** "65.81,-24.11 66.06,-23.86 …" -> [[lat, lon], …] */
export function parsePolygon(s) {
  if (!s) return [];
  return String(s)
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

const COLOURS = { yellow: 1, orange: 2, red: 3 };

/**
 * Normalise one CAP message ({ alert } or the alert itself) into warnings:
 * one per area, with English and Icelandic text side by side.
 */
export function normalizeAlert(msg) {
  const a = msg?.alert ?? msg;
  if (!a || !a.info) return [];
  const infos = asList(a.info);
  const en = infos.find((i) => /^en/i.test(i.language || '')) ?? infos[0];
  const is = infos.find((i) => /^is/i.test(i.language || '')) ?? null;
  const param = (info, name) =>
    asList(info?.parameter).find((p) => (p.valueName || '').toLowerCase() === name.toLowerCase())?.value;
  const colour = String(param(en, 'Color') ?? param(is, 'Color') ?? '').toLowerCase();
  const areasEn = asList(en.area);
  const areasIs = asList(is?.area);
  return areasEn.map((area, k) => ({
    id: `${a.identifier}#${k}`,
    identifier: a.identifier,
    sender: a.sender,
    sent: a.sent,
    msgType: a.msgType,
    status: a.status,
    references: String(a.references || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((r) => r.split(',')[1])
      .filter(Boolean),
    colour: COLOURS[colour] ? colour : 'yellow',
    level: COLOURS[colour] ?? 1,
    event: en.event,
    eventIs: is?.event,
    headline: en.headline,
    headlineIs: is?.headline,
    description: en.description,
    descriptionIs: is?.description,
    area: area.areaDesc,
    areaIs: areasIs[k]?.areaDesc,
    polygons: asList(area.polygon).map(parsePolygon).filter((p) => p.length >= 3),
    onset: Date.parse(en.onset || en.effective || a.sent),
    expires: Date.parse(en.expires),
    severity: en.severity,
    certainty: en.certainty,
    web: en.web,
    icon: asList(en.resource)[0]?.uri,
  }));
}

/**
 * Current set of warnings from many messages: drops cancelled, test and
 * expired ones, and any message superseded by an Update/Cancel that refers to it.
 */
export function activeWarnings(messages, now = Date.now()) {
  const all = messages.flatMap(normalizeAlert);
  const superseded = new Set(all.flatMap((w) => w.references));
  return all
    .filter((w) => w.status !== 'Test' && w.status !== 'Exercise')
    .filter((w) => w.msgType !== 'Cancel')
    .filter((w) => !superseded.has(w.identifier))
    .filter((w) => !Number.isFinite(w.expires) || w.expires > now)
    .sort((a, b) => b.level - a.level || a.onset - b.onset);
}

/** Ray-casting point-in-polygon; polygon is [[lat, lon], …]. */
export function pointInPolygon([lat, lon], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Approximate distance (NM) from a position to a polygon: 0 if inside,
 * otherwise the distance to the nearest edge (sampled along each edge).
 */
export function distanceToPolygonNm(pos, poly) {
  if (pointInPolygon([pos.lat, pos.lon], poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = { lat: poly[i][0], lon: poly[i][1] };
    const b = { lat: poly[(i + 1) % poly.length][0], lon: poly[(i + 1) % poly.length][1] };
    const steps = Math.max(1, Math.ceil(distanceNm(a, b) / 0.5));
    for (let s = 0; s <= steps; s++) {
      const p = { lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps };
      best = Math.min(best, distanceNm(pos, p));
    }
  }
  return best;
}

/** Nearest distance (NM) from a position to any of a warning's polygons. */
export function warningDistanceNm(w, pos) {
  return w.polygons.length ? Math.min(...w.polygons.map((p) => distanceToPolygonNm(pos, p))) : Infinity;
}

/** Whether a warning is in force now (vs. upcoming). */
export const inForce = (w, now = Date.now()) => !Number.isFinite(w.onset) || w.onset <= now;

