// Read-only persistence for the Cloudflare Worker, over the data baked into dist/ by
// scripts/build.js. Same interface as server/store.js, minus the writes: the deployed
// data is whatever was committed, so it changes by redeploying, not at runtime.
//
// Reads go through the ASSETS binding rather than the public URL, so they stay inside
// the Worker and cost no subrequest to the outside world.
import { normaliseIcao } from './api.js';

const BASE = '/data/airports/';
const MANIFEST = '/data/manifest.json';

export function createStaticStore(assets, origin) {
  const url = (p) => new URL(p, origin).toString();

  // One fetch per isolate; the manifest is small and never changes for a given deploy.
  let manifestPromise;
  const manifest = () => (manifestPromise ??= assets
    .fetch(url(MANIFEST))
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({})));

  const get = async (icao, name) => {
    const files = (await manifest())[normaliseIcao(icao)];
    if (!files?.includes(name)) return null; // no asset fetch for something we know isn't there
    const res = await assets.fetch(url(`${BASE}${normaliseIcao(icao)}/${name}`));
    return res.ok ? res : null;
  };

  return {
    // api.js turns every mutating request (all PUTs) into a 405 when this is set.
    readOnly: true,

    async readJson(icao, name) {
      const res = await get(icao, name);
      return res ? res.json() : null;
    },

    // The OSM source caches Overpass responses through writeJson. There's nowhere to put
    // them, but an airport outside the baked-in set should still load live, so dropping
    // the cache write is the right failure: correct, just uncached.
    async writeJson() {},

    async writeStream() {
      throw Object.assign(new Error('This deployment is read-only'), { status: 405 });
    },

    async readFile(icao, name) {
      const res = await get(icao, name);
      if (!res) return null;
      const len = Number(res.headers.get('content-length'));
      // api.js sends this straight back with a Content-Length, so buffer when the
      // asset response didn't carry one rather than guessing.
      if (Number.isFinite(len) && len > 0) return { body: res.body, size: len };
      const buf = await res.arrayBuffer();
      return { body: new Blob([buf]).stream(), size: buf.byteLength };
    },

    async exists(icao, name) {
      return Boolean((await manifest())[normaliseIcao(icao)]?.includes(name));
    },

    async remove() {},

    async listAirports() {
      return Object.keys(await manifest()).sort();
    },
  };
}
