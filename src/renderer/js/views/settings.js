// Settings: categories on the left, one pane on the right, and a search
// field over both. Destructive actions confirm or offer Undo.
import { store, DEFAULT_SETTINGS } from '../store.js';
import { api, CLIENT_VERSION } from '../api.js';
import { h, fill, select, button, toast, icon, copyText } from '../ui.js';
import { LANGUAGES, forgetSeries } from '../tracks.js';
import { capabilities } from '../profile.js';
import { confirmDialog } from '../dialog.js';
import { shortcutList } from '../shortcuts.js';
import { stepZoom, setZoom } from '../appearance.js';
import { debugInfo } from '../diagnostics.js';
import { signOut } from '../app.js';
import {
  appInfo, updateState, onUpdateChange, describeUpdate, checkForUpdates, installUpdate, releasesUrl,
} from '../updates.js';

const BITRATES = [
  [120000000, 'Maximum (direct play when possible)'],
  [80000000, '80 Mbps'], [60000000, '60 Mbps'], [40000000, '40 Mbps'], [20000000, '20 Mbps'],
  [10000000, '10 Mbps'], [8000000, '8 Mbps'], [4000000, '4 Mbps'], [2000000, '2 Mbps'], [1000000, '1 Mbps'],
];
const SUB_COLOURS = [['#ffffff', 'White'], ['#ffe14d', 'Yellow'], ['#9ee7ff', 'Light blue'], ['#a8f0a8', 'Light green'], ['#ffb3c7', 'Pink'], ['#cfcfcf', 'Grey']];
const SUB_FONTS = [['', 'Nova (Segoe UI)'], ['Arial', 'Arial'], ['Verdana', 'Verdana'], ['Trebuchet MS', 'Trebuchet MS'], ['Tahoma', 'Tahoma'], ['Georgia', 'Georgia'], ['Consolas', 'Consolas']];
const LICENCES = [
  ['Electron', 'MIT', 'https://github.com/electron/electron/blob/main/LICENSE'],
  ['Chromium', 'BSD-3-Clause and others', 'https://www.chromium.org/chromium-projects/'],
  ['hls.js', 'Apache-2.0', 'https://github.com/video-dev/hls.js/blob/master/LICENSE'],
  ['JASSUB', 'MIT', 'https://github.com/ThaUnknown/jassub/blob/main/LICENSE'],
  ['libass', 'ISC', 'https://github.com/libass/libass/blob/master/COPYING'],
  ['electron-updater', 'MIT', 'https://github.com/electron-userland/electron-builder/blob/master/LICENSE'],
];

let lastCategory = 'playback';

export function settingsView() {
  const el = h('div', { class: 'page settings' });

  // ---- building blocks
  let rowIds = 0;
  const row = (label, desc, control) => {
    const id = `setting-${++rowIds}`;
    const ctl = control instanceof Node ? control : h('span', null, control);
    const focusable = ctl.matches?.('input, select, button') ? ctl : ctl.querySelector?.('input, select');
    focusable?.setAttribute('aria-labelledby', id);
    return h('div', { class: 'setting', dataset: { search: `${label} ${typeof desc === 'string' ? desc : ''}`.toLowerCase() } },
      h('div', null, h('div', { class: 'setting-label', id }, label), desc ? h('div', { class: 'setting-desc' }, desc) : null),
      h('div', { class: 'setting-control' }, ctl));
  };

  const toggle = (key, after) => {
    const input = h('input', { type: 'checkbox', role: 'switch', checked: !!store.setting(key) });
    input.addEventListener('change', () => {
      store.setSetting(key, input.checked);
      after?.();
    });
    return h('label', { class: 'switch' }, input, h('span', { class: 'slider' }));
  };

  const choice = (key, options, numeric = false, after) =>
    select(options, store.setting(key), (v) => {
      store.setSetting(key, numeric ? Number(v) : v);
      after?.();
    });

  const range = (key, min, max, step, fmt) => {
    const out = h('span', { class: 'range-val' }, fmt(store.setting(key)));
    const input = h('input', { type: 'range', min, max, step, value: store.setting(key), 'aria-valuetext': fmt(store.setting(key)) });
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
      input.setAttribute('aria-valuetext', fmt(Number(input.value)));
      store.setSetting(key, Number(input.value));
      updatePreview();
    });
    return h('div', { class: 'range' }, input, out);
  };

  // Six presets plus a custom colour.
  const swatches = (key) => {
    const custom = h('input', { type: 'color', value: store.setting(key), 'aria-label': 'Custom colour' });
    const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Text colour' });
    const sync = () => {
      for (const b of wrap.querySelectorAll('.swatch')) {
        const on = b.dataset.value.toLowerCase() === String(store.setting(key)).toLowerCase();
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
    };
    fill(wrap, SUB_COLOURS.map(([v, name]) => h('button', {
      class: 'swatch', role: 'radio', 'aria-label': name, title: name, dataset: { value: v }, style: { background: v },
      onclick: () => {
        store.setSetting(key, v);
        custom.value = v;
        sync();
        updatePreview();
      },
    })), custom);
    custom.addEventListener('input', () => {
      store.setSetting(key, custom.value);
      sync();
      updatePreview();
    });
    sync();
    return wrap;
  };

  const preview = h('div', { class: 'sub-preview', 'aria-hidden': 'true' }, h('div', { class: 'sub-layer' }, h('span', { class: 'sub-cue' }, 'This is how your subtitles will look.')));
  function updatePreview() {
    applySubtitleStyle(preview.firstChild);
  }

  const section = (title, ...rows) => h('section', { class: 'settings-section' }, h('h2', null, title), ...rows);

  // ---- remembered series, with Undo
  const memoryList = h('div', { class: 'memory-list' });
  function renderMemory() {
    const all = store.get('seriesTracks') || {};
    const entries = Object.entries(all).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    if (!entries.length) {
      fill(memoryList, h('div', { class: 'setting-text' }, 'No series remembered yet. Change audio or subtitles while watching an episode and it will be saved here.'));
      return;
    }
    fill(memoryList, entries.map(([id, p]) => h('div', { class: 'memory-item' },
      h('div', null,
        h('div', { class: 'memory-name' }, p.name || id),
        h('div', { class: 'muted small' },
          [p.audio ? `Audio: ${p.audio.label || p.audio.language}` : null,
            p.subtitle ? `Subtitles: ${p.subtitle.off ? 'Off' : p.subtitle.label || p.subtitle.language}` : null].filter(Boolean).join('  ·  '))),
      button('Forget', {
        onclick: () => {
          const before = { ...(store.get('seriesTracks') || {}) };
          forgetSeries(id);
          renderMemory();
          toast(`Forgot ${p.name || 'this series'}`, 'info', 6000, { label: 'Undo', onClick: () => { store.set('seriesTracks', before); renderMemory(); } });
        },
      }))));
  }
  renderMemory();

  // ---- updates
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
  const zoomLabel = h('span', { class: 'range-val' }, `${Math.round((store.setting('zoom') || 1) * 100)}%`);
  const zoomBy = (d) => { zoomLabel.textContent = `${Math.round(stepZoom(d) * 100)}%`; };

  // ---- the panes
  const PANES = [
    ['playback', 'Playback', 'play', () => [
      section('Playback',
        row('Maximum streaming quality', 'Lower this if you watch away from home on slow internet.', choice('maxBitrate', BITRATES, true)),
        row('Auto-play next episode', 'Shows an Up Next countdown at the end of an episode.', toggle('autoplayNext')),
        row('Ask "Still watching?"', 'After several episodes play on their own with no one touching anything, Nova checks before carrying on.',
          choice('stillWatching', [[0, 'Never'], [2, 'After 2 episodes'], [3, 'After 3 episodes'], [5, 'After 5 episodes']], true)),
        row('Up Next countdown', null, choice('nextUpCountdown', [[5, '5 seconds'], [10, '10 seconds'], [15, '15 seconds'], [20, '20 seconds'], [30, '30 seconds']], true)),
        row('Skip intros and recaps', 'Uses Jellyfin media segments (10.10+ or the Intro Skipper plugin).', choice('skipIntro', [['button', 'Show a Skip button'], ['auto', 'Skip automatically'], ['off', 'Off']])),
        row('Show Up Next when credits start', 'If the server knows where the credits are.', toggle('skipCredits')),
        row('Start playback in fullscreen', null, toggle('startFullscreen')),
        row('Video fit', 'How the picture fills the window. Auto crop finds black bars that are part of the video and zooms past them, great on ultrawide screens. V cycles it during playback.', choice('videoFit', [['fit', 'Fit (letterbox)'], ['crop', 'Auto crop (removes bars in the video)'], ['fill', 'Fill (crop to the window)'], ['stretch', 'Stretch'], ['zoom', 'Zoom']])),
        row('Seek back', null, choice('seekBack', [[5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s']], true)),
        row('Seek forward', null, choice('seekForward', [[10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '60 s']], true)),
        row('Streaming buffer', 'How far ahead to load when the server is streaming or converting. Bigger helps on slow or unstable connections.',
          choice('bufferSize', [['normal', 'Normal (1 minute)'], ['large', 'Large (3 minutes)'], ['max', 'Maximum (10 minutes)']])),
        row('Always transcode', 'Troubleshooting only: makes the server convert every video.', toggle('forceTranscode'))),
      section('Sound',
        row('Night mode', 'Evens out loud and quiet scenes so dialogue stays clear at low volume.', toggle('nightMode')),
        row('Volume boost', 'For quiet files or laptop speakers.', choice('volumeBoost', [[1, '100% (normal)'], [1.5, '150%'], [2, '200%'], [3, '300%']], true))),
    ]],
    ['subtitles', 'Audio and subtitles', 'subtitles', () => [
      section('Tracks',
        row('Remember tracks per series', 'Keeps the audio and subtitles you pick for every episode of a show, even when the tracks are in a different order.', toggle('rememberTracks')),
        row('Preferred audio language', 'Used when a series has nothing remembered yet.', choice('audioLang', LANGUAGES)),
        row('Subtitle mode', null, choice('subMode', [
          ['server', 'Use the server default'],
          ['smart', 'Smart: only when the audio is foreign'],
          ['always', 'Always on'],
          ['forced', 'Forced subtitles only'],
          ['off', 'Off'],
        ])),
        row('Preferred subtitle language', null, choice('subLang', LANGUAGES)),
        row('Styled anime subtitles', 'Shows ASS/SSA subtitles exactly as authored: their own fonts, colours, positions, signs and karaoke. Turn off to use the plain style below.', toggle('styledSubs'))),
      section('Subtitle appearance',
        preview,
        row('Font', null, choice('subFont', SUB_FONTS, false, updatePreview)),
        row('Size', null, range('subSize', 50, 200, 5, (v) => `${v}%`)),
        row('Text colour', null, swatches('subColor')),
        row('Edge', null, choice('subEdge', [['outline', 'Outline'], ['shadow', 'Drop shadow'], ['raised', 'Raised'], ['none', 'None']], false, () => { store.setSetting('subOutline', true); updatePreview(); })),
        row('Background', null, range('subBg', 0, 100, 5, (v) => `${v}%`)),
        row('Distance from bottom', null, range('subPosition', 2, 40, 1, (v) => `${v}%`))),
      section('Remembered series', memoryList,
        h('div', { class: 'setting-actions' }, button('Forget all', {
          onclick: () => {
            const before = store.get('seriesTracks') || {};
            store.set('seriesTracks', {});
            renderMemory();
            toast('Forgot every remembered series', 'info', 8000, { label: 'Undo', onClick: () => { store.set('seriesTracks', before); renderMemory(); } });
          },
        }))),
    ]],
    ['libraries', 'Libraries', 'folder', () => [
      section('Libraries',
        row('Mark new episodes', 'Shows a New badge on shows with unwatched episodes added recently, and on new episodes and movies.',
          choice('newBadgeDays', [[0, 'Off'], [3, 'Added in the last 3 days'], [7, 'Added in the last 7 days'], [14, 'Added in the last 2 weeks'], [30, 'Added in the last 30 days']], true)),
        row('Reset saved sorting', 'Every library remembers its own sort, order, filter and card size.', button('Reset', {
          onclick: () => {
            const before = store.get('librarySort') || {};
            store.set('librarySort', {});
            toast('Library sorting reset', 'info', 6000, { label: 'Undo', onClick: () => store.set('librarySort', before) });
          },
        }))),
    ]],
    ['appearance', 'Appearance', 'palette', () => [
      section('Appearance',
        row('Accent colour', 'Starlight is Nova\'s own. Windows uses your accent colour, lightened if it needs more contrast.',
          choice('accentSource', [['starlight', 'Starlight'], ['windows', 'My Windows accent colour']])),
        row('Tint pages with the artwork', 'Movie and show pages take a soft colour from the poster.', toggle('ambientTint')),
        row('Reduce transparency', 'A solid sidebar instead of Mica, and no blur over video. Mica changes after a restart.', toggle('reduceTransparency')),
        row('Motion', 'Reduce turns slides and zooms into plain fades.', choice('motion', [['system', 'Follow Windows'], ['reduce', 'Reduce'], ['full', 'Full']])),
        row('Zoom', 'Ctrl + and Ctrl − also work anywhere; Ctrl 0 resets.', h('div', { class: 'range' },
          button('−', { cls: 'small-btn', onclick: () => zoomBy(-1), title: 'Zoom out' }),
          zoomLabel,
          button('+', { cls: 'small-btn', onclick: () => zoomBy(1), title: 'Zoom in' }),
          button('Reset', { cls: 'small-btn btn-quiet', onclick: () => { setZoom(1); zoomLabel.textContent = '100%'; } })))),
    ]],
    ['shortcuts', 'Shortcuts', 'keyboard', () => [
      section('Keyboard shortcuts', h('div', { class: 'setting-text' }, 'Press ? anywhere to see these.'), shortcutList()),
    ]],
    ['account', 'Account', 'logout', () => [
      section('Account',
        row('Server', server?.url, h('span', { class: 'muted' }, server?.name || '')),
        row('Signed in as', null, h('span', { class: 'muted' }, user?.Name || '')),
        h('div', { class: 'setting-actions' },
          button('Switch user', { onclick: () => signOut(undefined, { keepServer: true }) }),
          button('Switch server', { onclick: () => signOut(undefined, { changeServer: true }) }),
          button('Sign out', { variant: 'danger', onclick: () => signOut() })),
        row('Reset all settings', 'Puts every setting back to how Nova came. Your sign-in, sorting and remembered series stay.', button('Reset…', {
          variant: 'danger',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Reset all settings?',
              body: 'Playback, subtitle, sound and appearance settings go back to their defaults. This can\'t be undone.',
              confirm: 'Reset settings',
              danger: true,
            });
            if (!ok) return;
            for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) store.setSetting(k, v);
            render(current);
            toast('Settings reset');
          },
        }))),
    ]],
    ['updates', 'Updates', 'download', () => [
      section('Updates',
        row('Install updates automatically', 'New versions download in the background and install when you close Nova.', toggle('autoUpdate')),
        row('Get beta versions', 'Try new versions before everyone else. Betas can have rough edges.', toggle('betaUpdates')),
        row(`Nova Player ${appInfo().version || CLIENT_VERSION}`, updateStatus, h('div', { class: 'setting-control' },
          updateAction,
          button('Check now', {
            onclick: async () => {
              updateStatus.textContent = 'Checking for updates…';
              renderUpdate(await checkForUpdates());
            },
          })))),
    ]],
    ['about', 'About', 'info', () => [
      section('About Nova',
        row(`Nova Player ${appInfo().version || CLIENT_VERSION}`, 'A Jellyfin player for Windows.', button('Website', { cls: 'small-btn', onclick: () => window.nova.openExternal(appInfo().homepage) })),
        row('This PC can direct play', `Video: ${caps.video.join(', ').toUpperCase()} · Audio: ${caps.audio.join(', ').toUpperCase()}${caps.mkv ? ' · MKV' : ''}`, ''),
        row('Jellyfin server', `${api.base}${api.serverVersion ? ` · ${api.serverVersion}` : ''}`, '')),
      section('Privacy',
        h('p', { class: 'setting-text' }, 'Nova only talks to your Jellyfin server and, to check for updates, to GitHub. It sends no usage data, analytics or crash reports anywhere.')),
      section('Diagnostics',
        row('Copy debug info', 'Versions, settings and recent errors, with your server address and sign-in removed. Paste it into a GitHub issue.',
          button('Copy', { icon: 'copy', onclick: () => copyText(debugInfo(), 'Debug info copied') }))),
      section('Open-source licences',
        h('div', { class: 'memory-list' }, LICENCES.map(([name, lic, url]) => h('div', { class: 'memory-item' },
          h('div', null, h('div', { class: 'memory-name' }, name), h('div', { class: 'muted small' }, lic)),
          button('View', { cls: 'small-btn btn-quiet', onclick: () => window.nova.openExternal(url) }))))),
    ]],
  ];

  const cats = h('div', { class: 'settings-cats', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings categories' });
  const panes = h('div', { class: 'settings-panes', role: 'tabpanel' });
  const search = h('input', { class: 'input settings-search', type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings' });
  let current = PANES.some(([k]) => k === lastCategory) ? lastCategory : 'playback';

  function render(key) {
    current = key;
    lastCategory = key;
    const q = search.value.trim().toLowerCase();
    fill(cats, PANES.map(([k, label, ic]) => h('button', {
      class: 'settings-cat',
      role: 'tab',
      id: `cat-${k}`,
      'aria-selected': String(!q && k === key),
      tabindex: k === key ? 0 : -1,
      onclick: () => {
        search.value = '';
        render(k);
      },
    }, icon(ic), h('span', null, label))));
    if (!q) {
      panes.setAttribute('aria-labelledby', `cat-${key}`);
      fill(panes, PANES.find(([k]) => k === key)[3]());
    } else {
      // Searching shows matching settings from every pane.
      panes.removeAttribute('aria-labelledby');
      const all = PANES.flatMap(([, , , build]) => build());
      for (const sec of all) {
        let any = false;
        for (const r of sec.querySelectorAll('.setting')) {
          const hit = r.dataset.search?.includes(q);
          r.classList.toggle('hidden', !hit);
          any ||= hit;
        }
        if (!any && !sec.querySelector('h2')?.textContent.toLowerCase().includes(q)) sec.classList.add('hidden');
      }
      const shown = all.filter((s) => !s.classList.contains('hidden'));
      fill(panes, shown.length ? shown : h('div', { class: 'no-match' }, `No settings match "${search.value.trim()}".`));
    }
    updatePreview();
  }

  // Arrow keys move between categories.
  cats.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = PANES.findIndex(([k]) => k === current);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? PANES.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + PANES.length) % PANES.length;
    render(PANES[n][0]);
    cats.querySelector(`#cat-${PANES[n][0]}`)?.focus();
  });
  search.addEventListener('input', () => render(current));

  el.append(
    h('div', { class: 'settings-head' }, h('h1', null, 'Settings'), search),
    h('div', { class: 'settings-body' }, cats, panes));
  render(current);

  return { el, title: 'Settings', onShow: renderMemory, destroy: unsubUpdate };
}

export function applySubtitleStyle(layer) {
  const size = store.setting('subSize') / 100;
  const bg = store.setting('subBg') / 100;
  layer.style.setProperty('--sub-scale', size);
  layer.style.setProperty('--sub-color', store.setting('subColor'));
  layer.style.setProperty('--sub-bg', `rgba(0,0,0,${bg})`);
  layer.style.setProperty('--sub-bottom', `${store.setting('subPosition')}%`);
  const font = store.setting('subFont');
  if (font) layer.style.setProperty('--sub-font', `'${font}', sans-serif`);
  else layer.style.removeProperty('--sub-font');
  // Older versions had an on/off outline; off means no edge.
  const edge = store.setting('subOutline') === false && store.setting('subEdge') === 'outline' ? 'none' : store.setting('subEdge');
  layer.classList.toggle('outline', edge === 'outline');
  layer.classList.toggle('edge-shadow', edge === 'shadow');
  layer.classList.toggle('edge-raised', edge === 'raised');
}
