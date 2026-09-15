// Per-device appearance settings: app theme and the look of the taxi ribbon.
// Saved in localStorage, so the Mac and the iPad can each have their own.

export const RIBBON_COLORS = [
  ['Yellow', '#ffd60a'],
  ['Magenta', '#ff2bd6'],
  ['Cyan', '#22d3ee'],
  ['Green', '#4ade80'],
  ['Orange', '#ff8c1a'],
  ['Blue', '#3b82f6'],
  ['White', '#ffffff'],
];
export const WIDTHS = { thin: 4, normal: 7, thick: 11 };

export const DEFAULTS = {
  theme: 'dark', // 'dark' | 'light' | 'auto'
  ribbon: { color: '#ffd60a', width: 'normal', outline: 'dark', glow: false, chevrons: true },
};

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// Whatever is stored, return a complete, valid settings object.
export function normaliseSettings(raw) {
  const r = raw?.ribbon || {};
  return {
    theme: pick(raw?.theme, ['dark', 'light', 'auto'], DEFAULTS.theme),
    ribbon: {
      color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toLowerCase() : DEFAULTS.ribbon.color,
      width: pick(r.width, Object.keys(WIDTHS), DEFAULTS.ribbon.width),
      outline: pick(r.outline, ['dark', 'light', 'none'], DEFAULTS.ribbon.outline),
      glow: typeof r.glow === 'boolean' ? r.glow : DEFAULTS.ribbon.glow,
      chevrons: typeof r.chevrons === 'boolean' ? r.chevrons : DEFAULTS.ribbon.chevrons,
    },
  };
}

// 'auto' follows the device (e.g. iPad dark mode at night).
export function resolveTheme(theme, prefersLight = false) {
  return theme === 'auto' ? (prefersLight ? 'light' : 'dark') : theme;
}

// Black or white, whichever reads better on `hex` (WCAG relative luminance).
export function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? '#000000' : '#ffffff';
}

export class SettingsPanel {
  constructor(el, { settings, onChange }) {
    this.el = el;
    this.settings = settings;
    this.onChange = onChange;
    el.addEventListener('click', (e) => this.handleClick(e));
    el.addEventListener('input', (e) => {
      if (e.target.matches('.custom-color')) this.update({ color: e.target.value });
    });
    this.render();
  }

  handleClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.theme) return this.set({ ...this.settings, theme: btn.dataset.theme });
    if (btn.dataset.reset) return this.set(normaliseSettings({ theme: this.settings.theme }));
    const { key, value } = btn.dataset;
    if (key) this.update({ [key]: value === 'true' ? true : value === 'false' ? false : value });
  }

  update(ribbon) {
    this.set({ ...this.settings, ribbon: { ...this.settings.ribbon, ...ribbon } });
  }

  set(settings) {
    this.settings = normaliseSettings(settings);
    this.onChange(this.settings);
    this.render();
  }

  render() {
    const { theme, ribbon } = this.settings;
    const seg = (key, options, current) =>
      `<div class="seg settings-seg">${options
        .map(([label, value]) => `<button type="button" data-key="${key}" data-value="${value}" class="${String(current) === String(value) ? 'on' : ''}">${label}</button>`)
        .join('')}</div>`;
    const preset = RIBBON_COLORS.some(([, c]) => c === ribbon.color);

    this.el.innerHTML = `
      <h3>Settings</h3>
      <h4>App theme</h4>
      <div class="seg settings-seg">${[['Dark', 'dark'], ['Light', 'light'], ['Auto', 'auto']]
        .map(([label, value]) => `<button type="button" data-theme="${value}" class="${theme === value ? 'on' : ''}">${label}</button>`)
        .join('')}</div>
      <p class="hint">Auto follows the device's light/dark setting.</p>

      <h4>Taxi ribbon</h4>
      <div class="ribbon-preview" aria-hidden="true">${previewSvg(ribbon)}</div>

      <div class="setting-label">Colour</div>
      <div class="swatches">
        ${RIBBON_COLORS.map(([name, c]) => `<button type="button" class="swatch${ribbon.color === c ? ' on' : ''}" data-key="color" data-value="${c}" style="--swatch:${c}" title="${name}" aria-label="${name}"></button>`).join('')}
        <label class="swatch custom${preset ? '' : ' on'}" title="Custom colour" style="--swatch:${preset ? 'transparent' : ribbon.color}">
          <input type="color" class="custom-color" value="${ribbon.color}" aria-label="Custom colour"><span>+</span>
        </label>
      </div>

      <div class="setting-label">Width</div>
      ${seg('width', [['Thin', 'thin'], ['Normal', 'normal'], ['Thick', 'thick']], ribbon.width)}
      <div class="setting-label">Outline</div>
      ${seg('outline', [['Dark', 'dark'], ['Light', 'light'], ['None', 'none']], ribbon.outline)}
      <div class="setting-label">Glow</div>
      ${seg('glow', [['Off', false], ['On', true]], ribbon.glow)}
      <div class="setting-label">Direction arrows</div>
      ${seg('chevrons', [['On', true], ['Off', false]], ribbon.chevrons)}

      <div class="panel-actions"><button type="button" data-reset="1">Reset ribbon</button></div>`;
    this.placePreviewChevrons();
  }

  // Put the preview's arrows on the curve, pointing along it, like the map does.
  placePreviewChevrons() {
    const line = this.el.querySelector('.ribbon-line');
    if (!line?.getTotalLength || !this.el.offsetParent) return; // measured again when the panel opens
    const total = line.getTotalLength();
    this.el.querySelectorAll('.preview-chevron').forEach((chevron, i, all) => {
      const at = (total * (i + 1)) / (all.length + 1);
      const p = line.getPointAtLength(at);
      const q = line.getPointAtLength(Math.min(total, at + 1));
      const angle = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
      chevron.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${angle}) ${chevron.dataset.scale}`);
    });
  }
}

// A short S-bend drawn exactly the way the map draws the route.
function previewSvg(r) {
  const w = WIDTHS[r.width];
  const d = 'M16 58 C 70 58, 80 18, 140 18 S 214 50, 264 34';
  const halo = r.outline === 'none' ? '' : `<path d="${d}" stroke="${r.outline === 'light' ? '#fff' : '#000'}" stroke-width="${w + 8}" opacity="0.9"/>`;
  const glow = r.glow ? `<path d="${d}" stroke="${r.color}" stroke-width="${w + 18}" opacity="0.28"/>` : '';
  const scale = `scale(${chevronSize(r.width) / 12}) translate(-6 -6)`;
  const chevrons = r.chevrons
    ? [0, 1, 2].map(() => `<path class="preview-chevron" data-scale="${scale}" transform="translate(-99 -99)" d="M3 1.5 L8.5 6 L3 10.5" stroke="${inkFor(r.color)}" stroke-width="2.8"/>`).join('')
    : '';
  return `<svg viewBox="0 0 280 76" preserveAspectRatio="xMidYMid meet"><g fill="none" stroke-linecap="round" stroke-linejoin="round">${glow}${halo}<path class="ribbon-line" d="${d}" stroke="${r.color}" stroke-width="${w}"/>${chevrons}</g></svg>`;
}

export const chevronSize = (width) => ({ thin: 11, normal: 15, thick: 20 })[width] || 15;
