// View stack. Previous views stay alive (detached) so Back is instant and
// keeps the exact scroll position and loaded pages. Views you go Back from
// stay alive too, so Forward is just as instant, until you go somewhere new.

const views = {};
const stack = [];
const ahead = []; // views to go Forward to, nearest last
const listeners = new Set();
let container = null;
const MAX_DEPTH = 25;
const MAX_AHEAD = 10;

export function initRouter(el, viewMap) {
  container = el;
  Object.assign(views, viewMap);
}

export function scroller() {
  return container;
}

export function current() {
  return stack[stack.length - 1] || null;
}

export function canGoBack() {
  return stack.length > 1;
}

export function canGoForward() {
  return ahead.length > 0;
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(current());
}

// The title shown in the title bar. Views set it once they know it (a movie's name, say).
export function setPageTitle(view, title) {
  const entry = stack.find((e) => e.view === view) || ahead.find((e) => e.view === view);
  if (!entry || entry.title === title) return;
  entry.title = title;
  if (entry === current()) emit();
}

function detach(entry) {
  entry.scroll = container.scrollTop;
  entry.el.remove();
  entry.view.onHide?.();
}

function attach(entry, scroll) {
  container.append(entry.el);
  container.scrollTop = scroll;
}

// Synchronous on purpose: callers read current() right after navigating.
// Pages fade in through CSS, which reduced motion turns off.
function transition(update) {
  update();
}

export function navigate(name, params = {}, { root = false } = {}) {
  if (!container || !views[name]) return;
  transition(() => {
    const cur = current();
    if (cur) detach(cur);
    while (ahead.length) ahead.pop().view.destroy?.();
    if (root) {
      while (stack.length) stack.pop().view.destroy?.();
    }
    const view = views[name](params);
    const entry = { name, params, view, el: view.el, scroll: 0, title: view.title || '' };
    stack.push(entry);
    while (stack.length > MAX_DEPTH) stack.shift().view.destroy?.();
    attach(entry, 0);
    emit();
  });
}

export function back() {
  if (stack.length <= 1) return;
  transition(() => {
    const cur = stack.pop();
    detach(cur);
    ahead.push(cur);
    while (ahead.length > MAX_AHEAD) ahead.shift().view.destroy?.();
    const prev = current();
    attach(prev, prev.scroll);
    prev.view.onShow?.();
    emit();
  });
}

export function forward() {
  if (!ahead.length) return;
  transition(() => {
    detach(current());
    const next = ahead.pop();
    stack.push(next);
    attach(next, next.scroll);
    next.view.onShow?.();
    emit();
  });
}

export function refreshCurrent() {
  current()?.view.onShow?.();
}

export function resetRouter() {
  while (stack.length) stack.pop().view.destroy?.();
  while (ahead.length) ahead.pop().view.destroy?.();
  container?.replaceChildren();
}
