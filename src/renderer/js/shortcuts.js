// Every keyboard shortcut in one table: shown by the ? overlay, the
// Settings → Shortcuts pane and in tooltips. Keep it in step with
// app.js (global keys) and player.js handleKey (player keys).
import { h, button } from './ui.js';
import { trapFocus } from './dialog.js';

export const SHORTCUTS = [
  {
    group: 'Everywhere',
    keys: [
      ['Ctrl K', 'Search'],
      ['Alt ←', 'Back'],
      ['Alt →', 'Forward'],
      ['Ctrl ,', 'Settings'],
      ['Ctrl + / Ctrl − / Ctrl 0', 'Zoom in, out, reset'],
      ['?', 'Show shortcuts'],
    ],
  },
  {
    group: 'Player',
    keys: [
      ['Space or K', 'Play or pause'],
      ['← / →', 'Back or forward (amounts in Settings)'],
      ['Shift ← / Shift →', 'Back or forward 1 minute'],
      ['J / L', 'Back or forward 10 seconds'],
      ['0 – 9', 'Jump to 0% – 90%'],
      ['Page Up / Page Down', 'Previous or next chapter'],
      ['↑ / ↓', 'Volume'],
      ['M', 'Mute'],
      ['F', 'Fullscreen'],
      ['T', 'Mini player'],
      ['A', 'Next audio track'],
      ['S', 'Next subtitle track'],
      ['Z / X', 'Subtitles earlier or later'],
      ['[ / ]', 'Slower or faster'],
      ['V', 'Video fit: fit, fill, stretch, zoom'],
      ['N / P', 'Next or previous episode'],
      ['I', 'Playback info'],
      ['Enter', 'Skip intro or credits'],
      ['Ctrl S', 'Screenshot'],
      ['Esc', 'Leave fullscreen or close the player'],
    ],
  },
];

export function shortcutList() {
  return SHORTCUTS.map((g) => h('section', null,
    h('h3', { class: 'eyebrow' }, g.group),
    h('div', { class: 'shortcut-list' }, g.keys.flatMap(([k, what]) => [h('kbd', null, k), h('span', null, what)]))));
}

let open = null;

// The ? overlay. Inside the player it covers the video; elsewhere it's a dialog.
export function showShortcuts(host = document.body) {
  if (open) {
    open();
    return;
  }
  const card = h('div', { class: 'shortcuts-card modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-title' },
    h('h2', { id: 'shortcuts-title' }, 'Keyboard shortcuts'),
    shortcutList(),
    h('div', { class: 'modal-actions' }, button('Close', { variant: 'primary', onclick: () => close() })));
  const overlay = h('div', { class: 'modal-backdrop', onclick: (e) => e.target === overlay && close() }, card);
  host.append(overlay);
  const release = trapFocus(overlay, () => close());
  function close() {
    release();
    overlay.remove();
    open = null;
  }
  open = close;
}
