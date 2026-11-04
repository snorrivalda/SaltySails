// Vegagerðin wave forecast (ölduspá) from sjolag.is, drawn as a Leaflet tile layer.
//
// sjolag.is publishes the forecast as PMTiles vector tiles: one national
// offshore model (≈10 days, 3-hourly) and eight high-resolution coastal models
// (≈5 days) — Þorlákshöfn, Eyjafjörður, Grindavík, Húsavík, Vestfirðir,
// Vestmannaeyjar, Hornafjörður, Vík. Each file holds a whole run; features are
// tagged with their forecast time. Layers:
//   olduhaed        polygons, z = lower bound of the wave-height band (m)
//   olduhaed_lines  contour lines, wave_height / wave_heigh (m)
//   stefna_0/1/2    points: Dir (direction of travel, °), Tp (peak period, s), at 3 densities
// The tiles have no CORS headers, so they're fetched through our same-origin
// proxy function (api/sjolag-pm.js), which forwards Range requests.

// Same-origin proxy function for sjolag.is (api/sjolag-pm.js): forwards Range, no CDN caching.
export const PM_PROXY = 'api/sjolag-pm?p=';
// Land masks, as sjolag.is uses them: Landmælingar's coastline (lmi_strandlina) and other countries.
export const MASKS = [
  { url: `${PM_PROXY}static/tiles/base/map-v1.pmtiles`, layer: 'lmi_strandlina', maxZoom: 22 },
  { url: `${PM_PROXY}static/tiles/base/countries-v1.pmtiles`, layer: 'countriesfiltered', maxZoom: 6 },
];

// sjolag.is's own colour steps for significant wave height (m).
export const BANDS = [
  [0, '#f4f4f4'],
  [0.5, '#CBF584'],
  [0.7, '#BAFF9A'],
  [1, '#7FF188'],
  [1.5, '#1FDE81'],
  [2, '#00C665'],
  [2.5, '#1EDEFF'],
  [3, '#32C1FF'],
  [3.5, '#008CFF'],
  [4, '#0066FF'],
  [5, '#FEDD00'],
  [6, '#FE8E2C'],
  [8, '#FF650F'],
  [10, '#FD4536'],
  [12, '#CC0F00'],
  [20, '#670800'],
];

/** Colour of the band a height falls in. */
export function bandColor(z) {
  let c = BANDS[0][1];
  for (const [v, col] of BANDS) if (z >= v) c = col;
  return c;
}

/** Band [low, high) for a colour (used to read values back from the drawn map). */
export function bandForColor(hex) {
  const i = BANDS.findIndex(([, c]) => c.toLowerCase() === hex.toLowerCase());
  if (i < 0) return null;
  return [BANDS[i][0], BANDS[i + 1]?.[0] ?? null];
}

/**
 * Normalise the forecast-time tags, which come in two spellings
 * ("2026-11-04-15_00_00" and "2026-11-04 15:00:00"), to "YYYYMMDDHH".
 */
export function timeKey(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(0, 10) : null;
}
/** Unix seconds -> "YYYYMMDDHH" (UTC). */
export const keyForUnix = (t) => new Date(t * 1000).toISOString().replace(/\D/g, '').slice(0, 10);

/** Forecast time of a feature (offshore uses "date", coastal "dt"). */
export const featureKey = (props) => timeKey(props.date ?? props.dt);

/**
 * Wave-forecast sources from sjolag.is's map style: the offshore model and
 * the coastal models, with their current run's PMTiles URL rewritten to the proxy.
 */
export function parseSources(style) {
  const out = [];
  for (const [id, src] of Object.entries(style?.sources ?? {})) {
    if (src.type !== 'vector' || !/^waves(_|$)/.test(id)) continue;
    const m = /\/tiles\/(forecast\/[^?#]+\.pmtiles)/.exec(src.url ?? '');
    if (!m) continue;
    out.push({
      id,
      area: id === 'waves' ? 'OFFSHORE' : id.slice('waves_'.length).toUpperCase(),
      offshore: id === 'waves',
      url: `${PM_PROXY}tiles/${m[1]}`,
      // sjolag.is shows the coastal models from zoom 7 up
      minZoom: id === 'waves' ? 0 : 7,
    });
  }
  return out.sort((a, b) => Number(b.offshore) - Number(a.offshore)); // offshore first, coastal drawn on top
}

/** Which direction-arrow layer to use at a zoom (offshore has three densities). */
export function arrowLayer(src, z) {
  if (!src.offshore) return 'stefna_0';
  return z >= 8 ? 'stefna_2' : z >= 6 ? 'stefna_1' : 'stefna_0';
}

/**
 * Leaflet layer. `lib` is the vendored { PMTiles, VectorTile, Pbf } module.
 * Call setTime(unixSeconds) to choose the forecast step (nearest within 90 min).
 */
export function createVgWavesLayer(L, lib, { onStatus = () => {}, pane = 'tilePane' } = {}) {
  const { PMTiles, VectorTile, Pbf } = lib;
  let sources = [];
  let masks = [];
  let times = []; // available forecast keys (offshore)
  let key = null;
  const cache = new Map(); // `${id}/${z}/${x}/${y}` -> Promise<VectorTile|null>
  const MAX_CACHE = 300;

  async function init() {
    const [style, ts] = await Promise.all([
      fetch(`${PM_PROXY}tiles/style.json&layer=default`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`style ${r.status}`)))),
      fetch('api/sjolag/forecasts/timestamps').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    sources = parseSources(style).map((s) => ({ ...s, pm: new PMTiles(s.url) }));
    await Promise.all(
      sources.map(async (s) => {
        try {
          const h = await s.pm.getHeader();
          s.bounds = [h.minLat, h.minLon, h.maxLat, h.maxLon];
          s.maxZoom = h.maxZoom;
        } catch {
          s.broken = true;
        }
      }),
    );
    sources = sources.filter((s) => !s.broken);
    masks = await Promise.all(
      MASKS.map(async (m) => {
        const pm = new PMTiles(m.url);
        try {
          const h = await pm.getHeader();
          return { ...m, id: `mask:${m.layer}`, pm, srcMax: h.maxZoom };
        } catch {
          return null;
        }
      }),
    ).then((a) => a.filter(Boolean));
    times = (ts?.data?.timestamps ?? []).filter((t) => t.types?.includes('OFFSHORE')).map((t) => keyForUnix(Date.parse(t.date) / 1000));
    return { sources: sources.map((s) => s.area), times };
  }
  const ready = init().catch((e) => {
    onStatus(`Wave forecast unavailable (${e.message})`);
    return null;
  });

  function getTile(src, z, x, y) {
    const k = `${src.id}/${z}/${x}/${y}`;
    if (!cache.has(k)) {
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(
        k,
        src.pm
          .getZxy(z, x, y)
          .then((t) => (t?.data ? new VectorTile(new Pbf(new Uint8Array(t.data))) : null))
          .catch(() => null),
      );
    }
    return cache.get(k);
  }

  const tileBounds = (z, x, y) => {
    const n = 2 ** z;
    const lon = (i) => (i / n) * 360 - 180;
    const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
    return [lat(y + 1), lon(x), lat(y), lon(x + 1)];
  };
  const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

  function drawLayer(ctx, layer, size, scale, ox, oy, fn) {
    if (!layer) return;
    const k = size / layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (featureKey(f.properties) !== key) continue;
      fn(f, f.loadGeometry(), (p) => [(p.x * k - ox) * scale, (p.y * k - oy) * scale]);
    }
  }

  /** Tile from a source at (z,x,y), using the parent at maxZoom when zoomed in further. */
  async function tileFor(src, maxZoom, z, x, y, size) {
    const dz = Math.max(0, z - maxZoom);
    const px = x >> dz;
    const py = y >> dz;
    const vt = await getTile(src, z - dz, px, py);
    if (!vt) return null;
    const scale = 2 ** dz;
    const sub = size / scale;
    return { vt, scale, ox: (x - (px << dz)) * sub, oy: (y - (py << dz)) * sub, zz: z - dz };
  }

  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const size = this.getTileSize();
      const tile = L.DomUtil.create('canvas', 'vg-tile');
      tile.width = size.x;
      tile.height = size.y;
      this._draw(tile, coords).then(() => done(null, tile), (e) => done(e, tile));
      return tile;
    },
    async _draw(tile, { x, y, z }) {
      await ready;
      if (!key) return;
      const ctx = tile.getContext('2d', { willReadFrequently: true });
      const tb = tileBounds(z, x, y);
      const arrowsTodo = [];
      for (const src of sources) {
        if (z < src.minZoom || !src.bounds || !overlaps(tb, src.bounds)) continue;
        // overzoom: use the parent tile at the source's max zoom, scaled up
        const dz = Math.max(0, z - src.maxZoom);
        const zz = z - dz;
        const px = x >> dz;
        const py = y >> dz;
        const vt = await getTile(src, zz, px, py);
        if (!vt) continue;
        const scale = 2 ** dz;
        const sub = tile.width / scale; // size of our tile inside the parent, in parent px
        const ox = (x - (px << dz)) * sub;
        const oy = (y - (py << dz)) * sub;
        const S = tile.width; // draw the parent at S px, then crop/scale via ox/oy/scale

        // wave-height bands
        drawLayer(ctx, vt.layers.olduhaed, S, scale, ox, oy, (f, rings, tp) => {
          ctx.fillStyle = bandColor(f.properties.z);
          ctx.beginPath();
          for (const ring of rings) {
            ring.forEach((p, i) => {
              const [a, b] = tp(p);
              if (i) ctx.lineTo(a, b);
              else ctx.moveTo(a, b);
            });
            ctx.closePath();
          }
          ctx.fill('evenodd');
        });
        // contour lines
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 0.8;
        drawLayer(ctx, vt.layers.olduhaed_lines, S, scale, ox, oy, (f, lines, tp) => {
          ctx.beginPath();
          for (const line of lines)
            line.forEach((p, i) => {
              const [a, b] = tp(p);
              if (i) ctx.lineTo(a, b);
              else ctx.moveTo(a, b);
            });
          ctx.stroke();
        });
        arrowsTodo.push({ src, vt, scale, ox, oy, zz, S });
      }
      // cut out land (Landmælingar coastline; other countries at low zoom), as sjolag.is does
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      for (const m of masks) {
        if (z > m.maxZoom) continue;
        const t = await tileFor(m, m.srcMax, z, x, y, tile.width);
        const lyr = t?.vt.layers[m.layer];
        if (!lyr) continue;
        const k = tile.width / lyr.extent;
        ctx.beginPath();
        for (let i = 0; i < lyr.length; i++) {
          for (const ring of lyr.feature(i).loadGeometry()) {
            ring.forEach((p, j) => {
              const a = (p.x * k - t.ox) * t.scale;
              const b = (p.y * k - t.oy) * t.scale;
              if (j) ctx.lineTo(a, b);
              else ctx.moveTo(a, b);
            });
            ctx.closePath();
          }
        }
        ctx.fill('evenodd');
      }
      ctx.globalCompositeOperation = 'source-over';
      // direction arrows (pointing the way the waves travel) + peak period, thinned to one per ~26 px
      const taken = new Set();
      for (const { src, vt, scale, ox, oy, zz, S } of arrowsTodo) {
        const showTp = z >= (src.offshore ? 6 : 12);
        drawLayer(ctx, vt.layers[arrowLayer(src, zz)], S, scale, ox, oy, (f, pts, tp) => {
          for (const ring of pts)
            for (const p of ring) {
              const [a, b] = tp(p);
              if (a < 0 || b < 0 || a >= tile.width || b >= tile.height) continue;
              const cell = `${Math.floor(a / 26)},${Math.floor(b / 26)}`;
              if (taken.has(cell)) continue;
              // over land (masked) -> skip
              if (ctx.getImageData(a, b, 1, 1).data[3] === 0) continue;
              taken.add(cell);
              arrow(ctx, a, b, f.properties.Dir, showTp ? f.properties.Tp : null);
            }
        });
      }
    },
  });

  function arrow(ctx, x, y, dir, tp) {
    const r = ((dir ?? 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r);
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(4, 4);
    ctx.lineTo(0, 1.5);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (tp) {
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(`${Math.round(tp)}s`, x + 6, y + 3);
    }
  }

  const layer = new Layer({
    pane,
    tileSize: 256,
    opacity: 0.85,
    className: 'vg-waves',
    attribution: 'Ölduspá &copy; <a href="https://sjolag.is" target="_blank" rel="noopener">Vegagerðin</a>',
    maxZoom: 19,
    updateWhenZooming: false,
  });

  return {
    layer,
    ready,
    get times() {
      return times;
    },
    /** Choose the forecast step nearest to unix time t; returns the key used (or null). */
    setTime(t) {
      // nearest available step within 90 min
      const best = times
        .map((k) => ({ k, d: Math.abs(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(8, 10)) / 1000 - t) }))
        .sort((a, b) => a.d - b.d)[0];
      const next = best && best.d <= 90 * 60 ? best.k : null;
      if (next !== key) {
        key = next;
        layer.redraw();
      }
      return key;
    },
  };
}
