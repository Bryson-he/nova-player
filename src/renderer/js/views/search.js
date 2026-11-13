// Search results for the title bar search box (Ctrl K). Results update as
// you type; with nothing typed it shows your recent searches.
import { api } from '../api.js';
import { store } from '../store.js';
import { h, icon, itemCard, debounce, fill } from '../ui.js';
import { navigate } from '../router.js';

const GROUPS = [
  ['Movie', 'Movies', 'portrait'],
  ['Series', 'Shows', 'portrait'],
  ['Episode', 'Episodes', 'landscape'],
  ['BoxSet', 'Collections', 'portrait'],
  ['Video', 'Videos', 'landscape'],
];
const MAX_RECENT = 8;

function remember(term) {
  const list = [term, ...(store.get('recentSearches') || []).filter((t) => t.toLowerCase() !== term.toLowerCase())];
  store.set('recentSearches', list.slice(0, MAX_RECENT));
}

function skeletonGrid() {
  return h('div', { class: 'skeleton-row', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton skeleton-title' }),
    h('div', { class: 'skeleton-track' }, Array.from({ length: 6 }, () => h('div', { class: 'skeleton skeleton-card' }))));
}

export function searchView({ q = '' } = {}) {
  const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'search-results' });
  const el = h('div', { class: 'page search' }, status, results);
  let term = q;
  let ctrl = null;

  function showRecent() {
    const recent = store.get('recentSearches') || [];
    if (!recent.length) {
      fill(results, h('div', { class: 'empty' }, icon('search'), h('p', null, 'Search for movies, shows, episodes, collections and people.')));
      return;
    }
    fill(results,
      h('section', { class: 'search-group' },
        h('h2', null, 'Recent searches'),
        h('div', { class: 'search-recent' },
          recent.map((t) => h('button', { class: 'chip', onclick: () => setInput(t) }, icon('search'), t)),
          h('button', { class: 'link-btn', onclick: () => { store.set('recentSearches', []); showRecent(); } }, 'Clear'))));
  }

  function setInput(t) {
    const input = document.querySelector('.titlebar-search input');
    if (input) input.value = t;
    setQuery(t);
  }

  const run = debounce(async () => {
    const t = term.trim();
    ctrl?.abort();
    if (t.length < 2) {
      showRecent();
      return;
    }
    ctrl = new AbortController();
    const signal = ctrl.signal;
    if (!results.querySelector('.search-group')) fill(results, skeletonGrid(), skeletonGrid());
    try {
      const [res, people] = await Promise.all([api.search(t, signal), api.searchPeople(t, signal)]);
      if (signal.aborted) return;
      const items = res?.Items || [];
      if (!items.length && !people.length) {
        fill(results, h('div', { class: 'empty' }, icon('search'), h('p', null, `Nothing matches "${t}". Check the spelling or try fewer words.`)));
        status.textContent = 'No results';
        return;
      }
      status.textContent = `${items.length + people.length} results`;
      fill(results,
        GROUPS.map(([type, label, shape]) => {
          const group = items.filter((i) => i.Type === type);
          if (!group.length) return null;
          return h('section', { class: 'search-group' },
            h('h2', null, label),
            h('div', { class: `grid size-m ${shape}` }, group.map((i) => itemCard(i, { shape }))));
        }),
        people.length ? h('section', { class: 'search-group' },
          h('h2', null, 'People'),
          h('div', { class: 'row-track' }, people.map((p) => h('button', {
            class: 'person person-btn',
            onclick: () => {
              remember(t);
              navigate('item', { id: p.Id });
            },
          },
          p.ImageTags?.Primary
            ? h('img', { src: api.image(p.Id, 'Primary', { tag: p.ImageTags.Primary, maxWidth: 260 }), alt: '', loading: 'lazy' })
            : h('div', { class: 'person-fallback' }, p.Name[0]),
          h('div', { class: 'person-name' }, p.Name))))) : null);
      // Opening a result counts as a search worth remembering.
      results.addEventListener('click', () => remember(t), { once: true });
    } catch (err) {
      if (!signal.aborted) fill(results, h('div', { class: 'empty' }, `Search failed: ${err.message}`));
    }
  }, 180);

  function setQuery(t) {
    term = t;
    run();
  }

  setQuery(term);

  return {
    el,
    title: 'Search',
    setQuery,
    commit: () => term.trim().length >= 2 && remember(term.trim()),
    focusResults: () => results.querySelector('.card, .chip, button')?.focus(),
    onShow: () => document.querySelector('.titlebar-search input')?.focus(),
    destroy: () => ctrl?.abort(),
  };
}
