/* global L */
// Weather: Windy-style map layer (colour field + flow particles + time slider),
// point forecast table, and Vegagerðin measured buoys/stations/harbours.
import {
  MODES,
  scaleFor,
  colorAt,
  beaufort,
  compass,
  latticeFor,
  latticePoints,
  pointKey,
  openMeteoUrls,
  mergeSeries,
  timeIndex,
  toVector,
  sampleGrid,
  vectorMean,
  fillGaps,
} from './weather.js';
import { distanceNm, formatPosition } from './geo.js';

const HOUR = 3600;
const GRID_TTL = 60 * 60 * 1000; // refetch grid points after an hour
const POINT_TTL = 30 * 60 * 1000;
const BATCH = 80; // locations per Open-Meteo request
const SJOLAG = 'api/sjolag'; // same-origin proxy to https://sjolag.is/api (see vercel.json)

const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (t) => {
  const d = new Date(t * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};
const r1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : '—');
/** Arrow pointing the way the wind/sea/current travels. */
const arrow = (dir, dirIsFrom, size = 14) =>
  Number.isFinite(dir)
    ? `<span class="wx-arrow" style="width:${size}px;height:${size}px;transform:rotate(${(dirIsFrom ? dir + 180 : dir) % 360}deg)">↑</span>`
    : '';

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Data service
// ---------------------------------------------------------------------------
const gridCache = new Map(); // pointKey -> { series, at }
const pending = new Map(); // pointKey -> Promise

async function fetchPoints(points) {
  const now = Date.now();
  const missing = points.filter((p) => {
    const c = gridCache.get(pointKey(p));
    return (!c || now - c.at > GRID_TTL) && !pending.has(pointKey(p));
  });
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const urls = openMeteoUrls(batch);
    const job = Promise.all([getJson(urls.forecast), getJson(urls.marine).catch(() => null)]).then(([f, m]) => {
      const series = mergeSeries(f, m);
      batch.forEach((p, k) => gridCache.set(pointKey(p), { series: series[k], at: Date.now() }));
    });
    batch.forEach((p) => pending.set(pointKey(p), job));
    job.finally(() => batch.forEach((p) => pending.delete(pointKey(p)))).catch(() => {});
  }
  await Promise.allSettled(points.map((p) => pending.get(pointKey(p))).filter(Boolean));
  return points.map((p) => gridCache.get(pointKey(p))?.series ?? null);
}

const pointCache = new Map();
/** Forecast series for one position (rounded to ~3 km so nearby requests share a cache entry). */
export async function pointForecast(pos) {
  const p = { lat: Math.round(pos.lat * 40) / 40, lon: Math.round(pos.lon * 20) / 20 };
  const k = pointKey(p);
  const c = pointCache.get(k);
  if (c && Date.now() - c.at < POINT_TTL) return c.series;
  const urls = openMeteoUrls([p], 7, 2); // 2 past days so drift can average back to the LKP
  const [f, m] = await Promise.all([getJson(urls.forecast), getJson(urls.marine).catch(() => null)]);
  const [series] = mergeSeries(f, m);
  pointCache.set(k, { series, at: Date.now() });
  return series;
}

let obsCache = null;
/** Vegagerðin measurements (buoys, harbours, weather stations) via the same-origin proxy. */
export async function observations() {
  if (obsCache && Date.now() - obsCache.at < 5 * 60 * 1000) return obsCache.data;
  const [buoys, harbours, stations] = await Promise.all(
    ['buoys/measurements', 'harbours/measurements', 'weather-stations/measurements'].map((p) =>
      getJson(`${SJOLAG}/${p}`)
        .then((j) => j.data ?? [])
        .catch(() => []),
    ),
  );
  const data = {
    buoys: buoys.filter((b) => b.coordinates && Number.isFinite(b.waveHeight)), // skip forecast-only points
    harbours,
    // Coastal stations only: those sjólag.is itself shows on its sea map.
    stations: stations.filter((s) => s.seaMapPriority != null && Number.isFinite(s.lat) && s.ageDays < 0.5),
  };
  obsCache = { data, at: Date.now() };
  return data;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
export function initWeather({ map, store, toast, getPos, marks, selectTab }) {
  const $ = (id) => document.getElementById(id);
  let mode = store.get('wxMode', 'wind');
  let active = false;
  let times = []; // master hourly times (unix s)
  let ti = 0;
  let grid = null; // { g, series[] }
  let playing = null;

  // ---------------------------------------------------------------- map layer
  map.createPane('wx');
  map.getPane('wx').style.zIndex = 350; // above chart tiles, below overlays/markers
  map.getPane('wx').style.pointerEvents = 'none';

  const WxLayer = L.Layer.extend({
    onAdd() {
      this._field = L.DomUtil.create('canvas', 'wx-field', map.getPane('wx'));
      this._flow = L.DomUtil.create('canvas', 'wx-flow', map.getPane('wx'));
      map.on('movestart zoomstart', this._hide, this);
      map.on('moveend zoomend resize', this._refresh, this);
      this._refresh();
    },
    onRemove() {
      map.off('movestart zoomstart', this._hide, this);
      map.off('moveend zoomend resize', this._refresh, this);
      cancelAnimationFrame(this._raf);
      this._field.remove();
      this._flow.remove();
    },
    _hide() {
      cancelAnimationFrame(this._raf);
      this._field.style.opacity = 0;
      this._flow.style.opacity = 0;
    },
    async _refresh() {
      const size = map.getSize();
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      for (const c of [this._field, this._flow]) {
        c.width = size.x;
        c.height = size.y;
        L.DomUtil.setPosition(c, topLeft);
      }
      const b = map.getBounds().pad(0.15);
      const g = latticeFor({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
      const pts = latticePoints(g);
      setStatus('Loading forecast…');
      try {
        const series = await fetchPoints(pts);
        if (!this._map) return;
        grid = { g, series };
        const first = series.find(Boolean);
        if (first && (!times.length || first.time[0] !== times[0])) setTimes(first.time);
        setStatus(series.some((s) => !s) ? 'Some forecast points unavailable' : '');
      } catch (e) {
        setStatus('Forecast unavailable (offline?)');
        return;
      }
      this.draw();
    },
    draw() {
      if (!grid || !this._map) return;
      const { g, series } = grid;
      const m = MODES[mode];
      const idx = series.map((s) => (s ? timeIndex(s.time, times[ti]) : -1));
      const val = series.map((s, k) => (s && idx[k] >= 0 ? (s[m.value][idx[k]] ?? NaN) : NaN));
      const dir = series.map((s, k) => (s && idx[k] >= 0 ? (s[m.dir][idx[k]] ?? NaN) : NaN));
      const uv = val.map((v, k) => toVector(v, dir[k], m.dirIsFrom));
      // Fill gaps (land points in the wave model) so the field has no hard edges.
      const U = fillGaps(g, uv.map((x) => x[0]));
      const V = fillGaps(g, uv.map((x) => x[1]));
      const filled = fillGaps(g, val);
      val.splice(0, val.length, ...filled);
      this._sample = (lat, lon) => ({
        v: sampleGrid(g, val, lat, lon),
        u: sampleGrid(g, U, lat, lon),
        n: sampleGrid(g, V, lat, lon),
      });

      // Colour field at quarter resolution, smoothed when scaled up.
      const W = this._field.width;
      const H = this._field.height;
      const step = 4;
      const w = Math.ceil(W / step);
      const h = Math.ceil(H / step);
      const lons = Array.from({ length: w }, (_, x) => map.containerPointToLatLng([x * step, 0]).lng);
      const lats = Array.from({ length: h }, (_, y) => map.containerPointToLatLng([0, y * step]).lat);
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      const img = octx.createImageData(w, h);
      const scale = scaleFor(mode);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = colorAt(scale, sampleGrid(g, val, lats[y], lons[x]));
          if (!c) continue;
          const o = (y * w + x) * 4;
          img.data[o] = c[0];
          img.data[o + 1] = c[1];
          img.data[o + 2] = c[2];
          img.data[o + 3] = 150;
        }
      }
      octx.putImageData(img, 0, 0);
      const ctx = this._field.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, W, H);

      // Direction arrows for waves/swell (sea state has no "flow" to animate).
      if (!m.flow) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        for (let y = 30; y < H; y += 56) {
          for (let x = 30; x < W; x += 56) {
            const ll = map.containerPointToLatLng([x, y]);
            const s = this._sample(ll.lat, ll.lng);
            if (!Number.isFinite(s.u) || !Number.isFinite(s.v)) continue;
            const a = Math.atan2(s.u, s.n);
            const len = 9 + Math.min(10, s.v * 2);
            const dx = Math.sin(a) * len;
            const dy = -Math.cos(a) * len;
            ctx.beginPath();
            ctx.moveTo(x - dx, y - dy);
            ctx.lineTo(x + dx, y + dy);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x + dx, y + dy, 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      this._field.style.opacity = 1;
      this._flow.style.opacity = 1;
      this._startFlow(m.flow);
    },
    _startFlow(on) {
      cancelAnimationFrame(this._raf);
      const ctx = this._flow.getContext('2d');
      ctx.clearRect(0, 0, this._flow.width, this._flow.height);
      if (!on || document.hidden) return;
      const W = this._flow.width;
      const H = this._flow.height;
      const n = Math.min(900, Math.round((W * H) / 450));
      const speedK = mode === 'current' ? 2.2 : 0.09; // px per frame per knot
      const spawn = (p) => {
        p.x = Math.random() * W;
        p.y = Math.random() * H;
        p.age = Math.floor(Math.random() * 80);
        return p;
      };
      const ps = Array.from({ length: n }, () => spawn({}));
      // Cache vectors on a coarse screen grid; sampling lat/lon per particle per frame is too slow.
      const cell = 8;
      const cw = Math.ceil(W / cell) + 1;
      const chh = Math.ceil(H / cell) + 1;
      const vx = new Float32Array(cw * chh);
      const vy = new Float32Array(cw * chh);
      for (let j = 0; j < chh; j++) {
        for (let i = 0; i < cw; i++) {
          const ll = map.containerPointToLatLng([i * cell, j * cell]);
          const s = this._sample(ll.lat, ll.lng);
          vx[j * cw + i] = Number.isFinite(s.u) ? s.u : NaN;
          vy[j * cw + i] = Number.isFinite(s.n) ? -s.n : NaN; // screen y grows downwards
        }
      }
      const frame = () => {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = 'rgba(0,0,0,0.9)';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const p of ps) {
          const k = Math.round(p.y / cell) * cw + Math.round(p.x / cell);
          const dx = vx[k] * speedK;
          const dy = vy[k] * speedK;
          if (!Number.isFinite(dx) || p.age++ > 90 || p.x < 0 || p.y < 0 || p.x > W || p.y > H) {
            spawn(p);
            p.age = 0;
            continue;
          }
          ctx.moveTo(p.x, p.y);
          p.x += dx;
          p.y += dy;
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        this._raf = requestAnimationFrame(frame);
      };
      this._raf = requestAnimationFrame(frame);
    },
    valueAt(latlng) {
      return this._sample ? this._sample(latlng.lat, latlng.lng) : null;
    },
  });
  const wxLayer = new WxLayer();
  document.addEventListener('visibilitychange', () => active && wxLayer.draw());

  // ---------------------------------------------------------------- control bar
  const WxButton = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const a = L.DomUtil.create('a', 'leaflet-bar wx-toggle');
      a.href = '#';
      a.title = 'Weather on the chart';
      a.setAttribute('role', 'button');
      a.textContent = 'Wx';
      L.DomEvent.on(a, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        setActive(!active);
      });
      L.DomEvent.disableClickPropagation(a);
      this._a = a;
      return a;
    },
  });
  const wxButton = new WxButton().addTo(map);

  const bar = $('wx-bar');
  for (const [k, m] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.dataset.mode = k;
    b.textContent = m.label;
    b.addEventListener('click', () => setMode(k));
    $('wx-modes').appendChild(b);
  }
  $('wx-time').addEventListener('input', (e) => setTi(Number(e.target.value)));
  $('wx-play').addEventListener('click', () => (playing ? stop() : play()));
  $('wx-close').addEventListener('click', () => setActive(false));

  function setActive(on) {
    active = on;
    store.set('wxActive', on);
    bar.hidden = !on;
    wxButton._a.classList.toggle('on', on);
    document.body.classList.toggle('wx-on', on);
    if (on) wxLayer.addTo(map);
    else {
      stop();
      map.removeLayer(wxLayer);
    }
  }
  function setMode(k) {
    mode = k;
    store.set('wxMode', k);
    document.querySelectorAll('#wx-modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === k)));
    renderLegend();
    wxLayer.draw();
  }
  function setTimes(t) {
    times = t;
    const now = Date.now() / 1000;
    ti = Math.max(0, timeIndex(times, now));
    const s = $('wx-time');
    s.max = times.length - 1;
    s.value = ti;
    renderTimeLabel();
  }
  function setTi(i) {
    ti = Math.max(0, Math.min(times.length - 1, i));
    $('wx-time').value = ti;
    renderTimeLabel();
    wxLayer.draw();
  }
  function play() {
    $('wx-play').textContent = '❚❚';
    playing = setInterval(() => setTi(ti >= times.length - 1 ? 0 : ti + 1), 900);
  }
  function stop() {
    $('wx-play').textContent = '▶';
    clearInterval(playing);
    playing = null;
  }
  function renderTimeLabel() {
    if (!times.length) return;
    const t = times[ti];
    const dh = Math.round((t - Date.now() / 1000) / HOUR);
    $('wx-time-label').textContent = `${dayLabel(t)} ${hhmm(t)} GMT${dh ? ` (${dh > 0 ? '+' : ''}${dh} h)` : ' (now)'}`;
  }
  function renderLegend() {
    const sc = scaleFor(mode);
    const max = sc[sc.length - 1][0];
    const stops = sc.map(([v, c]) => `rgb(${c}) ${((v / max) * 100).toFixed(0)}%`).join(',');
    $('wx-legend').innerHTML = `<div class="wx-grad" style="background:linear-gradient(90deg,${stops})"></div>
      <div class="wx-ticks">${sc
        .filter((_, i) => i % 2 === 0 || i === sc.length - 1)
        .map(([v]) => `<span style="left:${(v / max) * 100}%">${v}</span>`)
        .join('')}<span class="u">${MODES[mode].unit}</span></div>`;
  }
  function setStatus(s) {
    $('wx-status').textContent = s;
  }

  // Tap the chart (when weather is on) to read the value there.
  map.on('click', (e) => {
    if (!active || document.getElementById('pick-banner').hidden === false) return;
    const s = wxLayer.valueAt(e.latlng);
    if (!s || !Number.isFinite(s.v)) return;
    const m = MODES[mode];
    const dir = ((Math.atan2(s.u, s.n) * 180) / Math.PI + (m.dirIsFrom ? 180 : 0) + 360) % 360;
    const how = m.dirIsFrom ? `from ${compass(dir)} (${r0(dir)}°)` : `towards ${compass(dir)} (${r0(dir)}°)`;
    L.popup({ className: 'wx-popup' })
      .setLatLng(e.latlng)
      .setContent(`<b>${m.label} ${r1(s.v)} ${m.unit}</b><br>${how}<br><small>${dayLabel(times[ti])} ${hhmm(times[ti])} GMT</small>`)
      .openOn(map);
  });

  // ---------------------------------------------------------------- forecast tab
  const locSel = $('wx-loc');
  function fillLoc() {
    const prev = locSel.value || store.get('wxLoc', '__own');
    locSel.innerHTML = '';
    locSel.add(new Option('Own position', '__own'));
    locSel.add(new Option('Chart centre', '__center'));
    for (const m of marks()) locSel.add(new Option(m.name, m.id));
    locSel.value = [...locSel.options].some((o) => o.value === prev) ? prev : '__own';
  }
  function locPos() {
    const v = locSel.value;
    if (v === '__own') return getPos() ? { ...getPos(), name: 'Own position' } : null;
    if (v === '__center') {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng, name: 'Chart centre' };
    }
    return marks().find((m) => m.id === v) || null;
  }
  locSel.addEventListener('change', () => {
    store.set('wxLoc', locSel.value);
    renderForecast();
  });
  $('wx-refresh').addEventListener('click', () => {
    pointCache.clear();
    obsCache = null;
    renderForecast();
  });

  let lastRender = 0;
  async function renderForecast() {
    fillLoc();
    let pos = locPos();
    if (!pos && locSel.value === '__own') {
      const c = map.getCenter();
      pos = { lat: c.lat, lon: c.lng, name: 'Chart centre (no GPS fix)' };
    }
    if (!pos) return;
    $('wx-where').textContent = `${pos.name} · ${formatPosition(pos, 'ddm')}`;
    $('wx-now').innerHTML = '<span class="muted">Loading forecast…</span>';
    let s;
    try {
      s = await pointForecast(pos);
    } catch {
      $('wx-now').innerHTML = '<span class="tide-warn">Forecast unavailable. You may be offline; the last forecast you viewed for this place is used when available.</span>';
      return;
    }
    lastRender = Date.now();
    const i = Math.max(0, timeIndex(s.time, Date.now() / 1000));
    const at = (k) => s[k][i];
    const bf = beaufort(at('wind_speed_10m'));
    $('wx-now').innerHTML = `
      <div class="big"><span class="label">Wind kn · F${bf}</span>${arrow(at('wind_direction_10m'), true, 18)} ${r0(at('wind_speed_10m'))}
        <span class="sub">${compass(at('wind_direction_10m'))} · gusts ${r0(at('wind_gusts_10m'))}</span></div>
      <div class="big"><span class="label">Waves m</span>${arrow(at('wave_direction'), true, 18)} ${r1(at('wave_height'))}
        <span class="sub">${r0(at('wave_period'))} s · swell ${r1(at('swell_wave_height'))} m</span></div>
      <div class="big"><span class="label">Current kn</span>${arrow(at('ocean_current_direction'), false, 18)} ${r1(at('current_kn'))}
        <span class="sub">to ${compass(at('ocean_current_direction'))} · ${r0(at('pressure_msl'))} hPa</span></div>`;
    renderTable(s, i);
    renderNearestObs(pos);
  }

  function cls(scale, v) {
    const c = colorAt(scale, v);
    return c ? `style="background:rgba(${c},0.55)"` : '';
  }
  function renderTable(s, i0) {
    const step = 3;
    const cols = [];
    let start = i0;
    while (start < s.time.length && (s.time[start] / HOUR) % step) start++; // align to 00/03/06… GMT
    for (let i = start; i < s.time.length; i += step) cols.push(i);
    const knS = scaleFor('wind');
    const mS = scaleFor('waves');
    const cS = scaleFor('current');
    const dayStart = new Set(cols.filter((i, k) => k === 0 || dayLabel(s.time[i]) !== dayLabel(s.time[cols[k - 1]])));
    const row = (label, f) =>
      `<tr><th>${label}</th>${cols.map((i) => f(i).replace('<td', dayStart.has(i) ? '<td class="day"' : '<td')).join('')}</tr>`;
    let lastDay = '';
    const head = cols
      .map((i) => {
        const d = dayLabel(s.time[i]);
        const newDay = d !== lastDay;
        lastDay = d;
        return `<th class="${newDay ? 'day' : ''}">${newDay ? `<span class="d">${d}</span>` : ''}${hhmm(s.time[i]).slice(0, 2)}</th>`;
      })
      .join('');
    const vis = (m) => (Number.isFinite(m) ? (m >= 10000 ? '10+' : (m / 1852).toFixed(m < 1852 ? 1 : 0)) : '—');
    $('wx-table').innerHTML = `<div class="wx-scroll"><table class="wx-tbl">
      <thead><tr><th>GMT</th>${head}</tr></thead><tbody>
      ${row('Wind kn', (i) => `<td ${cls(knS, s.wind_speed_10m[i])}>${arrow(s.wind_direction_10m[i], true)}<b>${r0(s.wind_speed_10m[i])}</b></td>`)}
      ${row('Gusts', (i) => `<td ${cls(knS, s.wind_gusts_10m[i])}>${r0(s.wind_gusts_10m[i])}</td>`)}
      ${row('Waves m', (i) => `<td ${cls(mS, s.wave_height[i])}>${arrow(s.wave_direction[i], true)}<b>${r1(s.wave_height[i])}</b></td>`)}
      ${row('Period s', (i) => `<td>${r0(s.wave_period[i])}</td>`)}
      ${row('Swell m', (i) => `<td ${cls(mS, s.swell_wave_height[i])}>${r1(s.swell_wave_height[i])}</td>`)}
      ${row('Current', (i) => `<td ${cls(cS, s.current_kn[i])}>${arrow(s.ocean_current_direction[i], false)}${r1(s.current_kn[i])}</td>`)}
      ${row('hPa', (i) => `<td>${r0(s.pressure_msl[i])}</td>`)}
      ${row('Air °C', (i) => `<td>${r0(s.temperature_2m[i])}</td>`)}
      ${row('Sea °C', (i) => `<td>${r1(s.sea_surface_temperature[i])}</td>`)}
      ${row('Rain mm', (i) => `<td>${Number.isFinite(s.precipitation[i]) && s.precipitation[i] > 0 ? r1(s.precipitation[i]) : ''}</td>`)}
      ${row('Vis NM', (i) => `<td>${vis(s.visibility[i])}</td>`)}
      </tbody></table></div>
      <p class="muted small">Model forecast, 3-hourly. Arrows point the way the wind, sea and current travel. Wind and gusts at 10 m. Weather: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (ECMWF, DWD, DMI and others). Waves and currents: DWD ICON-Wave / Copernicus via Open-Meteo. Always check the Met Office's marine forecasts and warnings (vedur.is).</p>`;
  }

  async function renderNearestObs(pos) {
    const el = $('wx-obs');
    try {
      const { buoys, stations, harbours } = await observations();
      const near = (list, getPos) =>
        list
          .map((x) => ({ x, nm: distanceNm(pos, getPos(x)) }))
          .sort((a, b) => a.nm - b.nm)[0];
      const b = near(buoys, (x) => ({ lat: x.coordinates.lat, lon: x.coordinates.lon }));
      const st = near(stations, (x) => x);
      const h = near(harbours, (x) => x);
      const ago = (iso) => {
        const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
        return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
      };
      let html = '<div class="label">Measured nearby (Vegagerðin, sjolag.is)</div><ul class="list">';
      if (b)
        html += `<li><div class="grow"><div class="title">Buoy ${b.x.name} · ${b.nm.toFixed(0)} NM</div><div class="sub">Waves ${r1(b.x.waveHeight)} m · ${r1(b.x.peakPeriod)} s${Number.isFinite(b.x.meanWaveDirection) ? ` · from ${compass(b.x.meanWaveDirection)}` : ''}${Number.isFinite(b.x.seaTemperature) ? ` · sea ${r1(b.x.seaTemperature)} °C` : ''} · ${ago(b.x.date)}</div></div></li>`;
      if (st)
        html += `<li><div class="grow"><div class="title">${st.x.name} · ${st.nm.toFixed(0)} NM</div><div class="sub">Wind ${r0(st.x.windSpeed * 1.943844)} kn from ${compass(st.x.windDirection)} · gusts ${r0(st.x.windGust * 1.943844)} kn${Number.isFinite(st.x.pressure) ? ` · ${r0(st.x.pressure)} hPa` : ''} · ${ago(st.x.measuredAt)}</div></div></li>`;
      if (h && h.nm < 30)
        html += `<li><div class="grow"><div class="title">Sea level ${h.x.name} · ${h.nm.toFixed(0)} NM</div><div class="sub">${r1(h.x.seaLevel)} m: tide ${r1(h.x.tide)} m + surge ${h.x.surge >= 0 ? '+' : ''}${(h.x.surge ?? 0).toFixed(2)} m (model, ${hhmm(Date.parse(h.x.date) / 1000)} GMT)</div></div></li>`;
      html += '</ul>';
      el.innerHTML = html;
    } catch {
      el.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------- observations overlay
  const obsLayer = L.layerGroup();
  async function drawObs() {
    obsLayer.clearLayers();
    if (!map.hasLayer(obsLayer)) return;
    const { buoys, stations: allStations, harbours } = await observations();
    // Declutter: buoys always; stations in sjólag.is's own priority order, skipping overlaps.
    const placed = buoys.map((b) => map.latLngToContainerPoint([b.coordinates.lat, b.coordinates.lon]));
    const free = (lat, lon, w = 52, h = 20) => {
      const pt = map.latLngToContainerPoint([lat, lon]);
      if (placed.some((q) => Math.abs(q.x - pt.x) < w && Math.abs(q.y - pt.y) < h)) return false;
      placed.push(pt);
      return true;
    };
    const stations = [...allStations]
      .sort((a, b) => (a.seaMapPriority ?? 9) - (b.seaMapPriority ?? 9))
      .filter((st) => free(st.lat, st.lon));
    for (const b of buoys) {
      L.marker([b.coordinates.lat, b.coordinates.lon], {
        icon: L.divIcon({
          className: '',
          iconSize: [0, 0],
          html: `<div class="obs-pin buoy">${Number.isFinite(b.meanWaveDirection) ? arrow(b.meanWaveDirection, true, 11) : ''}${r1(b.waveHeight)} m · ${r0(b.peakPeriod)} s</div>`,
        }),
      })
        .bindPopup(
          `<b>${b.name}</b> (buoy)<br>${b.description ?? ''}<br>Waves ${r1(b.waveHeight)} m, peak period ${r1(b.peakPeriod)} s, wavelength ${r0(b.waveLength)} m${Number.isFinite(b.meanWaveDirection) ? `, from ${compass(b.meanWaveDirection)}` : ''}${Number.isFinite(b.seaTemperature) ? `<br>Sea ${r1(b.seaTemperature)} °C` : ''}<br><small>${new Date(b.date).toISOString().slice(0, 16).replace('T', ' ')} GMT · Vegagerðin</small>`,
        )
        .addTo(obsLayer);
    }
    for (const s of stations) {
      const kn = s.windSpeed * 1.943844;
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '',
          iconSize: [0, 0],
          html: `<div class="obs-pin wind">${arrow(s.windDirection, true, 11)}${r0(kn)}<small>/${r0(s.windGust * 1.943844)}</small></div>`,
        }),
      })
        .bindPopup(
          `<b>${s.name}</b><br>Wind ${r0(kn)} kn from ${compass(s.windDirection)} (${r0(s.windDirection)}°), gusts ${r0(s.windGust * 1.943844)} kn${Number.isFinite(s.pressure) ? `<br>${r1(s.pressure)} hPa` : ''}${Number.isFinite(s.temperature) ? ` · ${r1(s.temperature)} °C` : ''}<br><small>${s.measuredAt.slice(0, 16).replace('T', ' ')} GMT · ${s.owner}</small>`,
        )
        .addTo(obsLayer);
    }
    for (const h of harbours) {
      L.circleMarker([h.lat, h.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#2a9d8f', fillOpacity: 1 })
        .bindPopup(
          `<b>${h.name}</b> sea level (model)<br>${r1(h.seaLevel)} m = tide ${r1(h.tide)} m + surge ${h.surge >= 0 ? '+' : ''}${(h.surge ?? 0).toFixed(2)} m<br><small>${h.date.slice(0, 16).replace('T', ' ')} GMT · Vegagerðin</small>`,
        )
        .addTo(obsLayer);
    }
  }
  obsLayer.on('add', () => drawObs().catch(() => toast('Measurements could not be loaded')));
  map.on('zoomend', () => map.hasLayer(obsLayer) && drawObs().catch(() => {}));
  setInterval(() => map.hasLayer(obsLayer) && drawObs().catch(() => {}), 10 * 60 * 1000);

  // ---------------------------------------------------------------- boot
  renderLegend();
  setMode(mode);
  if (store.get('wxActive', false)) setActive(true);
  setInterval(() => {
    if (!document.querySelector('[data-panel="weather"]').hidden && Date.now() - lastRender > 15 * 60 * 1000) renderForecast();
  }, 60 * 1000);

  return {
    obsLayer,
    renderForecast,
    pointForecast,
    observations,
    /** Mean wind (from) and current (towards) at pos between unix times t0..t1. */
    async driftInputs(pos, t0, t1) {
      const s = await pointForecast(pos);
      return {
        wind: vectorMean(s, 'wind_speed_10m', 'wind_direction_10m', t0, t1),
        current: vectorMean(s, 'current_kn', 'ocean_current_direction', t0, t1),
      };
    },
    selectTab,
  };
}
