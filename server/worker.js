// Cloudflare Worker entry. wrangler.jsonc routes only /api/* here (run_worker_first);
// everything else is served straight from dist/ by the assets layer.
import { handleApi } from './api.js';
import { createR2Store } from './r2-store.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handleApi(request, createR2Store(env.DATA));
    return env.ASSETS.fetch(request);
  },
};
