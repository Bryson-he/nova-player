import { store, DEFAULT_SETTINGS } from '../store.js';
import { api, CLIENT_VERSION } from '../api.js';
import { h, fill, select, button, toast } from '../ui.js';
import { LANGUAGES, forgetSeries } from '../tracks.js';
import { capabilities } from '../profile.js';
import {
  appInfo, updateState, onUpdateChange, describeUpdate, checkForUpdates, installUpdate, releasesUrl,
} from '../updates.js';

const BITRATES = [
  [120000000, 'Maximum (direct play when possible)'],
  [80000000, '80 Mbps'], [60000000, '60 Mbps'], [40000000, '40 Mbps'], [20000000, '20 Mbps'],
  [10000000, '10 Mbps'], [8000000, '8 Mbps'], [4000000, '4 Mbps'], [2000000, '2 Mbps'], [1000000, '1 Mbps'],
];

export function settingsView() {
  const el = h('div', { class: 'page settings' });

  const row = (label, desc, control) => h('div', { class: 'setting' },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), desc ? h('div', { class: 'setting-desc' }, desc) : null),
    h('div', { class: 'setting-control' }, control));

  const toggle = (key) => {
    const input = h('input', { type: 'checkbox', checked: !!store.setting(key) });
    input.addEventListener('change', () => store.setSetting(key, input.checked));
    return h('label', { class: 'switch' }, input, h('span', { class: 'slider' }));
  };

  const choice = (key, options, numeric = false) =>
    select(options, store.setting(key), (v) => store.setSetting(key, numeric ? Number(v) : v));

  const range = (key, min, max, step, fmt) => {
    const out = h('span', { class: 'range-val' }, fmt(store.setting(key)));
    const input = h('input', { type: 'range', min, max, step, value: store.setting(key) });
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
      store.setSetting(key, Number(input.value));
      updatePreview();
    });
    return h('div', { class: 'range' }, input, out);
  };

  const color = (key) => {
    const input = h('input', { type: 'color', value: store.setting(key) });
    input.addEventListener('input', () => {
      store.setSetting(key, input.value);
      updatePreview();
    });
    return input;
  };

  const preview = h('div', { class: 'sub-preview' }, h('div', { class: 'sub-layer' }, h('span', { class: 'sub-cue' }, 'This is how your subtitles will look.')));
  function updatePreview() {
    applySubtitleStyle(preview.firstChild);
  }

  const section = (title, ...rows) => h('section', { class: 'settings-section' }, h('h2', null, title), ...rows);

  const memoryList = h('div', { class: 'memory-list' });
  function renderMemory() {
    const all = store.get('seriesTracks') || {};
    const entries = Object.entries(all).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    if (!entries.length) {
      memoryList.replaceChildren(h('div', { class: 'muted' }, 'No series remembered yet. Change audio or subtitles while watching an episode and it will be saved here.'));
      return;
    }
    memoryList.replaceChildren(...entries.map(([id, p]) => h('div', { class: 'memory-item' },
      h('div', null,
        h('div', { class: 'memory-name' }, p.name || id),
        h('div', { class: 'muted small' },
          [p.audio ? `Audio: ${p.audio.label || p.audio.language}` : null,
            p.subtitle ? `Subtitles: ${p.subtitle.off ? 'Off' : p.subtitle.label || p.subtitle.language}` : null].filter(Boolean).join('  ·  '))),
      button('Forget', { onclick: () => { forgetSeries(id); renderMemory(); } }))));
  }
  renderMemory();

  const updateStatus = h('span');
  const updateAction = h('span');
  function renderUpdate(s) {
    updateStatus.textContent = describeUpdate(s) || 'Updates come from GitHub Releases.';
    fill(updateAction, 
      s.state === 'ready' ? button('Restart to update', { variant: 'primary', onclick: installUpdate }) : null,
      s.state === 'available' && s.portable && releasesUrl()
        ? button('Download', { variant: 'primary', onclick: () => window.nova.openExternal(releasesUrl()) })
        : null);
  }
  renderUpdate(updateState());
  const unsubUpdate = onUpdateChange(renderUpdate);

  const caps = capabilities();
  const server = store.get('server');
  const user = store.get('user');

  el.append(
    h('h1', null, 'Settings'),
    section('Playback',
      row('Maximum streaming quality', 'Lower this if you watch away from home on slow internet.', choice('maxBitrate', BITRATES, true)),
      row('Auto-play next episode', 'Shows an "Up Next" countdown at the end of an episode.', toggle('autoplayNext')),
      row('Up Next countdown', null, choice('nextUpCountdown', [[5, '5 seconds'], [10, '10 seconds'], [15, '15 seconds'], [20, '20 seconds'], [30, '30 seconds']], true)),
      row('Skip intros & recaps', 'Uses Jellyfin media segments (10.10+ or the Intro Skipper plugin).', choice('skipIntro', [['button', 'Show "Skip" button'], ['auto', 'Skip automatically'], ['off', 'Off']])),
      row('Show Up Next when credits start', 'If the server knows where the credits are.', toggle('skipCredits')),
      row('Start playback in fullscreen', null, toggle('startFullscreen')),
      row('Seek back', null, choice('seekBack', [[5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s']], true)),
      row('Seek forward', null, choice('seekForward', [[10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '60 s']], true)),
      row('Always transcode', 'Troubleshooting only: forces the server to convert every video.', toggle('forceTranscode'))),
    section('Audio & Subtitles',
      row('Remember tracks per series', 'Keeps the audio and subtitle you pick for every episode of that show — even when tracks are in a different order.', toggle('rememberTracks')),
      row('Preferred audio language', 'Used when a series has nothing remembered yet.', choice('audioLang', LANGUAGES)),
      row('Subtitle mode', null, choice('subMode', [
        ['server', 'Use server default'],
        ['smart', 'Smart: only when audio is foreign'],
        ['always', 'Always on'],
        ['forced', 'Forced subtitles only'],
        ['off', 'Off'],
      ])),
      row('Preferred subtitle language', null, choice('subLang', LANGUAGES))),
    section('Subtitle appearance',
      preview,
      row('Size', null, range('subSize', 50, 200, 5, (v) => `${v}%`)),
      row('Text colour', null, color('subColor')),
      row('Background', null, range('subBg', 0, 100, 5, (v) => `${v}%`)),
      row('Distance from bottom', null, range('subPosition', 2, 40, 1, (v) => `${v}%`)),
      row('Text outline', null, (() => {
        const t = toggle('subOutline');
        t.querySelector('input').addEventListener('change', updatePreview);
        return t;
      })())),
    section('Remembered series', memoryList,
      h('div', { class: 'setting-actions' }, button('Forget all', {
        onclick: () => {
          store.set('seriesTracks', {});
          renderMemory();
          toast('All remembered tracks cleared');
        },
      }))),
    section('Libraries',
      row('Reset saved sorting', 'Every library remembers its own sort, order, filter and card size.', button('Reset', {
        onclick: () => {
          store.set('librarySort', {});
          toast('Library sorting reset');
        },
      }))),
    section('Account',
      row('Server', server?.url, h('span', { class: 'muted' }, server?.name || '')),
      row('Signed in as', null, h('span', { class: 'muted' }, user?.Name || '')),
      row('Reset all settings', null, button('Reset', {
        onclick: () => {
          for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) store.setSetting(k, v);
          toast('Settings reset — reopen this page to see defaults');
        },
      }))),
    section('Updates',
      row('Install updates automatically', 'New versions download in the background and install when you close Nova.', toggle('autoUpdate')),
      row(`Nova Player ${appInfo().version || CLIENT_VERSION}`, updateStatus, h('div', { class: 'setting-control' },
        updateAction,
        button('Check now', {
          onclick: async () => {
            updateStatus.textContent = 'Checking for updates…';
            renderUpdate(await checkForUpdates());
          },
        })))),
    section('About',
      row('This PC can direct play', null, h('span', { class: 'muted' },
        `Video: ${caps.video.join(', ').toUpperCase()} · Audio: ${caps.audio.join(', ').toUpperCase()}${caps.mkv ? ' · MKV' : ''}`)),
      row('Server', null, h('span', { class: 'muted' }, api.base))),
  );

  updatePreview();
  return { el, onShow: renderMemory, destroy: unsubUpdate };
}

export function applySubtitleStyle(layer) {
  const size = store.setting('subSize') / 100;
  const bg = store.setting('subBg') / 100;
  layer.style.setProperty('--sub-scale', size);
  layer.style.setProperty('--sub-color', store.setting('subColor'));
  layer.style.setProperty('--sub-bg', `rgba(0,0,0,${bg})`);
  layer.style.setProperty('--sub-bottom', `${store.setting('subPosition')}%`);
  layer.classList.toggle('outline', !!store.setting('subOutline'));
}
