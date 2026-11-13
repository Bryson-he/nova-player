import { initStore, store } from './store.js';
import { api } from './api.js';
import { h, icon, iconBtn, toast, popupMenu, initTooltips } from './ui.js';
import { applyAppearance } from './appearance.js';
import './diagnostics.js';
import { initRouter, navigate, back, forward, canGoBack, canGoForward, onRouteChange, resetRouter, current } from './router.js';
import { isPlayerOpen, closePlayer, closePlayerAndReport, openPlayer } from './player.js';
import { loginView } from './views/login.js';
import { homeView } from './views/home.js';
import { libraryView } from './views/library.js';
import { itemView } from './views/item.js';
import { searchView } from './views/search.js';
import { settingsView } from './views/settings.js';
import { initUpdates, updateCard, appInfo } from './updates.js';
import { maybeShowWhatsNew } from './whatsnew.js';
import { showShortcuts } from './shortcuts.js';

const root = document.getElementById('app');
const SUPPORTED_LIBS = new Set(['movies', 'tvshows', 'boxsets', 'homevideos', 'musicvideos', 'mixed', undefined, null, '']);
let libraries = [];

let signingOut = false;
api.onUnauthorized = () => {
  if (!signingOut) signOut('Your session expired or was signed out on the server. Please sign in again.');
};

// Jump list "Continue watching" entries start playback.
window.nova.onPlayRequest((id) => {
  if (store.signedIn) openPlayer(id);
});

// The window is closing: report playback stopped first (main waits up to 1.5 s).
window.nova.onBeforeClose(async () => {
  try {
    await closePlayerAndReport();
  } finally {
    window.nova.closeReady();
  }
});

async function boot() {
  await Promise.all([initStore(), initUpdates()]);
  if (appInfo().version) api.version = appInfo().version;
  if (appInfo().mica) document.documentElement.classList.add('mica');
  applyAppearance();
  initTooltips();
  const server = store.get('server');
  const user = store.get('user');
  if (server?.url && user?.Id && store.signedIn) {
    api.configure({ base: server.url, signedIn: true, userId: user.Id, serverVersion: server.version });
    showShell();
    maybeShowWhatsNew(appInfo().version);
    if (!store.tokenSaved) toast("Windows couldn't encrypt your sign-in, so it isn't saved. You'll sign in again next time.", 'error', 8000);
    // Validate the saved session in the background; never block startup on it.
    api.me().catch((err) => {
      if (err.status === 401) signOut('Your session expired. Please sign in again.');
    });
    // The server may have been upgraded since sign-in; media URL auth depends on its version.
    api.request('/System/Info/Public', { timeout: 8000 })
      .then((info) => {
        if (info?.Version && info.Version !== server.version) {
          api.configure({ serverVersion: info.Version });
          store.set('server', { ...store.get('server'), version: info.Version });
        }
      })
      .catch(() => {});
  } else {
    showLogin(takeSignOutMessage());
  }
}

// The page reloads on sign-in and sign-out so its security policy names the
// right server; a sign-out message survives the reload here.
const SIGNOUT_KEY = 'nova:signout-message';
const STEP_KEY = 'nova:login-step';
function takeSession(key) {
  try {
    const v = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return v || undefined;
  } catch {
    return undefined;
  }
}
const takeSignOutMessage = () => takeSession(SIGNOUT_KEY);

export function showLogin(message) {
  closePlayer();
  resetRouter();
  // 'users': straight to this server's user list (Switch user); 'server': pick another server.
  root.replaceChildren(loginView({ onDone: onLoggedIn, message, start: takeSession(STEP_KEY) }));
}

function onLoggedIn({ server, auth }) {
  store.set('server', server);
  store.set('user', auth.user);
  location.reload();
}

export async function signOut(message, { keepServer = false, changeServer = false } = {}) {
  if (signingOut) return;
  signingOut = true;
  await closePlayerAndReport();
  await api.logout();
  store.set('user', null);
  try {
    if (message) sessionStorage.setItem(SIGNOUT_KEY, message);
    if (keepServer) sessionStorage.setItem(STEP_KEY, 'users');
    if (changeServer) sessionStorage.setItem(STEP_KEY, 'server');
  } catch {
    // These are niceties.
  }
  location.reload();
}

function showShell() {
  const backBtn = iconBtn('back', 'Back', () => back(), 'titlebar-back');
  const fwdBtn = iconBtn('arrowForward', 'Forward', () => forward(), 'titlebar-forward');
  backBtn.dataset.shortcut = 'Alt+Left';
  fwdBtn.dataset.shortcut = 'Alt+Right';
  const pageTitle = h('div', { class: 'titlebar-title', 'aria-live': 'polite' });
  searchInput = h('input', { type: 'search', placeholder: 'Search movies, shows and people', 'aria-label': 'Search', spellcheck: false });
  const titlebar = h('header', { class: 'titlebar' },
    h('div', { class: 'titlebar-nav' }, backBtn, fwdBtn),
    pageTitle,
    h('label', { class: 'titlebar-search' }, icon('search'), searchInput, h('span', { class: 'kbd', 'aria-hidden': 'true' }, 'Ctrl K')));

  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Main' });
  const update = updateCard();
  const content = h('main', { class: 'content', id: 'content' });
  root.replaceChildren(titlebar, h('div', { class: 'shell' }, nav, content));

  initRouter(content, {
    home: homeView,
    library: libraryView,
    item: itemView,
    search: searchView,
    settings: settingsView,
  });

  // Typing in the title bar search opens Search and updates it as you type.
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (current()?.name !== 'search') {
      if (!q.trim()) return;
      navigate('search', { q });
    } else {
      current().view.setQuery?.(q);
    }
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      if (current()?.name === 'search') back();
      searchInput.blur();
    } else if (e.key === 'Enter') {
      current()?.view.commit?.();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      current()?.view.focusResults?.();
    }
  });

  const renderNav = () => {
    const cur = current();
    const isActive = (name, id) => cur && cur.name === name && (id === undefined || cur.params.id === id);
    const link = (label, ic, active, onclick) =>
      h('button', { class: `nav-link${active ? ' active' : ''}`, onclick, title: label, 'aria-current': active ? 'page' : null }, icon(ic), h('span', null, label));
    const user = store.get('user');
    const server = store.get('server');
    nav.replaceChildren(
      h('div', { class: 'nav-group' },
        link('Home', 'home', isActive('home'), () => navigate('home', {}, { root: true }))),
      h('div', { class: 'nav-label' }, 'Libraries'),
      h('div', { class: 'nav-group nav-libs' },
        libraries.length
          ? libraries.map((lib) => link(lib.Name, libIcon(lib.CollectionType), isActive('library', lib.Id),
            () => navigate('library', { id: lib.Id, name: lib.Name, collectionType: lib.CollectionType }, { root: true })))
          : h('div', { class: 'nav-empty' }, 'Loading…')),
      h('div', { class: 'nav-spacer' }),
      update,
      h('div', { class: 'nav-group' },
        link('Settings', 'settings', isActive('settings'), () => navigate('settings'))),
      h('button', {
        class: 'nav-user',
        'aria-label': `Account: ${user?.Name || ''} on ${server?.name || server?.url || ''}`,
        'aria-haspopup': 'menu',
        onclick: (e) => accountMenu(e.currentTarget),
      },
      user?.PrimaryImageTag
        ? h('img', { class: 'avatar', src: api.userImage(user.Id, user.PrimaryImageTag), alt: '' })
        : h('div', { class: 'avatar avatar-letter' }, (user?.Name || '?')[0].toUpperCase()),
      h('div', { class: 'nav-user-text' },
        h('div', { class: 'nav-user-name' }, user?.Name || ''),
        h('div', { class: 'nav-user-server' },
          store.get('serverInsecure') ? h('span', { class: 'insecure-lock', title: 'Not encrypted: this server uses plain HTTP' }, icon('lockOpen')) : null,
          server?.name || server?.url || ''))));
    backBtn.disabled = !canGoBack();
    fwdBtn.disabled = !canGoForward();
    const title = cur?.title || '';
    pageTitle.textContent = title;
    document.title = title ? `${title} – Nova` : 'Nova Player';
    if (cur?.name !== 'search' && document.activeElement !== searchInput) searchInput.value = '';
  };

  onRouteChange(renderNav);
  navigate('home', {}, { root: true });
  renderNav();

  api.views()
    .then((r) => {
      libraries = (r?.Items || []).filter((v) => SUPPORTED_LIBS.has(v.CollectionType));
      renderNav();
    })
    .catch((err) => toast(`Couldn't load libraries: ${err.message}`, 'error'));
}

let searchInput = null;

export function focusSearch() {
  searchInput?.focus();
  searchInput?.select();
}

// The account row opens a menu instead of signing out on one click.
function accountMenu(anchor) {
  const server = store.get('server');
  popupMenu(anchor, [
    { label: 'Switch user', sub: server?.name || server?.url, onClick: () => signOut(undefined, { keepServer: true }) },
    { label: 'Switch server', onClick: () => signOut(undefined, { changeServer: true }) },
    { divider: true },
    { label: 'Sign out', danger: true, onClick: () => signOut() },
  ], { title: store.get('user')?.Name });
}

function libIcon(type) {
  if (type === 'movies') return 'movie';
  if (type === 'tvshows') return 'tv';
  if (type === 'boxsets') return 'collection';
  return 'folder';
}

// Global shortcuts (the player installs its own while open).
document.addEventListener('keydown', (e) => {
  if (isPlayerOpen() || document.querySelector('.modal-backdrop')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const key = e.key.toLowerCase();
  if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !typing)) {
    e.preventDefault();
    back();
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    forward();
  } else if (e.ctrlKey && (key === 'k' || key === 'f')) {
    e.preventDefault();
    focusSearch();
  } else if (e.ctrlKey && key === ',') {
    e.preventDefault();
    navigate('settings');
  } else if (e.key === '?' && !typing) {
    e.preventDefault();
    showShortcuts();
  }
});

// Mouse back and forward side buttons.
window.addEventListener('mouseup', (e) => {
  if (isPlayerOpen()) return;
  if (e.button === 3) {
    e.preventDefault();
    back();
  } else if (e.button === 4) {
    e.preventDefault();
    forward();
  }
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

boot().catch((err) => {
  console.error(err);
  root.replaceChildren(h('div', { class: 'error-box' }, `Startup failed: ${err.message}`));
});
