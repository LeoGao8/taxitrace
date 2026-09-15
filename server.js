// Tiny dependency-free server: static files + JSON API. Run: npm start
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import * as store from './server/store.js';
import { sources, getSource } from './server/sources/index.js';
import * as trace from './server/sources/trace.js';

const PORT = Number(process.env.PORT) || 5178;
// All interfaces, so an iPad on the same Wi-Fi can reach it. HOST=127.0.0.1 keeps it local-only.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(import.meta.dirname, 'public');
const LEAFLET = path.join(import.meta.dirname, 'node_modules', 'leaflet', 'dist');
const MAX_UPLOAD = 60 * 1024 * 1024;

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

const routes = [
  ['GET', /^\/api\/sources$/, async () => Object.values(sources).map(({ id, label }) => ({ id, label }))],

  ['GET', /^\/api\/airports$/, async () => Promise.all((await store.listAirports()).map(airportSummary))],

  ['GET', /^\/api\/airports\/([^/]+)$/, async (req, [icao]) => airportSummary(store.normaliseIcao(icao))],

  ['PUT', /^\/api\/airports\/([^/]+)\/meta$/, async (req, [icao]) => {
    icao = store.normaliseIcao(icao);
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    const meta = (await store.readJson(icao, 'meta.json')) || {};
    if (body.preferredSource) meta.preferredSource = getSource(body.preferredSource).id;
    await store.writeJson(icao, 'meta.json', meta);
    return airportSummary(icao);
  }],

  ['GET', /^\/api\/airports\/([^/]+)\/sources\/([a-z]+)$/, async (req, [icao, src], url) => {
    const airport = await getSource(src).load(store.normaliseIcao(icao), { refresh: url.searchParams.has('refresh') });
    if (!airport) throw Object.assign(new Error(`No ${src} data saved for ${icao}`), { status: 404 });
    return airport;
  }],

  ['PUT', /^\/api\/airports\/([^/]+)\/sources\/([a-z]+)$/, async (req, [icao, src]) => {
    const source = getSource(src);
    if (!source.save) throw Object.assign(new Error(`${source.label} is read-only`), { status: 405 });
    const body = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
    return source.save(store.normaliseIcao(icao), body);
  }],

  ['PUT', /^\/api\/airports\/([^/]+)\/chart$/, async (req, [icao], url) => {
    const buffer = await readBody(req, MAX_UPLOAD);
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    return trace.saveChart(store.normaliseIcao(icao), buffer, type,
      Number(url.searchParams.get('width')), Number(url.searchParams.get('height')));
  }],
];

async function airportSummary(icao) {
  const meta = (await store.readJson(icao, 'meta.json')) || {};
  const available = {};
  for (const s of Object.values(sources)) available[s.id] = await s.hasData(icao);
  return { icao, preferredSource: meta.preferredSource || null, available };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Upload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
    const chart = /^\/api\/airports\/([^/]+)\/chart$/.exec(url.pathname);
    if (chart && req.method === 'GET') {
      const info = await trace.chartInfo(store.normaliseIcao(chart[1]));
      return info ? serveFile(res, info.path, info.contentType) : sendJson(res, 404, { error: 'No chart' });
    }

    if (url.pathname.startsWith('/api/')) {
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (m && req.method === method) {
          return sendJson(res, 200, await handler(req, m.slice(1), url));
        }
      }
      return sendJson(res, 404, { error: 'No such endpoint' });
    }

    if (url.pathname.startsWith('/vendor/leaflet/')) {
      const file = safeJoin(LEAFLET, url.pathname.slice('/vendor/leaflet/'.length));
      return file ? serveFile(res, file) : sendJson(res, 400, { error: 'Bad path' });
    }

    const file = safeJoin(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    return file ? serveFile(res, file) : sendJson(res, 400, { error: 'Bad path' });
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message });
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
