// Trace editor for "My chart" airports. Produces the same feature objects as
// any other source; the app saves them and feeds them back to the highlighter.
import { splitRefs } from './refs.js';
import { midpoint } from './mapview.js';

const L = window.L;

const HELP = `Type a label (A, B4, 16R/34L) and press <kbd>Enter</kbd>, then click along the
centreline. <kbd>Enter</kbd> or double-click finishes, <kbd>Backspace</kbd> removes the last
point, <kbd>Esc</kbd> cancels. Clicks snap to existing lines (white ring) so junctions connect for routing.
Click a line to select it, then drag its points; right-click a point to delete it.
For gates/bays choose <b>Stand</b>, type its number (36) and click once where it is.`;

export class Tracer {
  constructor(mapView, panelEl, { onChange }) {
    this.view = mapView;
    this.panel = panelEl;
    this.onChange = onChange;
    this.active = false;
    this.features = [];
    this.drawing = null; // { label, kind, points: [] }
    this.selectedId = null;
    this.renderPanelShell();
  }

  get map() {
    return this.view.map;
  }

  start(airport) {
    this.active = true;
    this.features = [
      ...airport.features.map((f) => ({ ...f, coords: f.coords.map((c) => [...c]) })),
      // Stands edit as one-point features; splitTraced() separates them again.
      ...(airport.stands || []).map((s) => ({ id: s.id, kind: 'stand', label: s.ref, refs: [], coords: [[...s.coords]] })),
    ];
    this.drawing = null;
    this.selectedId = null;
    this.view.setBaseVisible(false);
    this.view.el.classList.add('tracing');
    this.layer = L.layerGroup().addTo(this.map);
    this.editLayer = L.layerGroup().addTo(this.map);
    this.map.doubleClickZoom.disable();
    this.map.on('click', this.handleMapClick, this);
    this.map.on('dblclick', this.handleDblClick, this);
    this.map.on('mousemove', this.handleMouseMove, this);
    this.panel.hidden = false;
    this.redraw();
    this.renderPanel();
    this.labelInput.focus();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.drawing = null;
    this.selectedId = null;
    if (this.map) {
      this.map.off('click', this.handleMapClick, this);
      this.map.off('dblclick', this.handleDblClick, this);
      this.map.off('mousemove', this.handleMouseMove, this);
      this.map.doubleClickZoom.enable();
      this.layer.remove();
      this.editLayer.remove();
    }
    this.view.el.classList.remove('tracing', 'drawing');
    this.view.setBaseVisible(true);
    this.panel.hidden = true;
  }

  // ------------------------------------------------------------ actions

  beginLine() {
    const label = this.labelInput.value.trim().toUpperCase();
    if (!label) {
      this.flash('Type the taxiway label first.');
      this.labelInput.focus();
      return;
    }
    this.selectedId = null;
    this.drawing = { label, kind: this.kindSelect.value, points: [] };
    this.labelInput.blur();
    this.view.el.classList.add('drawing');
    if (this.drawing.kind === 'stand') this.flash(`Click where ${label} is.`, true);
    this.redraw();
    this.renderPanel();
  }

  finishLine() {
    const d = this.drawing;
    if (!d) return;
    const isStand = d.kind === 'stand';
    const points = isStand ? d.points.slice(-1) : dedupe(d.points);
    if (points.length < (isStand ? 1 : 2)) {
      this.flash('A line needs at least two points — keep clicking, or Esc to cancel.');
      return;
    }
    const feature = { id: newId(), kind: d.kind, label: d.label, refs: isStand ? [] : splitRefs(d.label), coords: points };
    this.features.push(feature);
    this.drawing = null;
    this.view.el.classList.remove('drawing');
    this.labelInput.value = '';
    this.emit();
    this.redraw();
    this.renderPanel();
    this.flash(`Saved ${feature.label}. Type the next label.`);
    this.labelInput.focus();
  }

  cancelLine() {
    this.drawing = null;
    this.view.el.classList.remove('drawing');
    this.redraw();
    this.renderPanel();
    this.labelInput.focus();
  }

  select(id) {
    this.selectedId = id;
    this.redraw();
    this.renderPanel();
  }

  updateSelected(changes) {
    const f = this.selected;
    if (!f) return;
    Object.assign(f, changes);
    f.refs = f.kind === 'stand' ? [] : splitRefs(f.label);
    this.emit();
    this.redraw();
    this.renderList();
  }

  deleteSelected() {
    this.features = this.features.filter((f) => f.id !== this.selectedId);
    this.selectedId = null;
    this.emit();
    this.redraw();
    this.renderPanel();
  }

  get selected() {
    return this.features.find((f) => f.id === this.selectedId) || null;
  }

  // Returns true if the key was handled by the editor.
  handleKey(e) {
    if (!this.active) return false;
    const inField = e.target.closest?.('input, select, textarea');

    if (e.key === 'Escape') {
      if (this.drawing) this.cancelLine();
      else if (this.selectedId) this.select(null);
      else return false;
      return true;
    }
    if (e.key === 'Enter') {
      if (this.drawing) this.finishLine();
      else if (e.target === this.labelInput) this.beginLine();
      else return false;
      return true;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !inField) {
      if (this.drawing) {
        this.drawing.points.pop();
        this.redraw();
        return true;
      }
      if (this.selectedId) {
        this.deleteSelected();
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------- map events

  handleMapClick(e) {
    if (this.drawing?.kind === 'stand') {
      this.drawing.points.push(this.clamp(e.latlng));
      this.finishLine();
    } else if (this.drawing) {
      this.drawing.points.push(this.snap(e.latlng).pos);
      this.redraw();
    } else if (this.selectedId) {
      this.select(null);
    }
  }

  handleDblClick() {
    if (this.drawing) this.finishLine();
  }

  handleMouseMove(e) {
    if (!this.drawing?.points.length) return;
    const last = this.drawing.points[this.drawing.points.length - 1];
    const { pos, snapped } = this.snap(e.latlng);
    if (this.rubber) this.rubber.setLatLngs([last, pos]);
    else this.rubber = L.polyline([last, pos], { color: '#ffd60a', weight: 2, dashArray: '6 6', interactive: false }).addTo(this.editLayer);
    if (!this.snapRing) this.snapRing = L.circleMarker(pos, { radius: 8, color: '#fff', weight: 2, fill: false, interactive: false });
    this.snapRing.setLatLng(pos);
    if (snapped) this.snapRing.addTo(this.editLayer);
    else this.snapRing.remove();
  }

  // Snap to an existing vertex (or failing that, a line) within a few screen
  // pixels, so traced taxiways share exact junction points.
  snap(latlng, excludeId = null) {
    const VERTEX_PX = 12;
    const LINE_PX = 9;
    const p = this.map.latLngToContainerPoint(latlng);
    const lines = this.features.filter((f) => f.id !== excludeId && f.kind !== 'stand').map((f) => f.coords);
    if (this.drawing) lines.push(this.drawing.points.slice(0, -1));

    let best = null;
    for (const coords of lines) {
      for (const c of coords) {
        const d = this.map.latLngToContainerPoint(c).distanceTo(p);
        if (d <= VERTEX_PX && (!best || d < best.d)) best = { d, pos: c };
      }
    }
    if (!best) {
      for (const coords of lines) {
        for (let i = 1; i < coords.length; i++) {
          const a = this.map.latLngToContainerPoint(coords[i - 1]);
          const b = this.map.latLngToContainerPoint(coords[i]);
          const q = L.LineUtil.closestPointOnSegment(p, a, b);
          const d = q.distanceTo(p);
          if (d <= LINE_PX && (!best || d < best.d)) {
            const ll = this.map.containerPointToLatLng(q);
            best = { d, pos: [ll.lat, ll.lng] };
          }
        }
      }
    }
    return best ? { pos: this.clamp({ lat: best.pos[0], lng: best.pos[1] }), snapped: true } : { pos: this.clamp(latlng), snapped: false };
  }

  clamp(latlng) {
    const { width, height } = this.view.airport.image;
    return [Math.max(0, Math.min(height, latlng.lat)), Math.max(0, Math.min(width, latlng.lng))];
  }

  // ------------------------------------------------------------- drawing

  redraw() {
    this.layer.clearLayers();
    this.editLayer.clearLayers();
    this.rubber = null;
    this.snapRing = null;

    this.selectedLines = [];
    for (const f of this.features) {
      const selected = f.id === this.selectedId;
      if (f.kind === 'stand') {
        L.circleMarker(f.coords[0], { radius: 7, color: '#000', weight: 2, fillColor: selected ? '#ffd60a' : '#22c55e', fillOpacity: 1, bubblingMouseEvents: false })
          .on('click', (e) => {
            if (this.drawing) return;
            L.DomEvent.stop(e);
            this.select(f.id);
          })
          .addTo(this.layer);
        L.marker(f.coords[0], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: 'stand-marker', html: `<div class="stand-label traced${selected ? ' selected' : ''}">${escapeHtml(f.label || '?')}</div>`, iconSize: [0, 0] }),
        }).addTo(this.layer);
        continue;
      }
      const color = f.kind === 'runway' ? '#ff4d6d' : selected ? '#ffd60a' : '#2ee6ff';
      const halo = L.polyline(f.coords, { color: '#000', weight: selected ? 9 : 7, opacity: 0.7, interactive: false }).addTo(this.layer);
      const line = L.polyline(f.coords, { color, weight: selected ? 5 : 3, opacity: 1, interactive: false }).addTo(this.layer);
      if (selected) this.selectedLines = [halo, line];
      // Wide invisible hit line so lines are easy to click.
      L.polyline(f.coords, { color: '#000', weight: 16, opacity: 0, className: 'hit-line' })
        .on('click', (e) => {
          if (this.drawing) return; // let the map click add a point
          L.DomEvent.stop(e);
          this.select(f.id);
        })
        .addTo(this.layer);
      L.marker(midpoint(f.coords), {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: `ref-label trace-label${selected ? ' selected' : ''}`, html: escapeHtml(f.label || '?'), iconSize: null }),
      }).addTo(this.layer);
    }

    const sel = this.selected;
    if (sel && !this.drawing) {
      sel.coords.forEach((c, i) => {
        L.marker(c, { draggable: true, icon: L.divIcon({ className: 'vertex', iconSize: [14, 14] }) })
          .on('drag', (e) => {
            sel.coords[i] = this.snap(e.target.getLatLng(), sel.id).pos;
            for (const l of this.selectedLines) l.setLatLngs(sel.coords);
          })
          .on('dragend', () => {
            this.emit();
            this.redraw();
          })
          .on('contextmenu', (e) => {
            L.DomEvent.stop(e);
            if (sel.kind === 'stand') return this.flash('Use Delete to remove a stand.');
            if (sel.coords.length <= 2) return this.flash('A line needs at least two points.');
            sel.coords.splice(i, 1);
            this.emit();
            this.redraw();
          })
          .addTo(this.editLayer);
      });
    }

    if (this.drawing) {
      const pts = this.drawing.points;
      if (pts.length > 1) {
        L.polyline(pts, { color: '#000', weight: 8, opacity: 0.7, interactive: false }).addTo(this.editLayer);
        L.polyline(pts, { color: '#ffd60a', weight: 4, interactive: false }).addTo(this.editLayer);
      }
      for (const p of pts) {
        L.circleMarker(p, { radius: 4, color: '#000', weight: 2, fillColor: '#ffd60a', fillOpacity: 1, interactive: false }).addTo(this.editLayer);
      }
    }
  }

  // --------------------------------------------------------------- panel

  renderPanelShell() {
    this.panel.innerHTML = `
      <h3>Trace chart</h3>
      <div class="tr-new">
        <input class="tr-label" placeholder="Label, e.g. B4" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="characters" maxlength="24">
        <select class="tr-kind"><option value="taxiway">Taxiway</option><option value="runway">Runway</option><option value="stand">Stand</option></select>
        <button class="tr-go primary">Trace</button>
      </div>
      <div class="tr-status" aria-live="polite"></div>
      <p class="hint">${HELP}</p>
      <div class="tr-selected" hidden>
        <h4>Selected line</h4>
        <div class="row">
          <input class="tr-sel-label" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="characters" maxlength="24">
          <select class="tr-sel-kind"><option value="taxiway">Taxiway</option><option value="runway">Runway</option><option value="stand" disabled>Stand</option></select>
          <button class="tr-delete danger">Delete</button>
        </div>
      </div>
      <h4 class="tr-count"></h4>
      <ul class="tr-list"></ul>`;
    const $ = (sel) => this.panel.querySelector(sel);
    this.labelInput = $('.tr-label');
    this.kindSelect = $('.tr-kind');
    this.statusEl = $('.tr-status');
    this.listEl = $('.tr-list');
    this.selEl = $('.tr-selected');
    this.selLabel = $('.tr-sel-label');
    this.selKind = $('.tr-sel-kind');
    this.goBtn = $('.tr-go');

    this.goBtn.addEventListener('click', () => (this.drawing ? this.finishLine() : this.beginLine()));
    this.selLabel.addEventListener('input', () => this.updateSelected({ label: this.selLabel.value.trim().toUpperCase() }));
    this.selKind.addEventListener('change', () => this.updateSelected({ kind: this.selKind.value }));
    $('.tr-delete').addEventListener('click', () => this.deleteSelected());
    this.listEl.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li && !this.drawing) {
        this.select(li.dataset.id);
        const f = this.selected;
        if (f) this.map.fitBounds(f.coords, { padding: [80, 80], maxZoom: 1 });
      }
    });
  }

  renderPanel() {
    const drawing = !!this.drawing;
    this.labelInput.disabled = drawing;
    this.kindSelect.disabled = drawing;
    this.goBtn.textContent = drawing ? 'Finish' : 'Trace';
    if (drawing) this.flash(`Tracing ${this.drawing.label} — click along the centreline.`, true);
    else if (this.statusEl.dataset.sticky) this.flash('');

    const sel = this.selected;
    this.selEl.hidden = !sel || drawing;
    if (sel) {
      if (document.activeElement !== this.selLabel) this.selLabel.value = sel.label || '';
      this.selKind.value = sel.kind;
      this.selKind.disabled = sel.kind === 'stand';
    }
    this.renderList();
  }

  renderList() {
    const sorted = [...this.features].sort((a, b) => (a.label || '').localeCompare(b.label || '', undefined, { numeric: true }));
    this.panel.querySelector('.tr-count').textContent = `${this.features.length} traced line${this.features.length === 1 ? '' : 's'}`;
    this.listEl.innerHTML = sorted
      .map(
        (f) => `<li data-id="${f.id}" class="${f.id === this.selectedId ? 'selected' : ''}">
          <span class="ref ${f.kind}">${escapeHtml(f.label || '?')}</span>
          <span class="muted">${f.kind === 'stand' ? 'stand' : `${f.kind === 'runway' ? 'runway · ' : ''}${f.coords.length} pts`}</span></li>`,
      )
      .join('');
  }

  flash(message, sticky = false) {
    this.statusEl.textContent = message;
    if (sticky) this.statusEl.dataset.sticky = '1';
    else delete this.statusEl.dataset.sticky;
  }

  emit() {
    this.onChange(this.features.map(({ id, kind, label, refs, coords }) => ({ id, kind, label, refs, coords })));
  }
}

function dedupe(points) {
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.5);
}

function newId() {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
