import { api } from './api.js';
import { indexAirport, planRoute, TAXI_SPEED_KT } from './route.js';
import { buildGraph } from './graph.js';
import { MapView, RUNWAY_COLOR } from './mapview.js';
import { SettingsPanel, normaliseSettings, resolveTheme, inkFor } from './settings.js';
import { Tracer, escapeHtml } from './tracer.js';
import { RefTray, withStand } from './tray.js';
import { standWord, splitTraced } from './stands.js';

const $ = (id) => document.getElementById(id);
const els = {
  airportForm: $('airport-form'),
  icao: $('icao'),
  airportList: $('airport-list'),
  sourceSeg: $('source-seg'),
  clearance: $('clearance'),
  clearClearance: $('clear-clearance'),
  strip: $('route-strip'),
  pickStart: $('pick-start'),
  pickEnd: $('pick-end'),
  clearStart: $('clear-start'),
  clearEnd: $('clear-end'),
  overlay: $('overlay'),
  overlayMsg: $('overlay-msg'),
  overlayActions: $('overlay-actions'),
  infoPanel: $('info-panel'),
  tracePanel: $('trace-panel'),
  editBtn: $('edit-btn'),
  panelBtn: $('panel-btn'),
  settingsBtn: $('settings-btn'),
  settingsPanel: $('settings-panel'),
  fitBtn: $('fit-btn'),
  autofit: $('autofit'),
  chartFile: $('chart-file'),
  map: $('map'),
  tray: $('tray'),
};

// Touch-first device (iPad): no hover, no precise pointer, usually no hardware Esc.
const touch = matchMedia('(pointer: coarse)');

const state = {
  icao: null,
  summary: null, // { preferredSource, available: { osm, trace } }
  source: null,
  airport: null,
  index: null,
  graph: null,
  route: null,
  points: {}, // { start?: [lat,lng], end?: [lat,lng] } — clicked on the map
  picking: null, // 'start' | 'end' while waiting for a map click
  loadToken: 0,
};

const view = new MapView(els.map, {
  onFeatureClick: (f) => {
    if (!state.picking) appendToClearance(f.refs[0]);
  },
  onMapClick: (latlng) => {
    if (!state.picking || tracer.active) return;
    setPoint(state.picking, latlng);
    setPicking(null);
  },
  onPointMove: (kind, latlng, done) => setPoint(kind, latlng, { save: done }),
  onStandClick: (stand) => {
    if (tracer.active || els.clearance.disabled) return;
    if (state.picking) {
      setPoint(state.picking, stand.coords);
      return setPicking(null);
    }
    const word = stand.kind === 'gate' ? 'GATE' : standWord(state.icao);
    els.clearance.value = withStand(els.clearance.value, word, stand.ref);
    updateRoute();
  },
});
const tracer = new Tracer(view, els.tracePanel, { onChange: queueTraceSave });

// ------------------------------------------------------------ settings

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// Keypad tray: open by default on the iPad, tucked away on the Mac.
const tray = new RefTray(els.tray, {
  getText: () => els.clearance.value,
  setText: (text) => {
    if (els.clearance.disabled || tracer.active) return;
    els.clearance.value = text;
    updateRoute();
  },
  open: prefs.get('trayOpen', touch.matches),
  onToggle: (open) => prefs.set('trayOpen', open),
});
tray.setAirport(null);

// ------------------------------------------------------------ appearance

let settings = normaliseSettings(prefs.get('settings', null));
const prefersLight = matchMedia('(prefers-color-scheme: light)');

function applySettings() {
  const theme = resolveTheme(settings.theme, prefersLight.matches);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty('--route', settings.ribbon.color);
  root.style.setProperty('--route-ink', inkFor(settings.ribbon.color));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#131922');
  view.setStyle({ theme, ribbon: settings.ribbon });
  if (state.route) renderStrip(state.route);
}
applySettings();
prefersLight.addEventListener('change', () => settings.theme === 'auto' && applySettings());

const settingsPanel = new SettingsPanel(els.settingsPanel, {
  settings,
  onChange: (next) => {
    settings = next;
    prefs.set('settings', settings);
    applySettings();
  },
});

// Settings and Info share the side of the map; one at a time.
function showSidePanel(which) {
  if (tracer.active) stopEditing();
  const showInfo = which === 'info' && els.infoPanel.hidden;
  const showSettings = which === 'settings' && els.settingsPanel.hidden;
  els.infoPanel.hidden = !showInfo;
  els.settingsPanel.hidden = !showSettings;
  els.panelBtn.classList.toggle('on', showInfo);
  els.settingsBtn.classList.toggle('on', showSettings);
  if (showSettings) settingsPanel.placePreviewChevrons();
  prefs.set('infoPanel', showInfo);
  view.map?.invalidateSize();
}
els.settingsBtn.addEventListener('click', () => showSidePanel('settings'));

els.autofit.checked = prefs.get('autofit', true);
els.autofit.addEventListener('change', () => prefs.set('autofit', els.autofit.checked));

// ------------------------------------------------------------- loading

async function refreshAirportList() {
  try {
    const airports = await api.listAirports();
    els.airportList.innerHTML = airports.map((a) => `<option value="${a.icao}">`).join('');
  } catch {}
}

async function loadAirport(rawIcao) {
  const icao = rawIcao.trim().toUpperCase();
  if (!icao) return;
  stopEditing({ rebuild: false });
  if (icao !== state.icao) clearRoute(); // the old airport's clearance means nothing here
  state.icao = icao;
  els.icao.value = icao;
  prefs.set('lastIcao', icao);
  const token = ++state.loadToken;

  try {
    state.summary = await api.airport(icao);
  } catch (err) {
    return showOverlay(escapeHtml(err.message), [['Try again', () => loadAirport(icao)]]);
  }
  if (token !== state.loadToken) return;
  const { preferredSource, available } = state.summary;
  await setSource(preferredSource || (available.trace ? 'trace' : 'osm'));
}

async function setSource(source, { persist = false, refresh = false } = {}) {
  stopEditing({ rebuild: false });
  state.source = source;
  renderSourceSeg();
  const icao = state.icao;
  const token = ++state.loadToken;

  if (persist) {
    api.setPreferredSource(icao, source).then((s) => (state.summary = s)).catch(() => {});
  }

  if (source === 'trace' && !state.summary.available.trace) {
    clearAirport();
    return showOverlay(
      `<h2>${icao} · My chart</h2><p>Upload a chart image (PNG/JPEG/WebP) and trace each taxiway once. Traces are saved locally.</p>
       <p class="muted">Got a PDF? Export or screenshot the ground chart page as an image first.</p>`,
      [['Upload chart image', chooseChart, 'primary'], ['Use OpenStreetMap instead', () => setSource('osm', { persist: true })]],
    );
  }

  const firstFetch = source === 'osm' && (refresh || !state.summary.available.osm);
  showOverlay(
    source === 'osm'
      ? `<div class="spinner"></div><p>${refresh ? 'Re-fetching' : 'Loading'} ${icao} taxiways from OpenStreetMap…</p>${firstFetch ? '<p class="muted">First download, usually under 10 s. Asking all servers at once… <span class="elapsed"></span></p>' : ''}`
      : `<div class="spinner"></div><p>Loading your ${icao} chart…</p>`,
  );
  const t0 = Date.now();
  const tick = setInterval(() => {
    const el = els.overlayMsg.querySelector('.elapsed');
    if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
  }, 1000);
  try {
    const airport = await api.loadSource(icao, source, { refresh });
    if (token !== state.loadToken) return;
    if (source === 'osm') state.summary.available.osm = true;
    hideOverlay();
    showAirport(airport);
    refreshAirportList();
  } catch (err) {
    if (token !== state.loadToken) return;
    clearAirport();
    const actions = [['Retry', () => setSource(source, { refresh })]];
    if (source === 'osm') actions.push(['Trace my own chart instead', () => setSource('trace', { persist: true }), 'primary']);
    showOverlay(`<h2>Couldn't load ${icao}</h2><pre class="error">${escapeHtml(err.message)}</pre>`, actions);
  } finally {
    clearInterval(tick);
  }
}

function showAirport(airport) {
  state.airport = airport;
  state.index = indexAirport(airport);
  state.graph = buildGraph(airport);
  state.points = prefs.get(pointsKey(), {});
  setPicking(null);
  view.setAirport(airport);
  els.clearance.disabled = false;
  els.editBtn.hidden = airport.crs !== 'image';
  renderInfoPanel();
  tray.setAirport(state.index, state.icao);
  updateRoute({ fit: true });
  els.clearance.focus();
}

function clearAirport() {
  state.airport = null;
  state.index = null;
  state.graph = null;
  setPicking(null);
  els.clearance.disabled = true;
  els.editBtn.hidden = true;
  els.strip.innerHTML = '';
  renderInfoPanel();
  tray.setAirport(null);
}

// --------------------------------------------------------------- route

let fitTimer;
let lastFitKey = '';

function updateRoute({ fit = false } = {}) {
  els.clearClearance.hidden = !touch.matches || !els.clearance.value;
  if (!state.airport) return;
  const route = planRoute(state.airport, state.index, state.graph, els.clearance.value, state.points);
  state.route = route;
  view.setRoute(route);
  // A gate/bay in the clearance replaces the draggable start pin.
  view.setPoints(route.start?.found ? { ...state.points, start: null } : state.points);
  renderStrip(route);
  renderPointButtons();
  tray.sync(route.start);

  const key = [route.start?.found ? route.start.label : '', ...route.legs.map((l) => l.ref)].join(' ').trim();
  clearTimeout(fitTimer);
  if (fit) {
    lastFitKey = key;
    key ? view.fitRoute(false) : view.fitAirport(false);
  } else if (els.autofit.checked && key !== lastFitKey) {
    fitTimer = setTimeout(() => {
      lastFitKey = key;
      key ? view.fitRoute() : view.fitAirport();
    }, 500);
  }
}

function renderStrip(route) {
  if (!route.steps.length && !route.unknown.length && !route.start) {
    els.strip.innerHTML = '';
    return;
  }

  const start = route.start
    ? `<span class="chip stand${route.start.found ? '' : ' missing'}" title="${escapeHtml(route.start.found ? `Starting at ${route.start.label}` : `${route.start.label} not found in data`)}">${escapeHtml(route.start.label)}${route.start.found ? '' : '<small>not found</small>'}</span>${route.steps.length ? '<span class="arrow">›</span>' : ''}`
    : '';
  const holdAt = new Map((route.path?.holds || []).map((h) => [h.stepN, h.kind]));
  const chips = route.steps
    .map((s, i) => {
      const action = holdAt.get(s.n);
      const title = s.found ? `${s.ref}${s.input.toUpperCase() !== s.ref ? ` (“${s.input}”)` : ''}` : `${s.ref} not found in data`;
      const color = s.kind === 'runway' ? RUNWAY_COLOR : settings.ribbon.color;
      const arrow = i === 0 ? '' : s.inferredBefore ? '<span class="arrow inferred" title="No junction in the data — connection inferred">⋯</span>' : '<span class="arrow">›</span>';
      return `${arrow}<span class="chip ${s.found ? s.kind : 'missing'}${action ? ` ${action}` : ''}" style="${s.found ? `--c:${color};--c-ink:${inkFor(color)}` : ''}" title="${escapeHtml(title)}">
        <b>${s.n}</b>${action ? `<small>${action === 'hold' ? 'hold short' : 'cross'}</small>` : ''}${escapeHtml(s.ref)}${s.found ? '' : '<small>not found</small>'}</span>`;
    })
    .join('');

  const path = route.path;
  const more = path?.whole.length ? '+' : '';
  const length = path && path.total > 0
    ? `<span class="route-length">${formatLength(path.total, path.unit)}${more}${path.seconds != null ? ` · <b title="At ${TAXI_SPEED_KT} kt${more ? '. Whole first/last taxiway not counted: set a start/end to include it' : ''}">${formatDuration(path.seconds)}${more}</b> <span class="muted">@ ${TAXI_SPEED_KT} kt</span>` : ''}</span>`
    : '';

  const notes = route.warnings.map((w) => `<li class="${w.level}">${escapeHtml(w.text)}</li>`);
  if (route.unknown.length) notes.push(`<li class="warn">Didn't understand: ${route.unknown.map((u) => `<code>${escapeHtml(u)}</code>`).join(' ')}</li>`);
  if (route.hold && state.points.end) notes.push(`<li class="hint">Route stops at the hold point for ${escapeHtml(path.end.hold)}; your end point is ignored.</li>`);
  for (const h of route.hints) notes.push(`<li class="hint">${escapeHtml(h)}</li>`);

  els.strip.innerHTML = `<div class="chips">${start}${chips}${length}</div>${notes.length ? `<ul class="warnings">${notes.join('')}</ul>` : ''}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
}

function formatLength(len, unit) {
  if (unit !== 'm') return `${Math.round(len)} px`;
  return len >= 1000 ? `${(len / 1000).toFixed(2)} km` : `${Math.round(len)} m`;
}

// ------------------------------------------------------ start/end points

function pointsKey() {
  return `points:${state.icao}:${state.airport?.source}`;
}

function setPoint(kind, latlng, { save = true } = {}) {
  if (latlng) state.points = { ...state.points, [kind]: latlng };
  else {
    const { [kind]: _, ...rest } = state.points;
    state.points = rest;
  }
  if (save) prefs.set(pointsKey(), state.points);
  updateRoute();
}

function setPicking(kind) {
  state.picking = kind;
  view.setPicking(kind);
  renderPointButtons();
}

function renderPointButtons() {
  for (const kind of ['start', 'end']) {
    const btn = kind === 'start' ? els.pickStart : els.pickEnd;
    const clear = kind === 'start' ? els.clearStart : els.clearEnd;
    const label = kind === 'start' ? 'Start' : 'End';
    btn.disabled = !state.airport;
    btn.classList.toggle('on', state.picking === kind);
    btn.classList.toggle('set', !!state.points[kind]);
    btn.textContent = state.picking === kind ? `Click the map…` : state.points[kind] ? `${label} ✓` : `Set ${label.toLowerCase()}`;
    clear.hidden = !state.points[kind];
  }
}

for (const kind of ['start', 'end']) {
  (kind === 'start' ? els.pickStart : els.pickEnd).addEventListener('click', () => setPicking(state.picking === kind ? null : kind));
  (kind === 'start' ? els.clearStart : els.clearEnd).addEventListener('click', () => setPoint(kind, null));
}

function appendToClearance(ref) {
  if (!ref || tracer.active) return;
  const v = els.clearance.value.trimEnd();
  els.clearance.value = v ? `${v} ${ref}` : ref;
  updateRoute();
  // On the iPad, focusing would pop the keyboard over the map on every tap.
  if (!touch.matches) els.clearance.focus();
}

els.clearance.addEventListener('input', () => updateRoute());
els.clearance.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && touch.matches) els.clearance.blur(); // "Done" dismisses the keyboard
});
els.clearClearance.addEventListener('click', () => {
  els.clearance.value = '';
  updateRoute();
});

// ---------------------------------------------------------- info panel

function renderInfoPanel() {
  const a = state.airport;
  if (!a) {
    els.infoPanel.innerHTML = state.icao ? `<h3>${state.icao}</h3><p class="muted">No data loaded.</p>` : '';
    return;
  }
  const taxiways = state.index.refs.filter((r) => state.index.byRef.get(r).some((f) => f.kind === 'taxiway'));
  const runways = state.index.refs.filter((r) => !taxiways.includes(r));
  const refButtons = (refs, cls) => refs.map((r) => `<button class="ref ${cls}" data-ref="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('');

  els.infoPanel.innerHTML = `
    <h3>${escapeHtml(a.name)} <span class="muted">${a.icao}</span></h3>
    <p class="muted">${a.source === 'osm' ? `OpenStreetMap · cached ${new Date(a.fetchedAt).toLocaleString()}` : 'Your traced chart'}</p>
    ${a.notes.length ? `<ul class="notes">${a.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    <div class="panel-actions">
      ${a.source === 'osm' ? '<button data-action="refresh">Re-fetch from OSM</button>' : '<button data-action="chart">Replace chart image</button>'}
      <button data-action="fit-airport">Show whole airport</button>
    </div>
    <h4>Taxiways (${taxiways.length}) <span class="muted">click to add</span></h4>
    <div class="refs">${refButtons(taxiways, 'taxiway') || '<span class="muted">none</span>'}</div>
    <h4>Runways</h4>
    <div class="refs">${refButtons(runways, 'runway') || '<span class="muted">none</span>'}</div>`;
}

els.infoPanel.addEventListener('click', (e) => {
  const ref = e.target.closest('[data-ref]')?.dataset.ref;
  if (ref) return appendToClearance(ref);
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'refresh') setSource('osm', { refresh: true });
  if (action === 'chart') chooseChart();
  if (action === 'fit-airport') view.fitAirport();
});

els.panelBtn.addEventListener('click', () => showSidePanel('info'));
els.infoPanel.hidden = !prefs.get('infoPanel', false);
els.panelBtn.classList.toggle('on', !els.infoPanel.hidden);

// --------------------------------------------------------------- tracing

let infoWasOpen = false;

function startEditing() {
  if (!state.airport || state.airport.crs !== 'image') return;
  infoWasOpen = !els.infoPanel.hidden;
  els.infoPanel.hidden = true;
  els.settingsPanel.hidden = true;
  els.settingsBtn.classList.remove('on');
  els.clearance.value = '';
  updateRoute();
  tracer.start(state.airport);
  els.tray.hidden = true;
  els.editBtn.classList.add('on');
  els.editBtn.textContent = 'Done tracing';
  view.map.invalidateSize();
}

function stopEditing({ rebuild = true } = {}) {
  if (!tracer.active) return;
  tracer.stop();
  els.tray.hidden = false;
  els.editBtn.classList.remove('on');
  els.editBtn.textContent = 'Edit traces';
  els.infoPanel.hidden = !infoWasOpen;
  flushTraceSave();
  if (rebuild && state.airport) {
    // Rebuild the highlighter's view from the edited features.
    showAirport({ ...state.airport, ...splitTraced(tracer.features) });
  }
}

els.editBtn.addEventListener('click', () => (tracer.active ? stopEditing() : startEditing()));

let saveTimer;
let pendingFeatures = null;

function queueTraceSave(features) {
  pendingFeatures = { icao: state.icao, features };
  Object.assign(state.airport, splitTraced(features));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushTraceSave, 600);
}

async function flushTraceSave() {
  clearTimeout(saveTimer);
  if (!pendingFeatures) return;
  const { icao, features } = pendingFeatures;
  pendingFeatures = null;
  try {
    await api.saveTrace(icao, features);
  } catch (err) {
    tracer.flash(`Save failed: ${err.message}`);
  }
}

window.addEventListener('pagehide', () => {
  if (!pendingFeatures) return;
  // keepalive lets the save finish even though the page is going away.
  fetch(`/api/airports/${pendingFeatures.icao}/sources/trace`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ features: pendingFeatures.features }),
  });
});

// ---------------------------------------------------------- chart upload

function chooseChart() {
  if (!state.icao) return;
  els.chartFile.value = '';
  els.chartFile.click();
}

els.chartFile.addEventListener('change', async () => {
  const file = els.chartFile.files[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    return showOverlay(`<p>That's a ${escapeHtml(file.type || 'unknown')} file. Please export the chart as PNG or JPEG.</p>`, [['OK', hideOverlay]]);
  }
  showOverlay('<div class="spinner"></div><p>Uploading chart…</p>');
  try {
    const { width, height } = await imageSize(file);
    const hadTraces = state.summary.available.trace;
    const airport = await api.uploadChart(state.icao, file, width, height);
    state.summary.available.trace = true;
    state.source = 'trace';
    renderSourceSeg();
    await api.setPreferredSource(state.icao, 'trace').catch(() => {});
    hideOverlay();
    showAirport(airport);
    refreshAirportList();
    if (!hadTraces || !airport.features.length) startEditing();
  } catch (err) {
    showOverlay(`<p>Upload failed:</p><pre class="error">${escapeHtml(err.message)}</pre>`, [['OK', hideOverlay]]);
  }
});

function imageSize(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}

// ------------------------------------------------------------------- UI

function renderSourceSeg() {
  for (const btn of els.sourceSeg.querySelectorAll('button')) {
    const on = btn.dataset.source === state.source;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', on);
  }
}

els.sourceSeg.addEventListener('click', (e) => {
  const source = e.target.closest('button')?.dataset.source;
  if (source && state.icao && source !== state.source) setSource(source, { persist: true });
});

function showOverlay(html, actions = []) {
  els.overlayMsg.innerHTML = html;
  els.overlayActions.innerHTML = '';
  for (const [label, fn, cls] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    els.overlayActions.appendChild(b);
  }
  els.overlay.hidden = false;
}

function hideOverlay() {
  els.overlay.hidden = true;
}

// Wipe the clearance and everything drawn from it.
function clearRoute() {
  els.clearance.value = '';
  els.clearClearance.hidden = true;
  state.route = null;
  els.strip.innerHTML = '';
  view.setRoute(null);
  view.setPoints({});
  tray.sync(null);
}

els.airportForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (touch.matches) els.icao.blur(); // close the iPad keyboard so the map shows
  loadAirport(els.icao.value);
});

els.fitBtn.addEventListener('click', () => view.map && view.fitRoute());

document.addEventListener('keydown', (e) => {
  if (tracer.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (tracer.active) return;
  const inField = e.target.closest('input, select, textarea');

  if (e.key === 'Escape') {
    if (e.target === els.icao) return els.clearance.focus();
    if (state.picking) return setPicking(null);
    e.preventDefault();
    els.clearance.value = '';
    updateRoute();
    if (!els.clearance.disabled) els.clearance.focus();
    return;
  }
  if (inField || e.metaKey || e.ctrlKey || e.altKey || tracer.active) return;

  if (e.key.length === 1 && /[\w ]/.test(e.key) && !els.clearance.disabled) {
    // Start typing anywhere and it goes into the clearance box.
    els.clearance.focus();
  }
});

// ---------------------------------------------------------------- iPad

// Size the layout to the part of the screen above the on-screen keyboard, so
// the map shrinks instead of iOS sliding the whole page (and the clearance box)
// up under the status bar. Ignored while pinch-zoomed on a desktop browser.
const vv = window.visualViewport;
if (vv) {
  const fitViewport = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return;
    document.body.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  fitViewport();
}
document.addEventListener('focusout', () => setTimeout(() => window.scrollTo(0, 0), 50));
// Safari page-zoom gesture; the map handles its own pinch via touch events.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ----------------------------------------------------------------- boot

refreshAirportList();
renderPointButtons();
const last = new URLSearchParams(location.search).get('icao') || prefs.get('lastIcao', null);
if (last) loadAirport(last);
else {
  showOverlay('<h2>Taxi Trace</h2><p>Enter an airport ICAO (e.g. YSSY) above and press Enter.</p>');
  els.icao.focus();
}
// local edit on machine A
