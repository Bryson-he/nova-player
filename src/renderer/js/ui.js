// Small DOM helpers, icons, cards and menus shared by every view.
import { api } from './api.js';
import { navigate, refreshCurrent } from './router.js';
import { openPlayer, shufflePlay } from './player.js';
import { store } from './store.js';
import { newEpisodeCount } from './newcontent.js';
import { blurCanvas } from './blurhash.js';

const SVGNS = 'http://www.w3.org/2000/svg';

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  replay: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  forward: 'M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  subtitles: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z',
  audio: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  arrowForward: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  movie: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
  tv: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  speed: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  arrowUp: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  arrowDown: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
  chevronLeft: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  chevronRight: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  pip: 'M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z',
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  collection: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  trailer: 'M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z',
  filter: 'M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z',
  more: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  fit: 'M3 5v4h2V5h4V3H5c-1.1 0-2 .9-2 2zm2 10H3v4c0 1.1.9 2 2 2h4v-2H5v-4zm14 4h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zm0-16h-4v2h4v4h2V5c0-1.1-.9-2-2-2z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  server: 'M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
  keyboard: 'M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z',
  palette: 'M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
  bug: 'M20 8h-2.81a5.985 5.985 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6.002 6.002 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z',
  lockOpen: 'M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z',
  doneAll: 'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z',
};

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendChildren(el, children);
  return el;
}

// Like el.replaceChildren(), but skips null/false/'' (replaceChildren would print "null").
export function fill(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  svg.append(p);
  return svg;
}

// The Nova mark (the Shell icon) in one colour: a disc with the play triangle
// cut out, wrapped by a broken ring. Colour comes from CSS (currentColor).
export function novaMark(cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 96 96');
  svg.setAttribute('class', `nova-mark ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const disc = document.createElementNS(SVGNS, 'path');
  disc.setAttribute('fill-rule', 'evenodd');
  disc.setAttribute('fill', 'currentColor');
  disc.setAttribute('d', 'M48 23a25 25 0 1 0 0 50a25 25 0 1 0 0-50ZM42 36.5v23a1.6 1.6 0 0 0 2.4 1.4l19.5-11.5a1.6 1.6 0 0 0 0-2.8L44.4 35.1a1.6 1.6 0 0 0-2.4 1.4Z');
  const ring = document.createElementNS(SVGNS, 'circle');
  for (const [k, v] of Object.entries({
    cx: 48, cy: 48, r: 39, fill: 'none', stroke: 'currentColor', 'stroke-width': 6,
    'stroke-linecap': 'round', 'stroke-dasharray': '186 59', transform: 'rotate(181 48 48)',
  })) ring.setAttribute(k, v);
  svg.append(disc, ring);
  return svg;
}

export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`.trim(), title, 'aria-label': title, onclick }, icon(name));
}

export function button(label, { icon: ic, onclick, variant = 'secondary', cls = '', title } = {}) {
  return h('button', { class: `btn btn-${variant} ${cls}`.trim(), onclick, title }, ic && icon(ic), label && h('span', null, label));
}

// A spinner, shown only if loading takes longer than about 400 ms (CSS delay).
export function spinner(text) {
  return h('div', { class: 'loading', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', { class: text ? 'loading-text' : 'sr-only' }, text || 'Loading'));
}

// Placeholder rows shaped like the content that is loading.
export function skeletonRows(count = 3, shape = 'portrait') {
  return h('div', { role: 'status', 'aria-label': 'Loading' }, Array.from({ length: count }, (_, n) => h('div', { class: 'skeleton-row', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton skeleton-title' }),
    h('div', { class: 'skeleton-track' }, Array.from({ length: 8 }, () => h('div', { class: `skeleton skeleton-card ${n === 0 && shape === 'portrait' ? 'landscape' : shape}` }))))));
}

// Turns a raw error into a title that says what happened and what to try.
function describeError(err) {
  const msg = err?.message || String(err);
  if (err?.status === 401) return ['You were signed out', 'Sign in again to continue.'];
  if (err?.status === 404) return ["This isn't on the server any more", 'It may have been deleted or moved. Go back and refresh.'];
  if (err?.status >= 500) return ['The server ran into a problem', `It answered "${msg}". Try again in a moment, or check the server's logs.`];
  if (/timed out|reach server|Failed to fetch|network/i.test(msg)) return ["Can't reach your server", "Check that it's running and that this PC is online, then try again."];
  return ["That didn't load", msg];
}

export function errorBox(err, retry) {
  const [title, hint] = describeError(err);
  const details = `${err?.status ? err.status + ' ' : ''}${err?.message || String(err)}`;
  return h('div', { class: 'error-box', role: 'alert' },
    h('div', { class: 'error-title' }, title),
    h('div', { class: 'error-msg' }, hint),
    h('div', { class: 'error-actions' },
      retry && button('Try again', { onclick: retry, variant: 'primary' }),
      button('Copy details', { onclick: () => copyText(details, 'Details copied') })));
}

export function copyText(text, done = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast(done), () => toast("Couldn't copy to the clipboard", 'error'));
}

// Toasts are announced to screen readers. Errors stay until dismissed.
// action: optional { label, onClick } shown as a button inside the toast (Undo, say).
export function toast(msg, kind = 'info', ms = 3200, action = null) {
  const host = document.getElementById('toasts');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('role', 'status');
  const close = () => {
    clearTimeout(timer);
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  };
  const t = h('div', { class: `toast toast-${kind}` }, h('span', null, msg),
    action ? h('button', { class: 'toast-action', onclick: () => { close(); action.onClick(); } }, action.label) : null,
    kind === 'error' || action ? h('button', { class: 'icon-btn toast-close', 'aria-label': 'Dismiss', onclick: close }, icon('close')) : null);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const timer = kind === 'error' ? null : setTimeout(close, action ? Math.max(ms, 6000) : ms);
  return close;
}

// ---- Formatting ----

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function formatRuntime(ticks) {
  const m = Math.round((ticks || 0) / 6e8);
  if (!m) return '';
  const hh = Math.floor(m / 60);
  return hh ? `${hh}h ${m % 60}m` : `${m}m`;
}

export function endsAt(remainingSec) {
  return new Date(Date.now() + remainingSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function epLabel(item) {
  const s = item.ParentIndexNumber;
  const e = item.IndexNumber;
  if (s == null && e == null) return '';
  return `S${s ?? '?'}:E${e ?? '?'}${item.IndexNumberEnd ? '-' + item.IndexNumberEnd : ''}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- Images ----

export function posterUrl(item, w = 360) {
  if (item.ImageTags?.Primary) return api.image(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: w });
  if (item.SeriesPrimaryImageTag && item.SeriesId) return api.image(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxWidth: w });
  if (item.AlbumPrimaryImageTag && item.AlbumId) return api.image(item.AlbumId, 'Primary', { tag: item.AlbumPrimaryImageTag, maxWidth: w });
  return null;
}

export function landscapeUrl(item, w = 560) {
  if (item.Type === 'Episode' && item.ImageTags?.Primary) return api.image(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: w });
  if (item.ImageTags?.Thumb) return api.image(item.Id, 'Thumb', { tag: item.ImageTags.Thumb, maxWidth: w });
  if (item.ParentThumbItemId && item.ParentThumbImageTag) return api.image(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth: w });
  if (item.BackdropImageTags?.length) return api.image(item.Id, 'Backdrop', { tag: item.BackdropImageTags[0], maxWidth: w, index: 0 });
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return api.image(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth: w, index: 0 });
  }
  if (item.ImageTags?.Primary) return api.image(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: w });
  return null;
}

export function backdropUrl(item, w = 1920) {
  if (item.BackdropImageTags?.length) return api.image(item.Id, 'Backdrop', { tag: item.BackdropImageTags[0], maxWidth: w, index: 0 });
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return api.image(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth: w, index: 0 });
  }
  if (item.Type === 'Episode' && item.ImageTags?.Primary) return api.image(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: w });
  return null;
}

export function logoUrl(item, w = 600) {
  if (item.ImageTags?.Logo) return api.image(item.Id, 'Logo', { tag: item.ImageTags.Logo, maxWidth: w });
  if (item.ParentLogoItemId && item.ParentLogoImageTag) return api.image(item.ParentLogoItemId, 'Logo', { tag: item.ParentLogoImageTag, maxWidth: w });
  return null;
}

// ---- Cards & rows ----

const PLAYABLE = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);
const DAY = 24 * 60 * 60 * 1000;

// "NEW": a show with unwatched episodes that got something added recently, or
// an episode/movie added recently that you haven't started. Window is a setting.
export function isNewItem(item) {
  const days = store.setting('newBadgeDays');
  if (!days || !item) return false;
  const since = Date.now() - days * DAY;
  const ud = item.UserData || {};
  if (item.Type === 'Series') return newEpisodeCount(item.Id) > 0;
  if (item.Type === 'Episode' || item.Type === 'Movie') {
    return !ud.Played && !ud.PlaybackPositionTicks && Date.parse(item.DateCreated || 0) >= since;
  }
  return false;
}

export function itemCard(item, { shape = 'portrait', showSeries = true, onRemove } = {}) {
  const isEp = item.Type === 'Episode';
  const img = shape === 'landscape' ? landscapeUrl(item) : posterUrl(item);
  const title = isEp && showSeries ? item.SeriesName : item.Name;
  let sub;
  if (isEp) sub = [epLabel(item), showSeries ? item.Name : ''].filter(Boolean).join(' · ');
  else if (item.Type === 'Series') sub = item.ProductionYear ? `${item.ProductionYear}${item.Status === 'Continuing' ? ' – Present' : ''}` : '';
  else sub = item.ProductionYear || '';

  const ud = item.UserData || {};
  const pct = ud.PlayedPercentage && !ud.Played ? ud.PlayedPercentage : 0;

  const playBtn = PLAYABLE.has(item.Type)
    ? h('button', {
      class: 'card-play', title: 'Play', 'aria-label': `Play ${title}`, tabindex: -1, onclick: (e) => {
        e.stopPropagation();
        openPlayer(item.Id);
      },
    }, icon('play'))
    : null;

  const state = ud.Played ? 'watched' : pct ? `${Math.round(pct)}% played` : '';
  const isNew = isNewItem(item);
  const label = [title, sub, isNew ? 'new' : '', state].filter(Boolean).join(', ');
  const el = h('div', { class: `card ${shape}`, tabindex: 0, role: 'link', 'aria-label': label },
    h('div', { class: 'card-img' },
      img ? blurFor(item, img) : null,
      img ? fadeImg(img) : h('div', { class: 'card-fallback' }, icon(item.Type === 'Series' ? 'tv' : 'movie')),
      isNew
        ? h('div', { class: 'badge-new', 'aria-hidden': 'true' }, item.Type === 'Series' && newEpisodeCount(item.Id) > 1 ? `${newEpisodeCount(item.Id)} new` : 'New')
        : null,
      ud.Played ? h('div', { class: 'badge badge-played' }, icon('check')) : null,
      !ud.Played && ud.UnplayedItemCount ? h('div', { class: 'badge' }, ud.UnplayedItemCount) : null,
      pct ? h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })) : null,
      playBtn,
      onRemove ? h('button', {
        class: 'card-remove',
        title: 'Remove from Continue Watching',
        onclick: (e) => {
          e.stopPropagation();
          onRemove(item, el);
        },
      }, icon('close')) : null),
    h('div', { class: 'card-title' }, title),
    sub ? h('div', { class: 'card-sub' }, sub) : null);

  const open = () => navigate('item', { id: item.Id });
  el.addEventListener('click', open);
  el.addEventListener('contextmenu', (e) => itemMenu(item, e, { onRemove: onRemove && (() => onRemove(item, el)) }));
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter') open();
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = el.getBoundingClientRect();
      itemMenu(item, { preventDefault() {}, stopPropagation() {}, currentTarget: el, clientX: r.left + 24, clientY: r.top + 24 }, { onRemove: onRemove && (() => onRemove(item, el)) });
    } else if (e.key.toLowerCase() === 'p' && PLAYABLE.has(item.Type)) openPlayer(item.Id);
  });
  return el;
}

// An image that fades in once loaded (over its blur placeholder).
export function fadeImg(src, attrs = {}) {
  const img = h('img', { src, loading: 'lazy', decoding: 'async', alt: '', ...attrs });
  const done = () => img.classList.add('loaded');
  if (img.complete && img.naturalWidth) done();
  else {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
  }
  return img;
}

// The blur placeholder for whichever image a URL points at, found by its tag.
export function blurFor(item, url) {
  const tag = /[?&]tag=([^&]+)/.exec(url)?.[1];
  if (!tag) return null;
  for (const map of Object.values(item.ImageBlurHashes || {})) {
    if (map?.[tag]) return blurCanvas(map[tag]);
  }
  return null;
}

// Right-click menu for any movie, show or episode.
export function itemMenu(item, e, { onRemove } = {}) {
  e.preventDefault();
  e.stopPropagation();
  const ud = item.UserData || {};
  const pos = ud.PlaybackPositionTicks || 0;
  const playable = PLAYABLE.has(item.Type);
  const act = (fn, done) => async () => {
    try {
      await fn();
      if (done) toast(done);
      refreshCurrent();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const label = item.Type === 'Episode' ? `${item.SeriesName} · ${epLabel(item)}` : item.Name;
  popupMenu(e.currentTarget, [
    playable ? { label: pos ? 'Resume' : 'Play', onClick: () => openPlayer(item.Id) } : null,
    playable && pos ? { label: 'Play from start', onClick: () => openPlayer(item.Id, { startTicks: 0 }) } : null,
    item.Type === 'Series' ? { label: 'Shuffle', onClick: () => shufflePlay(item.Id, 'Episode') } : null,
    { label: 'Details', onClick: () => navigate('item', { id: item.Id }) },
    item.Type === 'Episode' && item.SeriesId ? { label: 'Go to series', onClick: () => navigate('item', { id: item.SeriesId }) } : null,
    { divider: true },
    { label: ud.Played ? 'Mark unwatched' : 'Mark watched', onClick: act(() => api.setPlayed(item.Id, !ud.Played), ud.Played ? 'Marked unwatched' : 'Marked watched') },
    { label: ud.IsFavorite ? 'Remove from favorites' : 'Add to favorites', onClick: act(() => api.setFavorite(item.Id, !ud.IsFavorite), ud.IsFavorite ? 'Removed from favorites' : 'Added to favorites') },
    pos && !ud.Played ? { label: 'Remove from Continue Watching', onClick: onRemove || act(() => api.hideFromResume(item.Id), 'Removed from Continue Watching') } : null,
  ].filter(Boolean), { title: label, at: { x: e.clientX, y: e.clientY } });
}

let rowIds = 0;
export function row(title, items, opts = {}) {
  const id = `row-${++rowIds}`;
  const track = h('div', { class: 'row-track', role: 'list', 'aria-labelledby': id }, items.map((it) => {
    const card = itemCard(it, opts);
    card.setAttribute('role', 'link');
    return h('div', { role: 'listitem' }, card);
  }));
  const scrollBy = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const prev = iconBtn('chevronLeft', 'Scroll left', () => scrollBy(-1));
  const next = iconBtn('chevronRight', 'Scroll right', () => scrollBy(1));
  const section = h('section', { class: 'row' },
    h('div', { class: 'row-head' },
      h('h2', { id }, title),
      h('div', { class: 'row-nav' }, prev, next)),
    track);
  // Arrows only when the row overflows, each disabled at its end.
  const sync = () => {
    const max = track.scrollWidth - track.clientWidth;
    section.classList.toggle('overflows', max > 4);
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = track.scrollLeft >= max - 4;
  };
  track.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(track);
  return section;
}

export function select(options, value, onChange, attrs = {}) {
  const el = h('select', { class: 'select', ...attrs },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

// ---- Popup menus ----

let openMenu = null;

export function closeMenu() {
  openMenu?.close();
}

export function isMenuOpen() {
  return !!openMenu;
}

// items: [{ label, sub, checked, onClick, keepOpen, disabled } | { header } | { divider } | { el }]
// at: optional { x, y } to open at the mouse (right-click menus) instead of under `anchor`.
export function popupMenu(anchor, items, { title, container = document.body, at } = {}) {
  if (openMenu && openMenu.anchor === anchor && !at) {
    openMenu.close();
    return null;
  }
  closeMenu();

  const menu = h('div', { class: 'menu', role: 'menu' },
    title ? h('div', { class: 'menu-title' }, title) : null,
    items.map((it) => {
      if (it.divider) return h('div', { class: 'menu-divider' });
      if (it.header) return h('div', { class: 'menu-header' }, it.header);
      if (it.el) return it.el;
      return h('button', {
        class: `menu-item${it.checked ? ' checked' : ''}${it.danger ? ' danger' : ''}`,
        role: it.checked !== undefined ? 'menuitemradio' : 'menuitem',
        'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
        tabindex: -1,
        disabled: it.disabled,
        onclick: (e) => {
          e.stopPropagation();
          if (!it.keepOpen) close();
          it.onClick?.();
        },
      },
      h('span', { class: 'menu-check' }, it.checked ? icon('check') : null),
      h('span', { class: 'menu-label' }, it.label, it.sub ? h('span', { class: 'menu-sub' }, it.sub) : null),
      it.key ? h('span', { class: 'menu-key', 'aria-hidden': 'true' }, it.key) : null);
    }));
  container.append(menu);

  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, at ? r.left : r.right - mr.width), window.innerWidth - mr.width - 8);
  let top = r.bottom + (at ? 2 : 6);
  if (top + mr.height > window.innerHeight - 8) top = Math.max(8, r.top - mr.height - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const onDoc = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  // Keyboard: focus moves into the menu, Up/Down/Home/End move, Escape and Tab close.
  const menuItems = () => [...menu.querySelectorAll('.menu-item:not(:disabled), .menu-row button, .menu-row input')];
  const onKey = (e) => {
    const list = menuItems();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor?.focus?.();
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (document.activeElement?.type === 'range') return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(i + step + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  document.addEventListener('keydown', onKey, true);
  if (anchor && !at) anchor.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => (menu.querySelector('.menu-item.checked:not(:disabled)') || menuItems()[0])?.focus({ preventScroll: true }));

  const handle = {
    anchor,
    el: menu,
    close() {
      anchor?.setAttribute?.('aria-expanded', 'false');
      menu.remove();
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      if (openMenu === handle) openMenu = null;
    },
  };
  function close() {
    handle.close();
  }
  openMenu = handle;
  return handle;
}

// ---- Tooltips: the control's name and its shortcut, after 500 ms.
// Native title tooltips are slow and can't show a shortcut, so `title`
// attributes are moved to data-tip on first hover.
let tipEl = null;
let tipTimer = 0;

function hideTip() {
  clearTimeout(tipTimer);
  tipEl?.remove();
  tipEl = null;
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    const target = e.target.closest?.('[title], [data-tip]');
    if (!target) return;
    if (target.hasAttribute('title')) {
      target.dataset.tip = target.getAttribute('title');
      target.removeAttribute('title');
    }
    if (!target.dataset.tip) return;
    hideTip();
    tipTimer = setTimeout(() => {
      if (!target.isConnected || !target.matches(':hover')) return;
      tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, target.dataset.tip,
        target.dataset.shortcut ? h('kbd', null, target.dataset.shortcut) : null);
      document.body.append(tipEl);
      const r = target.getBoundingClientRect();
      const t = tipEl.getBoundingClientRect();
      let top = r.bottom + 6;
      if (top + t.height > innerHeight - 4) top = r.top - t.height - 6;
      tipEl.style.top = `${top}px`;
      tipEl.style.left = `${Math.min(Math.max(4, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 4)}px`;
    }, 500);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest?.('[data-tip]')) hideTip();
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('keydown', hideTip, true);
}
