// Same-origin proxy for sjolag.is's PMTiles (wave forecast + land masks) and map style.
//
// sjolag.is sends no CORS headers, and PMTiles are read with HTTP Range
// requests. A plain vercel.json rewrite may be cached by Vercel's CDN keyed by
// URL (which would mix up byte ranges), so this function forwards the Range
// header explicitly, returns the exact upstream status (206) and Content-Range,
// and turns off shared caching. Only sjolag.is's forecast/base-map PMTiles and
// the style file can be fetched — it is not an open proxy.
//
// GET /api/sjolag-pm?p=tiles/forecast/GRINDAVIK_2026-11-04_00_00_00_0.pmtiles
// GET /api/sjolag-pm?p=static/tiles/base/map-v1.pmtiles
// GET /api/sjolag-pm?p=tiles/style.json&layer=default

const ALLOWED = [
  /^tiles\/forecast\/[A-Za-z0-9_-]+\.pmtiles$/,
  /^static\/tiles\/base\/[A-Za-z0-9_-]+\.pmtiles$/,
  /^tiles\/style\.json$/,
];

export function allowedPath(p) {
  return typeof p === 'string' && !p.includes('..') && ALLOWED.some((re) => re.test(p));
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.searchParams.get('p');
  if (!allowedPath(p)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'path not allowed' }));
    return;
  }
  const origin = process.env.SJOLAG_ORIGIN || 'https://sjolag.is';
  const qs = p === 'tiles/style.json' && url.searchParams.get('layer') ? `?layer=${encodeURIComponent(url.searchParams.get('layer'))}` : '';
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match'];
  let r;
  try {
    r = await fetch(`${origin}/${p}${qs}`, { headers });
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sjolag.is unreachable' }));
    return;
  }
  const out = {
    'content-type': r.headers.get('content-type') || 'application/octet-stream',
    // per-visitor caching only: byte ranges of one URL must not be shared via the CDN
    'cache-control': p.endsWith('.json') ? 'private, max-age=300' : 'private, max-age=3600',
    vary: 'Range',
  };
  for (const k of ['content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = r.headers.get(k);
    if (v) out[k] = v;
  }
  const body = Buffer.from(await r.arrayBuffer());
  out['content-length'] = String(body.length);
  res.writeHead(r.status, out);
  res.end(body);
}
