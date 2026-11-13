// Diagnostics: a small in-memory log of recent errors and "Copy debug info".
// Server addresses, tokens and user names are removed before anything is
// copied; nothing leaves the PC unless you paste it somewhere.
import { store } from './store.js';
import { api } from './api.js';
import { appInfo } from './updates.js';

const MAX = 50;
const log = [];

export function redact(text) {
  let t = String(text);
  const base = store.get('server')?.url;
  if (base) t = t.split(base).join('[server]');
  const user = store.get('user')?.Name;
  if (user && user.length > 2) t = t.split(user).join('[user]');
  return t
    .replace(/(token|api_?key|apikey|pw|password)(["']?\s*[=:]\s*["']?)[^"'&\s,}]+/gi, '$1$2[removed]')
    .replace(/https?:\/\/[^\s"')]+/gi, '[url]')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '[address]');
}

export function logError(where, err) {
  log.push(`${new Date().toISOString()} ${where}: ${redact(err?.stack || err?.message || err)}`.slice(0, 2000));
  while (log.length > MAX) log.shift();
}

window.addEventListener('error', (e) => logError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logError('promise', e.reason));

export function debugInfo() {
  const settings = { ...(store.get('settings') || {}) };
  return redact([
    `Nova Player ${appInfo().version || '?'}`,
    navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''),
    `Jellyfin ${api.serverVersion || 'unknown'}`,
    `Window ${innerWidth}x${innerHeight} @${devicePixelRatio}x`,
    `Settings ${JSON.stringify(settings)}`,
    '',
    `Recent errors (${log.length}):`,
    ...(log.length ? log : ['none']),
  ].join('\n'));
}
