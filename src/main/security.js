// @ts-check
'use strict';
// Pure helpers for the main process: path guards, server address rules,
// store validation and the content security policy. Kept free of Electron
// imports so they can be unit tested with plain Node.
const path = require('path');

/**
 * True when `target` is `base` itself or somewhere inside it. A sibling
 * folder that merely shares the prefix ("Nova Player2") does not count.
 * @param {string} base
 * @param {string} target
 */
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** @param {string} url */
function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** @param {string} ip */
function ipv4Parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

const PRIVATE_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost'];

/**
 * Hosts on the user's own network (or their Tailscale tailnet), where plain
 * HTTP is normal for Jellyfin and needs no warning.
 * @param {string} hostname  without port; IPv6 may keep its brackets
 */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost') return true;
  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127); // 100.64.0.0/10: Tailscale / CGNAT
  }
  if (host.includes(':')) {
    return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  if (!host.includes('.')) return true; // single-label names like "tower" or "nas"
  return PRIVATE_SUFFIXES.some((s) => host.endsWith(s));
}

/** @param {string} base */
function isEncrypted(base) {
  return /^https:/i.test(base);
}

/**
 * The addresses to probe, in order, for what the user typed. HTTPS comes
 * first unless the host is private, where Jellyfin's default
 * http://host:8096 is tried first. An address with a scheme is used as is.
 * @param {string} input
 * @returns {string[]}
 */
function serverCandidates(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  const host = raw.split('/')[0];
  const rest = raw.slice(host.length);
  const hasPort = /:\d+$/.test(host);
  const hostname = host.replace(/:\d+$/, '');
  const list = [];
  if (isPrivateHost(hostname)) {
    if (!hasPort) list.push(`http://${host}:8096${rest}`);
    list.push(`https://${raw}`, `http://${raw}`);
  } else {
    list.push(`https://${raw}`);
    if (!hasPort) list.push(`http://${host}:8096${rest}`);
    list.push(`http://${raw}`);
  }
  return [...new Set(list)];
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A safe Windows file name stem from arbitrary text.
 * @param {unknown} name
 * @param {string} fallback
 */
function safeFileName(name, fallback = 'screenshot') {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
  let s = String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 150);
  s = s.replace(/[. ]+$/, '');
  if (!s || RESERVED_NAMES.test(s)) s = s ? `_${s}` : fallback;
  return s;
}

/** @param {unknown} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
/** @param {unknown} v @param {number} max */
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** Keys the renderer may write, each with a shape check. */
const STORE_KEYS = {
  seriesTracks: isPlainObject,
  librarySort: isPlainObject,
  subDelays: isPlainObject,
  settings: isPlainObject,
  volume: (/** @type {unknown} */ v) => typeof v === 'number' && v >= 0 && v <= 1,
  muted: (/** @type {unknown} */ v) => typeof v === 'boolean',
  lastVersion: (/** @type {unknown} */ v) => isStr(v, 32),
  deviceId: (/** @type {unknown} */ v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v),
  lastUsername: (/** @type {unknown} */ v) => isStr(v, 256),
  user: (/** @type {any} */ v) => isPlainObject(v) && isStr(v.Id, 64),
  server: (/** @type {any} */ v) => isPlainObject(v) && isStr(v.url, 2048) && !!originOf(v.url),
};
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

/**
 * @param {unknown} key
 * @param {unknown} value  null/undefined means delete
 * @returns {boolean}
 */
function validStoreWrite(key, value) {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(STORE_KEYS, key)) return false;
  if (value === undefined || value === null) return true;
  if (!STORE_KEYS[/** @type {keyof typeof STORE_KEYS} */ (key)](value)) return false;
  try {
    return JSON.stringify(value).length <= MAX_VALUE_BYTES;
  } catch {
    return false;
  }
}

/**
 * The page's content security policy. Signed in, network access is limited
 * to the one server; signed out, any server may be probed (no token exists).
 * @param {string | null} serverOrigin
 */
function buildCsp(serverOrigin) {
  const net = serverOrigin || 'http: https:';
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    `img-src 'self' data: blob: ${net}`,
    `media-src 'self' blob: data: ${net}`,
    `connect-src 'self' ${net}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
  ].join('; ');
}

module.exports = {
  isInside, originOf, isPrivateHost, isEncrypted, serverCandidates, safeFileName,
  STORE_KEYS, validStoreWrite, MAX_STORE_BYTES, buildCsp,
};
