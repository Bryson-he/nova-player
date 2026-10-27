import { api } from '../api.js';
import { h, icon, row, spinner, errorBox, backdropUrl, logoUrl, button, epLabel, formatTime, toast } from '../ui.js';
import { refreshNewEpisodes, newEpisodeShows } from '../newcontent.js';
import { navigate } from '../router.js';
import { openPlayer } from '../player.js';
import { TICKS } from '../api.js';

export function homeView() {
  const el = h('div', { class: 'page home' }, spinner());
  let token = 0;

  function heroFor(item) {
    const bd = backdropUrl(item);
    const logo = logoUrl(item);
    const pos = (item.UserData?.PlaybackPositionTicks || 0) / TICKS;
    const title = item.Type === 'Episode' ? item.SeriesName : item.Name;
    return h('section', { class: 'home-hero' },
      bd ? h('div', { class: 'home-hero-bg', style: { backgroundImage: `url("${bd}")` } }) : null,
      h('div', { class: 'home-hero-fade' }),
      h('div', { class: 'home-hero-content' },
        h('div', { class: 'eyebrow' }, 'Continue watching'),
        logo ? h('img', { class: 'hero-logo', src: logo, alt: title }) : h('h1', null, title),
        item.Type === 'Episode' ? h('div', { class: 'hero-sub' }, `${epLabel(item)} · ${item.Name}`) : null,
        item.Overview ? h('p', { class: 'hero-overview clamp-3' }, item.Overview) : null,
        h('div', { class: 'hero-actions' },
          button(pos ? `Resume ${formatTime(pos)}` : 'Play', { icon: 'play', variant: 'primary', onclick: () => openPlayer(item.Id) }),
          button('Details', { icon: 'info', onclick: () => navigate('item', { id: item.Id }) }))));
  }

  async function removeFromResume(item, card) {
    card.classList.add('removing');
    try {
      await api.hideFromResume(item.Id);
      card.remove();
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
      const nextUp = (nextUpR.value?.Items || []).filter((n) => !resume.some((r) => r.Id === n.Id));
      const frag = [];
      if (resume.length) frag.push(heroFor(resume[0]));
      if (resume.length) frag.push(row('Continue Watching', resume, { shape: 'landscape', onRemove: removeFromResume }));
      if (nextUp.length) frag.push(row('Next Up', nextUp, { shape: 'landscape' }));
      const newSlot = h('div');
      const favSlot = h('div');
      frag.push(newSlot, favSlot);

      const libs = (viewsR.value?.Items || []).filter((v) => ['movies', 'tvshows', 'homevideos', 'mixed', undefined].includes(v.CollectionType));
      const latestSlots = libs.map(() => h('div'));
      frag.push(...latestSlots);
      if (!frag.length) frag.push(h('div', { class: 'empty' }, icon('movie'), h('p', null, 'Nothing here yet.')));
      el.replaceChildren(...frag);

      newEpisodeShows().then((items) => {
        if (my === token && items.length) newSlot.replaceWith(row('New Episodes', items));
      });

      api.favorites().then((items) => {
        if (my === token && items.length) favSlot.replaceWith(row('Favorites', items));
      });

      libs.forEach((lib, i) => {
        api.latest(lib.Id).then((items) => {
          if (my !== token || !items?.length) return;
          latestSlots[i].replaceWith(row(`Recently Added in ${lib.Name}`, items, { shape: 'portrait' }));
        }).catch(() => {});
      });
    } catch (err) {
      if (my === token) el.replaceChildren(errorBox(err, load));
    }
  }

  load();
  return {
    el,
    onShow: load,
    destroy() {
      token++;
      window.removeEventListener('focus', onFocus);
    },
  };
}
