// Navigation math for SaltySails.
// All distances are in nautical miles, speeds in knots, angles in degrees true.
// Positions are { lat, lon } in decimal degrees (WGS84, south/west negative).

export const EARTH_RADIUS_NM = 3440.065;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export const norm360 = (d) => ((d % 360) + 360) % 360;
export const normLon = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Great-circle distance between two positions (haversine), in NM. */
export function distanceNm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees true. */
export function bearing(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return norm360(toDeg(Math.atan2(y, x)));
}

/** Position reached from p after travelling distNm on initial bearing brg. */
export function destination(p, brg, distNm) {
  const δ = distNm / EARTH_RADIUS_NM;
  const θ = toRad(brg);
  const φ1 = toRad(p.lat);
  const λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: normLon(toDeg(λ2)) };
}

/**
 * Signed cross-track distance (NM) of p from the great circle start→end.
 * Positive = p is to the right (starboard) of the track.
 */
export function crossTrackNm(start, end, p) {
  const δ13 = distanceNm(start, p) / EARTH_RADIUS_NM;
  const θ13 = toRad(bearing(start, p));
  const θ12 = toRad(bearing(start, end));
  return Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_NM;
}

// ---------------------------------------------------------------------------
// Coordinate formatting / parsing
// ---------------------------------------------------------------------------

const pad = (n, w) => String(n).padStart(w, '0');

function splitDm(value, decimals) {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Number(((abs - deg) * 60).toFixed(decimals));
  if (min >= 60) {
    deg += 1;
    min = 0;
  }
  return { deg, min };
}

function splitDms(value, decimals) {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  const totalMin = (abs - deg) * 60;
  let min = Math.floor(totalMin);
  let sec = Number(((totalMin - min) * 60).toFixed(decimals));
  if (sec >= 60) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  return { deg, min, sec };
}

/**
 * Format a position. fmt: 'ddm' (degrees + decimal minutes, maritime default),
 * 'dms' or 'dd'.
 */
export function formatPosition(p, fmt = 'ddm') {
  if (!p) return '—';
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  if (fmt === 'dd') {
    return `${Math.abs(p.lat).toFixed(5)}°${ns} ${Math.abs(p.lon).toFixed(5)}°${ew}`;
  }
  if (fmt === 'dms') {
    const a = splitDms(p.lat, 1);
    const o = splitDms(p.lon, 1);
    return (
      `${pad(a.deg, 2)}°${pad(a.min, 2)}'${a.sec.toFixed(1).padStart(4, '0')}"${ns} ` +
      `${pad(o.deg, 3)}°${pad(o.min, 2)}'${o.sec.toFixed(1).padStart(4, '0')}"${ew}`
    );
  }
  const a = splitDm(p.lat, 3);
  const o = splitDm(p.lon, 3);
  return (
    `${pad(a.deg, 2)}°${a.min.toFixed(3).padStart(6, '0')}'${ns} ` +
    `${pad(o.deg, 3)}°${o.min.toFixed(3).padStart(6, '0')}'${ew}`
  );
}

function parseOne(str, isLat) {
  let s = str.trim().toUpperCase().replace(/,/g, '.');
  let sign = 1;
  const hemi = s.match(/[NSEWV]/); // V = vestur (Icelandic for west)
  if (hemi) {
    const h = hemi[0];
    if (h === 'S' || h === 'W' || h === 'V') sign = -1;
    if (isLat && !(h === 'N' || h === 'S')) return NaN;
    if (!isLat && (h === 'N' || h === 'S')) return NaN;
    s = s.replace(/[NSEWV]/g, ' ');
  }
  if (s.trim().startsWith('-')) {
    sign *= -1;
    s = s.replace('-', ' ');
  }
  const parts = s
    .replace(/[°º'’′"”″:]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  const [d, m = 0, sec = 0] = parts;
  if (m >= 60 || sec >= 60) return NaN;
  const v = sign * (d + m / 60 + sec / 3600);
  const lim = isLat ? 90 : 180;
  return Math.abs(v) <= lim ? v : NaN;
}

/**
 * Parse a free-text position. Accepts e.g.
 *   "64 08.50N 021 56.30W", "64°08.5'N 21°56.3'W", "64.1416, -21.9383",
 *   "64 08 30 N 021 56 18 W", "6408.5N 02156.3W" is NOT supported (ambiguous).
 * Returns { lat, lon } or null.
 */
export function parsePosition(input) {
  if (!input) return null;
  const s = input.trim().toUpperCase();
  let latStr;
  let lonStr;
  const hemiSplit = s.match(/^(.*?[NS])\s*[,;/]?\s*(.*[EWV])$/);
  if (hemiSplit) {
    [, latStr, lonStr] = hemiSplit;
  } else {
    // A semicolon separator allows decimal commas, e.g. "64,1416; -21,9383".
    const parts = (s.includes(';') ? s.split(';') : s.split(/\s*[,/]\s*|\s+/))
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length !== 2) return null;
    [latStr, lonStr] = parts;
  }
  const lat = parseOne(latStr, true);
  const lon = parseOne(lonStr, false);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// ---------------------------------------------------------------------------
// IAMSAR search patterns. Each returns an ordered list of waypoints
// (the first being the commence search point, CSP).
// ---------------------------------------------------------------------------

/**
 * Expanding square search (SS). Starts at datum; legs S, S, 2S, 2S, 3S, 3S…
 * each turn 90° (right by default).
 */
export function expandingSquare({ datum, track, spacing, legs, turn = 'right' }) {
  const dir = turn === 'left' ? -1 : 1;
  const pts = [datum];
  let p = datum;
  let hdg = track;
  for (let i = 0; i < legs; i++) {
    const len = spacing * (Math.floor(i / 2) + 1);
    p = destination(p, hdg, len);
    pts.push(p);
    hdg = norm360(hdg + 90 * dir);
  }
  return pts;
}

/**
 * Sector search (VS). Starts at datum. Nine legs of length `radius`, every turn
 * 120° (right by default), giving three triangles and six radials 60° apart.
 */
export function sectorSearch({ datum, track, radius, turn = 'right' }) {
  const dir = turn === 'left' ? -1 : 1;
  const pts = [datum];
  let hdg = track;
  // Each triangle: out, crossleg, back to datum. The inbound leg of each
  // triangle continues straight through datum as the next outbound leg.
  for (let tri = 0; tri < 3; tri++) {
    const out = destination(datum, hdg, radius);
    const cross = destination(out, norm360(hdg + 120 * dir), radius);
    pts.push(out, cross, datum);
    hdg = norm360(hdg + 240 * dir);
  }
  return pts;
}

/**
 * Parallel track / creeping line search (PS / CS). Starts at csp, runs legs of
 * `legLength` along `track`, alternating direction, stepping `spacing` to the
 * right (or left) between legs.
 */
export function parallelSearch({ csp, track, spacing, legLength, legs, turn = 'right' }) {
  const dir = turn === 'left' ? -1 : 1;
  const step = norm360(track + 90 * dir);
  const pts = [csp];
  let p = csp;
  for (let i = 0; i < legs; i++) {
    const hdg = i % 2 === 0 ? track : norm360(track + 180);
    p = destination(p, hdg, legLength);
    pts.push(p);
    if (i < legs - 1) {
      p = destination(p, step, spacing);
      pts.push(p);
    }
  }
  return pts;
}

/** Total length (NM) of a waypoint list. */
export function routeLengthNm(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distanceNm(pts[i - 1], pts[i]);
  return total;
}

// ---------------------------------------------------------------------------
// Drift / datum
// ---------------------------------------------------------------------------

/**
 * Simple datum estimate: last known position moved by total water current and
 * leeway for `hours`. Wind direction is where the wind blows FROM; leeway acts
 * downwind. Current set is the direction the water flows TOWARDS.
 * Returns { datum, driftBearing, driftNm }.
 */
export function estimateDatum({ lkp, hours, windFrom, leewayKn, currentSet, currentKn }) {
  const leewayDir = toRad(norm360(windFrom + 180));
  const cur = toRad(currentSet);
  // East/north components in knots.
  const e = leewayKn * Math.sin(leewayDir) + currentKn * Math.sin(cur);
  const n = leewayKn * Math.cos(leewayDir) + currentKn * Math.cos(cur);
  const speed = Math.hypot(e, n);
  const driftBearing = norm360(toDeg(Math.atan2(e, n)));
  const driftNm = speed * hours;
  return { datum: destination(lkp, driftBearing, driftNm), driftBearing, driftNm };
}

// ---------------------------------------------------------------------------
// GPX export
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function toGpx({ name = 'SaltySails', waypoints = [], routes = [], tracks = [] }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SaltySails" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>`,
  ];
  for (const w of waypoints) {
    out.push(
      `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${esc(w.name || 'WPT')}</name>` +
        (w.time ? `<time>${new Date(w.time).toISOString()}</time>` : '') +
        '</wpt>',
    );
  }
  for (const r of routes) {
    out.push(`  <rte><name>${esc(r.name || 'Route')}</name>`);
    r.points.forEach((p, i) =>
      out.push(`    <rtept lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><name>${esc(`${r.prefix || 'WP'}${pad(i, 2)}`)}</name></rtept>`),
    );
    out.push('  </rte>');
  }
  for (const t of tracks) {
    out.push(`  <trk><name>${esc(t.name || 'Track')}</name><trkseg>`);
    for (const p of t.points) {
      out.push(
        `    <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">` +
          (p.time ? `<time>${new Date(p.time).toISOString()}</time>` : '') +
          '</trkpt>',
      );
    }
    out.push('  </trkseg></trk>');
  }
  out.push('</gpx>');
  return out.join('\n');
}
