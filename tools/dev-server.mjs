// Local static server that mirrors vercel.json: serves the app and proxies
// /api/sjolag/* to https://sjolag.is/api/* (that API sends no CORS headers),
// and runs the AIS relay (api/ais.js) at /api/ais.
// Usage: node tools/dev-server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import aisRelay from '../api/ais.js';
import lhgRelay from '../api/ais-lhg.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/ais') return aisRelay(req, res);
    if (url.pathname === '/api/ais-lhg') return lhgRelay(req, res);
    if (url.pathname.startsWith('/api/sjolag/')) {
      const r = await fetch(`https://sjolag.is/api/${url.pathname.slice('/api/sjolag/'.length)}${url.search}`);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`SaltySails on http://localhost:${port}`));
