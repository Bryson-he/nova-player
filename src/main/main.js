'use strict';
const {
  app, BrowserWindow, ipcMain, protocol, net, session, safeStorage, shell, powerSaveBlocker, screen, Menu, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const { pathToFileURL } = require('url');
const {
  isInside, originOf, isPrivateHost, isEncrypted, serverCandidates, safeFileName, validStoreWrite, MAX_STORE_BYTES, buildCsp,
} = require('./security');
const { CHANNELS } = require('./ipc-contract');

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
const APP_ORIGIN = 'app://nova';
const DEBUG = !!process.env.NOVA_DEBUG;
const CLIENT_NAME = 'Nova Player';
const DEVICE_NAME = 'Windows PC';

// Window colours come from the design tokens (src/renderer/styles/tokens.css).
const BG = '#0e0e10';
const TEXT = '#f2f2f3';
const TITLEBAR_HEIGHT = 48;
// Mica needs Windows 11 (build 22000+); Windows 10 gets the solid background.
const IS_WIN11 = process.platform === 'win32' && Number(process.getSystemVersion().split('.')[2]) >= 22000;
const useMica = () => IS_WIN11 && store.settings?.reduceTransparency !== true;
const overlayColors = (dark) => (dark
  ? { color: '#000000', symbolColor: '#ffffff' }
  : { color: useMica() ? '#00000000' : BG, symbolColor: TEXT });

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Exposes HTMLMediaElement.audioTracks so embedded audio tracks can be switched
// instantly during direct play instead of restarting the stream.
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

let win = null;
let miniRestore = null;
let store = {};
let saveTimer = null;
let powerBlockId = null;

// The Jellyfin login lives here only. The page never sees the token: it is
// added as an Authorization header to requests for the server it was issued
// for (see installNetworkHooks), and the page only learns whether one exists.
let auth = { origin: null, base: null, token: null };
let tokenSaved = true;
// The server being probed during sign-in, before any token exists.
let pendingOrigin = null;

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

// Without OS encryption the token is kept in memory only, never written in
// plain text; the user signs in again next launch.
function encryptToken(token) {
  if (!token || !safeStorage.isEncryptionAvailable()) return undefined;
  return 'enc:' + safeStorage.encryptString(token).toString('base64');
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

function loadAuth() {
  const token = decryptToken(store.token);
  const base = store.tokenBase || store.server?.url || null; // 1.3.0 saved no tokenBase
  const origin = base && originOf(base);
  if (!token || !origin) {
    auth = { origin: null, base: null, token: null };
    return;
  }
  auth = { origin, base, token };
  // Older versions fell back to a plain-text "raw:" token. Re-save it encrypted, or drop it from disk.
  if (store.token.startsWith('raw:') || !store.tokenBase) saveAuth();
}

function saveAuth() {
  const enc = encryptToken(auth.token);
  tokenSaved = !auth.token || !!enc;
  store.token = enc;
  store.tokenBase = auth.token ? auth.base : undefined;
  scheduleSave();
}

function authHeader(token) {
  const deviceId = typeof store.deviceId === 'string' ? store.deviceId : '';
  const parts = [`Client="${CLIENT_NAME}"`, `Device="${DEVICE_NAME}"`, `DeviceId="${deviceId}"`, `Version="${app.getVersion()}"`];
  if (token) parts.push(`Token="${token}"`);
  return 'MediaBrowser ' + parts.join(', ');
}

async function jellyfin(base, route, { method = 'GET', body, token, timeout = 8000 } = {}) {
  const res = await net.fetch(base + route, {
    method,
    headers: {
      Authorization: authHeader(token),
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const describe = (err) => (err?.name === 'TimeoutError' ? 'Request timed out' : String(err?.message || err));

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
    backgroundColor: useMica() ? '#00000000' : BG,
    ...(useMica() ? { backgroundMaterial: 'mica' } : {}),
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayColors(false), height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'generated', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${APP_ORIGIN}/index.html`);

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isFullScreen() || win.isMinimized() || miniRestore) return;
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
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) e.preventDefault();
  });

  // Developer tools only with NOVA_DEBUG set, or in a dev checkout.
  if (DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  else if (app.isPackaged) win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());

  // Reload after a crash, but no more than 3 times a minute; then show a static page.
  const crashes = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer gone', details);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    crashes.push(now);
    if (crashes.length > 3) win.loadURL(`${APP_ORIGIN}/crash.html`);
    else win.reload();
  });

  // Closing mid-playback: give the page up to 1.5 s to tell the server
  // playback stopped (and save the position) before the window goes.
  let closeReady = false;
  win.on('close', (e) => {
    if (closeReady || win.webContents.isCrashed()) return;
    e.preventDefault();
    if (closeWaiter) return;
    closeWaiter = () => {
      closeWaiter = null;
      closeReady = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.close();
    };
    const timer = setTimeout(() => closeWaiter?.(), 1500);
    win.webContents.send('app:before-close');
  });
}
let closeWaiter = null;

// Jellyfin answers a UDP broadcast on port 7359 with its name and address.
function discoverServers(timeout = 1500) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const done = () => {
      try {
        sock?.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    sock.on('error', done);
    sock.on('message', (msg) => {
      try {
        const j = JSON.parse(msg.toString('utf8'));
        const url = typeof j.Address === 'string' && originOf(j.Address) ? j.Address.replace(/\/+$/, '') : null;
        if (j.Id && url) found.set(String(j.Id), { id: String(j.Id).slice(0, 64), name: String(j.Name || '').slice(0, 100), url });
      } catch {
        // not a Jellyfin reply
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.send('who is JellyfinServer?', 7359, '255.255.255.255');
      } catch {
        done();
        return;
      }
      setTimeout(done, timeout);
    });
  });
}

// External links open in the browser: HTTPS only, and anything outside a
// short list of well-known sites asks first, showing the host.
const KNOWN_HOSTS = ['youtube.com', 'youtu.be', 'github.com', 'jellyfin.org', 'imdb.com', 'themoviedb.org', 'thetvdb.com', 'bryson-he.github.io'];

async function openExternalSafe(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'https:') return;
  const host = u.hostname.toLowerCase();
  const known = KNOWN_HOSTS.some((k) => host === k || host.endsWith('.' + k));
  if (!known) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Open in browser', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Open a link to ${host}?`,
      detail: u.href.length > 300 ? u.href.slice(0, 300) + '…' : u.href,
    });
    if (response !== 0) return;
  }
  shell.openExternal(u.href);
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(RENDERER_DIR, rel);
    if (!isInside(RENDERER_DIR, file)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    // Never serve app files from cache: after an update the same paths hold new code.
    headers.set('Cache-Control', 'no-cache');
    // The policy names the signed-in server, so it is sent per load, not baked into the file.
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', buildCsp(auth.token ? auth.origin : null));
    return new Response(res.body, { status: res.status, headers });
  });
}

// Only the signed-in server, or the one being probed during sign-in, is touched.
function isJellyfin(url) {
  const o = originOf(url);
  return !!o && (o === auth.origin || o === pendingOrigin);
}

function installNetworkHooks() {
  const { webRequest } = session.defaultSession;

  // The token rides in a header, never in a URL (Jellyfin 10.11 also rejects api_key).
  webRequest.onBeforeSendHeaders((details, callback) => {
    if (!auth.token || originOf(details.url) !== auth.origin) return callback({});
    const requestHeaders = {};
    for (const [k, v] of Object.entries(details.requestHeaders)) {
      if (!/^(authorization|x-emby-authorization|x-emby-token|x-mediabrowser-token)$/i.test(k)) requestHeaders[k] = v;
    }
    requestHeaders.Authorization = authHeader(auth.token);
    callback({ requestHeaders });
  });

  // Some reverse proxies strip CORS headers from Jellyfin. Re-add them so the
  // app works no matter how the server is exposed.
  webRequest.onHeadersReceived((details, callback) => {
    if (!isJellyfin(details.url)) return callback({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!/^access-control-/i.test(k)) headers[k] = v;
    }
    headers['Access-Control-Allow-Origin'] = [APP_ORIGIN];
    headers['Access-Control-Allow-Headers'] = ['Authorization, Content-Type, Accept, Range, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS, HEAD'];
    headers['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Content-Type'];
    const result = { responseHeaders: headers };
    if (details.method === 'OPTIONS') result.statusLine = 'HTTP/1.1 204 No Content';
    callback(result);
  });
}

// Electron's default is to grant whatever a page asks for. Nova only needs
// fullscreen and writing to the clipboard ("Copy details").
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
function installPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

// Every handler goes through the contract: the sender must be our own page
// and each argument must pass its check, or the call is dropped.
function fromApp(event) {
  return !!win && event.sender === win.webContents && !!event.senderFrame?.url?.startsWith(APP_ORIGIN + '/');
}

function argsOk(def, args) {
  return args.length <= def.args.length && def.args.every((check, i) => check(args[i]));
}

const registered = new Set();

function handle(channel, fn) {
  const def = CHANNELS[channel];
  if (!def || def.kind === 'event') throw new Error(`Unknown IPC channel ${channel}`);
  registered.add(channel);
  if (def.kind === 'invoke') {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromApp(event) || !argsOk(def, args)) throw new Error(`Rejected ${channel}`);
      return fn(event, ...args);
    });
  } else {
    ipcMain.on(channel, (event, ...args) => {
      if (fromApp(event) && argsOk(def, args)) fn(event, ...args);
    });
  }
}

function registerIpc() {
  handle('store:get', () => {
    const { token: _t, tokenBase: _b, window: _w, cachedVersion: _c, ...rest } = store;
    let serverInsecure = false;
    try {
      const u = new URL(store.server?.url);
      serverInsecure = u.protocol === 'http:' && !isPrivateHost(u.hostname);
    } catch {
      // no server yet
    }
    return { ...rest, signedIn: !!auth.token, tokenSaved, serverInsecure };
  });

  handle('store:set', (_e, key, value) => {
    if (!validStoreWrite(key, value)) return;
    const had = Object.prototype.hasOwnProperty.call(store, key);
    const prev = store[key];
    if (value === undefined || value === null) delete store[key];
    else store[key] = value;
    if (JSON.stringify(store).length > MAX_STORE_BYTES) {
      if (had) store[key] = prev;
      else delete store[key];
      console.error(`Store write for ${key} refused: store is full`);
      return;
    }
    scheduleSave();
  });

  // ---- sign-in (the token never reaches the page)

  handle('server:find', async (_e, input) => {
    const candidates = serverCandidates(input);
    if (!candidates.length) return { error: 'Enter your server address' };
    let lastErr = null;
    for (const base of candidates) {
      try {
        const info = await jellyfin(base, '/System/Info/Public', { timeout: 6000 });
        if (info?.Id) {
          pendingOrigin = originOf(base);
          return {
            base,
            info: { Id: info.Id, ServerName: info.ServerName, Version: info.Version },
            encrypted: isEncrypted(base),
            privateHost: isPrivateHost(new URL(base).hostname),
          };
        }
      } catch (err) {
        lastErr = err;
      }
    }
    const why = lastErr ? ` (${describe(lastErr)})` : '';
    return { error: `Couldn't reach a Jellyfin server at "${input.trim()}"${why}. Check the address and port, and that the server is running.` };
  });

  handle('server:discover', () => discoverServers());

  handle('auth:signIn', async (_e, req) => {
    const base = req.base.replace(/\/+$/, '');
    const origin = originOf(base);
    if (!origin || (origin !== pendingOrigin && origin !== auth.origin)) return { ok: false, message: 'Connect to the server first.' };
    try {
      const res = req.secret !== undefined
        ? await jellyfin(base, '/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: req.secret }, timeout: 20000 })
        : await jellyfin(base, '/Users/AuthenticateByName', { method: 'POST', body: { Username: req.username, Pw: req.password }, timeout: 20000 });
      if (!res?.AccessToken || !res.User?.Id) return { ok: false, message: 'The server sent an unexpected reply.' };
      auth = { origin, base, token: res.AccessToken };
      pendingOrigin = null;
      saveAuth();
      const { Id, Name, PrimaryImageTag } = res.User;
      return { ok: true, user: { Id, Name, PrimaryImageTag }, tokenSaved };
    } catch (err) {
      return { ok: false, status: err.status, message: describe(err) };
    }
  });

  handle('auth:signOut', async () => {
    if (auth.token) await jellyfin(auth.base, '/Sessions/Logout', { method: 'POST', token: auth.token, timeout: 4000 }).catch(() => {});
    auth = { origin: null, base: null, token: null };
    saveAuth();
    return true;
  });

  // ---- window and system

  handle('power:block', (_e, on) => {
    if (on && powerBlockId === null) {
      powerBlockId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!on && powerBlockId !== null) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = null;
    }
  });

  handle('win:fullscreen', (_e, value) => {
    if (!win) return false;
    win.setFullScreen(typeof value === 'boolean' ? value : !win.isFullScreen());
    return win.isFullScreen();
  });

  handle('win:overlay', (_e, dark) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay(overlayColors(dark));
    } catch {
      // Not supported on this platform.
    }
  });

  handle('open-external', (_e, url) => openExternalSafe(url));

  // Screenshots go to Pictures\Nova Player.
  const shotsDir = () => path.join(app.getPath('pictures'), 'Nova Player');
  handle('screenshot:save', async (_e, bytes, name) => {
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('Screenshot too large');
    const dir = shotsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const safe = safeFileName(name);
    let file = path.join(dir, `${safe}.png`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safe} (${i}).png`);
    const data = ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes);
    await fs.promises.writeFile(file, data);
    return file;
  });
  handle('shell:show', (_e, file) => {
    if (isInside(shotsDir(), file)) shell.showItemInFolder(file);
  });

  // Mini player: small always-on-top 16:9 window in the corner of the screen.
  handle('win:mini', (_e, on) => {
    if (!win) return false;
    if (on && !miniRestore) {
      miniRestore = { bounds: win.getBounds(), maximized: win.isMaximized() };
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      const w = 512;
      const h = 288;
      win.setMinimumSize(320, 180);
      win.setBounds({ x: wa.x + wa.width - w - 24, y: wa.y + wa.height - h - 24, width: w, height: h });
      win.setAspectRatio(16 / 9);
      win.setAlwaysOnTop(true, 'floating');
    } else if (!on && miniRestore) {
      const restore = miniRestore;
      miniRestore = null;
      win.setAlwaysOnTop(false);
      win.setAspectRatio(0);
      win.setMinimumSize(960, 580);
      win.setBounds(restore.bounds);
      if (restore.maximized) win.maximize();
    }
    return !!miniRestore;
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    homepage: require('../../package.json').homepage,
    mica: useMica(),
  }));
  handle('app:close-ready', () => closeWaiter?.());
  handle('update:state', () => updateState);
  handle('update:check', () => checkForUpdates(true));
  handle('update:install', () => {
    // Silent install (no setup wizard), then relaunch Nova.
    if (updateState.state === 'ready') autoUpdater?.quitAndInstall(true, true);
  });

  const missing = Object.keys(CHANNELS).filter((ch) => CHANNELS[ch].kind !== 'event' && !registered.has(ch));
  if (missing.length) throw new Error(`IPC channels without a handler: ${missing.join(', ')}`);
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

app.whenReady().then(async () => {
  if (app.isPackaged && !DEBUG) Menu.setApplicationMenu(null); // no reload / devtools shortcuts
  loadStore();
  // A new version may reuse the same file paths; drop anything cached by the old one.
  if (store.cachedVersion !== app.getVersion()) {
    await session.defaultSession.clearCache().catch(() => {});
    store.cachedVersion = app.getVersion();
    scheduleSave();
  }
  loadAuth();
  registerProtocol();
  installNetworkHooks();
  installPermissionHandlers();
  registerIpc();
  createWindow();
  setupUpdater();
});

app.on('before-quit', () => {
  clearTimeout(saveTimer);
  writeStoreSync();
});

app.on('window-all-closed', () => app.quit());
