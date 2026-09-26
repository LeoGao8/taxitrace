// Leaflet renderer. Knows nothing about where features came from: geo
// airports sit on web tiles, image airports on a chart overlay (CRS.Simple).
import { DEFAULTS, WIDTHS, chevronSize } from './settings.js';

const L = window.L;

export const RUNWAY_COLOR = '#ff4d6d';
export const INFERRED_COLOR = '#ff9f1c';

// Airport base layers per app theme (dark sits on inverted tiles, light on normal ones).
const BASE = {
  dark: { apron: ['#3b4456', 0.45], runway: ['#737c8f', 0.75], taxiway: ['#a7b1c2', 0.75] },
  light: { apron: ['#94a3b8', 0.35], runway: ['#475569', 0.7], taxiway: ['#334155', 0.7] },
};
const DEFAULT_BASEMAP = { dark: 'Dark', light: 'Streets' };

const BASEMAPS = {
  // Standard OSM tiles dimmed under a dark overlay (see .tiles-dark) — no API key needed.
  Dark: () =>
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 22, className: 'tiles-dark',
      attribution: '&copy; OpenStreetMap contributors',
    }),
  Satellite: () =>
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 22, attribution: 'Imagery &copy; Esri',
    }),
  Streets: () =>
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 22, attribution: '&copy; OpenStreetMap contributors',
    }),
  None: () => L.layerGroup(),
};

export class MapView {
  constructor(el, { onFeatureClick, onMapClick, onPointMove, onStandClick } = {}) {
    this.el = el;
    this.style = { theme: 'dark', ribbon: DEFAULTS.ribbon };
    this.onStandClick = onStandClick;
    this.onFeatureClick = onFeatureClick;
    this.onMapClick = onMapClick;
    this.onPointMove = onPointMove;
    this.map = null;
    this.airport = null;
    this.route = null;
  }

  setAirport(airport) {
    if (this.map) this.map.remove();
    // Keyboard showing/hiding or rotation resizes the container without a window resize.
    this.resizeObserver ??= new ResizeObserver(() => this.map?.invalidateSize({ debounceMoveend: true }));
    this.resizeObserver.observe(this.el);
    this.airport = airport;
    this.route = null;
    const isGeo = airport.crs === 'geo';

    this.map = L.map(this.el, {
      crs: isGeo ? L.CRS.EPSG3857 : L.CRS.Simple,
      zoomControl: true,
      zoomSnap: isGeo ? 0.5 : 0.25,
      minZoom: isGeo ? 3 : -6,
      maxZoom: isGeo ? 22 : 5,
      preferCanvas: false, // SVG so CSS can dim/restyle paths
      attributionControl: isGeo,
      // Long-press = right-click (e.g. delete a trace point). Leaflet only turns
      // this on for UAs it thinks are mobile, and iPadOS Safari claims to be a Mac.
      tapHold: L.Browser.touchNative,
    });
    for (const [name, z] of [['route', 450], ['routeTop', 460], ['markers', 650], ['routeLabels', 660], ['refLabels', 640]]) {
      this.map.createPane(name).style.zIndex = z;
    }

    this.basemaps = null;
    this.el.classList.toggle('crs-geo', isGeo);
    this.el.classList.toggle('crs-image', !isGeo);
    this.el.classList.remove('route-active');

    if (isGeo) this.addBasemaps();
    else {
      const { url, width, height } = airport.image;
      L.imageOverlay(url, [[0, 0], [height, width]], { className: 'chart-image' }).addTo(this.map);
      this.map.setMaxBounds(L.latLngBounds([[-height, -width], [height * 2, width * 2]]));
    }

    this.baseLayer = this.drawFeatures(airport).addTo(this.map);
    this.refLabels = this.drawRefLabels(airport);
    if (isGeo) this.refLabels.addTo(this.map);
    this.standLayer = this.drawStands(airport).addTo(this.map);
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.chevronLayer = L.layerGroup().addTo(this.map);
    this.pointLayer = L.layerGroup().addTo(this.map);
    this.labelMarkers = [];
    this.pointMarkers = {};

    this.map.on('click', (e) => this.onMapClick?.([e.latlng.lat, e.latlng.lng]));
    this.map.on('zoomend', () => {
      this.updateZoomClass();
      this.drawChevrons();
      this.declutterLabels();
    });
    this.fitAirport(false);
    this.updateZoomClass();
  }

  // style: { theme: 'dark'|'light', ribbon: { color, width, outline, glow, chevrons } }
  setStyle(style) {
    const themeChanged = style.theme !== this.style.theme;
    this.style = style;
    if (!this.map) return;
    if (themeChanged) {
      this.restyleBase();
      if (this.basemaps) this.showBasemap(this.savedBasemap());
    }
    this.setRoute(this.route);
  }

  addBasemaps() {
    this.basemaps = Object.fromEntries(Object.entries(BASEMAPS).map(([name, make]) => [name, make()]));
    this.showBasemap(this.savedBasemap());
    L.control.layers(this.basemaps, null, { position: 'topright' }).addTo(this.map);
    this.map.on('baselayerchange', (e) => {
      this.basemapName = e.name;
      try {
        localStorage.setItem(`basemap:${this.style.theme}`, e.name);
      } catch {}
    });
  }

  // Remembered per theme: Dark tiles for the dark app, Streets for the light one.
  savedBasemap() {
    let name = null;
    try {
      name = localStorage.getItem(`basemap:${this.style.theme}`) ?? (this.style.theme === 'dark' ? localStorage.getItem('basemap') : null);
    } catch {}
    return this.basemaps[name] ? name : DEFAULT_BASEMAP[this.style.theme];
  }

  showBasemap(name) {
    if (this.basemapName === name && this.map.hasLayer(this.basemaps[name])) return;
    for (const layer of Object.values(this.basemaps)) if (this.map.hasLayer(layer)) this.map.removeLayer(layer);
    this.basemaps[name].addTo(this.map).bringToBack?.();
    this.basemapName = name;
  }

  baseStyle(f) {
    const [color, opacity] = BASE[this.style.theme][f.kind === 'apron' ? 'apron' : f.kind === 'runway' ? 'runway' : 'taxiway'];
    if (f.kind === 'apron') return { fillColor: color, fillOpacity: opacity };
    if (f.kind !== 'runway' && !f.refs.length) return { color, opacity: opacity * 0.55 };
    return { color, opacity };
  }

  restyleBase() {
    for (const [layer, f] of this.featureLayers || []) layer.setStyle(this.baseStyle(f));
  }

  drawFeatures(airport) {
    const group = L.layerGroup();
    const order = { apron: 0, runway: 1, taxiway: 2 };
    const features = [...airport.features].sort((a, b) => order[a.kind] - order[b.kind]);
    this.featureLayers = [];

    for (const f of features) {
      let layer;
      const style = this.baseStyle(f);
      if (f.kind === 'apron') {
        layer = L.polygon(f.coords, { className: 'f-apron', stroke: false, ...style, interactive: false });
      } else if (f.kind === 'runway') {
        layer = L.polyline(f.coords, { className: 'f-runway', weight: 12, lineCap: 'butt', ...style });
      } else if (f.refs.length) {
        layer = L.polyline(f.coords, { className: 'f-taxiway', weight: 3, ...style });
      } else {
        layer = L.polyline(f.coords, { className: 'f-taxiway f-noref', weight: 2, dashArray: '4 6', interactive: false, ...style });
      }
      this.featureLayers.push([layer, f]);
      if (f.refs.length) {
        layer.bindTooltip(f.refs.join(' / '), { sticky: true, className: 'ref-tip', direction: 'top' });
        layer.on('click', () => this.onFeatureClick?.(f));
      }
      group.addLayer(layer);
    }
    return group;
  }

  // One faint label per ref, on its longest segment.
  drawRefLabels(airport) {
    const group = L.layerGroup();
    const longest = new Map();
    for (const f of airport.features) {
      if (f.kind === 'apron' || !f.refs.length) continue;
      const key = f.refs.join('/');
      const len = polylineLength(f.coords);
      if (!longest.has(key) || longest.get(key).len < len) longest.set(key, { f, len });
    }
    for (const [key, { f }] of longest) {
      group.addLayer(
        L.marker(midpoint(f.coords), {
          pane: 'refLabels',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: `ref-label ref-${f.kind}`, html: key, iconSize: null }),
        }),
      );
    }
    return group;
  }

  // Gate/bay numbers: tap one to start the clearance there. Hidden when zoomed out.
  drawStands(airport) {
    const group = L.layerGroup();
    for (const s of airport.stands || []) {
      group.addLayer(
        L.marker(s.coords, {
          pane: 'refLabels',
          keyboard: false,
          icon: L.divIcon({ className: 'stand-marker', html: `<div class="stand-label ${s.kind}">${escape(s.ref)}</div>`, iconSize: [0, 0] }),
        }).on('click', () => this.onStandClick?.(s)),
      );
    }
    return group;
  }

  setBaseVisible(visible) {
    if (!this.map) return;
    for (const layer of [this.baseLayer, this.standLayer, this.airport.crs === 'geo' ? this.refLabels : null]) {
      if (!layer) continue;
      if (visible && !this.map.hasLayer(layer)) layer.addTo(this.map);
      if (!visible && this.map.hasLayer(layer)) layer.remove();
    }
  }

  setPicking(kind) {
    this.el.classList.toggle('picking', !!kind);
  }

  // ---------------------------------------------------------------- route

  setRoute(route) {
    if (!this.map) return;
    this.route = route;
    this.routeLayer.clearLayers();
    this.labelMarkers = [];
    const path = route?.path;
    const active = !!path && (path.pieces.length > 0 || path.whole.length > 0);
    this.el.classList.toggle('route-active', active);
    this.fullPath = active ? joinPieces(path.pieces) : [];
    this.drawChevrons();

    // Starting gate/bay from the clearance, drawn even before any taxiway is entered.
    this.el.classList.toggle('stand-start', !!route?.start?.found);
    if (route?.start?.found) {
      this.routeLayer.addLayer(
        L.marker(route.start.stand.coords, {
          pane: 'markers',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: 'point-marker', html: `<div class="pin start fixed">${escape(route.start.label)}</div>`, iconSize: [0, 0] }),
        }),
      );
    }
    if (!active) return;

    const add = (layer) => this.routeLayer.addLayer(layer);
    const lineOpts = { pane: 'route', interactive: false, lineCap: 'round', lineJoin: 'round' };
    const ribbon = this.style.ribbon;
    const width = WIDTHS[ribbon.width];
    const halo = ribbon.outline === 'none' ? null : ribbon.outline === 'light' ? '#fff' : '#000';

    // First/last taxiway we couldn't trim (no start/end): shown whole but faded.
    for (const w of path.whole) {
      const color = w.kind === 'runway' ? RUNWAY_COLOR : ribbon.color;
      const thin = Math.max(3, width - 3);
      for (const coords of w.lines) {
        if (halo) add(L.polyline(coords, { ...lineOpts, color: halo, weight: thin + 6, opacity: 0.55 }));
        add(L.polyline(coords, { ...lineOpts, color, weight: thin, opacity: 0.6, className: 'route-whole' }));
      }
      const longest = w.lines.reduce((b, l) => (polylineLength(l) > polylineLength(b) ? l : b));
      this.addLabel(midpoint(longest), w.ref, 'untrimmed');
    }

    // The route itself: optional glow, one outline, then solid/dashed runs on top.
    if (this.fullPath.length > 1) {
      if (ribbon.glow) add(L.polyline(this.fullPath, { ...lineOpts, color: ribbon.color, weight: width + 18, opacity: 0.28 }));
      if (halo) add(L.polyline(this.fullPath, { ...lineOpts, color: halo, weight: width + 8, opacity: 0.9 }));
      for (const run of runsByInferred(path.pieces)) {
        if (run.inferred) {
          add(L.polyline(run.coords, { ...lineOpts, color: INFERRED_COLOR, weight: width, opacity: 0.35 }));
          add(L.polyline(run.coords, { ...lineOpts, pane: 'routeTop', color: INFERRED_COLOR, weight: width, dashArray: `${width + 3} ${width + 5}`, lineCap: 'butt' }));
        } else {
          add(L.polyline(run.coords, { ...lineOpts, color: ribbon.color, weight: width }));
        }
      }
    }

    // Where the route changes taxiway.
    for (const t of path.turns) {
      // Straight over a runway, or the runway the route ends at: the hold/cross label covers it.
      if (t.silent || t.hold) continue;
      add(L.circleMarker(t.point, { pane: 'routeTop', interactive: false, radius: 5, color: '#000', weight: 3, fillColor: '#fff', fillOpacity: 1 }));
      this.addLabel(t.point, t.to, t.inferred ? 'inferred' : '');
    }

    // Hold short: red bar across the route, back from the runway. Cross: label only.
    for (const h of path.holds) {
      if (h.kind === 'hold') add(this.holdBar(h.point, h.towards));
      this.addLabel(h.point, `${h.kind === 'hold' ? 'HOLD SHORT' : 'CROSS'} ${h.ref}`, h.kind);
    }

    if (path.start) {
      add(L.polyline([path.start.clicked, path.start.point], { pane: 'route', interactive: false, color: '#fff', weight: 2, dashArray: '4 5', opacity: 0.8 }));
      add(L.circleMarker(path.start.point, { pane: 'routeTop', interactive: false, radius: 6, color: '#000', weight: 3, fillColor: '#22c55e', fillOpacity: 1 }));
      this.addLabel(path.start.point, path.start.ref, '');
    }
    if (path.end && !path.end.hold) {
      add(L.polyline([path.end.point, path.end.clicked], { pane: 'route', interactive: false, color: '#fff', weight: 2, dashArray: '4 5', opacity: 0.8 }));
      add(L.circleMarker(path.end.point, { pane: 'routeTop', interactive: false, radius: 6, color: '#000', weight: 3, fillColor: '#fff', fillOpacity: 1 }));
    }

    this.declutterLabels();
  }

  addLabel(pos, text, cls) {
    const marker = L.marker(pos, {
      pane: 'routeLabels',
      interactive: false,
      keyboard: false,
      icon: L.divIcon({ className: 'turn-marker', html: `<div class="turn-label ${cls}">${escape(text)}</div>`, iconSize: [0, 0] }),
    });
    this.labelMarkers.push(marker);
    this.routeLayer.addLayer(marker);
  }

  // A red bar across the route at the hold point, perpendicular to travel (towards the runway).
  holdBar(point, towards) {
    let angle = 0;
    const a = this.map.latLngToLayerPoint(point);
    const b = this.map.latLngToLayerPoint(towards);
    if (a.distanceTo(b) > 0) angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90;
    return L.marker(point, {
      pane: 'markers',
      interactive: false,
      keyboard: false,
      icon: L.divIcon({ className: 'hold-marker', html: `<div class="hold-bar" style="transform: translate(-50%, -50%) rotate(${angle}deg)"></div>`, iconSize: [0, 0] }),
    });
  }

  // Direction chevrons every ~90 screen px along the route.
  drawChevrons() {
    if (!this.chevronLayer) return;
    this.chevronLayer.clearLayers();
    const coords = this.fullPath || [];
    if (coords.length < 2 || !this.style.ribbon.chevrons) return;
    const size = chevronSize(this.style.ribbon.width);
    const pts = coords.map((c) => this.map.latLngToLayerPoint(c));
    const SPACING = 90;
    let next = 45;
    let acc = 0;
    let count = 0;
    for (let i = 1; i < pts.length && count < 400; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = a.distanceTo(b);
      while (seg > 0 && acc + seg >= next && count < 400) {
        const t = (next - acc) / seg;
        const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const pos = this.map.layerPointToLatLng(L.point(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
        this.chevronLayer.addLayer(
          L.marker(pos, {
            pane: 'routeTop',
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'chevron-marker',
              html: `<svg class="chevron" style="transform: translate(-50%, -50%) rotate(${angle}deg)" viewBox="0 0 12 12" width="${size}" height="${size}"><path d="M3 1.5 L8.5 6 L3 10.5" /></svg>`,
              iconSize: [0, 0],
            }),
          }),
        );
        next += SPACING;
        count++;
      }
      acc += seg;
    }
  }

  // Keep labels from sitting on top of each other.
  declutterLabels() {
    const R = 30;
    const offsets = [[0, 0]];
    for (const ring of [1, 2, 3]) {
      for (let a = 0; a < 8; a++) offsets.push([Math.round(Math.cos((a * Math.PI) / 4) * R * ring), Math.round(Math.sin((a * Math.PI) / 4) * R * ring)]);
    }
    const placed = [];
    for (const marker of this.labelMarkers) {
      const el = marker.getElement()?.firstElementChild;
      if (!el) continue;
      const p = this.map.latLngToLayerPoint(marker.getLatLng());
      const [dx, dy] = offsets.find(([ox, oy]) => placed.every((q) => Math.hypot(p.x + ox - q.x, p.y + oy - q.y) >= R)) || [0, 0];
      el.style.translate = `${dx}px ${dy}px`;
      placed.push({ x: p.x + dx, y: p.y + dy });
    }
  }

  // ------------------------------------------------------ start/end points

  setPoints(points) {
    if (!this.map) return;
    for (const kind of ['start', 'end']) {
      const pos = points[kind];
      let marker = this.pointMarkers[kind];
      if (!pos) {
        if (marker) this.pointLayer.removeLayer(marker);
        delete this.pointMarkers[kind];
        continue;
      }
      if (!marker) {
        marker = L.marker(pos, {
          pane: 'markers',
          draggable: true,
          keyboard: false,
          icon: L.divIcon({ className: 'point-marker', html: `<div class="pin ${kind}">${kind === 'start' ? 'START' : 'END'}</div>`, iconSize: [0, 0] }),
        });
        let frame = 0;
        marker.on('drag', () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => this.onPointMove?.(kind, toArr(marker.getLatLng()), false));
        });
        marker.on('dragend', () => this.onPointMove?.(kind, toArr(marker.getLatLng()), true));
        this.pointMarkers[kind] = marker.addTo(this.pointLayer);
      } else {
        marker.setLatLng(pos);
      }
    }
  }

  // ----------------------------------------------------------------- view

  fitRoute(animate = true) {
    const path = this.route?.path;
    const coords = path
      ? [...path.pieces.flatMap((p) => p.coords), ...path.whole.flatMap((w) => w.lines.flat()), ...(path.start ? [path.start.clicked] : []), ...(path.end?.clicked ? [path.end.clicked] : [])]
      : [];
    if (!coords.length && this.route?.start?.found) {
      return this.map.setView(this.route.start.stand.coords, this.airport.crs === 'geo' ? 17 : Math.max(this.map.getZoom(), 0), { animate });
    }
    if (!coords.length) return this.fitAirport(animate);
    this.map.fitBounds(L.latLngBounds(coords), { padding: [60, 60], maxZoom: this.airport.crs === 'geo' ? 18 : 2, animate });
  }

  fitAirport(animate = true) {
    if (!this.map) return;
    const b = this.airport.bounds;
    if (b) this.map.fitBounds(b, { padding: [20, 20], animate });
    else this.map.setView([0, 0], 2);
  }

  updateZoomClass() {
    const z = this.map.getZoom();
    this.el.classList.toggle('zoom-far', this.airport.crs === 'geo' && z < 15);
    this.el.classList.toggle('zoom-mid', this.airport.crs === 'geo' && z < 16);
  }
}

function joinPieces(pieces) {
  const out = [];
  for (const p of pieces) {
    for (const c of p.coords) {
      const last = out[out.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
    }
  }
  return out;
}

// Consecutive pieces with the same inferred flag, joined so solid stretches
// render as single polylines with clean joins.
function runsByInferred(pieces) {
  const runs = [];
  for (const p of pieces) {
    const last = runs[runs.length - 1];
    if (last && last.inferred === p.inferred) last.coords.push(...p.coords.slice(1));
    else runs.push({ inferred: p.inferred, coords: [...p.coords] });
  }
  return runs.filter((r) => r.coords.length > 1);
}

const toArr = (ll) => [ll.lat, ll.lng];
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function polylineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  return len;
}

export function midpoint(coords) {
  const half = polylineLength(coords) / 2;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const [y0, x0] = coords[i - 1];
    const [y1, x1] = coords[i];
    const seg = Math.hypot(y1 - y0, x1 - x0);
    if (acc + seg >= half && seg > 0) {
      const t = (half - acc) / seg;
      return [y0 + t * (y1 - y0), x0 + t * (x1 - x0)];
    }
    acc += seg;
  }
  return coords[coords.length - 1];
}
