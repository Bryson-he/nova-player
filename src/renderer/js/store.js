// Persistent app state. Lives in the main process (JSON file in %APPDATA%),
// mirrored here so reads are synchronous and writes never block the UI.

export const DEFAULT_SETTINGS = {
  maxBitrate: 120000000,
  forceTranscode: false,
  autoplayNext: true,
  nextUpCountdown: 10,
  skipIntro: 'button', // off | button | auto
  skipCredits: true,
  startFullscreen: false,
  audioLang: '',
  subMode: 'server', // server | off | forced | always | smart
  subLang: '',
  subSize: 100,
  subColor: '#ffffff',
  subBg: 0,
  subPosition: 8,
  subOutline: true,
  seekBack: 10,
  seekForward: 30,
  rememberTracks: true,
  autoUpdate: true,
  styledSubs: true, // render ASS/SSA with libass (fonts, positioning, karaoke)
  volumeBoost: 1, // 1 = 100%, up to 3 = 300%
  nightMode: false, // dynamic range compression + dialogue lift
  bufferSize: 'normal', // normal | large | max  (streamed/transcoded playback)
  newBadgeDays: 7, // how long something counts as NEW (0 = off)
};

let data = {};
const settingListeners = new Set();

export async function initStore() {
  data = (await window.nova.getStore()) || {};
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data.librarySort ||= {};
  data.seriesTracks ||= {};
  data.subDelays ||= {};
  if (!data.deviceId) {
    data.deviceId = crypto.randomUUID().replace(/-/g, '');
    window.nova.set('deviceId', data.deviceId);
  }
}

export const store = {
  get(key) {
    return data[key];
  },
  set(key, value) {
    data[key] = value;
    window.nova.set(key, value);
  },
  setting(key) {
    return data.settings[key];
  },
  setSetting(key, value) {
    data.settings = { ...data.settings, [key]: value };
    window.nova.set('settings', data.settings);
    for (const fn of settingListeners) fn(key, value);
  },
  get token() {
    return data.token || null;
  },
  setToken(token) {
    data.token = token || null;
    window.nova.setToken(token || null);
  },
};

export function onSettingChange(fn) {
  settingListeners.add(fn);
  return () => settingListeners.delete(fn);
}
