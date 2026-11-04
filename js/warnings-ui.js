/* global L */
// Icelandic Met Office weather warnings: banner, Weather-tab list, map polygons.
import { CAP_BASE, messageUrl, activeWarnings, warningDistanceNm, inForce } from './warnings.js';
import { distanceNm } from './geo.js';

const REFRESH_MS = 10 * 60 * 1000;
const NEAR_NM = 10; // warnings within this distance of own position count as "here"
const COLOUR_HEX = { yellow: '#f2c200', orange: '#f28c00', red: '#d62839' };
const LABEL = { yellow: 'Yellow', orange: 'Orange', red: 'Red' };

const gmt = (ms) => {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1} ${d.toISOString().slice(11, 16)}`;
};
/** "15-25 m/s" -> "15-25 m/s (≈ 29–49 kn)": warnings give wind in m/s. */
const withKnots = (text) =>
  text.replace(/(\d+)(?:\s*[-–]\s*(\d+))?\s*m\/s/g, (m, a, b) => {
    const kn = (v) => Math.round(Number(v) * 1.943844);
    return `${m} (≈ ${kn(a)}${b ? `–${kn(b)}` : ''} kn)`;
  });
const esc = (s) =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);

/** Fetch every active Met warning (204 = none). */
async function fetchActive() {
  const r = await fetch(`${CAP_BASE}/active/category/met`);
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`CAP ${r.status}`);
  const ids = await r.json();
  const msgs = await Promise.all(
    (Array.isArray(ids) ? ids : []).map((id) =>
      // entries are identifiers; fetch each full message
      id.alert ? id : fetch(messageUrl({ ...id, sent: id.sent ?? id.sent_string })).then((m) => (m.ok ? m.json() : null)),
    ),
  );
  return msgs.filter(Boolean);
}

export function initWarnings({ map, store, getPos, selectTab }) {
  const $ = (id) => document.getElementById(id);
  let warnings = [];
  let fetchedAt = null;
  let failed = false;
  let lastFix = null;

  const layer = L.layerGroup();

  async function refresh() {
    try {
      const msgs = await fetchActive();
      store.set('capCache', { msgs, at: Date.now() });
      apply(msgs, Date.now(), false);
    } catch {
      // Offline: fall back to the last warnings we saw, clearly marked with their age.
      const c = store.get('capCache', null);
      if (c) apply(c.msgs, c.at, true);
      else {
        failed = true;
        render();
      }
    }
  }

  function apply(msgs, at, stale) {
    warnings = activeWarnings(msgs);
    fetchedAt = at;
    failed = stale;
    render();
  }

  function relevant() {
    const pos = getPos();
    return warnings
      .map((w) => ({ w, nm: pos ? warningDistanceNm(w, pos) : null }))
      // nearest area first; within it, what applies now before what is coming, worst first
      .sort(
        (a, b) =>
          (a.nm ?? 1e9) - (b.nm ?? 1e9) ||
          Number(inForce(b.w)) - Number(inForce(a.w)) ||
          b.w.level - a.w.level ||
          a.w.onset - b.w.onset,
      );
  }

  function render() {
    const list = relevant();
    const here = list.filter((x) => x.nm != null && x.nm <= NEAR_NM);

    // Tab badge: any warning anywhere in Iceland.
    const tab = document.querySelector('[data-tab="weather"]');
    tab.classList.toggle('has-warning', warnings.length > 0);
    const top = warnings[0];
    tab.style.setProperty('--warn', top ? COLOUR_HEX[top.colour] : 'transparent');

    // Banner: warnings at (or within 10 NM of) own position.
    const banner = $('warn-banner');
    if (here.length) {
      // What applies now (worst first); otherwise the next one coming.
      const now = here.filter((x) => inForce(x.w)).sort((a, b) => b.w.level - a.w.level);
      const next = here.filter((x) => !inForce(x.w)).sort((a, b) => a.w.onset - b.w.onset);
      const w = (now[0] ?? next[0]).w;
      const worse = next.find((x) => x.w.level > w.level)?.w;
      const ev = (x) => esc(x.event.replace(/^Weather Warning:\s*/i, ''));
      banner.hidden = false;
      banner.style.setProperty('--warn', COLOUR_HEX[w.colour]);
      banner.classList.toggle('dark', w.colour !== 'yellow');
      banner.innerHTML =
        `<b>⚠ ${LABEL[w.colour]}${inForce(w) ? ' now' : ''}:</b> ${ev(w)} · ${esc(w.area)} · ` +
        `${inForce(w) ? `until ${gmt(w.expires)}` : `from ${gmt(w.onset)}`} GMT` +
        (worse ? ` <span class="warn-chip ${worse.colour}" style="--warn:${COLOUR_HEX[worse.colour]}">${LABEL[worse.colour]} from ${gmt(worse.onset)}</span>` : '');
    } else banner.hidden = true;
    document.body.classList.toggle('has-banner', !banner.hidden);
    document.documentElement.style.setProperty('--banner-h', `${banner.hidden ? 0 : banner.offsetHeight}px`);

    // Weather tab list.
    const el = $('wx-warnings');
    if (failed && !warnings.length) {
      el.innerHTML = `<div class="warn-none">Warnings could not be loaded. Check <a href="https://en.vedur.is/weather/warnings/" target="_blank" rel="noopener">vedur.is</a>.</div>`;
    } else if (!warnings.length) {
      el.innerHTML = `<div class="warn-none">No weather warnings in force from the Icelandic Met Office${fetchedAt ? ` (checked ${gmt(fetchedAt)} GMT)` : ''}.</div>`;
    } else {
      el.innerHTML =
        `<div class="label">Warnings · Veðurstofa Íslands${failed ? ` · <span class="stale">offline, as of ${gmt(fetchedAt)} GMT</span>` : ''}</div>` +
        list
          .map(
            ({ w, nm }) => `
        <details class="warn-item" style="--warn:${COLOUR_HEX[w.colour]}" ${nm != null && nm <= NEAR_NM ? 'open' : ''}>
          <summary>
            <span class="warn-chip ${w.colour}">${LABEL[w.colour]}</span>
            <b>${esc(w.event.replace(/^Weather Warning:\s*/i, ''))}</b> · ${esc(w.area)}
            <span class="sub">${inForce(w) ? `In force until ${gmt(w.expires)}` : `${gmt(w.onset)} → ${gmt(w.expires)}`} GMT${
              nm == null ? '' : nm === 0 ? ' · <b>you are in this area</b>' : ` · ${nm.toFixed(0)} NM away`
            }</span>
          </summary>
          <p><b>${esc(w.headline)}</b>. ${withKnots(esc(w.description))}</p>
          ${w.descriptionIs ? `<p lang="is" class="muted"><b>${esc(w.headlineIs)}</b>. ${esc(w.descriptionIs)}</p>` : ''}
          <p class="small"><a href="${esc(w.web || 'https://en.vedur.is/weather/warnings/')}" target="_blank" rel="noopener">vedur.is</a>
            · <a href="#" data-show="${esc(w.id)}">Show on chart</a></p>
        </details>`,
          )
          .join('');
      el.querySelectorAll('[data-show]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const w = warnings.find((x) => x.id === a.dataset.show);
          if (!w) return;
          if (!map.hasLayer(layer)) layer.addTo(map);
          map.fitBounds(L.latLngBounds(w.polygons.flat()).pad(0.1));
        }),
      );
    }
    drawLayer();
  }

  function drawLayer() {
    layer.clearLayers();
    // lowest level first so red is drawn on top
    for (const w of [...warnings].reverse()) {
      for (const poly of w.polygons) {
        L.polygon(poly, {
          color: COLOUR_HEX[w.colour],
          weight: 2,
          fillColor: COLOUR_HEX[w.colour],
          fillOpacity: inForce(w) ? 0.22 : 0.08,
          dashArray: inForce(w) ? null : '6 6',
        })
          .bindPopup(
            `<b>${LABEL[w.colour]} warning: ${esc(w.event.replace(/^Weather Warning:\s*/i, ''))}</b><br>${esc(w.area)}<br>${gmt(w.onset)} → ${gmt(
              w.expires,
            )} GMT<br><br>${withKnots(esc(w.description))}<br><small>Veðurstofa Íslands</small>`,
            { maxWidth: 260 },
          )
          .addTo(layer);
      }
    }
  }

  $('warn-banner').addEventListener('click', () => selectTab('weather'));

  refresh();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!fetchedAt || Date.now() - fetchedAt > REFRESH_MS)) refresh();
  });

  return {
    layer,
    refresh,
    /** Re-evaluate distances after a position change. */
    onFix(fix) {
      if (!warnings.length) return;
      if (lastFix && distanceNm(lastFix, fix) < 0.5) return;
      lastFix = fix;
      render();
    },
    get warnings() {
      return warnings;
    },
  };
}
