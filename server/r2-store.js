// R2 persistence for the Cloudflare Worker. Same layout and interface as server/store.js,
// with object keys airports/<ICAO>/<name> in place of files. R2 is strongly consistent,
// so a trace saved on one device is what the next read sees on another.
import { ICAO_RE, normaliseIcao } from './api.js';

const PREFIX = 'airports/';

export function createR2Store(bucket) {
  const key = (icao, name) => `${PREFIX}${normaliseIcao(icao)}/${name}`;

  return {
    async readJson(icao, name) {
      const obj = await bucket.get(key(icao, name));
      return obj ? obj.json() : null;
    },

    async writeJson(icao, name, value) {
      await bucket.put(key(icao, name), JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
    },

    async writeStream(icao, name, body, size, contentType) {
      // R2 needs the length up front; FixedLengthStream also rejects a body that doesn't match it.
      const { readable, writable } = new FixedLengthStream(size);
      const piped = body.pipeTo(writable);
      await Promise.all([bucket.put(key(icao, name), readable, { httpMetadata: { contentType } }), piped]);
    },

    async readFile(icao, name) {
      const obj = await bucket.get(key(icao, name));
      return obj && { body: obj.body, size: obj.size };
    },

    async exists(icao, name) {
      return (await bucket.head(key(icao, name))) !== null;
    },

    async remove(icao, name) {
      await bucket.delete(key(icao, name));
    },

    async listAirports() {
      const airports = [];
      let cursor;
      do {
        const page = await bucket.list({ prefix: PREFIX, delimiter: '/', cursor });
        for (const p of page.delimitedPrefixes) {
          const icao = p.slice(PREFIX.length, -1);
          if (ICAO_RE.test(icao)) airports.push(icao);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return airports.sort();
    },
  };
}
