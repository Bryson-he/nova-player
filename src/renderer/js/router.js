// View stack. Previous views stay alive (detached) so "Back" is instant and
// keeps the exact scroll position and loaded pages.

const views = {};
const stack = [];
const listeners = new Set();
let container = null;
const MAX_DEPTH = 25;

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

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(current());
}

export function navigate(name, params = {}, { root = false } = {}) {
  if (!container || !views[name]) return;
  const cur = current();
  if (cur) {
    cur.scroll = container.scrollTop;
    cur.el.remove();
    cur.view.onHide?.();
  }
  if (root) {
    while (stack.length) stack.pop().view.destroy?.();
  }
  const view = views[name](params);
  const entry = { name, params, view, el: view.el, scroll: 0 };
  stack.push(entry);
  while (stack.length > MAX_DEPTH) stack.shift().view.destroy?.();
  container.append(entry.el);
  container.scrollTop = 0;
  emit();
}

export function back() {
  if (stack.length <= 1) return;
  const cur = stack.pop();
  cur.el.remove();
  cur.view.destroy?.();
  const prev = current();
  container.append(prev.el);
  container.scrollTop = prev.scroll;
  prev.view.onShow?.();
  emit();
}

export function refreshCurrent() {
  current()?.view.onShow?.();
}

export function resetRouter() {
  while (stack.length) stack.pop().view.destroy?.();
  container?.replaceChildren();
}
