// Tap-to-enter keypad beside the map, for when ATC talks faster than you type.
// Shows the airport's own refs: letter groups on the left (A, B, DOM…), the
// selected group's refs on the right (A, A1, A2…), runways on top. Plain A is
// one tap; A1 is two (A, then A1 — which replaces the A just entered).
// The BAY/GATE tab picks where you start the same way: 30–39, then 36.
import { standWord } from './stands.js';

// refs: canonical refs (already sorted); isRunway(ref) -> boolean.
export function groupRefs(refs, isRunway) {
  const runways = [];
  const groups = new Map();
  for (const ref of refs) {
    if (isRunway(ref)) {
      runways.push(ref);
      continue;
    }
    const key = /^[A-Z]+/.exec(ref)?.[0] ?? ref;
    if (!groups.has(key)) groups.set(key, { key, hasSelf: false, refs: [] });
    const g = groups.get(key);
    if (ref === key) g.hasSelf = true;
    g.refs.push(ref);
  }
  const sorted = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { runways, groups: sorted };
}

// Stands: letter prefix (D1, D2 -> "D"), else by tens (36 -> "30s").
export function groupStands(refs) {
  const groups = new Map();
  for (const ref of refs) {
    const letters = /^[A-Z]+/.exec(ref)?.[0];
    const n = parseInt(ref, 10);
    const key = letters || (Number.isNaN(n) ? ref : n < 10 ? '1–9' : `${Math.floor(n / 10) * 10}s`);
    if (!groups.has(key)) groups.set(key, { key, hasSelf: false, refs: [] });
    groups.get(key).refs.push(ref);
  }
  return [...groups.values()];
}

// Text starting from `word ref`, replacing any gate/bay/stand already in it.
export function withStand(text, word, ref) {
  const rest = text
    .replace(/\b(gates?|stands?|bays?|parking)\s+(number\s+|no\s+)?[a-z]*\d+[a-z]?(\s+(left|right|cent(re|er))\b)?\s*/i, '')
    .trim();
  return `${word} ${ref}${rest ? ` ${rest}` : ''}`;
}

// Text with `ref` added: replaces the last word if it belongs to the same group
// (A -> A1, A1 -> A2 fixes a mis-tap), otherwise appends.
export function applyRef(text, ref, group) {
  const m = /^(.*?)(\S+)\s*$/s.exec(text);
  const last = m?.[2].toUpperCase();
  if (group && last && last !== ref && group.refs.includes(last) && ref !== group.key) {
    return `${m[1]}${ref}`;
  }
  const head = text.trimEnd();
  return head ? `${head} ${ref}` : ref;
}

// Text with the last word removed ("HOLD SHORT" counts as one).
export function dropLastWord(text) {
  return text.trimEnd().replace(/\s*(hold\s+short|\S+)$/i, '');
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class RefTray {
  constructor(el, { getText, setText, open = false, onToggle }) {
    this.el = el;
    this.getText = getText;
    this.setText = setText;
    this.onToggle = onToggle;
    this.data = { runways: [], groups: [], stands: [] };
    this.selected = null; // group key
    this.mode = 'taxi'; // 'taxi' | 'stand'
    this.standSelected = null;
    this.start = null; // parsed start from the clearance

    el.innerHTML = `
      <div class="tray-body" id="tray-body">
        <div class="tray-tabs" role="tablist">
          <button type="button" role="tab" data-mode="taxi">TAXI</button>
          <button type="button" role="tab" data-mode="stand">BAY</button>
        </div>
        <div class="tray-actions">
          <button type="button" data-act="undo" aria-label="Delete last word">⌫</button>
          <button type="button" data-act="clear">Clear</button>
        </div>
        <div class="tray-runways"></div>
        <div class="tray-panes">
          <div class="tray-groups" aria-label="Taxiway letters"></div>
          <div class="tray-refs" aria-live="polite"></div>
        </div>
      </div>
      <button type="button" class="tray-handle" aria-controls="tray-body" title="Taxiway keypad"><span>REFS</span></button>`;
    this.body = el.querySelector('.tray-body');
    this.handle = el.querySelector('.tray-handle');
    this.runwaysEl = el.querySelector('.tray-runways');
    this.groupsEl = el.querySelector('.tray-groups');
    this.refsEl = el.querySelector('.tray-refs');
    this.tabs = el.querySelector('.tray-tabs');

    this.handle.addEventListener('click', () => this.setOpen(!this.open, true));
    el.addEventListener('click', (e) => this.handleClick(e));
    this.setOpen(open);
  }

  setOpen(open, user = false) {
    this.open = open;
    this.el.classList.toggle('open', open);
    this.handle.setAttribute('aria-expanded', open);
    this.body.hidden = !open;
    if (user) this.onToggle?.(open);
  }

  // index: from indexAirport(), or null when no airport is loaded.
  setAirport(index, icao) {
    this.data = index
      ? { ...groupRefs(index.refs, (r) => !index.byRef.get(r).some((f) => f.kind === 'taxiway')), stands: groupStands(index.stands.refs) }
      : { runways: [], groups: [], stands: [] };
    this.word = standWord(icao);
    this.selected = null;
    this.standSelected = null;
    this.mode = 'taxi';
    this.render();
  }

  // Follow typing: select the group of the last word if it's a known ref.
  // start: the clearance's parsed gate/bay (or null).
  sync(start = null) {
    const last = /(\S+)\s*$/.exec(this.getText())?.[1].toUpperCase();
    const group = last && this.data.groups.find((g) => g.refs.includes(last));
    const startKey = start ? `${start.label}:${start.found}` : '';
    if ((group && group.key !== this.selected) || startKey !== this.startKey) {
      if (group) this.selected = group.key;
      this.start = start;
      this.startKey = startKey;
      this.render();
    }
  }

  get group() {
    return this.data.groups.find((g) => g.key === this.selected) || null;
  }

  handleClick(e) {
    const btn = e.target.closest('button');
    if (!btn || btn === this.handle) return;
    const text = this.getText();

    if (btn.dataset.mode) {
      this.mode = btn.dataset.mode;
      return this.render();
    }
    if (btn.dataset.act === 'undo') return this.setText(dropLastWord(text));
    if (btn.dataset.act === 'clear') return this.setText('');

    if (this.mode === 'stand') {
      if (btn.dataset.group) {
        this.standSelected = btn.dataset.group;
        return this.render();
      }
      if (btn.dataset.ref) {
        // Where you are is set; next thing ATC says is the taxiways.
        this.mode = 'taxi';
        this.setText(withStand(text, this.word, btn.dataset.ref));
        this.render();
      }
      return;
    }
    if (btn.dataset.runway) return this.setText(applyRef(text, btn.dataset.runway, null));
    if (btn.dataset.word) return this.setText(applyRef(text, btn.dataset.word, null));

    if (btn.dataset.group) {
      const group = this.data.groups.find((g) => g.key === btn.dataset.group);
      this.selected = group.key;
      this.render();
      // "A…" (no plain A at this airport) only opens the list.
      if (group.hasSelf) this.setText(applyRef(text, group.key, null));
      return;
    }
    if (btn.dataset.ref) this.setText(applyRef(text, btn.dataset.ref, this.group));
  }

  render() {
    const hasStands = this.data.stands.length > 0;
    const start = this.start;
    this.tabs.querySelector('[data-mode="stand"]').innerHTML = start
      ? `<span class="${start.found ? '' : 'bad'}">${escapeHtml(start.label)}</span>`
      : `${this.word}${hasStands ? '' : ' <small>none</small>'}`;
    for (const b of this.tabs.children) {
      b.classList.toggle('on', b.dataset.mode === this.mode);
      b.setAttribute('aria-selected', b.dataset.mode === this.mode);
    }
    this.el.classList.toggle('stand-mode', this.mode === 'stand');
    if (this.mode === 'stand') return this.renderStands();

    const { runways, groups } = this.data;
    if (!groups.length && !runways.length) {
      this.runwaysEl.innerHTML = '';
      this.groupsEl.innerHTML = '<p class="muted">Load an airport to get its taxiways here.</p>';
      this.refsEl.innerHTML = '';
      return;
    }
    this.runwaysEl.innerHTML = runways.length
      ? `<button type="button" class="tk word hold" data-word="HOLD SHORT">HOLD SHORT</button><button type="button" class="tk word" data-word="CROSS">CROSS</button>${runways
          .map((r) => `<button type="button" class="tk runway" data-runway="${escapeHtml(r)}">${escapeHtml(r)}</button>`)
          .join('')}`
      : '';
    this.groupsEl.innerHTML = groups
      .map((g) => {
        const more = g.refs.length - (g.hasSelf ? 1 : 0);
        return `<button type="button" class="tk group${g.key === this.selected ? ' on' : ''}${g.key.length + (g.hasSelf ? 0 : 1) > 3 ? ' long' : ''}" data-group="${escapeHtml(g.key)}"
          aria-pressed="${g.key === this.selected}">${escapeHtml(g.key)}${g.hasSelf ? '' : '…'}${more ? `<small>${more}</small>` : ''}</button>`;
      })
      .join('');
    const group = this.group;
    this.refsEl.innerHTML = group
      ? group.refs.map((r) => `<button type="button" class="tk ref-key${r.length > 4 ? ' long' : ''}" data-ref="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')
      : '<p class="muted">Tap a letter — its numbered taxiways show here.</p>';
  }

  renderStands() {
    const groups = this.data.stands;
    this.runwaysEl.innerHTML = '';
    if (!groups.length) {
      this.groupsEl.innerHTML = `<p class="muted">No ${this.word.toLowerCase()} numbers in this airport's data. Type it anyway (e.g. "${this.word} 36"), or use Set start on the map.</p>`;
      this.refsEl.innerHTML = '';
      return;
    }
    const current = this.start?.found ? this.start.ref : null;
    const selected = groups.find((g) => g.key === this.standSelected) || groups.find((g) => g.refs.includes(current)) || (groups.length === 1 ? groups[0] : null);
    this.groupsEl.innerHTML = groups
      .map((g) => `<button type="button" class="tk group${g === selected ? ' on' : ''}${g.key.length > 3 ? ' long' : ''}" data-group="${escapeHtml(g.key)}">${escapeHtml(g.key)}<small>${g.refs.length}</small></button>`)
      .join('');
    this.refsEl.innerHTML = selected
      ? selected.refs.map((r) => `<button type="button" class="tk stand-key${r === current ? ' on' : ''}${r.length > 4 ? ' long' : ''}" data-ref="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')
      : `<p class="muted">Pick a range — then your ${this.word.toLowerCase()}.</p>`;
  }
}
