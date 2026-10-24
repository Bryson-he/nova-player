// Mirrors the auto-updater state from the main process and draws the small
// "update" card in the sidebar.
import { h, icon } from './ui.js';

let state = { state: 'idle' };
let info = { version: '', homepage: '' };
const listeners = new Set();

export async function initUpdates() {
  [state, info] = await Promise.all([window.nova.updateState(), window.nova.appInfo()]);
  window.nova.onUpdate((next) => {
    state = next;
    for (const fn of listeners) fn(state);
  });
}

export const updateState = () => state;
export const appInfo = () => info;
export const releasesUrl = () => (info.homepage ? `${info.homepage}/releases/latest` : '');
export const checkForUpdates = () => window.nova.checkForUpdates();
export const installUpdate = () => window.nova.installUpdate();

export function onUpdateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function describeUpdate(s = state) {
  switch (s.state) {
    case 'checking': return 'Checking for updates…';
    case 'latest': return 'You have the latest version.';
    case 'available': return `Version ${s.version} is available.`;
    case 'downloading': return `Downloading ${s.version || 'update'}… ${s.percent || 0}%`;
    case 'ready': return `Version ${s.version} is ready to install.`;
    case 'error': return `Update check failed: ${s.message}`;
    case 'dev': return 'Updates are disabled when running from source.';
    default: return '';
  }
}

// Sidebar card: only visible when there is something to act on.
export function updateCard() {
  const el = h('div', { class: 'update-card hidden' });
  const render = (s) => {
    if (s.state === 'ready') {
      el.replaceChildren(
        h('div', { class: 'update-title' }, icon('download'), `Update ${s.version} ready`),
        h('button', { class: 'btn btn-primary wide small-btn', onclick: installUpdate }, 'Restart to update'));
    } else if (s.state === 'available' && s.portable) {
      el.replaceChildren(
        h('div', { class: 'update-title' }, icon('download'), `Version ${s.version} available`),
        h('button', { class: 'btn btn-secondary wide small-btn', onclick: () => window.nova.openExternal(releasesUrl()) }, 'Download'));
    } else if (s.state === 'downloading') {
      el.replaceChildren(
        h('div', { class: 'update-title' }, icon('download'), `Downloading ${s.version || 'update'}`),
        h('div', { class: 'update-bar' }, h('div', { style: { width: `${s.percent || 0}%` } })));
    } else {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
  };
  render(state);
  onUpdateChange(render);
  return el;
}
