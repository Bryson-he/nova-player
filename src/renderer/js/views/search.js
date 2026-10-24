import { api } from '../api.js';
import { h, icon, itemCard, spinner, debounce } from '../ui.js';

const GROUPS = [
  ['Movie', 'Movies', 'portrait'],
  ['Series', 'Shows', 'portrait'],
  ['Episode', 'Episodes', 'landscape'],
  ['BoxSet', 'Collections', 'portrait'],
  ['Video', 'Videos', 'landscape'],
];

export function searchView() {
  const input = h('input', { class: 'input search-input', placeholder: 'Search movies, shows, episodes…', autofocus: true });
  const results = h('div', { class: 'search-results' });
  const el = h('div', { class: 'page search' },
    h('div', { class: 'search-bar' }, icon('search'), input),
    results);

  let ctrl = null;

  const run = debounce(async () => {
    const term = input.value.trim();
    ctrl?.abort();
    if (term.length < 2) {
      results.replaceChildren();
      return;
    }
    ctrl = new AbortController();
    const signal = ctrl.signal;
    results.replaceChildren(spinner());
    try {
      const res = await api.search(term, signal);
      if (signal.aborted) return;
      const items = res?.Items || [];
      if (!items.length) {
        results.replaceChildren(h('div', { class: 'empty' }, `No results for "${term}"`));
        return;
      }
      results.replaceChildren(...GROUPS.map(([type, label, shape]) => {
        const group = items.filter((i) => i.Type === type);
        if (!group.length) return null;
        return h('section', { class: 'search-group' },
          h('h2', null, label),
          h('div', { class: `grid size-m ${shape}` }, group.map((i) => itemCard(i, { shape }))));
      }).filter(Boolean));
    } catch (err) {
      if (!signal.aborted) results.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }, 300);

  input.addEventListener('input', run);
  setTimeout(() => input.focus(), 30);

  return {
    el,
    onShow: () => input.focus(),
    destroy: () => ctrl?.abort(),
  };
}
