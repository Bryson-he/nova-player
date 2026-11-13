import { api } from '../api.js';
import { h, icon, row, errorBox, backdropUrl, logoUrl, button, epLabel, formatTime, toast, skeletonRows } from '../ui.js';
import { refreshNewEpisodes, newEpisodeShows } from '../newcontent.js';
import { navigate } from '../router.js';
import { openPlayer } from '../player.js';
import { TICKS } from '../api.js';

export function homeView() {
  const el = h('div', { class: 'page home', 'aria-busy': 'true' }, skeletonRows());
  let token = 0;

  // The hero steps through the first few things you're watching, with dots.
  // It moves on by itself every 10 s, except under reduced motion.
  function hero(items) {
    let index = 0;
    let timer = null;
    const section = h('section', { class: 'home-hero', 'aria-roledescription': 'carousel', 'aria-label': 'Continue watching' });
    const dots = items.length > 1
      ? h('div', { class: 'hero-dots', role: 'group', 'aria-label': 'Choose item' }, items.map((it, i) => h('button', {
        class: 'hero-dot',
        'aria-label': it.Type === 'Episode' ? `${it.SeriesName}, ${epLabel(it)}` : it.Name,
        onclick: () => {
          stop();
          show(i);
        },
      })))
      : null;
    const reduced = () => document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stop = () => clearInterval(timer);
    function show(i) {
      index = i;
      const item = items[i];
      const bd = backdropUrl(item);
      const logo = logoUrl(item);
      const pos = (item.UserData?.PlaybackPositionTicks || 0) / TICKS;
      const title = item.Type === 'Episode' ? item.SeriesName : item.Name;
      section.replaceChildren(
        bd ? h('div', { class: 'home-hero-bg', style: { backgroundImage: `url("${bd}")` } }) : null,
        h('div', { class: 'home-hero-fade' }),
        h('div', { class: 'home-hero-content' },
          h('div', { class: 'eyebrow' }, 'Continue watching'),
          logo ? h('img', { class: 'hero-logo', src: logo, alt: title }) : h('h1', null, title),
          item.Type === 'Episode' ? h('div', { class: 'hero-sub' }, `${epLabel(item)} · ${item.Name}`) : null,
          item.Overview ? h('p', { class: 'hero-overview clamp-3' }, item.Overview) : null,
          h('div', { class: 'hero-actions' },
            button(pos ? `Resume ${formatTime(pos)}` : 'Play', { icon: 'play', variant: 'primary', onclick: () => openPlayer(item.Id) }),
            button('Details', { onclick: () => navigate('item', { id: item.Id }) }))),
        dots);
      dots?.querySelectorAll('.hero-dot').forEach((d, n) => d.setAttribute('aria-current', String(n === i)));
    }
    show(0);
    if (items.length > 1 && !reduced()) {
      timer = setInterval(() => {
        if (!section.isConnected || section.matches(':hover, :focus-within')) return;
        show((index + 1) % items.length);
      }, 10000);
    }
    section.addEventListener('focusin', stop);
    return section;
  }

  async function removeFromResume(item, card) {
    card.classList.add('removing');
    try {
      await api.hideFromResume(item.Id);
      (card.closest('[role=listitem]') || card).remove();
      toast(`Removed "${item.Type === 'Episode' ? item.SeriesName : item.Name}" from Continue Watching`);
    } catch (err) {
      card.classList.remove('removing');
      toast(`Couldn't remove it: ${err.message}`, 'error');
    }
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
      const heroItems = [...resume, ...nextUp].filter((i) => backdropUrl(i)).slice(0, 5);
      if (heroItems.length) frag.push(hero(heroItems));
      if (resume.length) frag.push(row('Continue watching', resume, { shape: 'landscape', onRemove: removeFromResume }));
      if (nextUp.length) frag.push(row('Next up', nextUp, { shape: 'landscape' }));
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
        if (my === token && items.length) favSlot.replaceWith(row('Favorites', items));
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
