// Library grid. Sort, order, filter, genre and card size are saved per library
// and restored every time you come back (and across app restarts).
import { api, CARD_FIELDS } from '../api.js';
import { store } from '../store.js';
import { h, icon, iconBtn, itemCard, select, spinner, errorBox } from '../ui.js';
import { scroller } from '../router.js';
import { shufflePlay } from '../player.js';
import { refreshNewEpisodes } from '../newcontent.js';

const PAGE = 120;

const COMMON_SORTS = [
  ['SortName', 'Name'],
  ['DateCreated', 'Date added'],
  ['PremiereDate', 'Release date'],
  ['ProductionYear,SortName', 'Year'],
  ['CommunityRating,SortName', 'Community rating'],
  ['CriticRating,SortName', 'Critic rating'],
  ['OfficialRating,SortName', 'Parental rating'],
  ['DatePlayed,SortName', 'Date played'],
];
const MOVIE_SORTS = [...COMMON_SORTS, ['Runtime,SortName', 'Runtime'], ['PlayCount,SortName', 'Play count'], ['Random', 'Random']];
const SHOW_SORTS = [...COMMON_SORTS, ['DateLastContentAdded,SortName', 'Latest episode added'], ['Random', 'Random']];

const FILTERS = [
  ['all', 'All'],
  ['IsUnplayed', 'Unwatched'],
  ['IsPlayed', 'Watched'],
  ['IsResumable', 'In progress'],
  ['IsFavorite', 'Favorites'],
];

function typesFor(collectionType) {
  switch (collectionType) {
    case 'movies': return { types: 'Movie', shape: 'portrait', sorts: MOVIE_SORTS };
    case 'tvshows': return { types: 'Series', shape: 'portrait', sorts: SHOW_SORTS };
    case 'boxsets': return { types: 'BoxSet', shape: 'portrait', sorts: COMMON_SORTS };
    case 'musicvideos': return { types: 'MusicVideo', shape: 'landscape', sorts: MOVIE_SORTS };
    case 'homevideos': return { types: 'Video', shape: 'landscape', sorts: MOVIE_SORTS };
    default: return { types: 'Movie,Series,Video', shape: 'portrait', sorts: MOVIE_SORTS };
  }
}

export function libraryView({ id, name, collectionType }) {
  const cfg = typesFor(collectionType);
  const saved = store.get('librarySort')?.[id] || {};
  const state = {
    sortBy: cfg.sorts.some(([v]) => v === saved.sortBy) ? saved.sortBy : 'SortName',
    sortOrder: saved.sortOrder || 'Ascending',
    filter: saved.filter || 'all',
    genre: saved.genre || '',
    size: saved.size || 'm',
  };

  const persist = () => store.set('librarySort', { ...(store.get('librarySort') || {}), [id]: { ...state } });

  const countEl = h('span', { class: 'lib-count' });
  const grid = h('div', { class: `grid size-${state.size} ${cfg.shape}` });
  const sentinel = h('div', { class: 'sentinel' });
  const status = h('div', { class: 'lib-status' });

  const orderBtn = iconBtn(state.sortOrder === 'Ascending' ? 'arrowUp' : 'arrowDown', 'Toggle sort order', () => {
    state.sortOrder = state.sortOrder === 'Ascending' ? 'Descending' : 'Ascending';
    orderBtn.replaceChildren(icon(state.sortOrder === 'Ascending' ? 'arrowUp' : 'arrowDown'));
    persist();
    reset();
  }, 'order-btn');

  const genreSelect = select([['', 'All genres']], state.genre, (v) => {
    state.genre = v;
    persist();
    reset();
  });

  const sizeBtns = h('div', { class: 'segmented' }, [['s', 'S'], ['m', 'M'], ['l', 'L']].map(([v, label]) =>
    h('button', {
      class: state.size === v ? 'active' : '',
      title: 'Card size',
      onclick: (e) => {
        state.size = v;
        persist();
        grid.className = `grid size-${v} ${cfg.shape}`;
        for (const b of sizeBtns.children) b.classList.toggle('active', b === e.currentTarget);
      },
    }, label)));

  // A–Z jump bar. Only meaningful (and shown) when sorting by name.
  let letter = '';
  const letters = h('div', { class: 'az-bar' }, ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => h('button', {
    class: l === '#' ? 'active' : '',
    title: l === '#' ? 'Show all' : `Jump to ${l}`,
    onclick: (e) => {
      letter = l === '#' ? '' : l;
      for (const b of letters.children) b.classList.toggle('active', b === e.currentTarget);
      reset();
    },
  }, l)));
  const syncLetters = () => {
    letters.classList.toggle('hidden', state.sortBy !== 'SortName');
    if (state.sortBy !== 'SortName' && letter) {
      letter = '';
      for (const b of letters.children) b.classList.toggle('active', b.textContent === '#');
    }
  };

  const shuffleTypes = cfg.types === 'Series' ? 'Episode' : cfg.types;

  const toolbar = h('div', { class: 'lib-toolbar' },
    h('div', { class: 'lib-title' }, h('h1', null, name), countEl,
      h('button', { class: 'btn btn-secondary small-btn', title: 'Play random items from this library', onclick: () => shufflePlay(id, shuffleTypes) },
        icon('shuffle'), h('span', null, 'Shuffle'))),
    h('div', { class: 'lib-controls' },
      h('label', { class: 'ctl' }, icon('tune'),
        select(cfg.sorts, state.sortBy, (v) => {
          state.sortBy = v;
          persist();
          syncLetters();
          reset();
        })),
      orderBtn,
      select(FILTERS, state.filter, (v) => {
        state.filter = v;
        persist();
        reset();
      }),
      genreSelect,
      sizeBtns),
    letters);
  syncLetters();

  const el = h('div', { class: 'page library' }, toolbar, grid, status, sentinel);

  let loaded = 0;
  let total = Infinity;
  let loading = false;
  let token = 0;

  async function loadPage() {
    if (loading || loaded >= total) return;
    loading = true;
    const my = token;
    if (!loaded) status.replaceChildren(spinner());
    if (!loaded && cfg.types.includes('Series')) await refreshNewEpisodes();
    try {
      const res = await api.items({
        ParentId: id,
        Recursive: true,
        IncludeItemTypes: cfg.types,
        SortBy: state.sortBy,
        SortOrder: state.sortOrder,
        Filters: state.filter !== 'all' ? state.filter : undefined,
        GenreIds: state.genre || undefined,
        // Ascending: start at the letter. Descending: everything up to (and including) it.
        NameStartsWithOrGreater: letter && state.sortOrder === 'Ascending' ? letter : undefined,
        NameLessThan: letter && state.sortOrder === 'Descending' ? String.fromCharCode(letter.charCodeAt(0) + 1) : undefined,
        StartIndex: loaded,
        Limit: PAGE,
        Fields: CARD_FIELDS,
        EnableImageTypes: 'Primary,Thumb,Backdrop',
        ImageTypeLimit: 1,
        EnableTotalRecordCount: true,
      });
      if (my !== token) return;
      const items = res?.Items || [];
      total = res?.TotalRecordCount ?? loaded + items.length;
      loaded += items.length;
      if (!items.length) total = loaded;
      grid.append(...items.map((it) => itemCard(it, { shape: cfg.shape, showSeries: true })));
      countEl.textContent = `${total.toLocaleString()} item${total === 1 ? '' : 's'}`;
      status.replaceChildren(total === 0 ? h('div', { class: 'empty' }, 'No items match these filters.') : '');
    } catch (err) {
      if (my === token) status.replaceChildren(errorBox(err, () => { loading = false; loadPage(); }));
    } finally {
      if (my === token) loading = false;
    }
    // Keep filling if the sentinel is still on screen (very tall windows).
    if (my === token && loaded < total) requestAnimationFrame(checkSentinel);
  }

  function checkSentinel() {
    const sc = scroller();
    if (!sc || !el.isConnected) return;
    if (sentinel.getBoundingClientRect().top < sc.getBoundingClientRect().bottom + 1200) loadPage();
  }

  function reset() {
    token++;
    loading = false;
    loaded = 0;
    total = Infinity;
    grid.replaceChildren();
    countEl.textContent = '';
    if (scroller()) scroller().scrollTop = 0;
    loadPage();
  }

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadPage();
  }, { root: scroller(), rootMargin: '1200px 0px' });
  observer.observe(sentinel);

  api.genres(id, cfg.types).then((genres) => {
    genreSelect.replaceChildren(...[['', 'All genres'], ...genres.map((g) => [g.Id, g.Name])].map(([v, label]) =>
      h('option', { value: v, selected: v === state.genre }, label)));
  });

  loadPage();

  return {
    el,
    destroy() {
      token++;
      observer.disconnect();
    },
  };
}
