/* global L */
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
} from './geo.js';

// ---------------------------------------------------------------------------
// Persistence (localStorage can be unavailable; never let that break the app)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ss.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ss.${key}`, JSON.stringify(value));
    } catch {
      /* storage full or blocked */
    }
  },
};

const $ = (id) => document.getElementById(id);
const fmt1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const fmt2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const fmtBrg = (n) => (Number.isFinite(n) ? String(Math.round(n) % 360).padStart(3, '0') : '—');
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const uid = () => Math.random().toString(36).slice(2, 10);

function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function download(filename, text, type = 'application/gpx+xml') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  fix: null, // { lat, lon, acc, sog, cog, time }
  lastFix: null,
  posFormat: store.get('posFormat', 'ddm'),
  follow: true,
  marks: store.get('marks', []),
  track: store.get('track', []),
  recording: store.get('recording', false),
  log: store.get('log', []),
  pattern: null, // { name, points, prefix }
  target: store.get('target', null), // { name, points, idx, isRoute }
  pickCallback: null,
  lastDatum: null,
};

const ARRIVAL_NM = 0.05; // ~90 m: waypoint considered reached

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map('map', {
  center: store.get('mapCenter', [64.9, -19.0]),
  zoom: store.get('mapZoom', 6),
  zoomControl: true,
  attributionControl: true,
});

const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: 'Seamarks &copy; <a href="https://www.openseamap.org">OpenSeaMap</a>',
}).addTo(map);

const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 18, attribution: 'Imagery &copy; Esri' },
);

// Official Icelandic nautical charts (Landhelgisgæslan / Sjómælingar Íslands), as
// served to the LHG map viewer at atlas.lmi.is. Web-mercator tile cache, so it
// lines up with the other layers. The chart is transparent outside chart
// coverage, so it is drawn over an OSM background.
const LHG_ATTR = 'Sjókort &copy; <a href="https://www.lhg.is">Landhelgisgæslan</a> / <a href="https://www.natt.is">Náttúrufræðistofnun</a>';
const sjokort = L.layerGroup([
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
  L.tileLayer.wms('https://gis.natt.is/mapcache/sjokort/web-mercator/wmst', {
    layers: 'Sjomaelingar:Sjokort_Sjomaelinga',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    tiled: true,
    maxZoom: 19,
    attribution: LHG_ATTR,
  }),
]);

// Vector overlays published by the Coast Guard as open data (gis.lmi.is, LHG workspace).
const lhgWms = (layer, extra = {}) =>
  L.tileLayer.wms('https://gis.lmi.is/geoserver/LHG/wms', {
    layers: `LHG:${layer}`,
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    maxZoom: 19,
    attribution: 'LHG / Náttúrufræðistofnun (open data)',
    ...extra,
  });

const baseLayers = { 'Chart (OSM)': osm, 'Sjókort (LHG)': sjokort, Satellite: satellite };
const overlays = {
  'Seamarks (OpenSeaMap)': seamarks,
  'Depth areas (LHG)': lhgWms('dyptarflakar', { opacity: 0.6 }),
  'Depth contours (LHG)': lhgWms('dypislinur'),
  'Territorial sea 12 NM': lhgWms('landhelgi_12_milur_lina'),
  'Contiguous zone 24 NM': lhgWms('adlaekt_belti_24_milur_lina'),
  'EEZ 200 NM': lhgWms('efnahagslogsaga_lina'),
  Baseline: lhgWms('grunnlina'),
};

// Restore the last chosen base map and overlays.
const savedBase = store.get('baseLayer', null);
if (savedBase && baseLayers[savedBase] && savedBase !== 'Chart (OSM)') {
  map.removeLayer(osm);
  baseLayers[savedBase].addTo(map);
}
const savedOverlays = store.get('overlays', null);
if (Array.isArray(savedOverlays)) {
  for (const [name, layer] of Object.entries(overlays)) {
    if (savedOverlays.includes(name)) layer.addTo(map);
    else map.removeLayer(layer);
  }
}
map.on('baselayerchange', (e) => store.set('baseLayer', e.name));
map.on('overlayadd overlayremove', () =>
  store.set('overlays', Object.keys(overlays).filter((n) => map.hasLayer(overlays[n]))),
);

L.control.layers(baseLayers, overlays, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, metric: true, position: 'bottomleft' }).addTo(map);

// Nautical-mile scale (Leaflet only does metric / imperial).
const NmScale = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    this._el = L.DomUtil.create('div', 'leaflet-control-scale-line');
    map.on('moveend zoomend', () => this._update());
    this._update();
    return this._el;
  },
  _update() {
    const y = map.getSize().y / 2;
    const a = map.containerPointToLatLng([0, y]);
    const b = map.containerPointToLatLng([100, y]);
    const nmPer100px = distanceNm({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
    const nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((n) => n >= nmPer100px * 0.6) ?? 200;
    this._el.style.width = `${Math.round((nice / nmPer100px) * 100)}px`;
    this._el.textContent = `${nice} NM`;
  },
});
new NmScale().addTo(map);

map.on('moveend', () => {
  const c = map.getCenter();
  store.set('mapCenter', [c.lat, c.lng]);
  store.set('mapZoom', map.getZoom());
});
map.on('dragstart', () => setFollow(false));

map.on('click', (e) => {
  if (!state.pickCallback) return;
  const cb = state.pickCallback;
  endPick();
  cb({ lat: e.latlng.lat, lon: e.latlng.lng });
});

function startPick(cb) {
  state.pickCallback = cb;
  $('pick-banner').hidden = false;
  setFollow(false);
}
function endPick() {
  state.pickCallback = null;
  $('pick-banner').hidden = true;
}
$('pick-cancel').addEventListener('click', endPick);

const ll = (p) => [p.lat, p.lon];

// Own ship
const shipIcon = L.divIcon({
  className: 'ownship',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  html: `<svg width="28" height="28" viewBox="-14 -14 28 28"><g id="ship-rot">
    <path d="M0,-13 L8,10 L0,5 L-8,10 Z" fill="#ff006e" stroke="#fff" stroke-width="2"/></g></svg>`,
});
const ship = L.marker([0, 0], { icon: shipIcon, interactive: false, zIndexOffset: 1000 });
const accCircle = L.circle([0, 0], { radius: 1, weight: 1, color: '#ff006e', fillOpacity: 0.08, interactive: false });
const cogVector = L.polyline([], { color: '#ff006e', weight: 2, dashArray: '6 6', interactive: false });
const trackLine = L.polyline(state.track.map(ll), { color: '#ff006e', weight: 2, opacity: 0.7 }).addTo(map);
const targetLine = L.polyline([], { color: '#ffb703', weight: 3, interactive: false }).addTo(map);

// Search pattern layers
const patternLayer = L.layerGroup().addTo(map);
const marksLayer = L.layerGroup().addTo(map);

// ---------------------------------------------------------------------------
// Top bar / follow / night
// ---------------------------------------------------------------------------
const FORMATS = ['ddm', 'dms', 'dd'];

function updateTopHeight() {
  document.documentElement.style.setProperty('--top-h', `${$('topbar').offsetHeight}px`);
  map.invalidateSize();
}
window.addEventListener('resize', updateTopHeight);

$('pos').addEventListener('click', () => {
  state.posFormat = FORMATS[(FORMATS.indexOf(state.posFormat) + 1) % FORMATS.length];
  store.set('posFormat', state.posFormat);
  renderFix();
  renderMarks();
});

function setFollow(on) {
  state.follow = on;
  $('follow').setAttribute('aria-pressed', String(on));
  if (on && state.fix) map.panTo(ll(state.fix));
}
$('follow').addEventListener('click', () => {
  if (!state.fix) return toast('No GPS fix yet');
  setFollow(!state.follow);
  if (state.follow && map.getZoom() < 12) map.setView(ll(state.fix), 13);
});

function setNight(on) {
  document.documentElement.dataset.night = on ? '1' : '0';
  document.querySelector('meta[name="theme-color"]').content = on ? '#000000' : '#0b2236';
  store.set('night', on);
}
$('night').addEventListener('click', () => setNight(document.documentElement.dataset.night !== '1'));
setNight(store.get('night', false));

// ---------------------------------------------------------------------------
// Tabs / sheet
// ---------------------------------------------------------------------------
function selectTab(name) {
  document.querySelectorAll('#tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  document.body.classList.remove('sheet-collapsed');
  $('sheet-toggle').textContent = '▾';
  store.set('tab', name);
  if (name === 'search' || name === 'drift') refreshMarkSelects();
  if (name === 'sos') renderSos();
  setTimeout(() => map.invalidateSize(), 50);
}
document.querySelectorAll('#tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('sheet-toggle').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('sheet-collapsed');
  $('sheet-toggle').textContent = collapsed ? '▴' : '▾';
  setTimeout(() => map.invalidateSize(), 50);
});

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------
function onPosition(pos) {
  const c = pos.coords;
  const fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, time: pos.timestamp, sog: NaN, cog: NaN };

  // Prefer device-provided speed/heading; otherwise derive from successive fixes.
  if (Number.isFinite(c.speed) && c.speed !== null) fix.sog = c.speed * 1.943844; // m/s → kn
  if (Number.isFinite(c.heading) && c.heading !== null && fix.sog > 0.3) fix.cog = c.heading;
  const prev = state.lastFix;
  if (prev) {
    const dtH = (fix.time - prev.time) / 3.6e6;
    const d = distanceNm(prev, fix);
    if (dtH > 0 && d * 1852 > Math.max(5, fix.acc / 2)) {
      if (!Number.isFinite(fix.sog)) fix.sog = d / dtH;
      if (!Number.isFinite(fix.cog)) fix.cog = bearing(prev, fix);
      state.lastFix = fix;
    } else if (state.fix) {
      // Not moved enough to trust a new vector: keep previous COG.
      if (!Number.isFinite(fix.cog)) fix.cog = state.fix.cog;
      if (!Number.isFinite(fix.sog)) fix.sog = dtH > 30 / 3600 ? 0 : state.fix.sog;
    }
  } else {
    state.lastFix = fix;
  }

  const first = !state.fix;
  state.fix = fix;

  if (!map.hasLayer(ship)) {
    ship.addTo(map);
    accCircle.addTo(map);
    cogVector.addTo(map);
  }
  ship.setLatLng(ll(fix));
  accCircle.setLatLng(ll(fix)).setRadius(fix.acc || 1);
  const rot = document.getElementById('ship-rot');
  if (rot) rot.setAttribute('transform', `rotate(${Number.isFinite(fix.cog) ? fix.cog : 0})`);
  // 6-minute COG vector
  if (Number.isFinite(fix.cog) && fix.sog > 0.3) {
    cogVector.setLatLngs([ll(fix), ll(destination(fix, fix.cog, fix.sog / 10))]);
  } else {
    cogVector.setLatLngs([]);
  }

  if (first) map.setView(ll(fix), Math.max(map.getZoom(), 12));
  else if (state.follow && !state.pickCallback) map.panTo(ll(fix), { animate: false });

  recordTrack(fix);
  renderFix();
  updateNav();
}

function onPositionError(err) {
  $('pos-value').textContent = err.code === 1 ? 'GPS permission denied' : 'No GPS fix';
}

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 30000,
  });
} else {
  $('pos-value').textContent = 'No GPS on this device';
}

function renderFix() {
  const f = state.fix;
  $('pos-fmt').textContent = state.posFormat.toUpperCase();
  if (!f) return;
  $('pos-value').textContent = formatPosition(f, state.posFormat);
  $('sog').textContent = fmt1(f.sog);
  $('cog').textContent = fmtBrg(f.cog);
  $('acc').textContent = Number.isFinite(f.acc) ? Math.round(f.acc) : '—';
  if (!$('sheet').querySelector('[data-panel="sos"]').hidden) renderSos();
}

// Keep the screen on while the app is visible (supported browsers only).
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    /* not allowed */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) requestWakeLock();
});
document.addEventListener('click', requestWakeLock, { once: true });

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------
function saveMarks() {
  store.set('marks', state.marks);
  renderMarks();
  refreshMarkSelects();
}

function addMark(p, name, kind = 'mark') {
  const m = { id: uid(), name: name || `M${state.marks.length + 1}`, lat: p.lat, lon: p.lon, time: Date.now(), kind };
  state.marks.unshift(m);
  saveMarks();
  // The newest mark (MOB, LKP, datum…) is almost always what the next search or drift is based on.
  $('sp-datum').value = m.id;
  $('dr-lkp').value = m.id;
  addLog(`Mark "${m.name}" set at ${formatPosition(m, 'ddm')}`, m);
  return m;
}

function markIcon(m) {
  const cls = m.kind === 'mob' ? 'mob' : m.kind === 'datum' ? 'datum' : '';
  const glyph = m.kind === 'mob' ? '!' : m.kind === 'datum' ? 'D' : '✕';
  return L.divIcon({ className: '', html: `<div class="mark-icon ${cls}">${glyph}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function renderMarks() {
  marksLayer.clearLayers();
  const list = $('mark-list');
  list.innerHTML = '';
  for (const m of state.marks) {
    L.marker(ll(m), { icon: markIcon(m) })
      .bindTooltip(m.name, { permanent: true, direction: 'right', offset: [10, 0], className: 'mark-label' })
      .on('click', () => {
        if (!state.pickCallback) goTo(m);
      })
      .addTo(marksLayer);

    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'grow';
    const rel = state.fix ? ` · ${fmtBrg(bearing(state.fix, m))}° ${fmt2(distanceNm(state.fix, m))} NM` : '';
    info.innerHTML = `<div class="title"></div><div class="sub"></div>`;
    info.querySelector('.title').textContent = m.name;
    info.querySelector('.sub').textContent = `${formatPosition(m, state.posFormat)} · ${hhmm(new Date(m.time))}${rel}`;
    const go = document.createElement('button');
    go.textContent = 'Go';
    go.onclick = () => goTo(m);
    const show = document.createElement('button');
    show.textContent = 'Show';
    show.onclick = () => {
      setFollow(false);
      map.setView(ll(m), Math.max(map.getZoom(), 13));
    };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'danger';
    del.setAttribute('aria-label', `Delete ${m.name}`);
    del.onclick = () => {
      if (!confirm(`Delete mark "${m.name}"?`)) return;
      state.marks = state.marks.filter((x) => x.id !== m.id);
      saveMarks();
    };
    li.append(info, go, show, del);
    list.appendChild(li);
  }
  if (!state.marks.length) list.innerHTML = '<li class="muted">No marks yet.</li>';
}

$('mark-here').addEventListener('click', () => {
  if (!state.fix) return toast('No GPS fix yet');
  addMark(state.fix, $('mark-name').value.trim() || undefined);
  $('mark-name').value = '';
  toast('Mark added at own position');
});
$('mark-pick').addEventListener('click', () =>
  startPick((p) => {
    addMark(p, $('mark-name').value.trim() || undefined);
    $('mark-name').value = '';
  }),
);
$('mark-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = parsePosition($('mark-coord').value);
  if (!p) return toast('Could not read that position. Try e.g. 64 08.50N 021 56.30W');
  addMark(p, $('mark-name').value.trim() || undefined);
  $('mark-name').value = '';
  $('mark-coord').value = '';
  map.setView(ll(p), Math.max(map.getZoom(), 11));
  setFollow(false);
});

// MOB: one tap marks the position, logs it, and starts navigation back to it.
$('mob').addEventListener('click', () => {
  if (!state.fix) return toast('No GPS fix — note the time and your last position!', 4000);
  const n = state.marks.filter((m) => m.kind === 'mob').length + 1;
  const m = addMark(state.fix, `MOB ${n}`, 'mob');
  goTo(m);
  if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  toast(`MOB marked ${hhmm(new Date())} — navigating back`, 4000);
});

function refreshMarkSelects() {
  for (const id of ['sp-datum', 'dr-lkp']) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = '';
    const opts = [['__center', 'Chart centre'], ['__own', 'Own position'], ...state.marks.map((m) => [m.id, m.name])];
    for (const [v, t] of opts) sel.add(new Option(t, v));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (state.marks.length) sel.value = state.marks[0].id;
  }
}

function resolvePoint(value) {
  if (value === '__center') {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, name: 'Chart centre' };
  }
  if (value === '__own') return state.fix ? { ...state.fix, name: 'Own position' } : null;
  return state.marks.find((m) => m.id === value) || null;
}

// ---------------------------------------------------------------------------
// Navigation to target / route
// ---------------------------------------------------------------------------
function goTo(mark) {
  setTarget({ name: mark.name, points: [{ lat: mark.lat, lon: mark.lon }], idx: 0, isRoute: false });
  selectTab('nav');
}

function setTarget(t) {
  state.target = t;
  store.set('target', t);
  updateNav();
}

function updateNav() {
  const t = state.target;
  $('nav-empty').hidden = !!t;
  $('nav-active').hidden = !t;
  if (!t) {
    targetLine.setLatLngs([]);
    return;
  }
  const wp = t.points[t.idx];
  $('nav-name').textContent = t.name;
  $('nav-leg').textContent = t.isRoute ? `WP ${t.idx}/${t.points.length - 1}` : '';
  $('nav-prev').hidden = $('nav-next').hidden = !t.isRoute;

  const f = state.fix;
  if (!f) {
    ['nav-brg', 'nav-dst', 'nav-eta', 'nav-xte'].forEach((id) => ($(id).textContent = '—'));
    targetLine.setLatLngs([]);
    return;
  }

  let dst = distanceNm(f, wp);
  if (t.isRoute && dst < ARRIVAL_NM && t.idx < t.points.length - 1) {
    t.idx += 1;
    store.set('target', t);
    if (navigator.vibrate) navigator.vibrate(200);
    toast(`Waypoint reached — next WP ${t.idx}`);
    return updateNav();
  }
  const brg = bearing(f, wp);
  $('nav-brg').textContent = fmtBrg(brg);
  $('nav-dst').textContent = dst < 10 ? fmt2(dst) : fmt1(dst);

  // ETA to the current waypoint, and for routes to the end of the pattern.
  if (f.sog > 0.5) {
    let rest = dst;
    if (t.isRoute) rest += routeLengthNm(t.points.slice(t.idx));
    const eta = new Date(Date.now() + (dst / f.sog) * 3.6e6);
    $('nav-eta').textContent = hhmm(eta);
    $('nav-eta').title = t.isRoute ? `Pattern complete ≈ ${hhmm(new Date(Date.now() + (rest / f.sog) * 3.6e6))}` : '';
  } else {
    $('nav-eta').textContent = '—';
  }

  if (t.isRoute && t.idx > 0) {
    const xte = crossTrackNm(t.points[t.idx - 1], wp, f);
    $('nav-xte').textContent = `${Math.abs(xte).toFixed(2)}${xte > 0 ? 'R' : 'L'}`;
  } else {
    $('nav-xte').textContent = '—';
  }
  targetLine.setLatLngs([ll(f), ll(wp)]);
}

$('nav-next').addEventListener('click', () => {
  const t = state.target;
  if (t && t.idx < t.points.length - 1) setTarget({ ...t, idx: t.idx + 1 });
});
$('nav-prev').addEventListener('click', () => {
  const t = state.target;
  if (t && t.idx > 0) setTarget({ ...t, idx: t.idx - 1 });
});
$('nav-stop').addEventListener('click', () => setTarget(null));

// ---------------------------------------------------------------------------
// Search patterns
// ---------------------------------------------------------------------------
const num = (id) => Number($(id).value);

function updatePatternFields() {
  const type = $('sp-type').value;
  document.querySelectorAll('#search-form [data-for]').forEach((el) => {
    el.hidden = !el.dataset.for.split(' ').includes(type);
  });
}
$('sp-type').addEventListener('change', () => {
  updatePatternFields();
  buildPattern();
});
$('search-form').addEventListener('input', () => {
  if (state.pattern) buildPattern();
});

function buildPattern() {
  const type = $('sp-type').value;
  const origin = resolvePoint($('sp-datum').value);
  if (!origin) {
    toast('Choose a datum (no GPS fix for own position)');
    return null;
  }
  const track = num('sp-track');
  const turn = $('sp-turn').value;
  let points;
  let name;
  if (type === 'SS') {
    points = expandingSquare({ datum: origin, track, spacing: num('sp-spacing'), legs: Math.round(num('sp-legs')), turn });
    name = `SS ${origin.name}`;
  } else if (type === 'VS') {
    points = sectorSearch({ datum: origin, track, radius: num('sp-radius'), turn });
    name = `VS ${origin.name}`;
  } else {
    points = parallelSearch({
      csp: origin,
      track,
      spacing: num('sp-spacing'),
      legLength: num('sp-leglen'),
      legs: Math.round(num('sp-pslegs')),
      turn,
    });
    name = `PS ${origin.name}`;
  }
  if (points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) {
    toast('Check the pattern values');
    return null;
  }
  state.pattern = { name, points, prefix: type };
  drawPattern();
  return state.pattern;
}

function drawPattern() {
  patternLayer.clearLayers();
  const pat = state.pattern;
  if (!pat) {
    $('sp-summary').textContent = '';
    return;
  }
  L.polyline(pat.points.map(ll), { color: '#ffb703', weight: 3, opacity: 0.9 }).addTo(patternLayer);
  pat.points.forEach((p, i) => {
    L.circleMarker(ll(p), { radius: 4, color: '#000', weight: 1, fillColor: i === 0 ? '#2ec27e' : '#ffb703', fillOpacity: 1 })
      .bindTooltip(i === 0 ? 'CSP' : String(i), { permanent: true, direction: 'top', className: 'wp-label' })
      .addTo(patternLayer);
  });
  const len = routeLengthNm(pat.points);
  const spd = num('sp-speed');
  const hrs = spd > 0 ? len / spd : NaN;
  $('sp-summary').textContent =
    `${pat.points.length - 1} legs · ${fmt1(len)} NM` +
    (Number.isFinite(hrs) ? ` · ≈ ${Math.floor(hrs)} h ${String(Math.round((hrs % 1) * 60)).padStart(2, '0')} min at ${spd} kn` : '');
}

$('sp-preview').addEventListener('click', () => {
  const pat = buildPattern();
  if (pat) {
    setFollow(false);
    map.fitBounds(L.latLngBounds(pat.points.map(ll)).pad(0.2));
  }
});
$('sp-start').addEventListener('click', () => {
  const pat = state.pattern || buildPattern();
  if (!pat) return;
  setTarget({ name: pat.name, points: pat.points, idx: 0, isRoute: true });
  addLog(`Started ${pat.name}: ${pat.points.length - 1} legs, ${fmt1(routeLengthNm(pat.points))} NM, CSP ${formatPosition(pat.points[0], 'ddm')}`);
  selectTab('nav');
});
$('sp-gpx').addEventListener('click', () => {
  const pat = state.pattern || buildPattern();
  if (!pat) return;
  download(`${pat.prefix}-${stamp()}.gpx`, toGpx({ name: pat.name, routes: [pat] }));
});
$('sp-clear').addEventListener('click', () => {
  state.pattern = null;
  drawPattern();
});

// ---------------------------------------------------------------------------
// Drift / datum
// ---------------------------------------------------------------------------
function localDateTimeValue(d) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
$('dr-time').value = localDateTimeValue(new Date());

$('dr-calc').addEventListener('click', () => {
  const lkp = resolvePoint($('dr-lkp').value);
  if (!lkp) return toast('Choose a last known position');
  const t0 = new Date($('dr-time').value);
  if (Number.isNaN(t0.getTime())) return toast('Enter the time at LKP');
  const hours = (Date.now() - t0.getTime()) / 3.6e6;
  if (hours < 0) return toast('LKP time is in the future');
  const r = estimateDatum({
    lkp,
    hours,
    windFrom: num('dr-wind'),
    leewayKn: num('dr-leeway'),
    currentSet: num('dr-set'),
    currentKn: num('dr-drift'),
  });
  state.lastDatum = { ...r, lkp, hours };
  $('dr-result').classList.remove('muted');
  $('dr-result').textContent =
    `Datum ${formatPosition(r.datum, state.posFormat)} — drift ${fmtBrg(r.driftBearing)}°T ${fmt2(r.driftNm)} NM ` +
    `over ${fmt1(hours)} h from ${lkp.name}`;
  $('dr-save').disabled = false;
  $('dr-search').disabled = false;
  patternLayer.clearLayers();
  L.polyline([ll(lkp), ll(r.datum)], { color: '#8e44ad', weight: 3, dashArray: '4 6' }).addTo(patternLayer);
  L.circleMarker(ll(r.datum), { radius: 7, color: '#fff', fillColor: '#8e44ad', fillOpacity: 1 }).addTo(patternLayer);
  setFollow(false);
  map.fitBounds(L.latLngBounds([ll(lkp), ll(r.datum)]).pad(0.5), { maxZoom: 14 });
});

function saveDatumMark() {
  const d = state.lastDatum;
  if (!d) return null;
  const m = addMark(d.datum, `DATUM ${hhmm(new Date())}`, 'datum');
  addLog(`Datum from ${d.lkp.name}: drift ${fmtBrg(d.driftBearing)}°T ${fmt2(d.driftNm)} NM over ${fmt1(d.hours)} h`);
  return m;
}
$('dr-save').addEventListener('click', () => {
  if (saveDatumMark()) toast('Datum saved as mark');
});
$('dr-search').addEventListener('click', () => {
  const m = saveDatumMark();
  if (!m) return;
  selectTab('search');
  $('sp-datum').value = m.id;
  const p = buildPattern();
  if (p) map.fitBounds(L.latLngBounds(p.points.map(ll)).pad(0.2));
});

// ---------------------------------------------------------------------------
// Track recording
// ---------------------------------------------------------------------------
let lastTrackSave = 0;
function recordTrack(fix) {
  if (!state.recording) return;
  const last = state.track[state.track.length - 1];
  // Record a point every 10 s or 20 m, whichever comes first, ignoring poor fixes.
  if (fix.acc > 100) return;
  if (last && fix.time - last.time < 10000 && distanceNm(last, fix) * 1852 < 20) return;
  state.track.push({ lat: fix.lat, lon: fix.lon, time: fix.time });
  trackLine.addLatLng(ll(fix));
  if (Date.now() - lastTrackSave > 15000) {
    store.set('track', state.track);
    lastTrackSave = Date.now();
  }
  renderTrackStats();
}

function renderTrackStats() {
  $('trk-stats').textContent = `${state.track.length} pts · ${fmt2(routeLengthNm(state.track))} NM`;
  $('trk-toggle').textContent = state.recording ? '■ Stop recording' : '● Record track';
  $('trk-toggle').classList.toggle('danger', state.recording);
  $('trk-toggle').classList.toggle('primary', !state.recording);
}

$('trk-toggle').addEventListener('click', () => {
  state.recording = !state.recording;
  store.set('recording', state.recording);
  store.set('track', state.track);
  addLog(state.recording ? 'Track recording started' : 'Track recording stopped');
  renderTrackStats();
});
$('trk-gpx').addEventListener('click', () => {
  if (!state.track.length) return toast('Track is empty');
  download(
    `track-${stamp()}.gpx`,
    toGpx({ name: 'SaltySails track', tracks: [{ name: 'Track', points: state.track }], waypoints: state.marks }),
  );
});
$('trk-clear').addEventListener('click', () => {
  if (!confirm('Clear the recorded track? Export it first if you need it.')) return;
  state.track = [];
  trackLine.setLatLngs([]);
  store.set('track', state.track);
  renderTrackStats();
});
window.addEventListener('pagehide', () => store.set('track', state.track));

// ---------------------------------------------------------------------------
// Incident log
// ---------------------------------------------------------------------------
function addLog(text, pos = state.fix) {
  state.log.unshift({ time: Date.now(), text, pos: pos ? { lat: pos.lat, lon: pos.lon } : null });
  store.set('log', state.log);
  renderLog();
}

function logLine(e) {
  const t = new Date(e.time);
  return `${t.toISOString().slice(0, 10)} ${hhmm(t)}  ${e.pos ? `[${formatPosition(e.pos, 'ddm')}]  ` : ''}${e.text}`;
}

function renderLog() {
  const list = $('log-list');
  list.innerHTML = '';
  for (const e of state.log.slice(0, 200)) {
    const li = document.createElement('li');
    li.textContent = logLine(e);
    list.appendChild(li);
  }
  if (!state.log.length) list.innerHTML = '<li class="muted">No log entries.</li>';
}

$('log-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('log-text').value.trim();
  if (!text) return;
  addLog(text);
  $('log-text').value = '';
});
$('log-export').addEventListener('click', () => {
  const body = [...state.log].reverse().map(logLine).join('\n');
  download(`sar-log-${stamp()}.txt`, `SaltySails incident log (times local)\n\n${body}\n`, 'text/plain');
});
$('log-clear').addEventListener('click', () => {
  if (!confirm('Clear the whole incident log?')) return;
  state.log = [];
  store.set('log', state.log);
  renderLog();
});

// ---------------------------------------------------------------------------
// SOS
// ---------------------------------------------------------------------------
for (const id of ['sos-vessel', 'sos-call', 'sos-pob']) {
  $(id).value = store.get(id, '');
  $(id).addEventListener('input', () => {
    store.set(id, $(id).value);
    renderSos();
  });
}

function renderSos() {
  const f = state.fix;
  const pos = f ? formatPosition(f, 'ddm') : 'POSITION UNKNOWN';
  $('sos-pos').textContent = f ? formatPosition(f, 'ddm') : 'No GPS fix';
  if (f) $('sos-pos').title = formatPosition(f, 'dd');
  const v = $('sos-vessel').value.trim() || '[VESSEL NAME]';
  const c = $('sos-call').value.trim() || '[CALL SIGN / MMSI]';
  const pob = $('sos-pob').value.trim() || '[NUMBER]';
  const spoken = pos.replace(/°/g, ' degrees ').replace(/'/g, ' minutes ').replace(/N\b/, 'North').replace(/W\b/, 'West');
  $('sos-script').textContent =
    `MAYDAY, MAYDAY, MAYDAY\n` +
    `This is ${v}, ${v}, ${v}, ${c}\n` +
    `MAYDAY ${v}, ${c}\n` +
    `Position: ${spoken}\n` +
    `[Nature of distress]\n` +
    `[Assistance required]\n` +
    `${pob} persons on board\n` +
    `[Other information]\n` +
    `OVER`;
}

$('sos-copy').addEventListener('click', async () => {
  renderSos();
  const text = `${$('sos-pos').textContent.trim()}\n\n${$('sos-script').textContent}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy not available');
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
updateTopHeight();
updatePatternFields();
refreshMarkSelects();
renderMarks();
renderLog();
renderTrackStats();
renderFix();
updateNav();
selectTab(store.get('tab', 'nav'));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Exposed for debugging / automated checks.
window.saltysails = { state, map, onPosition };
