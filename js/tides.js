// Tide predictions from the Icelandic Coast Guard tide tables (Sjávarfallatöflur).
//
// Reference ports (Table I) have every high/low water for the year. Secondary
// ports (Table II) are derived from their reference port: a time difference,
// plus a height difference interpolated between its spring and neap values
// according to the reference port's height that day (standard method).
// Heights between high and low water follow the cosine curve that the
// tables' Table III is built on.
//
// Times are minutes since the epoch (UTC; Icelandic time is GMT). Heights are
// metres above chart datum ("0 íslenskra sjókorta", near mean low water springs).

import { distanceNm } from './geo.js';

/** Linear interpolation of y at x through (x0,y0),(x1,y1), extrapolating beyond. */
const lerp = (x, x0, x1, y0, y1) => (x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0));

/**
 * Build the list of stations from the tide data file: every reference port and
 * every secondary port, each with its own [time, height, 'H'|'L'] events.
 */
export function buildStations(data) {
  const refs = Object.fromEntries(data.ports.map((p) => [p.id, p]));
  const stations = data.ports.map((p) => ({
    id: p.id,
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    reference: true,
    events: p.events,
  }));
  for (const s of data.secondary) {
    const ref = refs[s.ref];
    const lv = data.ref_levels[s.ref];
    if (!ref || !lv) continue;
    stations.push({
      id: `${s.ref}:${s.name}`,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      reference: false,
      refName: ref.name,
      dt: s.dt,
      heightsKnown: !!s.dh,
      events: secondaryEvents(ref.events, lv, s),
    });
  }
  return stations;
}

/** Derive a secondary port's events from its reference port (Table II method). */
export function secondaryEvents(refEvents, lv, s) {
  return refEvents.map(([t, h, k]) => {
    let dh = 0;
    if (s.dh) {
      const [dHWs, dHWn, dLWn, dLWs] = s.dh;
      dh = k === 'H' ? lerp(h, lv.mhwn, lv.mhws, dHWn, dHWs) : lerp(h, lv.mlws, lv.mlwn, dLWs, dLWn);
    }
    return [t + s.dt, Math.round((h + dh) * 100) / 100, k];
  });
}

/** Index of the last event at or before t (binary search); -1 if none. */
function indexAtOrBefore(events, t) {
  let lo = 0;
  let hi = events.length - 1;
  if (!events.length || t < events[0][0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Tide height at time t (minutes), by cosine interpolation between the
 * surrounding high and low water. Returns null outside the table's range.
 */
export function heightAt(events, t) {
  const i = indexAtOrBefore(events, t);
  if (i < 0 || i >= events.length - 1) return null;
  const [t0, h0] = events[i];
  const [t1, h1] = events[i + 1];
  const f = (1 - Math.cos((Math.PI * (t - t0)) / (t1 - t0))) / 2;
  return h0 + (h1 - h0) * f;
}

/** Current state: height, rising/falling, rate (m/h), previous and next events. */
export function tideState(events, t) {
  const i = indexAtOrBefore(events, t);
  if (i < 0 || i >= events.length - 1) return null;
  const h = heightAt(events, t);
  const [t0, h0] = events[i];
  const [t1, h1] = events[i + 1];
  // derivative of the cosine curve, metres per hour
  const rate = ((h1 - h0) * Math.PI * Math.sin((Math.PI * (t - t0)) / (t1 - t0))) / (2 * (t1 - t0)) * 60;
  return {
    height: h,
    rising: h1 > h0,
    rate,
    prev: events[i],
    next: events[i + 1],
    upcoming: events.slice(i + 1, i + 9),
    range: Math.abs(h1 - h0),
  };
}

/** Sampled curve between t0 and t1 (minutes), every `step` minutes. */
export function curve(events, t0, t1, step = 10) {
  const pts = [];
  for (let t = t0; t <= t1; t += step) {
    const h = heightAt(events, t);
    if (h != null) pts.push([t, h]);
  }
  return pts;
}

/** Stations sorted by distance from a position (NM). */
export function nearestStations(stations, pos, n = 5) {
  return stations
    .map((s) => ({ station: s, nm: distanceNm(pos, s) }))
    .sort((a, b) => a.nm - b.nm)
    .slice(0, n);
}

/** First/last event times, to tell the user when the tables run out. */
export function coverage(events) {
  return events.length ? { from: events[0][0], to: events[events.length - 1][0] } : null;
}
