import { api, TICKS } from '../api.js';
import {
  h, fill, icon, iconBtn, button, spinner, errorBox, row, itemCard, toast, select, isNewItem, itemMenu, popupMenu, fadeImg,
  backdropUrl, posterUrl, logoUrl, landscapeUrl, formatRuntime, formatTime, endsAt, epLabel,
} from '../ui.js';
import { navigate, scroller, setPageTitle } from '../router.js';
import { store } from '../store.js';
import { tintFromHash } from '../blurhash.js';
import { openPlayer, shufflePlay } from '../player.js';
import {
  chooseAudio, chooseSubtitle, audioStreams, subStreams, streamLabel, rememberTrack, seriesPref, forgetSeries,
} from '../tracks.js';

export function itemView({ id, seasonId }) {
  const el = h('div', { class: 'page item-page' }, spinner());
  let token = 0;
  let selectedSeason = seasonId || null;

  async function load(keepScroll = false) {
    const my = ++token;
    const sc = scroller();
    const top = keepScroll && sc ? sc.scrollTop : 0;
    try {
      let item = await api.item(id);
      if (my !== token) return;
      if (item.Type === 'Season' && item.SeriesId) {
        selectedSeason ||= item.Id;
        item = await api.item(item.SeriesId);
        if (my !== token) return;
      }
      setPageTitle(self, item.Name);
      let content;
      if (item.Type === 'Person') content = await renderPerson(item, my);
      else if (item.Type === 'Series') content = await renderSeries(item, my);
      else if (item.Type === 'BoxSet' || item.IsFolder) content = await renderCollection(item, my);
      else content = renderPlayable(item);
      if (my !== token || !content) return;
      el.replaceChildren(...[].concat(content));
      if (keepScroll && sc) sc.scrollTop = top;
      loadExtras(item, my);
    } catch (err) {
      if (my === token) el.replaceChildren(errorBox(err, () => load()));
    }
  }

  // ---------- shared pieces ----------

  function metaLine(item) {
    const bits = [];
    if (item.Type === 'Episode') bits.push(epLabel(item));
    if (item.ProductionYear) bits.push(String(item.ProductionYear));
    if (item.OfficialRating) bits.push(h('span', { class: 'rating-badge' }, item.OfficialRating));
    if (item.RunTimeTicks && item.Type !== 'Series') bits.push(formatRuntime(item.RunTimeTicks));
    if (item.CommunityRating) bits.push(h('span', { class: 'star' }, icon('star'), item.CommunityRating.toFixed(1)));
    if (item.CriticRating) bits.push(`${item.CriticRating}% critics`);
    if (item.RunTimeTicks && item.Type !== 'Series') {
      const remaining = (item.RunTimeTicks - (item.UserData?.PlaybackPositionTicks || 0)) / TICKS;
      bits.push(`Ends at ${endsAt(remaining)}`);
    }
    const ms = item.MediaSources?.[0];
    const vs = ms?.MediaStreams?.find((s) => s.Type === 'Video');
    if (vs?.Width) {
      const res = vs.Width >= 3800 ? '4K' : vs.Width >= 1900 ? '1080p' : vs.Width >= 1260 ? '720p' : 'SD';
      bits.push(h('span', { class: 'tech-badge' }, res));
      if (vs.VideoRange && vs.VideoRange !== 'SDR') bits.push(h('span', { class: 'tech-badge' }, vs.VideoRangeType || vs.VideoRange));
    }
    return h('div', { class: 'meta-line' }, bits.map((b) => h('span', { class: 'meta-item' }, b)));
  }

  function hero(item, { actions, extra, titleOverride, subtitle } = {}) {
    const bd = backdropUrl(item);
    const logo = logoUrl(item);
    const poster = item.Type === 'Episode' ? landscapeUrl(item, 640) : posterUrl(item, 500);
    const title = titleOverride || item.Name;
    // Ambient tint: a calm colour from the poster, washed over the hero.
    const hash = Object.values(item.ImageBlurHashes?.Primary || {})[0];
    const tint = store.setting('ambientTint') ? tintFromHash(hash) : null;
    return h('section', { class: 'hero', style: tint ? { '--tint': tint } : null },
      bd ? h('div', { class: 'hero-bg', style: { backgroundImage: `url("${bd}")` } }) : null,
      h('div', { class: 'hero-fade' }),
      h('div', { class: 'hero-content' },
        poster ? h('img', { class: `hero-poster ${item.Type === 'Episode' ? 'landscape' : ''}`, src: poster, alt: '' }) : null,
        h('div', { class: 'hero-info' },
          logo && item.Type !== 'Episode' ? h('img', { class: 'hero-logo', src: logo, alt: title }) : h('h1', null, title),
          subtitle || null,
          metaLine(item),
          item.Genres?.length ? h('div', { class: 'genres' }, item.Genres.slice(0, 5).map((g) => h('span', { class: 'chip' }, g))) : null,
          item.Taglines?.[0] ? h('div', { class: 'tagline' }, item.Taglines[0]) : null,
          item.Overview ? h('p', { class: 'overview' }, item.Overview) : null,
          actions ? h('div', { class: 'hero-actions' }, actions) : null,
          extra || null)));
  }

  function trailerBtn(item) {
    const url = item.RemoteTrailers?.[0]?.Url;
    if (!url) return null;
    return button('Trailer', { icon: 'trailer', onclick: () => window.nova.openExternal(url) });
  }

  // Less-used actions live in a More menu next to the main buttons.
  function moreBtn(item, onChange, extra = []) {
    const ud = item.UserData || {};
    const act = (fn, done) => async () => {
      try {
        await fn();
        toast(done);
        onChange();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    const btn = iconBtn('more', 'More', () => popupMenu(btn, [
      ...extra,
      extra.length ? { divider: true } : null,
      { label: ud.Played ? 'Mark unwatched' : 'Mark watched', onClick: act(() => api.setPlayed(item.Id, !ud.Played), ud.Played ? 'Marked unwatched' : 'Marked watched') },
      { label: ud.IsFavorite ? 'Remove from favourites' : 'Add to favourites', onClick: act(() => api.setFavorite(item.Id, !ud.IsFavorite), ud.IsFavorite ? 'Removed from favourites' : 'Added to favourites') },
    ].filter(Boolean)), 'round');
    btn.setAttribute('aria-haspopup', 'menu');
    return btn;
  }

  // Watched and favourite state, shown quietly beside the buttons.
  function stateChips(item) {
    const ud = item.UserData || {};
    return [
      ud.Played ? h('span', { class: 'chip' }, icon('check'), 'Watched') : null,
      ud.IsFavorite ? h('span', { class: 'chip' }, icon('heart'), 'Favourite') : null,
    ];
  }

  function loadExtras(item, my) {
    const cast = (item.People || []).filter((p) => p.Type === 'Actor' || p.Type === 'Director').slice(0, 24);
    if (cast.length) {
      el.append(h('section', { class: 'row' },
        h('div', { class: 'row-head' }, h('h2', null, 'Cast and crew')),
        h('div', { class: 'row-track' }, cast.map((p) => h('button', { class: 'person person-btn', onclick: () => navigate('item', { id: p.Id }) },
          p.PrimaryImageTag
            ? h('img', { src: api.image(p.Id, 'Primary', { tag: p.PrimaryImageTag, maxWidth: 200 }), loading: 'lazy', alt: '' })
            : h('div', { class: 'person-fallback' }, p.Name[0]),
          h('div', { class: 'person-name' }, p.Name),
          h('div', { class: 'person-role' }, p.Role || p.Type))))));
    }
    if (['Movie', 'Series'].includes(item.Type)) {
      api.similar(item.Id).then((items) => {
        if (my === token && items.length) el.append(row('More like this', items));
      });
    }
  }

  // ---------- movie / episode / video ----------

  function renderPlayable(item) {
    const sources = item.MediaSources || [];
    let ms = sources[0];
    let audioIndex = ms ? chooseAudio(item, ms) : null;
    let subIndex = ms ? chooseSubtitle(item, ms, audioIndex) : -1;
    const pos = (item.UserData?.PlaybackPositionTicks || 0) / TICKS;

    const trackArea = h('div', { class: 'track-pickers' });
    const renderTracks = () => {
      const audios = audioStreams(ms);
      const subs = subStreams(ms);
      fill(trackArea, 
        sources.length > 1 ? h('label', { class: 'picker' }, h('span', null, 'Version'),
          select(sources.map((s) => [s.Id, s.Name || s.Container]), ms.Id, (v) => {
            ms = sources.find((s) => s.Id === v);
            audioIndex = chooseAudio(item, ms);
            subIndex = chooseSubtitle(item, ms, audioIndex);
            renderTracks();
          })) : null,
        audios.length ? h('label', { class: 'picker' }, h('span', null, 'Audio'),
          select(audios.map((s) => [s.Index, streamLabel(s)]), audioIndex, (v) => {
            audioIndex = Number(v);
            rememberTrack(item, 'audio', audios.find((s) => s.Index === audioIndex));
          })) : null,
        h('label', { class: 'picker' }, h('span', null, 'Subtitles'),
          select([[-1, 'Off'], ...subs.map((s) => [s.Index, streamLabel(s)])], subIndex, (v) => {
            subIndex = Number(v);
            rememberTrack(item, 'subtitle', subs.find((s) => s.Index === subIndex) || null);
          })));
    };
    if (ms) renderTracks();

    const play = (fromStart) => openPlayer(item.Id, {
      startTicks: fromStart ? 0 : undefined,
      mediaSourceId: ms?.Id,
      audioIndex,
      subIndex,
    });

    const actions = [
      pos > 0
        ? button(`Resume ${formatTime(pos)}`, { icon: 'play', variant: 'primary', onclick: () => play(false) })
        : button('Play', { icon: 'play', variant: 'primary', onclick: () => play(true) }),
      pos > 0 ? button('From start', { icon: 'replay', onclick: () => play(true) }) : null,
      trailerBtn(item),
      moreBtn(item, () => load(true), item.Type === 'Episode' && item.SeriesId ? [{ label: 'Go to series', onClick: () => navigate('item', { id: item.SeriesId }) }] : []),
      ...stateChips(item),
    ];

    const subtitle = item.Type === 'Episode'
      ? h('button', { class: 'series-link', onclick: () => navigate('item', { id: item.SeriesId }) }, item.SeriesName)
      : null;

    return hero(item, { actions, extra: trackArea, subtitle });
  }

  // ---------- series ----------

  async function renderSeries(series, my) {
    const [seasons, nextUpRes] = await Promise.all([
      api.seasons(series.Id),
      api.nextUp({ SeriesId: series.Id, Limit: 1 }).catch(() => null),
    ]);
    if (my !== token) return null;
    const next = nextUpRes?.Items?.[0] || null;
    if (!selectedSeason || !seasons.some((s) => s.Id === selectedSeason)) {
      selectedSeason = (next && seasons.find((s) => s.Id === next.SeasonId)?.Id)
        || seasons.find((s) => s.IndexNumber !== 0)?.Id || seasons[0]?.Id || null;
    }

    const playNext = async () => {
      if (next) return openPlayer(next.Id);
      const eps = await api.episodes(series.Id, { Limit: 1 }).catch(() => []);
      if (eps[0]) openPlayer(eps[0].Id);
      else toast('No episodes found', 'error');
    };
    const nextPos = (next?.UserData?.PlaybackPositionTicks || 0) / TICKS;
    const playLabel = next ? `${nextPos ? 'Resume' : 'Play'} ${epLabel(next)}` : 'Play';

    const actions = [
      button(playLabel, { icon: 'play', variant: 'primary', onclick: playNext }),
      button('Shuffle', { icon: 'shuffle', onclick: () => shufflePlay(series.Id, 'Episode') }),
      trailerBtn(series),
      moreBtn(series, () => load(true)),
      ...stateChips(series),
    ];

    const memory = trackMemory(series);
    const top = hero(series, { actions, extra: memory });

    const tabs = h('div', { class: 'season-tabs' });
    const tabList = h('div', { role: 'tablist', 'aria-label': 'Seasons', style: { display: 'contents' } });
    const list = h('ul', { class: 'episode-list', role: 'tabpanel', 'aria-label': 'Episodes' });
    const seasonBtn = (s) => {
      const played = !!s.UserData?.Played;
      return button(played ? 'Mark season unwatched' : 'Mark season watched', {
        icon: 'doneAll',
        cls: 'small-btn season-mark',
        onclick: async () => {
          try {
            await api.setPlayed(s.Id, !played);
            toast(`${s.Name} marked ${played ? 'unwatched' : 'watched'}`);
            load(true);
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      });
    };
    const pick = (s, focus) => {
      selectedSeason = s.Id;
      renderTabs();
      loadEpisodes();
      if (focus) tabList.querySelector(`[data-id="${s.Id}"]`)?.focus();
    };
    // A real tab list: one tab stop, arrow keys move between seasons.
    const renderTabs = () => {
      fill(tabList, seasons.map((s, i) => h('button', {
        class: 'season-tab',
        role: 'tab',
        dataset: { id: s.Id },
        'aria-selected': String(s.Id === selectedSeason),
        tabindex: s.Id === selectedSeason ? 0 : -1,
        onclick: () => pick(s),
        onkeydown: (e) => {
          const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: seasons.length - 1 }[e.key];
          if (n === undefined) return;
          e.preventDefault();
          pick(seasons[(n + seasons.length) % seasons.length], true);
        },
      }, s.Name, s.UserData?.UnplayedItemCount ? h('span', { class: 'tab-count', 'aria-label': `${s.UserData.UnplayedItemCount} unwatched` }, s.UserData.UnplayedItemCount) : null)));
      fill(tabs, tabList, seasons.filter((s) => s.Id === selectedSeason).map(seasonBtn));
    };

    async function loadEpisodes() {
      const season = selectedSeason;
      list.replaceChildren(h('li', null, spinner()));
      try {
        const eps = await api.episodes(series.Id, { seasonId: season });
        if (season !== selectedSeason || my !== token) return;
        list.replaceChildren(...eps.map((ep) => episodeRow(ep, () => load(true))));
        if (!eps.length) list.replaceChildren(h('li', { class: 'empty' }, 'No episodes in this season.'));
      } catch (err) {
        list.replaceChildren(h('li', null, errorBox(err, loadEpisodes)));
      }
    }

    renderTabs();
    await loadEpisodes();
    return [top, h('section', { class: 'seasons' }, tabs, list)];
  }

  function trackMemory(series) {
    const box = h('div', { class: 'track-memory' });
    const render = () => {
      const pref = seriesPref(series.Id);
      if (!pref || (!pref.audio && !pref.subtitle)) {
        box.replaceChildren(h('span', { class: 'muted' }, icon('audio'),
          'Audio & subtitle choices you make in any episode will be remembered for the whole series.'));
        return;
      }
      fill(box, 
        h('span', { class: 'mem-label' }, 'Remembered for this series:'),
        pref.audio ? h('span', { class: 'chip' }, icon('audio'), pref.audio.label || pref.audio.language || 'Audio') : null,
        pref.subtitle ? h('span', { class: 'chip' }, icon('subtitles'), pref.subtitle.off ? 'Subtitles off' : (pref.subtitle.label || pref.subtitle.language)) : null,
        h('button', {
          class: 'link-btn',
          onclick: () => {
            forgetSeries(series.Id);
            render();
            toast('Track memory cleared for this series');
          },
        }, 'Reset'));
    };
    render();
    return box;
  }

  function episodeRow(ep, refresh) {
    const ud = ep.UserData || {};
    const pct = ud.PlayedPercentage && !ud.Played ? ud.PlayedPercentage : 0;
    const img = landscapeUrl(ep, 480);
    const aired = ep.PremiereDate ? new Date(ep.PremiereDate).toLocaleDateString() : '';
    const label = [`Episode ${ep.IndexNumber ?? ''}`, ep.Name, isNewItem(ep) ? 'new' : '', ud.Played ? 'watched' : pct ? `${Math.round(pct)}% played` : ''].filter(Boolean).join(', ');
    const rowEl = h('li', { class: `episode ${ud.Played ? 'played' : ''}`, tabindex: 0, 'aria-label': label },
      h('div', {
        class: 'ep-thumb',
        onclick: (e) => {
          e.stopPropagation();
          openPlayer(ep.Id);
        },
      },
      img ? fadeImg(img) : h('div', { class: 'card-fallback' }, icon('tv')),
      h('div', { class: 'ep-play' }, icon('play')),
      pct ? h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })) : null),
      h('div', { class: 'ep-body' },
        h('div', { class: 'ep-title' },
          h('span', { class: 'ep-num' }, ep.IndexNumber != null ? `${ep.IndexNumber}.` : ''),
          ep.Name,
          isNewItem(ep) ? h('span', { class: 'pill-new', 'aria-hidden': 'true' }, 'New') : null),
        h('div', { class: 'ep-meta' }, [formatRuntime(ep.RunTimeTicks), aired, ep.CommunityRating ? `★ ${ep.CommunityRating.toFixed(1)}` : '']
          .filter(Boolean).join(' · ')),
        ep.Overview ? h('div', { class: 'ep-overview clamp-2' }, ep.Overview) : null),
      h('div', { class: 'ep-actions' },
        iconBtn('check', ud.Played ? 'Mark unwatched' : 'Mark watched', async (e) => {
          e.stopPropagation();
          try {
            await api.setPlayed(ep.Id, !ud.Played);
            refresh();
          } catch (err) {
            toast(err.message, 'error');
          }
        }, `round small ${ud.Played ? 'on' : ''}`)));
    rowEl.addEventListener('click', () => navigate('item', { id: ep.Id }));
    rowEl.addEventListener('contextmenu', (e) => itemMenu(ep, e));
    // Enter opens the episode, Space plays it, the Menu key opens the menu.
    rowEl.addEventListener('keydown', (e) => {
      if (e.target !== rowEl) return;
      if (e.key === 'Enter') navigate('item', { id: ep.Id });
      else if (e.key === ' ') {
        e.preventDefault();
        openPlayer(ep.Id);
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = rowEl.getBoundingClientRect();
        itemMenu(ep, { preventDefault() {}, stopPropagation() {}, currentTarget: rowEl, clientX: r.left + 40, clientY: r.top + 20 });
      }
    });
    return rowEl;
  }

  // ---------- collections / folders ----------

  // A person (from search or the cast row): their movies and shows in this library.
  async function renderPerson(item, my) {
    const res = await api.items({
      PersonIds: item.Id,
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      SortBy: 'ProductionYear,SortName',
      SortOrder: 'Descending',
      Fields: 'PrimaryImageAspectRatio,ProductionYear',
      EnableImageTypes: 'Primary,Thumb,Backdrop',
    });
    if (my !== token) return null;
    const items = res?.Items || [];
    const photo = item.ImageTags?.Primary ? api.image(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: 400 }) : null;
    return [
      h('header', { class: 'person-head' },
        photo ? h('img', { class: 'person-photo', src: photo, alt: '' }) : h('div', { class: 'person-photo person-fallback' }, item.Name[0]),
        h('div', { class: 'hero-info' },
          h('h1', null, item.Name),
          item.Overview ? h('p', { class: 'overview clamp-3' }, item.Overview) : null)),
      h('section', { class: 'collection-grid' },
        h('h2', null, items.length ? `In your library (${items.length})` : 'Nothing with them in your library'),
        h('div', { class: 'grid size-m portrait' }, items.map((i) => itemCard(i)))),
    ];
  }

  async function renderCollection(item, my) {
    const res = await api.items({
      ParentId: item.Id,
      SortBy: item.Type === 'BoxSet' ? 'PremiereDate,ProductionYear,SortName' : 'SortName',
      Fields: 'PrimaryImageAspectRatio,ProductionYear',
      EnableImageTypes: 'Primary,Thumb,Backdrop',
    });
    if (my !== token) return null;
    const items = res?.Items || [];
    return [
      hero(item, { actions: [moreBtn(item, () => load(true)), ...stateChips(item)] }),
      h('section', { class: 'collection-grid' },
        h('h2', null, `${items.length} item${items.length === 1 ? '' : 's'}`),
        h('div', { class: 'grid size-m portrait' }, items.map((i) => itemCard(i)))),
    ];
  }

  load();
  const self = {
    el,
    onShow: () => load(true),
    destroy() {
      token++;
    },
  };
  return self;
}
