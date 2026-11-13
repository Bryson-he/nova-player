// Appearance settings: accent (Starlight or your Windows accent), motion,
// transparency and app zoom. Applied at startup and whenever they change.
import { store, onSettingChange } from './store.js';

const ROOT = document.documentElement;
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/**
 * Makes a Windows accent colour usable as Nova's accent: lightened until it
 * stands out on the dark background (4.5:1), with ink text on top.
 * @param {string} hex
 */
export function usableAccent(hex) {
  const bg = hexToRgb('#0e0e10');
  let rgb = hexToRgb(hex);
  for (let i = 0; i < 20 && contrast(rgb, bg) < 4.5; i++) rgb = rgb.map((v) => v + (255 - v) * 0.15);
  const ink = hexToRgb('#111113');
  const onAccent = contrast(rgb, ink) >= 4.5 ? '#111113' : '#ffffff';
  return { accent: toHex(rgb), onAccent };
}

async function applyAccent() {
  if (store.setting('accentSource') === 'windows') {
    const hex = await window.nova.accentColor().catch(() => null);
    if (hex) {
      const { accent, onAccent } = usableAccent(hex);
      ROOT.style.setProperty('--accent', accent);
      ROOT.style.setProperty('--on-accent', onAccent);
      return;
    }
  }
  ROOT.style.removeProperty('--accent');
  ROOT.style.removeProperty('--on-accent');
}

function applyMotion() {
  const motion = store.setting('motion');
  ROOT.classList.toggle('reduce-motion', motion === 'reduce');
  ROOT.classList.toggle('motion-on', motion === 'full');
}

function applyTransparency() {
  ROOT.classList.toggle('reduce-transparency', !!store.setting('reduceTransparency'));
}

export function setZoom(z) {
  const zoom = Math.min(Math.max(Number(z) || 1, ZOOM_STEPS[0]), ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  if (store.setting('zoom') !== zoom) store.setSetting('zoom', zoom);
  window.nova.setZoom(zoom);
  return zoom;
}

export function stepZoom(dir) {
  const cur = store.setting('zoom') || 1;
  if (dir === 0) return setZoom(1);
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
  return setZoom(next ?? cur);
}

export function applyAppearance() {
  applyAccent();
  applyMotion();
  applyTransparency();
  window.nova.setZoom(store.setting('zoom') || 1);
}

onSettingChange((key) => {
  if (key === 'accentSource') applyAccent();
  else if (key === 'motion') applyMotion();
  else if (key === 'reduceTransparency') applyTransparency();
});

// Ctrl + / Ctrl − / Ctrl 0 zoom the whole app, remembered between launches.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  if (e.key === '=' || e.key === '+') stepZoom(1);
  else if (e.key === '-') stepZoom(-1);
  else if (e.key === '0') stepZoom(0);
  else return;
  e.preventDefault();
});
