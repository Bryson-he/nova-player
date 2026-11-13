import { initStore, store } from './store.js';
import { api } from './api.js';
import { h, icon, iconBtn, toast } from './ui.js';
import { initRouter, navigate, back, canGoBack, onRouteChange, resetRouter, current } from './router.js';
import { isPlayerOpen, closePlayer, closePlayerAndReport } from './player.js';
import { loginView } from './views/login.js';
import { homeView } from './views/home.js';
import { libraryView } from './views/library.js';
import { itemView } from './views/item.js';
import { searchView } from './views/search.js';
import { settingsView } from './views/settings.js';
import { initUpdates, updateCard, appInfo } from './updates.js';
import { maybeShowWhatsNew } from './whatsnew.js';

const root = document.getElementById('app');
const SUPPORTED_LIBS = new Set(['movies', 'tvshows', 'boxsets', 'homevideos', 'musicvideos', 'mixed', undefined, null, '']);
let libraries = [];

let signingOut = false;
api.onUnauthorized = () => {
  if (!signingOut) signOut('Your session expired or was signed out on the server. Please sign in again.');
};

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
function takeSignOutMessage() {
  try {
    const msg = sessionStorage.getItem(SIGNOUT_KEY);
    sessionStorage.removeItem(SIGNOUT_KEY);
    return msg || undefined;
  } catch {
    return undefined;
  }
}

export function showLogin(message) {
  closePlayer();
  resetRouter();
  root.replaceChildren(loginView({ onDone: onLoggedIn, message }));
}

function onLoggedIn({ server, auth }) {
  store.set('server', server);
  store.set('user', auth.user);
  location.reload();
}

export async function signOut(message) {
  if (signingOut) return;
  signingOut = true;
  closePlayer();
  await api.logout();
  store.set('user', null);
  try {
    if (message) sessionStorage.setItem(SIGNOUT_KEY, message);
  } catch {
    // The message is a nicety.
  }
  location.reload();
}

function showShell() {
  const backBtn = iconBtn('back', 'Back (Alt+←)', () => back(), 'titlebar-back');
  const titlebar = h('header', { class: 'titlebar' },
    backBtn,
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('play')), 'Nova'),
    h('div', { class: 'titlebar-fill' }));

  const nav = h('nav', { class: 'sidebar' });
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

  const renderNav = () => {
    const cur = current();
    const isActive = (name, id) => cur && cur.name === name && (id === undefined || cur.params.id === id);
    const link = (label, ic, active, onclick) =>
      h('button', { class: `nav-link${active ? ' active' : ''}`, onclick }, icon(ic), h('span', null, label));
    const user = store.get('user');
    const server = store.get('server');
    nav.replaceChildren(
      h('div', { class: 'nav-group' },
        link('Home', 'home', isActive('home'), () => navigate('home', {}, { root: true })),
        link('Search', 'search', isActive('search'), () => navigate('search'))),
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
      h('div', { class: 'nav-user' },
        user?.PrimaryImageTag
          ? h('img', { class: 'avatar', src: api.userImage(user.Id, user.PrimaryImageTag), alt: '' })
          : h('div', { class: 'avatar avatar-letter' }, (user?.Name || '?')[0].toUpperCase()),
        h('div', { class: 'nav-user-text' },
          h('div', { class: 'nav-user-name' }, user?.Name || ''),
          h('div', { class: 'nav-user-server' },
            store.get('serverInsecure') ? h('span', { class: 'insecure-lock', title: 'Not encrypted: this server uses plain HTTP' }, icon('lockOpen')) : null,
            server?.name || server?.url || '')),
        iconBtn('logout', 'Sign out', () => signOut())));
    backBtn.classList.toggle('hidden', !canGoBack());
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

function libIcon(type) {
  if (type === 'movies') return 'movie';
  if (type === 'tvshows') return 'tv';
  if (type === 'boxsets') return 'collection';
  return 'folder';
}

// Global navigation shortcuts (the player installs its own while open).
document.addEventListener('keydown', (e) => {
  if (isPlayerOpen()) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !typing)) {
    e.preventDefault();
    back();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    navigate('search');
  }
});

// Mouse "back" side button.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3 && !isPlayerOpen()) {
    e.preventDefault();
    back();
  }
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

boot().catch((err) => {
  console.error(err);
  root.replaceChildren(h('div', { class: 'error-box' }, `Startup failed: ${err.message}`));
});
