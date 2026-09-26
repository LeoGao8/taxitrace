// Tiny dependency-free server: static files + JSON API. Run: npm start
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as store from './server/store.js';
import { handleApi } from './server/api.js';

const PORT = Number(process.env.PORT) || 5178;
// All interfaces, so an iPad on the same Wi-Fi can reach it. HOST=127.0.0.1 keeps it local-only.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(import.meta.dirname, 'public');
const LEAFLET = path.join(import.meta.dirname, 'node_modules', 'leaflet', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ API
// Same handler the Cloudflare Worker uses (server/api.js), with files under data/ as the store.

async function serveApi(req, res, url) {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
  const response = await handleApi(request, store);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}

// --------------------------------------------------------------- static

async function serveFile(res, file, contentType) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
    res.writeHead(200, {
      'Content-Type': contentType || MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function safeJoin(root, urlPath) {
  const file = path.normalize(path.join(root, decodeURIComponent(urlPath)));
  return file.startsWith(root + path.sep) ? file : null;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await serveApi(req, res, url);

    if (url.pathname.startsWith('/vendor/leaflet/')) {
      const file = safeJoin(LEAFLET, url.pathname.slice('/vendor/leaflet/'.length));
      return file ? serveFile(res, file) : sendJson(res, 400, { error: 'Bad path' });
    }

    const file = safeJoin(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    return file ? serveFile(res, file) : sendJson(res, 400, { error: 'Bad path' });
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.destroy();
    else sendJson(res, err instanceof URIError ? 400 : 500, { error: err.message });
  }
});

// macOS lets a second server bind 0.0.0.0 while an old one still holds 127.0.0.1
// on the same port, and localhost then silently reaches the old code. Refuse instead.
const inUse = `Port ${PORT} is already in use: another Taxi Trace (or other app) is still running.
Stop it first (Ctrl+C in its terminal, or: lsof -ti tcp:${PORT} | xargs kill), then npm start again.`;
const portTaken = await new Promise((resolve) => {
  const probe = net.connect({ port: PORT, host: '127.0.0.1' });
  probe.once('connect', () => (probe.destroy(), resolve(true)));
  probe.once('error', () => resolve(false));
});
if (portTaken) {
  console.error(inUse);
  process.exit(1);
}
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? inUse : err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const wildcard = HOST === '0.0.0.0' || HOST === '::';
  console.log(`Taxi Trace running`);
  console.log(`  Local:   http://${wildcard ? 'localhost' : HOST}:${PORT}`);
  if (!wildcard) return;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Network: http://${a.address}:${PORT}`);
    }
  }
});
