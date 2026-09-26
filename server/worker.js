// Cloudflare Worker entry. wrangler.jsonc routes only /api/* here (run_worker_first);
// everything else is served straight from dist/ by the assets layer.
//
// The store is read-only and backed by the data baked into dist/ at build time, so there
// is no bucket to provision: `npm run build` bakes in whatever is committed under data/.
import { handleApi } from './api.js';
import { createStaticStore } from './static-store.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, createStaticStore(env.ASSETS, url.origin));
    return env.ASSETS.fetch(request);
  },
};
