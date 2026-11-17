import { api } from '../api.js';
import { h, icon, row, errorBox, backdropUrl, logoUrl, button, epLabel, formatTime, skeletonRows, removeFromResume as removeResume } from '../ui.js';
import { refreshNewEpisodes, newEpisodeShows } from '../newcontent.js';
import { navigate } from '../router.js';
import { openPlayer } from '../player.js';
import { TICKS } from '../api.js';

export function homeView() {
  const el = h('div', { class: 'page home', 'aria-busy': 'true' }, skeletonRows());
  let token = 0;

  // The hero is the one thing to pick up next: the most recent item you're
  // part way through, or else the next episode of a show. The row below holds
  // the rest, so nothing appears twice.
  function hero(item) {
    const bd = backdropUrl(item);
    const logo = logoUrl(item);
    const pos = (item.UserData?.PlaybackPositionTicks || 0) / TICKS;
    const title = item.Type === 'Episode' ? item.SeriesName : item.Name;
    const label = pos
      ? `Resume ${item.Type === 'Episode' ? epLabel(item) + ' ' : ''}from ${formatTime(pos)}`
      : item.Type === 'Episode' ? `Play ${epLabel(item)}` : 'Play';
    return h('section', { class: 'home-hero', 'aria-label': `Pick up ${title}` },
      bd ? h('div', { class: 'home-hero-bg', style: { backgroundImage: `url("${bd}")` } }) : null,
      h('div', { class: 'home-hero-fade' }),
      h('div', { class: 'home-hero-content' },
        logo ? h('img', { class: 'hero-logo', src: logo, alt: title }) : h('h1', null, title),
        item.Type === 'Episode' ? h('div', { class: 'hero-sub' }, `${epLabel(item)} · ${item.Name}`) : null,
        item.Overview ? h('p', { class: 'hero-overview clamp-3' }, item.Overview) : null,
        h('div', { class: 'hero-actions' },
          button(label, { icon: 'play', variant: 'primary', onclick: () => openPlayer(item.Id) }),
          button('Details', { onclick: () => navigate('item', { id: item.Id }) }))));
  }

  async function removeFromResume(item, card) {
    card.classList.add('removing');
    const ok = await removeResume(item, () => load());
    if (!ok) card.classList.remove('removing');
  }

  let lastLoad = 0;
  // Coming back to Nova after a while: refresh Home so new episodes show up.
  const onFocus = () => {
    if (el.isConnected && Date.now() - lastLoad > 5 * 60 * 1000) load();
  };
  window.addEventListener('focus', onFocus);

  async function load() {
    lastLoad = Date.now();
    const my = ++token;
    try {
      const [resumeR, nextUpR, viewsR] = await Promise.allSettled([api.resume(), api.nextUp(), api.views(), refreshNewEpisodes()]);
      if (my !== token) return;
      if (viewsR.status === 'rejected' && resumeR.status === 'rejected') throw viewsR.reason;

      const resume = resumeR.value?.Items || [];
      // The taskbar jump list mirrors Continue watching.
      window.nova.setJumpList(resume.slice(0, 8).map((i) => ({
        id: i.Id,
        title: i.Type === 'Episode' ? `${i.SeriesName} · ${epLabel(i)}` : i.Name,
      })));
      const nextUp = (nextUpR.value?.Items || []).filter((n) => !resume.some((r) => r.Id === n.Id));
      const frag = [];
      const top = [...resume, ...nextUp].find((i) => backdropUrl(i));
      if (top) frag.push(hero(top));
      const rest = resume.filter((i) => i !== top);
      const restNext = nextUp.filter((i) => i !== top);
      if (rest.length) frag.push(row('Continue watching', rest, { shape: 'landscape', onRemove: removeFromResume }));
      if (restNext.length) frag.push(row('Next up', restNext, { shape: 'landscape' }));
      const newSlot = h('div');
      const favSlot = h('div');
      frag.push(newSlot, favSlot);

      const libs = (viewsR.value?.Items || []).filter((v) => ['movies', 'tvshows', 'homevideos', 'mixed', undefined].includes(v.CollectionType));
      const latestSlots = libs.map(() => h('div'));
      frag.push(...latestSlots);
      if (!frag.length) frag.push(h('div', { class: 'empty' }, icon('movie'), h('p', null, 'Nothing here yet.')));
      el.replaceChildren(...frag);
      el.removeAttribute('aria-busy');

      newEpisodeShows().then((items) => {
        if (my === token && items.length) newSlot.replaceWith(row('New episodes', items));
      });

      api.favorites().then((items) => {
        if (my === token && items.length) favSlot.replaceWith(row('Favourites', items));
      });

      libs.forEach((lib, i) => {
        api.latest(lib.Id).then((items) => {
          if (my !== token || !items?.length) return;
          latestSlots[i].replaceWith(row(`Recently added in ${lib.Name}`, items, { shape: 'portrait' }));
        }).catch(() => {});
      });
    } catch (err) {
      if (my === token) el.replaceChildren(errorBox(err, load));
    }
  }

  load();
  return {
    el,
    title: 'Home',
    onShow: load,
    destroy() {
      token++;
      window.removeEventListener('focus', onFocus);
    },
  };
}
