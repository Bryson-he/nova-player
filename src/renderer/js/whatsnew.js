// "What's new" window shown once after Nova updates itself. Notes are bundled
// with the app, so it works offline and lists every version you skipped.
import { store } from './store.js';
import { h, button, novaMark } from './ui.js';
import { trapFocus } from './dialog.js';

export const NOTES = {
  '2.0.0': [
    'A new look: calm graphite, one warm accent, a new icon, and Mica behind the sidebar on Windows 11.',
    'Search from anywhere with Ctrl K. Results appear as you type, including people.',
    "Play, pause and skip from the taskbar thumbnail, and jump back into a show from the taskbar's Continue watching list.",
    "Nova finds Jellyfin servers on your network, remembers the ones you've used, and lets you switch user or server from the account menu.",
    'Every screen works with the keyboard; press ? to see every shortcut.',
    'Settings → Appearance: your Windows accent colour, artwork tints, reduced motion or transparency, and zoom (Ctrl + / Ctrl −).',
    'Auto crop (press V) finds black bars that are part of the video and zooms past them, so films fill ultrawide screens.',
    'Sleep timer, Still watching? after a few episodes, and more video fit modes: fill, stretch and zoom.',
  ],
  '1.4.0': [
    'Safer sign-in: your login now stays inside Nova\'s core and is never written into video, subtitle or picture links, so it can\'t end up in server or proxy logs.',
    'Nova tries a secure (HTTPS) connection first, and warns before sending your password unencrypted over the internet. Servers on your home network or Tailscale work as before.',
    'Closing Nova during playback now saves your exact position on the server.',
    'Links to unfamiliar websites ask before opening in your browser.',
    'Lots of behind-the-scenes hardening, and signed build records for every release.',
  ],
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

  const close = () => {
    release();
    overlay.remove();
  };
  const overlay = h('div', { class: 'modal-backdrop', onclick: (e) => e.target === overlay && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': "What's new" },
      h('div', { class: 'modal-head' },
        novaMark(),
        h('div', null,
          h('div', { class: 'modal-title' }, `What's new in Nova ${current}`),
          h('div', { class: 'modal-sub' }, last ? `Updated from ${last}` : 'Nova updated itself'))),
      h('div', { class: 'modal-body' }, versions.map((v) => h('section', { class: 'notes' },
        versions.length > 1 ? h('h3', null, `Version ${v}`) : null,
        h('ul', null, NOTES[v].map((n) => h('li', null, n)))))),
      h('div', { class: 'modal-actions' }, button('Got it', { variant: 'primary', onclick: close }))));
  document.body.append(overlay);
  const release = trapFocus(overlay, close);
}
