// "What's new" window shown once after Nova updates itself. Notes are bundled
// with the app, so it works offline and lists every version you skipped.
import { store } from './store.js';
import { h, icon, button } from './ui.js';

export const NOTES = {
  '1.3.0': [
    'Subtitles now show up right as an episode starts, even anime with lots of styled fonts. The next episode\'s subtitles are fetched while you watch.',
    'NEW badges on shows with recently added episodes, on new episodes and movies, plus a New Episodes row on Home. Change how long things count as new in Settings → Libraries.',
    'Right-click any movie, show or episode for quick actions: play, from start, mark watched, favorite, shuffle, go to series.',
    'Home refreshes itself when you come back to Nova after a while, so new episodes appear without restarting.',
    'This window, so you can see what changed after an update.',
  ],
  '1.2.1': [
    'Fixed subtitles and seek-bar previews on Jellyfin 10.11 and newer.',
    'Styled subtitles now move above the player controls instead of sitting under them.',
  ],
  '1.2.0': [
    'Styled anime subtitles (ASS/SSA) with their own fonts, signs and karaoke.',
    'Dual subtitles, night mode, volume boost, chapters, screenshots (Ctrl+S) and a mini player (T).',
  ],
};

const parse = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

export function maybeShowWhatsNew(current) {
  if (!current) return;
  const last = store.get('lastVersion');
  store.set('lastVersion', current);
  // Versions before 1.3.0 didn't record this; a saved server means it's an update, not a fresh install.
  const upgradedFromOld = !last && !!store.get('server');
  if (!last && !upgradedFromOld) return;
  if (last && compareVersions(current, last) <= 0) return;
  const versions = last
    ? Object.keys(NOTES).filter((v) => compareVersions(v, last) > 0 && compareVersions(v, current) <= 0).sort((a, b) => compareVersions(b, a))
    : (NOTES[current] ? [current] : []);
  if (!versions.length) return;

  const close = () => overlay.remove();
  const overlay = h('div', { class: 'modal-backdrop', onclick: (e) => e.target === overlay && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': "What's new" },
      h('div', { class: 'modal-head' },
        h('div', { class: 'brand-mark' }, icon('play')),
        h('div', null,
          h('div', { class: 'modal-title' }, `What's new in Nova ${current}`),
          h('div', { class: 'modal-sub' }, last ? `Updated from ${last}` : 'Nova updated itself'))),
      h('div', { class: 'modal-body' }, versions.map((v) => h('section', { class: 'notes' },
        versions.length > 1 ? h('h3', null, `Version ${v}`) : null,
        h('ul', null, NOTES[v].map((n) => h('li', null, n)))))),
      h('div', { class: 'modal-actions' }, button('Got it', { variant: 'primary', onclick: close }))));
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      close();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}
