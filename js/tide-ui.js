/* global L */
// Tide tab + map overlay. Data: Landhelgisgæsla Íslands tide tables (see tools/make_tides.py).
import { buildStations, tideState, curve, nearestStations, coverage } from './tides.js';
import { distanceNm } from './geo.js';

const TIDE_FILES = ['data/tides-2026.json'];
const nowMin = () => Math.floor(Date.now() / 60000);
// Iceland keeps GMT all year, and SAR works in UTC, so tide times are shown in GMT.
const hhmm = (tMin) => new Date(tMin * 60000).toISOString().slice(11, 16);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (tMin) => {
  const d = new Date(tMin * 60000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};
const fmtH = (h) => (h == null ? '—' : `${h.toFixed(1)}`);
const until = (tMin) => {
  const m = Math.max(0, Math.round(tMin - nowMin()));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

/** Merge stations from several yearly files into one continuous event list per station. */
function mergeStations(files) {
  const byId = new Map();
  for (const data of files) {
    for (const s of buildStations(data)) {
      const cur = byId.get(s.id);
      if (!cur) byId.set(s.id, s);
      else cur.events = [...cur.events, ...s.events].sort((a, b) => a[0] - b[0]);
    }
  }
  return [...byId.values()];
}

export function initTides({ map, store, toast, getPos, onSelectTab }) {
  const $ = (id) => document.getElementById(id);
  let stations = [];
  let source = '';
  let station = null;
  let auto = store.get('tideAuto', true);
  let rangeDays = store.get('tideRange', 1);
  let scrubT = null;
  let REF_LEVELS = {};

  const layer = L.layerGroup();

  const ready = Promise.all(
    TIDE_FILES.map((f) =>
      fetch(f)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${f}: ${r.status}`))))
        .catch(() => null),
    ),
  ).then((files) => {
    const ok = files.filter(Boolean);
    if (!ok.length) {
      $('tide-body').innerHTML = '<p class="muted">Tide tables could not be loaded.</p>';
      return;
    }
    source = ok.map((d) => d.source).join('; ');
    REF_LEVELS = Object.assign({}, ...ok.map((d) => d.ref_levels || {}));
    stations = mergeStations(ok);
    const saved = store.get('tideStation', null);
    station = (!auto && stations.find((s) => s.id === saved)) || null;
    pickNearestIfAuto();
    fillSelect();
    render();
    drawLayer();
  });

  function refPos() {
    const p = getPos();
    if (p) return p;
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  function pickNearestIfAuto() {
    if (!auto || !stations.length) return;
    const [n] = nearestStations(stations, refPos(), 1);
    if (n && n.station !== station) {
      station = n.station;
      return true;
    }
    return false;
  }

  function fillSelect() {
    const sel = $('tide-station');
    const pos = refPos();
    const sorted = stations
      .map((s) => ({ s, nm: distanceNm(pos, s) }))
      .sort((a, b) => a.nm - b.nm);
    sel.innerHTML = '';
    sel.add(new Option(`Nearest (${station ? station.name : '—'})`, '__auto'));
    for (const { s, nm } of sorted) sel.add(new Option(`${s.name}${s.reference ? ' ★' : ''} · ${nm.toFixed(0)} NM`, s.id));
    sel.value = auto ? '__auto' : station?.id;
  }

  $('tide-station').addEventListener('change', (e) => {
    auto = e.target.value === '__auto';
    store.set('tideAuto', auto);
    if (!auto) {
      station = stations.find((s) => s.id === e.target.value) || station;
      store.set('tideStation', station?.id);
    } else pickNearestIfAuto();
    fillSelect();
    render();
  });

  document.querySelectorAll('#tide-range button').forEach((b) =>
    b.addEventListener('click', () => {
      rangeDays = Number(b.dataset.days);
      store.set('tideRange', rangeDays);
      render();
    }),
  );

  // ---------------------------------------------------------------- rendering
  function render() {
    if (!station) return;
    document.querySelectorAll('#tide-range button').forEach((b) =>
      b.setAttribute('aria-pressed', String(Number(b.dataset.days) === rangeDays)),
    );
    const t = nowMin();
    const st = tideState(station.events, t);
    const cov = coverage(station.events);
    const pos = getPos();
    const nm = pos ? distanceNm(pos, station) : null;

    $('tide-name').textContent = station.name;
    $('tide-meta').textContent =
      (station.reference
        ? 'Reference port (Table I)'
        : `From ${station.refName}, ${station.dt >= 0 ? '+' : '−'}${Math.floor(Math.abs(station.dt) / 60)} h ${String(Math.abs(station.dt) % 60).padStart(2, '0')} min (Table II, less accurate)`) +
      (nm != null ? ` · ${nm.toFixed(1)} NM away` : '');

    if (!st) {
      const after = cov && t > cov.to;
      $('tide-now').innerHTML = `<div class="tide-warn">${
        after ? 'The loaded tide tables have run out. Add the new year’s tables (tools/make_tides.py).' : 'No tide data for this time.'
      }</div>`;
      $('tide-chart').innerHTML = '';
      $('tide-table').innerHTML = '';
      return;
    }

    const nextH = st.upcoming.find((e) => e[2] === 'H');
    const nextL = st.upcoming.find((e) => e[2] === 'L');
    const heights = station.heightsKnown !== false;
    // spring/neap from this cycle's range vs the reference levels
    const springNeap = st.range > 0 ? classifyRange(station, st.range) : '';
    $('tide-now').innerHTML = `
      <div class="big tide-height">
        <span class="label">Now (m)</span>
        ${heights ? `${fmtH(st.height)} <span class="arrow">${st.rising ? '↑' : '↓'}</span>` : `<span class="small">${st.rising ? 'Rising ↑' : 'Falling ↓'}</span>`}
        <span class="sub">${heights ? `${Math.abs(st.rate * 100).toFixed(0)} cm/h` : 'no heights'}${springNeap ? ` · ${springNeap}` : ''}</span>
      </div>
      <div class="big"><span class="label">Next HW</span>${hhmm(nextH[0])}
        <span class="sub">${heights ? `${fmtH(nextH[1])} m · ` : ''}${until(nextH[0])}</span></div>
      <div class="big"><span class="label">Next LW</span>${hhmm(nextL[0])}
        <span class="sub">${heights ? `${fmtH(nextL[1])} m · ` : ''}${until(nextL[0])}</span></div>`;

    renderChart(t, heights);
    renderTable(t, heights);
    const daysLeft = (cov.to - t) / 1440;
    if (daysLeft < 30) {
      $('tide-table').insertAdjacentHTML(
        'afterbegin',
        `<div class="tide-warn">Tide data ends ${dayLabel(cov.to)} (${Math.max(0, Math.floor(daysLeft))} days). ` +
          'The Coast Guard usually publishes next year’s tables in late November; the app needs updating with them.</div>',
      );
    }
  }

  function classifyRange(s, range) {
    // Only reference-port levels are published; use the reference port's spring/neap ranges.
    const lv = REF_LEVELS[s.reference ? s.id : s.id.split(':')[0]];
    if (!lv) return '';
    const spring = lv.mhws - lv.mlws;
    const neap = lv.mhwn - lv.mlwn;
    const f = (range - neap) / (spring - neap);
    return f > 0.75 ? 'Springs' : f < 0.25 ? 'Neaps' : '';
  }

  function renderChart(t, heights) {
    const el = $('tide-chart');
    const W = Math.max(280, el.clientWidth || 360);
    const Hh = 170;
    const pad = { l: 30, r: 8, t: 20, b: 26 };
    const t0 = t - (rangeDays === 1 ? 4 * 60 : 6 * 60);
    const t1 = t0 + rangeDays * 24 * 60 + (rangeDays === 1 ? 4 * 60 : 0);
    const pts = curve(station.events, t0, t1, rangeDays > 3 ? 20 : 10);
    if (!pts.length) {
      el.innerHTML = '';
      return;
    }
    const evs = station.events.filter((e) => e[0] >= t0 && e[0] <= t1);
    const hs = pts.map((p) => p[1]);
    const ymin = Math.min(0, Math.floor(Math.min(...hs)));
    const ymax = Math.max(1, Math.ceil(Math.max(...hs)));
    const x = (tm) => pad.l + ((tm - t0) / (t1 - t0)) * (W - pad.l - pad.r);
    const y = (h) => pad.t + ((ymax - h) / (ymax - ymin)) * (Hh - pad.t - pad.b);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const area = `${line}L${x(pts[pts.length - 1][0]).toFixed(1)},${y(ymin)}L${x(pts[0][0]).toFixed(1)},${y(ymin)}Z`;

    let grid = '';
    for (let h = ymin; h <= ymax; h++) {
      grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(h)}" y2="${y(h)}" class="g"/>`;
      if (heights) grid += `<text x="${pad.l - 4}" y="${y(h) + 4}" class="ax" text-anchor="end">${h}</text>`;
    }
    // time ticks: every 6 h (1 day), 12 h (3 days) or 24 h (7 days); day boundaries stronger
    const tick = rangeDays === 1 ? 360 : rangeDays === 3 ? 720 : 1440;
    for (let tm = Math.ceil(t0 / tick) * tick; tm <= t1; tm += tick) {
      const midnight = tm % 1440 === 0;
      grid += `<line x1="${x(tm)}" x2="${x(tm)}" y1="${pad.t}" y2="${Hh - pad.b}" class="${midnight ? 'gd' : 'g'}"/>`;
      grid += `<text x="${x(tm)}" y="${Hh - pad.b + 13}" class="ax" text-anchor="middle">${midnight ? dayLabel(tm) : hhmm(tm)}</text>`;
    }
    let marks = '';
    if (rangeDays <= 3) {
      for (const [tm, h, k] of evs) {
        const above = k === 'H';
        marks += `<circle cx="${x(tm)}" cy="${y(h)}" r="3" class="${k === 'H' ? 'hw' : 'lw'}"/>`;
        const ex = x(tm);
        const anchor = ex < pad.l + 28 ? 'start' : ex > W - pad.r - 28 ? 'end' : 'middle';
        if (rangeDays === 1 || k === 'H')
          marks += `<text x="${ex}" y="${y(h) + (above ? -7 : 15)}" class="ev" text-anchor="${anchor}">${hhmm(tm)}${heights && rangeDays === 1 ? ` ${fmtH(h)}` : ''}</text>`;
      }
    }
    const nowX = x(t);
    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${Hh}" width="100%" height="${Hh}" role="img" aria-label="Tide curve for ${station.name}">
        ${grid}
        <path d="${area}" class="area"/><path d="${line}" class="line"/>
        ${marks}
        <line x1="${nowX}" x2="${nowX}" y1="${pad.t - 6}" y2="${Hh - pad.b}" class="now"/>
        <text x="${nowX}" y="${pad.t - 9}" class="nowt" text-anchor="middle">now</text>
        <g id="tide-scrub" style="display:none"><line class="scrub" y1="${pad.t}" y2="${Hh - pad.b}"/><circle r="4" class="scrubdot"/></g>
      </svg>
      <div id="tide-scrub-label" class="tide-scrub-label" hidden></div>`;

    // Touch/drag to read the height at any time.
    const svg = el.querySelector('svg');
    const scrub = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const tm = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
      const p = pts.reduce((best, q) => (Math.abs(q[0] - tm) < Math.abs(best[0] - tm) ? q : best), pts[0]);
      scrubT = p[0];
      const g = svg.querySelector('#tide-scrub');
      g.style.display = '';
      g.querySelector('line').setAttribute('x1', x(p[0]));
      g.querySelector('line').setAttribute('x2', x(p[0]));
      g.querySelector('circle').setAttribute('cx', x(p[0]));
      g.querySelector('circle').setAttribute('cy', y(p[1]));
      const lab = $('tide-scrub-label');
      lab.hidden = false;
      lab.textContent = `${dayLabel(p[0])} ${hhmm(p[0])} GMT — ${heights ? `${p[1].toFixed(1)} m` : 'height not given'}`;
    };
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      scrub(e);
    });
    svg.addEventListener('pointermove', (e) => e.buttons && scrub(e));
  }

  function renderTable(t, heights) {
    const evs = station.events.filter((e) => e[0] >= t - 12 * 60 && e[0] <= t + 7 * 24 * 60);
    const byDay = new Map();
    for (const e of evs) {
      const key = dayLabel(e[0]);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    let html = '<table class="tide-tbl"><tbody>';
    for (const [day, list] of byDay) {
      html += `<tr><th>${day}</th>${list
        .map(
          ([tm, h, k]) =>
            `<td class="${k === 'H' ? 'hw' : 'lw'}${tm < t ? ' past' : ''}"><b>${k === 'H' ? 'HW' : 'LW'}</b> ${hhmm(tm)}${heights ? `<br>${fmtH(h)} m` : ''}</td>`,
        )
        .join('')}</tr>`;
    }
    html += '</tbody></table>';
    html += `<p class="muted small">Times GMT (Icelandic time). Heights in metres above chart datum: add to charted depths for the depth now. Springs/Neaps = stórstreymi/smástreymi. Tables assume average air pressure: each 10 hPa below 1013 raises the sea about 0.1 m, and onshore wind raises it further. Source: ${source}.</p>`;
    $('tide-table').innerHTML = html;
  }

  // ------------------------------------------------------------- map overlay
  function drawLayer() {
    layer.clearLayers();
    if (!map.hasLayer(layer)) return;
    const t = nowMin();
    // Reference ports first, then skip any pin that would overlap one already placed.
    const placed = [];
    const ordered = [...stations].sort((a, b) => Number(b.reference) - Number(a.reference));
    for (const s of ordered) {
      const pt = map.latLngToContainerPoint([s.lat, s.lon]);
      if (placed.some((q) => Math.abs(q.x - pt.x) < 46 && Math.abs(q.y - pt.y) < 22)) continue;
      placed.push(pt);
      const st = tideState(s.events, t);
      const txt = st && s.heightsKnown !== false ? `${st.height.toFixed(1)}${st.rising ? '↑' : '↓'}` : '≈';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '',
          iconSize: [0, 0],
          html: `<div class="tide-pin${s.reference ? ' ref' : ''}" title="${s.name}">${txt}</div>`,
        }),
      })
        .on('click', () => {
          auto = false;
          station = s;
          store.set('tideAuto', false);
          store.set('tideStation', s.id);
          fillSelect();
          onSelectTab('tide');
          render();
        })
        .bindTooltip(s.name, { direction: 'top', offset: [0, -12] })
        .addTo(layer);
    }
  }

  // Refresh every minute, and pick a new nearest station when the position moves.
  let lastPickPos = null;
  setInterval(() => {
    render();
    if (map.hasLayer(layer)) drawLayer();
  }, 60000);
  layer.on('add', drawLayer);
  map.on('zoomend', () => map.hasLayer(layer) && drawLayer());
  map.on('moveend', () => {
    if (!getPos() && pickNearestIfAuto()) {
      fillSelect();
      render();
    }
  });

  return {
    layer,
    ready,
    /** Call on each GPS fix. */
    onFix(fix) {
      if (!lastPickPos || distanceNm(lastPickPos, fix) > 1) {
        lastPickPos = fix;
        if (pickNearestIfAuto()) fillSelect();
      }
    },
    render,
    /** For other panels: current tide at the selected station. */
    current() {
      return station ? { station, state: tideState(station.events, nowMin()) } : null;
    },
    get scrubT() {
      return scrubT;
    },
  };
}
