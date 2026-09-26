// The JSON API as a fetch-style handler: Request in, Response out. Both hosts use it:
// server.js (Node, files under data/) and worker.js (Cloudflare, data baked into dist/).
// `store` is the persistence backend; see server/store.js for the interface.
import { sources, getSource } from './sources/index.js';
import * as trace from './sources/trace.js';

const MAX_UPLOAD = 60 * 1024 * 1024;

// Also allows non-ICAO idents (e.g. private strips) since traces don't need OSM.
export const ICAO_RE = /^[A-Z0-9-]{2,8}$/;

export function normaliseIcao(raw) {
  const icao = String(raw || '').trim().toUpperCase();
  if (!ICAO_RE.test(icao)) throw Object.assign(new Error(`Invalid airport ident "${raw}"`), { status: 400 });
  return icao;
}

const routes = [
  ['GET', /^\/api\/sources$/, async () => Object.values(sources).map(({ id, label }) => ({ id, label }))],

  ['GET', /^\/api\/airports$/, async (store) => Promise.all((await store.listAirports()).map((icao) => airportSummary(store, icao)))],

  ['GET', /^\/api\/airports\/([^/]+)$/, async (store, req, [icao]) => airportSummary(store, normaliseIcao(icao))],

  ['PUT', /^\/api\/airports\/([^/]+)\/meta$/, async (store, req, [icao]) => {
    icao = normaliseIcao(icao);
    const body = JSON.parse(await readText(req, 64 * 1024));
    const meta = (await store.readJson(icao, 'meta.json')) || {};
    if (body.preferredSource) meta.preferredSource = getSource(body.preferredSource).id;
    await store.writeJson(icao, 'meta.json', meta);
    return airportSummary(store, icao);
  }],

  ['GET', /^\/api\/airports\/([^/]+)\/sources\/([a-z]+)$/, async (store, req, [icao, src], url) => {
    const airport = await getSource(src).load(store, normaliseIcao(icao), { refresh: url.searchParams.has('refresh') });
    if (!airport) throw Object.assign(new Error(`No ${src} data saved for ${icao}`), { status: 404 });
    return airport;
  }],

  ['PUT', /^\/api\/airports\/([^/]+)\/sources\/([a-z]+)$/, async (store, req, [icao, src]) => {
    const source = getSource(src);
    if (!source.save) throw Object.assign(new Error(`${source.label} is read-only`), { status: 405 });
    const body = JSON.parse(await readText(req, 20 * 1024 * 1024));
    return source.save(store, normaliseIcao(icao), body);
  }],

  ['PUT', /^\/api\/airports\/([^/]+)\/chart$/, async (store, req, [icao], url) => {
    const size = Number(req.headers.get('content-length'));
    if (!req.headers.has('content-length') || !Number.isFinite(size)) throw Object.assign(new Error('Content-Length required'), { status: 411 });
    if (size > MAX_UPLOAD) throw Object.assign(new Error('Upload too large'), { status: 413 });
    const type = (req.headers.get('content-type') || '').split(';')[0].trim();
    return trace.saveChart(store, normaliseIcao(icao), req.body, size, type,
      Number(url.searchParams.get('width')), Number(url.searchParams.get('height')));
  }],
];

export async function handleApi(req, store) {
  const url = new URL(req.url);
  try {
    // Every mutating route is a PUT, so one check covers them all. A read-only store
    // (see server/static-store.js) serves data baked in at build time.
    if (req.method === 'PUT' && store.readOnly) {
      throw Object.assign(new Error('This deployment is read-only: its airport data is baked in at build time'), { status: 405 });
    }

    const chart = /^\/api\/airports\/([^/]+)\/chart$/.exec(url.pathname);
    if (chart && req.method === 'GET') {
      const file = await trace.chart(store, normaliseIcao(chart[1]));
      if (!file) return json(404, { error: 'No chart' });
      return new Response(file.body, {
        headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.size), 'Cache-Control': 'no-cache' },
      });
    }

    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);
      if (m && req.method === method) return json(200, await handler(store, req, m.slice(1), url));
    }
    return json(404, { error: 'No such endpoint' });
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    return json(status, { error: err.message });
  }
}

async function airportSummary(store, icao) {
  const meta = (await store.readJson(icao, 'meta.json')) || {};
  const available = {};
  for (const s of Object.values(sources)) available[s.id] = await s.hasData(store, icao);
  return { icao, preferredSource: meta.preferredSource || null, available };
}

async function readText(req, limit) {
  if (Number(req.headers.get('content-length')) > limit) throw Object.assign(new Error('Upload too large'), { status: 413 });
  const text = await req.text();
  if (text.length > limit) throw Object.assign(new Error('Upload too large'), { status: 413 });
  return text;
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
