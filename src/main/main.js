'use strict';
const {
  app, BrowserWindow, ipcMain, protocol, net, session, safeStorage, shell, powerSaveBlocker, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// NOVA_PROFILE runs a separate, isolated profile (handy for testing a second server).
if (process.env.NOVA_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), `Nova Player (${process.env.NOVA_PROFILE})`));
}

// Only one copy may run: a second launch just focuses the existing window
// (see 'second-instance'). Exit before Chromium touches the locked profile.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Exposes HTMLMediaElement.audioTracks so embedded audio tracks can be switched
// instantly during direct play instead of restarting the stream.
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

let win = null;
let store = {};
let saveTimer = null;
let powerBlockId = null;

const storeFile = () => path.join(app.getPath('userData'), 'nova-store.json');

function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) || {};
  } catch {
    store = {};
  }
}

function writeStoreSync() {
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(store));
  } catch (err) {
    console.error('Failed to save store', err);
  }
}

// Writes are async and debounced so the UI never waits on disk.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = storeFile() + '.tmp';
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(store));
      await fs.promises.rename(tmp, storeFile());
    } catch (err) {
      console.error('Failed to save store', err);
    }
  }, 400);
}

function encryptToken(token) {
  if (!token) return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(token).toString('base64');
  }
  return 'raw:' + token;
}

function decryptToken(value) {
  if (!value) return null;
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('raw:')) return value.slice(4);
  } catch {
    // Token cannot be decrypted (different Windows user, etc.): force a fresh login.
  }
  return null;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function boundsVisible(b) {
  return screen.getAllDisplays().some(({ workArea: d }) =>
    b.x < d.x + d.width - 50 && b.x + b.width > d.x + 50 && b.y < d.y + d.height - 50 && b.y + b.height > d.y);
}

function createWindow() {
  const saved = store.window || {};
  const bounds = { width: saved.width || 1440, height: saved.height || 880 };
  if (saved.x !== undefined && boundsVisible({ ...bounds, x: saved.x, y: saved.y })) {
    bounds.x = saved.x;
    bounds.y = saved.y;
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 580,
    show: false,
    title: 'Nova Player',
    backgroundColor: '#0b0d12',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#e6e8ef', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://nova/index.html');

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isFullScreen() || win.isMinimized()) return;
    if (win.isMaximized()) {
      store.window = { ...(store.window || {}), maximized: true };
    } else {
      store.window = { ...win.getBounds(), maximized: false };
    }
    scheduleSave();
  };
  const debouncedSave = debounce(saveBounds, 500);
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);
  win.on('close', saveBounds);

  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer gone', details);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });
}

function registerProtocol() {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// Some reverse proxies strip CORS headers from Jellyfin. Re-add them so the
// app works no matter how the server is exposed.
function installCorsShim() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!/^https?:/i.test(details.url)) return callback({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!/^access-control-/i.test(k)) headers[k] = v;
    }
    headers['Access-Control-Allow-Origin'] = ['app://nova'];
    headers['Access-Control-Allow-Headers'] = ['Authorization, Content-Type, Accept, Range, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS, HEAD'];
    headers['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Content-Type'];
    const result = { responseHeaders: headers };
    if (details.method === 'OPTIONS') result.statusLine = 'HTTP/1.1 204 No Content';
    callback(result);
  });
}

function registerIpc() {
  ipcMain.handle('store:get', () => {
    const { token, window: _w, ...rest } = store;
    return { ...rest, token: decryptToken(token) };
  });

  ipcMain.on('store:set', (_e, key, value) => {
    if (typeof key !== 'string' || key === 'token' || key === 'window') return;
    if (value === undefined || value === null) delete store[key];
    else store[key] = value;
    scheduleSave();
  });

  ipcMain.on('store:token', (_e, token) => {
    store.token = token ? encryptToken(token) : undefined;
    scheduleSave();
  });

  ipcMain.on('power:block', (_e, on) => {
    if (on && powerBlockId === null) {
      powerBlockId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!on && powerBlockId !== null) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = null;
    }
  });

  ipcMain.handle('win:fullscreen', (_e, value) => {
    if (!win) return false;
    win.setFullScreen(typeof value === 'boolean' ? value : !win.isFullScreen());
    return win.isFullScreen();
  });

  ipcMain.on('win:overlay', (_e, dark) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay(dark
        ? { color: '#000000', symbolColor: '#ffffff' }
        : { color: '#0b0d12', symbolColor: '#e6e8ef' });
    } catch {
      // Not supported on this platform.
    }
  });

  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    homepage: require('../../package.json').homepage,
  }));
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.on('update:install', () => {
    if (updateState.state === 'ready') autoUpdater?.quitAndInstall(false, true);
  });
}

// ---------------------------------------------------------------- auto-update
//
// Updates come from GitHub Releases. They download quietly in the background
// and install when you close the app, or right away if you click
// "Restart to update". The portable .exe can't self-update, so it only
// tells you a new version exists.

let autoUpdater = null;
let updateState = { state: 'idle' };
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;

function setUpdateState(next) {
  updateState = { ...next, portable: isPortable };
  if (win && !win.isDestroyed()) win.webContents.send('update', updateState);
}

function setupUpdater() {
  if (!app.isPackaged) {
    updateState = { state: 'dev' };
    return;
  }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('electron-updater unavailable', err);
    return;
  }
  autoUpdater.autoDownload = !isPortable;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdateState({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdateState({ state: 'latest' }));
  autoUpdater.on('update-available', (info) => setUpdateState({ state: isPortable ? 'available' : 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ ...updateState, state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => setUpdateState({ state: 'error', message: String(err?.message || err).split('\n')[0] }));

  const autoCheck = () => {
    if (store.settings?.autoUpdate !== false) checkForUpdates(false);
  };
  setTimeout(autoCheck, 8000);
  setInterval(autoCheck, 4 * 60 * 60 * 1000);
}

async function checkForUpdates(manual) {
  if (!autoUpdater) {
    if (manual) setUpdateState({ state: 'dev' });
    return updateState;
  }
  if (['downloading', 'ready'].includes(updateState.state)) return updateState;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdateState({ state: 'error', message: String(err?.message || err).split('\n')[0] });
  }
  return updateState;
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  loadStore();
  registerProtocol();
  installCorsShim();
  registerIpc();
  createWindow();
  setupUpdater();
});

app.on('before-quit', () => {
  clearTimeout(saveTimer);
  writeStoreSync();
});

app.on('window-all-closed', () => app.quit());
