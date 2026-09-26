# Taxi Trace

Type an airport and an ATC taxi clearance; the taxiways light up in order.

```
npm install
npm start          # prints Local and Network URLs, e.g. http://192.168.1.39:5178
npm test
```

The server listens on all interfaces so a tablet on the same Wi-Fi can open the Network URL; `HOST=127.0.0.1 npm start`
keeps it local-only. There is no login, so only run it on a network you trust. On an iPad, Safari → Share →
*Add to Home Screen* opens it fullscreen like an EFB app.

Needs Node 18+. The only dependency is Leaflet. Everything you set up is saved under `data/airports/<ICAO>/`.

**Cloudflare.** The deployed app (https://taxitrace.leogao46369.workers.dev) is a Worker with static assets:
`npm run build` copies `public/` and Leaflet into `dist/` and bakes in the committed `data/airports/` (plus a
`data/manifest.json` index), and `server/worker.js` answers `/api/*` with the same handler as `npm start`
(`server/api.js`). There is no bucket or database — the Worker reads that baked-in copy through the assets
binding, so **the deployment is read-only**: it serves the data as committed.

`data/` is **not** committed: it is only a cache, and the Worker refetches any airport from OpenStreetMap when
it isn't baked in, so leaving it out of git means two machines can never disagree about it and `./update.sh` can
never hit a merge conflict. The cost is that the deployed copy starts with an empty airport list and each first
load takes a few seconds instead of one; type an ICAO and it fetches. If you ever do want an airport baked in
(instant loads, and it shows in the list), commit that one folder deliberately.

Run `./update.sh` to publish: it commits your local work, rebases onto origin and pushes, and Workers Builds
deploys from that push. If it can't sort something out it stops and tells you to ask Claude, without breaking
anything. Editing happens locally with `npm start`, which writes under `data/airports/`; the chart editor, chart
upload and preferred-source toggle all return **405** on the deployed copy. `npm run dev` runs the Worker locally
against the same built `dist/`.

## Using it

1. Type an ICAO (e.g. `YSSY`) and tap **Search** (or press Enter). Switching to a different airport clears the
   clearance and the route drawn for the previous one.
2. Type the clearance in the big box: `INTL5 G C`, `alpha lima hold short 34 left`, `BAY 36 A B C`.
   **Hold short / cross:** `A B C hold short of runway 25 C C2 hold short 16R` draws a red hold bar before 25, carries
   the ribbon on across it (always to the far side, never back the way you came), and stops at the 16R hold bar.
   `cross 25` marks the crossing without a bar. A bare runway between two taxiways the route goes straight over
   (`C 25 C`) is shown as a hold short; the tray has HOLD SHORT and CROSS keys.
   A gate, bay or stand (`gate D5`, `stand 51 left`) is where the route starts. Gate/bay numbers come from
   OpenStreetMap (`aeroway=gate` / `parking_position`) or the Stand type in the chart tracer; tap one on the map
   (zoomed in) or pick it from the tray's BAY tab. The strip shows distance and taxi time at 10 kt (real-world
   maps only; traced charts have no scale).
   The app works out the actual path: each taxiway is trimmed to the stretch between where you join it and
   where you leave it, and drawn as one continuous line with direction chevrons. Esc clears it.
3. **Set start** (then click your gate) trims the first taxiway from that point. The route stops at the hold
   point when the clearance ends with a runway; otherwise **Set end** trims the last taxiway. Until you set them,
   the first/last taxiway is drawn whole and faded. Both markers can be dragged.
   **REFS tray** (left of the map; open by default on touch screens): the airport's own taxiways as buttons.
   Tap a letter to enter it and list its numbered taxiways on the right; tap one (e.g. `A1`) to replace the
   letter. Runway buttons end the route at the hold point; ⌫ removes the last word.
   The **BAY** tab (GATE in North America, STAND elsewhere) picks your start: a range, then the number.
4. A red chip means that ref isn't in the data. An orange dashed stretch (and `⋯` between chips) means the data
   has no real connection there, so the route was inferred — usually a misheard letter or a gap in OSM.

**Settings (⚙).** App theme: Dark, Light, or Auto (follows the device). Taxi ribbon: colour (presets or any custom
colour), width, outline, glow and direction arrows, with a live preview. Saved per device, so the Mac and iPad can
differ. The map's base layer is remembered per theme (Dark tiles for dark, Streets for light by default).

**Sources.** Choose one per airport; the app remembers your choice.

- **OpenStreetMap:** fetched from Overpass the first time (all public mirrors are asked at once; the first answer
  wins, usually under 10 s), then cached so later loads are instant. Use *Info → Re-fetch from OSM* to update.
- **My chart:** upload a chart image (PNG/JPEG/WebP; export PDFs to an image first), then *Edit traces*:
  type a label → Enter → click along the centreline → Enter or double-click. Clicks snap to existing lines
  (white ring) so junctions connect for routing. Click a line to select it and drag its points; right-click a
  point to delete it.

## Layout

```
server.js                  local server: static files + server/api.js (no framework)
server/api.js              JSON API as Request -> Response, shared by server.js and the Worker
server/worker.js           Cloudflare Worker entry (/api/* only; wrangler.jsonc)
server/store.js            file persistence (npm start)
server/static-store.js     read-only persistence (Worker) over the baked-in dist/data/
server/sources/index.js    source registry — every source returns the same Airport shape
server/sources/osm.js      Overpass: aerodrome area → bbox fallback, mirrors raced in parallel, cache
server/sources/trace.js    your traced charts
public/js/refs.js          ref cleaning shared by server and browser
public/js/parser.js        clearance text → ordered refs
public/js/geometry.js      planar projection, segment maths, spatial grid, heap
public/js/graph.js         labelled polylines → network (shared nodes, crossings, T-junctions)
public/js/router.js        refs → path: per-taxiway shortest walks + DP over junction choices
public/js/route.js         glue: parse → route → lat/lng, warnings and hints
public/js/mapview.js       Leaflet renderer (tiles or chart image)
public/js/tracer.js        chart trace editor
public/js/app.js           UI wiring
```

## Adding LittleNavmap later

Create `server/sources/littlenavmap.js` exporting `id`, `label`, `hasData(icao)` and `load(icao)`. Read the MSFS
scenery database (the `taxipath` table has taxiway names and start/end coordinates per airport) and return
`crs: 'geo'` features in the shape documented in `server/sources/index.js`. Then register it there and add a
button to the source switch in `index.html`. The parser, highlighter and map need no changes.
