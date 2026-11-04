/* global L */
// AIS: onboard (Signal K / NMEA over WebSocket) and internet (aisstream.io via /api/ais) sources,
// map layer, AIS tab (status, settings, target list) and SAR/CPA alarms.
import {
  createNmeaDecoder,
  fromSignalK,
  fromAisstream,
  createStore,
  cpaTcpa,
  isDistress,
  KIND_LABEL,
  NAV_STATUS,
  STALE_MS,
} from './ais.js';
import { formatPosition } from './geo.js';

const COLOURS = {
  sart: '#ff1744',
  mob: '#ff1744',
  epirb: '#ff1744',
  'sar-aircraft': '#ff9100',
  sar: '#ff9100',
  law: '#2979ff',
  fishing: '#00bfa5',
  pilot: '#00b0ff',
  tug: '#8d6e63',
  pleasure: '#ce93d8',
  passenger: '#3d5afe',
  cargo: '#76ff03',
  tanker: '#ff5252',
  aton: '#ffd600',
  other: '#b0bec5',
};
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
const r1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const r0 = (v) => (Number.isFinite(v) ? String(Math.round(v)).padStart(3, '0') : '—');
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};
/** CPA text: "CPA 0.52 NM in 6 min", or "opening" when the closest point is already past. */
const cpaText = (c) =>
  !c ? '' : !Number.isFinite(c.tcpa) ? 'no relative motion' : c.tcpa <= 0 ? 'opening' : `CPA ${c.cpa.toFixed(2)} NM in ${Math.round(c.tcpa)} min`;

/** SVG icon for a target. */
function iconHtml(t, stale) {
  const c = COLOURS[t.kind] || COLOURS.other;
  const rot = Number.isFinite(t.heading) ? t.heading : Number.isFinite(t.cog) ? t.cog : 0;
  const op = stale ? 0.45 : 1;
  let shape;
  if (isDistress(t.kind)) {
    shape = `<circle r="9" fill="none" stroke="${c}" stroke-width="3"/><path d="M-6,-6 L6,6 M6,-6 L-6,6" stroke="${c}" stroke-width="3"/>`;
    return `<svg class="ais-svg distress" width="28" height="28" viewBox="-14 -14 28 28" style="opacity:${op}">${shape}</svg>`;
  }
  if (t.kind === 'sar-aircraft') shape = `<path d="M0,-11 L2,-3 L10,1 L10,3 L2,1 L1,7 L4,9 L4,10 L0,9 L-4,10 L-4,9 L-1,7 L-2,1 L-10,3 L-10,1 L-2,-3 Z" fill="${c}" stroke="#000" stroke-width="1"/>`;
  else if (t.kind === 'aton') shape = `<path d="M0,-7 L7,0 L0,7 L-7,0 Z" fill="${c}" stroke="#000" stroke-width="1.2"/>`;
  else {
    const s = t.classB ? 0.8 : 1;
    const moving = (t.sog ?? 0) > 0.5;
    shape = moving
      ? `<path transform="scale(${s})" d="M0,-11 L6,8 L0,5 L-6,8 Z" fill="${c}" stroke="#000" stroke-width="1.2"/>`
      : `<circle r="${5 * s}" fill="${c}" stroke="#000" stroke-width="1.2"/>`;
    if (t.kind === 'sar') shape += `<circle r="13" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 3"/>`;
  }
  return `<svg class="ais-svg" width="28" height="28" viewBox="-14 -14 28 28" style="transform:rotate(${rot}deg);opacity:${op}">${shape}</svg>`;
}

export function initAis({ map, store: kv, getPos, toast, addMark, goTo, addLog, selectTab, onOwnFix }) {
  const $ = (id) => document.getElementById(id);
  const targets = createStore();
  const cfg = {
    onboardUrl: kv.get('aisOnboardUrl', ''),
    onboard: kv.get('aisOnboard', false),
    boatGps: kv.get('aisBoatGps', false),
    internet: kv.get('aisInternet', false),
    cpaNm: kv.get('aisCpaNm', 0.5),
    tcpaMin: kv.get('aisTcpaMin', 12),
  };
  const status = { onboard: 'off', internet: 'off' };
  const alarmed = new Map(); // mmsi -> time of last alarm
  const layer = L.layerGroup();
  const vectors = L.layerGroup().addTo(layer);
  const markers = new Map();

  // ------------------------------------------------------------ incoming data
  function ingest(msg, source) {
    if (!msg) return;
    if (msg.own) {
      if (cfg.boatGps && Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) onOwnFix(msg);
      return;
    }
    const t = targets.update(msg, source);
    if (t && isDistress(t.kind) && !alarmed.has(t.mmsi) && Number.isFinite(t.lat)) distressAlarm(t);
    scheduleRender();
  }

  // Onboard: Signal K server or NMEA 0183 over WebSocket.
  let ws = null;
  let wsRetry = null;
  let nmea = createNmeaDecoder();
  let selfCtx = null;
  function connectOnboard() {
    clearTimeout(wsRetry);
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    if (!cfg.onboard || !cfg.onboardUrl) {
      setStatus('onboard', cfg.onboard ? 'no URL' : 'off');
      return;
    }
    let url = cfg.onboardUrl.trim();
    if (location.protocol === 'https:' && url.startsWith('ws://') && !/^ws:\/\/(localhost|127\.)/.test(url)) {
      setStatus('onboard', 'blocked: an https app can only use wss:// (enable SSL on the server)');
      return;
    }
    // Signal K: ask for everything about other vessels, not just ourselves.
    if (/\/signalk\/v1\/stream\/?$/.test(url)) url += (url.includes('?') ? '&' : '?') + 'subscribe=none';
    setStatus('onboard', 'connecting…');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus('onboard', `bad URL (${e.message})`);
      return;
    }
    nmea = createNmeaDecoder();
    ws.onopen = () => setStatus('onboard', 'connected');
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (data.startsWith('{')) {
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          return;
        }
        if (j.self || j.version) {
          // Signal K hello
          selfCtx = j.self?.startsWith('vessels.') ? j.self : j.self ? `vessels.${j.self}` : null;
          ws.send(
            JSON.stringify({
              context: '*',
              subscribe: [{ path: '*', period: 2000, policy: 'instant' }],
            }),
          );
          setStatus('onboard', `connected (Signal K${j.name ? ` · ${j.name}` : ''})`);
          return;
        }
        for (const m of fromSignalK(j, selfCtx)) ingest(m, 'onboard');
      } else {
        for (const line of data.split(/\r?\n/)) if (line.startsWith('!')) ingest(nmea(line), 'onboard');
      }
    };
    ws.onclose = () => {
      setStatus('onboard', 'disconnected, retrying…');
      wsRetry = setTimeout(connectOnboard, 5000);
    };
    ws.onerror = () => setStatus('onboard', 'connection failed, retrying…');
  }

  // Internet: aisstream.io through our relay (/api/ais), area around the chart view or own position.
  let es = null;
  let esBox = null;
  function wantedBox() {
    const p = getPos();
    const b = map.getBounds();
    const c = p ? { lat: p.lat, lng: p.lon } : map.getCenter();
    // at least ±0.5° lat / ±1° lon around the centre, at most the view
    const dLat = Math.max(0.5, Math.min(2, (b.getNorth() - b.getSouth()) / 2 + 0.2));
    const dLon = Math.max(1, Math.min(4, (b.getEast() - b.getWest()) / 2 + 0.4));
    return [c.lat - dLat, c.lng - dLon, c.lat + dLat, c.lng + dLon].map((v) => +v.toFixed(2));
  }
  function connectInternet(force = false) {
    if (!cfg.internet) {
      if (es) es.close();
      es = null;
      setStatus('internet', 'off');
      return;
    }
    const box = wantedBox();
    // only reconnect when the area really changed (centre moved > 1/3 of the box)
    if (!force && es && esBox) {
      const moved = Math.abs((box[0] + box[2]) / 2 - (esBox[0] + esBox[2]) / 2) > (esBox[2] - esBox[0]) / 3 || Math.abs((box[1] + box[3]) / 2 - (esBox[1] + esBox[3]) / 2) > (esBox[3] - esBox[1]) / 3;
      if (!moved) return;
    }
    if (es) es.close();
    esBox = box;
    setStatus('internet', 'connecting…');
    es = new EventSource(`api/ais?bbox=${box.join(',')}`);
    es.addEventListener('status', (ev) => {
      try {
        const s = JSON.parse(ev.data);
        setStatus('internet', s.error ? `error: ${s.error}` : 'connected (aisstream.io)');
      } catch {}
    });
    es.onmessage = (ev) => {
      try {
        ingest(fromAisstream(JSON.parse(ev.data)), 'internet');
      } catch {}
    };
    es.onerror = async () => {
      if (es.readyState === EventSource.CLOSED) {
        // find out why (e.g. relay not configured)
        try {
          const r = await fetch(`api/ais?bbox=${box.join(',')}`, { method: 'GET' });
          if (r.status === 503) {
            setStatus('internet', 'relay not configured (AISSTREAM_API_KEY)');
            return;
          }
        } catch {}
        setStatus('internet', 'offline, retrying…');
        setTimeout(() => connectInternet(true), 15000);
      } else setStatus('internet', 'reconnecting…');
    };
  }
  map.on('moveend', () => cfg.internet && connectInternet());

  // ------------------------------------------------------------ alarms
  function distressAlarm(t) {
    alarmed.set(t.mmsi, Date.now());
    const what = KIND_LABEL[t.kind];
    const pos = formatPosition(t, 'ddm');
    addLog(`ALARM ${what} MMSI ${t.mmsi} at ${pos}`, t);
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
    const el = $('ais-alarm');
    el.hidden = false;
    el.innerHTML = `<b>⚠ ${esc(what)} received</b> · MMSI ${t.mmsi} · ${esc(pos)} <span class="ais-alarm-actions"><button data-a="go">Go to</button><button data-a="mark">Mark</button><button data-a="x" aria-label="Dismiss">✕</button></span>`;
    el.querySelector('[data-a="go"]').onclick = () => goTo({ name: `${what} ${t.mmsi}`, lat: t.lat, lon: t.lon });
    el.querySelector('[data-a="mark"]').onclick = () => addMark({ lat: t.lat, lon: t.lon }, `${t.kind.toUpperCase()} ${String(t.mmsi).slice(-4)}`, 'mob');
    el.querySelector('[data-a="x"]').onclick = () => (el.hidden = true);
    if (!map.hasLayer(layer)) layer.addTo(map);
  }

  function cpaAlarms(list, own) {
    if (!own || !(cfg.cpaNm > 0)) return;
    for (const { t, c } of list) {
      if (t.kind === 'aton' || isDistress(t.kind) || !c) continue;
      if (c.cpa < cfg.cpaNm && c.tcpa > 0 && c.tcpa < cfg.tcpaMin) {
        const last = alarmed.get(t.mmsi);
        if (last && Date.now() - last < 10 * 60 * 1000) continue;
        alarmed.set(t.mmsi, Date.now());
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        toast(`CPA ${c.cpa.toFixed(2)} NM in ${Math.round(c.tcpa)} min: ${t.name || t.mmsi}`, 6000);
      }
    }
  }

  // ------------------------------------------------------------ rendering
  let renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      render();
    }, 1000);
  }

  function withCpa() {
    const own = getPos();
    return targets.list().map((t) => ({ t, c: own ? cpaTcpa(own, t) : null }));
  }

  function render() {
    const now = Date.now();
    const list = withCpa();
    const own = getPos();
    cpaAlarms(list, own);
    $('ais-count').textContent = list.length ? `${list.length}` : '';

    if (map.hasLayer(layer)) {
      vectors.clearLayers();
      const seen = new Set();
      for (const { t } of list) {
        seen.add(t.mmsi);
        const stale = now - (t.lastPos ?? t.lastSeen) > STALE_MS;
        const html = `${iconHtml(t, stale)}<span class="ais-label">${esc(t.name || t.mmsi)}</span>`;
        let m = markers.get(t.mmsi);
        const cls = `ais-icon k-${t.kind}`;
        const icon = () => L.divIcon({ className: cls, html, iconSize: [28, 28], iconAnchor: [14, 14] });
        if (!m) {
          const mmsi = t.mmsi;
          m = L.marker([t.lat, t.lon], { icon: icon(), zIndexOffset: isDistress(t.kind) ? 2000 : t.kind === 'sar' ? 500 : 0 })
            .bindPopup(() => popupHtml(targets.targets.get(mmsi)), { maxWidth: 270 })
            .addTo(layer);
          m._aisHtml = html + cls;
          markers.set(t.mmsi, m);
        } else {
          m.setLatLng([t.lat, t.lon]);
          // rebuild the icon only when it changed (rebuilding replaces the element, e.g. mid-tap)
          if (m._aisHtml !== html + cls) {
            m.setIcon(icon());
            m._aisHtml = html + cls;
          }
          if (m.isPopupOpen()) m.getPopup().setContent(popupHtml(t));
        }
        // 6-minute course vector for moving targets
        if ((t.sog ?? 0) > 0.5 && Number.isFinite(t.cog) && !stale) {
          const d = t.sog / 10 / 60; // NM in 6 min -> degrees lat approx
          const a = (t.cog * Math.PI) / 180;
          const end = [t.lat + d * Math.cos(a), t.lon + (d * Math.sin(a)) / Math.cos((t.lat * Math.PI) / 180)];
          L.polyline([[t.lat, t.lon], end], { color: COLOURS[t.kind] || COLOURS.other, weight: 2, opacity: 0.8, interactive: false, className: 'ais-vec' }).addTo(vectors);
        }
      }
      for (const [k, m] of markers) {
        if (!seen.has(k)) {
          layer.removeLayer(m);
          markers.delete(k);
        }
      }
    }
    if (!document.querySelector('[data-panel="ais"]').hidden) renderList(list);
  }

  function popupHtml(t) {
    if (!t) return '';
    const own = getPos();
    const c = own ? cpaTcpa(own, t) : null;
    const st = NAV_STATUS[t.status];
    const html = `
      <div class="ais-pop">
        <b>${esc(t.name || 'Unknown')}</b> <span class="muted">${esc(KIND_LABEL[t.kind])}</span><br>
        MMSI ${t.mmsi}${t.callsign ? ` · ${esc(t.callsign)}` : ''}${t.classB ? ' · class B' : ''}<br>
        ${st ? `${esc(st)}<br>` : ''}
        SOG ${r1(t.sog)} kn · COG ${r0(t.cog)}°${Number.isFinite(t.heading) ? ` · HDG ${r0(t.heading)}°` : ''}${Number.isFinite(t.altitude) ? ` · alt ${t.altitude} m` : ''}<br>
        ${t.destination ? `To ${esc(t.destination)}<br>` : ''}
        ${c ? `BRG ${r0(c.bearing)}° · RNG ${c.range.toFixed(2)} NM<br>${cpaText(c)}<br>` : ''}
        <span class="muted small">${formatPosition(t, 'ddm')} · ${ago(t.lastPos ?? t.lastSeen)} · ${[...t.sources].join(' + ')}</span>
        <div class="row" style="margin-top:6px"><button data-ais-go="${t.mmsi}">Go to</button><button data-ais-mark="${t.mmsi}">Mark</button></div>
      </div>`;
    return html;
  }
  // popup buttons (event delegation; popups are rebuilt often)
  document.addEventListener('click', (e) => {
    const go = e.target.closest?.('[data-ais-go]');
    const mk = e.target.closest?.('[data-ais-mark]');
    const t = targets.targets.get(Number((go || mk)?.dataset.aisGo ?? (go || mk)?.dataset.aisMark));
    if (!t) return;
    if (go) goTo({ name: t.name || `MMSI ${t.mmsi}`, lat: t.lat, lon: t.lon });
    if (mk) {
      addMark({ lat: t.lat, lon: t.lon }, t.name || `AIS ${t.mmsi}`, isDistress(t.kind) ? 'mob' : 'mark');
      toast('Marked at its current position');
    }
  });

  function renderList(list) {
    const now = Date.now();
    const rank = (t) => (isDistress(t.kind) ? 0 : t.kind === 'sar' || t.kind === 'sar-aircraft' ? 1 : 2);
    const sorted = list
      .filter(({ t }) => t.kind !== 'aton')
      .sort((a, b) => rank(a.t) - rank(b.t) || (a.c?.range ?? 1e9) - (b.c?.range ?? 1e9));
    $('ais-list').innerHTML = sorted.length
      ? sorted
          .slice(0, 100)
          .map(({ t, c }) => {
            const danger = c && c.cpa < cfg.cpaNm && c.tcpa > 0 && c.tcpa < cfg.tcpaMin;
            const stale = now - (t.lastPos ?? t.lastSeen) > STALE_MS;
            return `<li class="${stale ? 'stale' : ''} ${isDistress(t.kind) ? 'distress' : ''}">
            <span class="ais-dot" style="background:${COLOURS[t.kind] || COLOURS.other}"></span>
            <div class="grow"><div class="title">${esc(t.name || `MMSI ${t.mmsi}`)} <span class="muted small">${esc(KIND_LABEL[t.kind])}</span></div>
            <div class="sub">${c ? `${r0(c.bearing)}° ${c.range.toFixed(1)} NM · ` : ''}${r1(t.sog)} kn ${r0(t.cog)}°${
              c ? ` · <span class="${danger ? 'cpa-danger' : ''}">${cpaText(c)}</span>` : ''
            } · ${ago(t.lastPos ?? t.lastSeen)}</div></div>
            <button data-ais-show="${t.mmsi}">Show</button></li>`;
          })
          .join('')
      : '<li class="muted">No AIS targets. Connect a source above.</li>';
    $('ais-list')
      .querySelectorAll('[data-ais-show]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const t = targets.targets.get(Number(b.dataset.aisShow));
          if (!t) return;
          if (!map.hasLayer(layer)) layer.addTo(map);
          map.setView([t.lat, t.lon], Math.max(map.getZoom(), 12));
          render();
          markers.get(t.mmsi)?.openPopup();
        }),
      );
  }

  function setStatus(which, s) {
    status[which] = s;
    const el = $(`ais-st-${which}`);
    if (el) {
      el.textContent = s;
      el.className = `ais-st ${s.startsWith('connected') ? 'ok' : s === 'off' ? '' : 'warn'}`;
    }
  }

  // ------------------------------------------------------------ settings UI
  $('ais-url').value = cfg.onboardUrl;
  $('ais-onboard').checked = cfg.onboard;
  $('ais-boatgps').checked = cfg.boatGps;
  $('ais-internet').checked = cfg.internet;
  $('ais-cpa').value = cfg.cpaNm;
  $('ais-tcpa').value = cfg.tcpaMin;
  const save = () => {
    cfg.onboardUrl = $('ais-url').value.trim();
    cfg.onboard = $('ais-onboard').checked;
    cfg.boatGps = $('ais-boatgps').checked;
    cfg.internet = $('ais-internet').checked;
    cfg.cpaNm = Number($('ais-cpa').value) || 0;
    cfg.tcpaMin = Number($('ais-tcpa').value) || 12;
    kv.set('aisOnboardUrl', cfg.onboardUrl);
    kv.set('aisOnboard', cfg.onboard);
    kv.set('aisBoatGps', cfg.boatGps);
    kv.set('aisInternet', cfg.internet);
    kv.set('aisCpaNm', cfg.cpaNm);
    kv.set('aisTcpaMin', cfg.tcpaMin);
  };
  $('ais-onboard').addEventListener('change', () => {
    save();
    connectOnboard();
    if (cfg.onboard) layer.addTo(map);
  });
  $('ais-url').addEventListener('change', () => {
    save();
    if (cfg.onboard) connectOnboard();
  });
  $('ais-internet').addEventListener('change', () => {
    save();
    connectInternet(true);
    if (cfg.internet) layer.addTo(map);
  });
  for (const id of ['ais-boatgps', 'ais-cpa', 'ais-tcpa']) $(id).addEventListener('change', save);

  layer.on('add', render);
  // Names next to the icons once zoomed in (SAR units and beacons always).
  const names = () => map.getContainer().classList.toggle('ais-names', map.getZoom() >= 11);
  map.on('zoomend', names);
  names();

  // ------------------------------------------------------------ boot
  setInterval(() => {
    targets.prune();
    render();
  }, 15000);
  connectOnboard();
  connectInternet(true);

  return {
    layer,
    render: () => render(),
    get cfg() {
      return cfg;
    },
    /** For tests and debugging: feed a raw NMEA line or a decoded message. */
    _ingestNmea(line) {
      ingest(nmea(line), 'test');
    },
    _ingest(msg, source = 'test') {
      ingest(msg, source);
    },
    targets,
  };
}
