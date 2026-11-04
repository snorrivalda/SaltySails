// Weather/sea-state data: Open-Meteo forecast + marine APIs, gridded for map display.
// Pure functions (no DOM) so they can be unit-tested.
//
// Sources: Open-Meteo (https://open-meteo.com), forecast models incl. ECMWF/DWD/DMI;
// waves, currents and sea level from DWD ICON-Wave / Copernicus via Open-Meteo Marine.

export const KMH_PER_KN = 1.852;

// Variables we request. Wind in knots; Open-Meteo marine currents come in km/h.
export const FORECAST_VARS = [
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'pressure_msl',
  'visibility',
  'temperature_2m',
  'precipitation',
  'weather_code',
];
export const MARINE_VARS = [
  'wave_height',
  'wave_direction',
  'wave_period',
  'wind_wave_height',
  'swell_wave_height',
  'swell_wave_direction',
  'swell_wave_period',
  'ocean_current_velocity',
  'ocean_current_direction',
  'sea_surface_temperature',
];

/** Map display modes: which value is coloured, and which direction drives particles/arrows. */
export const MODES = {
  wind: { label: 'Wind', unit: 'kn', value: 'wind_speed_10m', dir: 'wind_direction_10m', dirIsFrom: true, flow: true },
  gust: { label: 'Gusts', unit: 'kn', value: 'wind_gusts_10m', dir: 'wind_direction_10m', dirIsFrom: true, flow: true },
  waves: { label: 'Waves', unit: 'm', value: 'wave_height', dir: 'wave_direction', dirIsFrom: true, flow: false },
  swell: { label: 'Swell', unit: 'm', value: 'swell_wave_height', dir: 'swell_wave_direction', dirIsFrom: true, flow: false },
  current: { label: 'Current', unit: 'kn', value: 'current_kn', dir: 'ocean_current_direction', dirIsFrom: false, flow: true },
};

// Colour scales: [value, [r,g,b]] stops, roughly Windy-like.
export const SCALES = {
  kn: [
    [0, [98, 113, 183]],
    [5, [57, 136, 202]],
    [10, [72, 179, 129]],
    [15, [110, 196, 66]],
    [20, [225, 214, 52]],
    [25, [240, 160, 40]],
    [30, [230, 100, 40]],
    [40, [200, 40, 50]],
    [50, [150, 30, 120]],
    [65, [90, 20, 110]],
  ],
  m: [
    [0, [70, 110, 180]],
    [0.5, [60, 150, 200]],
    [1, [70, 185, 160]],
    [2, [110, 196, 66]],
    [3, [225, 214, 52]],
    [4, [240, 150, 40]],
    [6, [220, 60, 45]],
    [8, [160, 30, 110]],
    [12, [90, 20, 110]],
  ],
  current: [
    [0, [60, 80, 150]],
    [0.25, [60, 130, 200]],
    [0.5, [70, 185, 160]],
    [1, [180, 210, 60]],
    [1.5, [240, 160, 40]],
    [2.5, [220, 60, 45]],
    [4, [150, 30, 120]],
  ],
};
export const scaleFor = (mode) => (mode === 'current' ? SCALES.current : SCALES[MODES[mode].unit]);

/** Colour for a value on a stop scale, linearly interpolated. */
export function colorAt(scale, v) {
  if (!Number.isFinite(v)) return null;
  if (v <= scale[0][0]) return scale[0][1];
  for (let i = 1; i < scale.length; i++) {
    const [v1, c1] = scale[i];
    if (v <= v1) {
      const [v0, c0] = scale[i - 1];
      const f = (v - v0) / (v1 - v0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + f * (c1[k] - c0[k])));
    }
  }
  return scale[scale.length - 1][1];
}

/** Beaufort force from knots (WMO). */
export function beaufort(kn) {
  const limits = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];
  const i = limits.findIndex((l) => kn < l);
  return i === -1 ? 12 : i;
}

/** Compass point for a direction in degrees (16-point). */
export function compass(deg) {
  if (!Number.isFinite(deg)) return '—';
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Grid lattice for a map view: spacing grows with the view size so a view
 * needs at most about `target` x `target` points. Spacing is 0.125° lat x 0.25°
 * lon times a power of two, so the same points are reused between views (and
 * cached) instead of shifting with every pan.
 */
export function latticeFor(bounds, target = 11) {
  let k = 0;
  while (k < 6) {
    const dlat = 0.125 * 2 ** k;
    const dlon = 0.25 * 2 ** k;
    if ((bounds.north - bounds.south) / dlat <= target && (bounds.east - bounds.west) / dlon <= target) break;
    k++;
  }
  const dlat = 0.125 * 2 ** k;
  const dlon = 0.25 * 2 ** k;
  const lat0 = Math.floor(bounds.south / dlat) * dlat;
  const lon0 = Math.floor(bounds.west / dlon) * dlon;
  const nLat = Math.ceil((bounds.north - lat0) / dlat) + 1;
  const nLon = Math.ceil((bounds.east - lon0) / dlon) + 1;
  return { k, dlat, dlon, lat0, lon0, nLat, nLon };
}

/** The lattice's points, row-major from south-west. */
export function latticePoints(g) {
  const pts = [];
  for (let i = 0; i < g.nLat; i++) {
    for (let j = 0; j < g.nLon; j++) {
      pts.push({ lat: +(g.lat0 + i * g.dlat).toFixed(4), lon: +(g.lon0 + j * g.dlon).toFixed(4) });
    }
  }
  return pts;
}

/** Stable cache key for a lattice point. */
export const pointKey = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/** Build Open-Meteo URLs for a list of points (one request each for forecast and marine). */
export function openMeteoUrls(points, days = 7, pastDays = 0) {
  const lat = points.map((p) => p.lat.toFixed(4)).join(',');
  const lon = points.map((p) => p.lon.toFixed(4)).join(',');
  const common =
    `latitude=${lat}&longitude=${lon}&timeformat=unixtime&timezone=GMT&forecast_days=${days}` +
    (pastDays ? `&past_days=${pastDays}` : '');
  return {
    forecast: `https://api.open-meteo.com/v1/forecast?${common}&wind_speed_unit=kn&hourly=${FORECAST_VARS.join(',')}`,
    marine: `https://marine-api.open-meteo.com/v1/marine?${common}&cell_selection=sea&hourly=${MARINE_VARS.join(',')}`,
  };
}

/**
 * Merge forecast + marine responses (arrays, one entry per point, or a single
 * object for one point) into per-point series: { time: [unix s], <var>: [...] }.
 * Adds current_kn (from km/h).
 */
export function mergeSeries(forecastResp, marineResp) {
  const fa = Array.isArray(forecastResp) ? forecastResp : [forecastResp];
  const ma = Array.isArray(marineResp) ? marineResp : marineResp ? [marineResp] : [];
  return fa.map((f, i) => {
    const s = { time: f.hourly.time };
    for (const v of FORECAST_VARS) s[v] = f.hourly[v] ?? s.time.map(() => null);
    const m = ma[i];
    const mt = m?.hourly?.time;
    for (const v of MARINE_VARS) {
      if (!m) {
        s[v] = [];
        continue;
      }
      // align marine to forecast times (both hourly GMT, but be safe)
      const idx = new Map(mt.map((t, k) => [t, k]));
      const col = m.hourly[v] ?? [];
      s[v] = s.time.map((t) => (idx.has(t) ? (col[idx.get(t)] ?? null) : null));
    }
    s.current_kn = s.ocean_current_velocity.map((v) => (v == null ? null : v / KMH_PER_KN));
    return s;
  });
}

/** Index of the hourly step nearest to unix time t (seconds); -1 if outside. */
export function timeIndex(times, t) {
  if (!times?.length || t < times[0] - 1800 || t > times[times.length - 1] + 1800) return -1;
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  return best;
}

/** Vector (east, north) for a direction, in the direction of travel. */
export function toVector(speed, dir, dirIsFrom) {
  if (!Number.isFinite(speed) || !Number.isFinite(dir)) return [NaN, NaN];
  const a = ((dirIsFrom ? dir + 180 : dir) * Math.PI) / 180;
  return [speed * Math.sin(a), speed * Math.cos(a)];
}

/**
 * Bilinear sample of a lattice field at (lat, lon). `vals` is row-major
 * (nLat x nLon) with NaN for missing. Missing corners are ignored (weights
 * renormalised); NaN if all four are missing.
 */
export function sampleGrid(g, vals, lat, lon) {
  const fi = (lat - g.lat0) / g.dlat;
  const fj = (lon - g.lon0) / g.dlon;
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  if (i0 < 0 || j0 < 0 || i0 >= g.nLat - 1 || j0 >= g.nLon - 1) return NaN;
  const di = fi - i0;
  const dj = fj - j0;
  let sum = 0;
  let w = 0;
  const add = (i, j, wt) => {
    const v = vals[i * g.nLon + j];
    if (Number.isFinite(v) && wt > 0) {
      sum += v * wt;
      w += wt;
    }
  };
  add(i0, j0, (1 - di) * (1 - dj));
  add(i0, j0 + 1, (1 - di) * dj);
  add(i0 + 1, j0, di * (1 - dj));
  add(i0 + 1, j0 + 1, di * dj);
  return w > 0 ? sum / w : NaN;
}

/**
 * Fill missing lattice values (e.g. wave data over land) from valid
 * neighbours, a few passes outwards, so the drawn field has no hard edges.
 * Returns a new array; cells still empty after `passes` stay NaN.
 */
export function fillGaps(g, vals, passes = 3) {
  let cur = Float64Array.from(vals, (v) => (Number.isFinite(v) ? v : NaN));
  for (let p = 0; p < passes; p++) {
    const next = Float64Array.from(cur);
    let changed = false;
    for (let i = 0; i < g.nLat; i++) {
      for (let j = 0; j < g.nLon; j++) {
        const k = i * g.nLon + j;
        if (Number.isFinite(cur[k])) continue;
        let sum = 0;
        let n = 0;
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= g.nLat || jj >= g.nLon) continue;
            const v = cur[ii * g.nLon + jj];
            if (Number.isFinite(v)) {
              sum += v;
              n++;
            }
          }
        }
        if (n) {
          next[k] = sum / n;
          changed = true;
        }
      }
    }
    cur = next;
    if (!changed) break;
  }
  return Array.from(cur);
}

/**
 * Mean wind/current over a time window, as a vector average (so 350° and 10°
 * average to 0°, not 180°). Returns { speed, dir, samples } with dir in the
 * same convention as the input (wind "from" stays "from", current "towards"
 * stays "towards"), since averaging doesn't depend on it.
 */
export function vectorMean(series, speedKey, dirKey, t0, t1) {
  let e = 0;
  let n = 0;
  let count = 0;
  series.time.forEach((t, i) => {
    if (t < t0 - 1800 || t > t1 + 1800) return;
    const [x, y] = toVector(series[speedKey][i], series[dirKey][i], false);
    if (!Number.isFinite(x)) return;
    e += x;
    n += y;
    count++;
  });
  if (!count) return null;
  e /= count;
  n /= count;
  const dir = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
  return { speed: Math.hypot(e, n), dir, samples: count };
}
