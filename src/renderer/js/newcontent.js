// Which shows have new, unwatched episodes. Jellyfin doesn't reliably return a
// show's "last added" date, so ask for recently added unwatched episodes
// instead and group them by show. Cached briefly; shared by every view.
import { api } from './api.js';
import { store, onSettingChange } from './store.js';

const DAY = 24 * 60 * 60 * 1000;
const TTL = 2 * 60 * 1000;
let counts = new Map(); // seriesId -> number of new episodes
let order = []; // seriesIds, most recent first
let fetchedAt = 0;
let inflight = null;

onSettingChange((key) => {
  if (key === 'newBadgeDays') fetchedAt = 0;
});

export const newWindowStart = () => {
  const days = store.setting('newBadgeDays');
  return days ? Date.now() - days * DAY : null;
};

export function newEpisodeCount(seriesId) {
  return counts.get(seriesId) || 0;
}

export function refreshNewEpisodes(force = false) {
  const since = newWindowStart();
  if (!since) {
    counts = new Map();
    order = [];
    return Promise.resolve();
  }
  if (!force && Date.now() - fetchedAt < TTL) return Promise.resolve();
  if (inflight) return inflight;
  inflight = api.items({
    Recursive: true, IncludeItemTypes: 'Episode', Filters: 'IsUnplayed', SortBy: 'DateCreated', SortOrder: 'Descending',
    Limit: 300, Fields: 'DateCreated', EnableImageTypes: '', EnableUserData: true,
  }, { timeout: 10000 }).then((r) => {
    const next = new Map();
    const seen = [];
    for (const ep of r?.Items || []) {
      if (Date.parse(ep.DateCreated || 0) < since) break; // sorted newest first
      if (!ep.SeriesId || ep.UserData?.PlaybackPositionTicks) continue;
      if (!next.has(ep.SeriesId)) seen.push(ep.SeriesId);
      next.set(ep.SeriesId, (next.get(ep.SeriesId) || 0) + 1);
    }
    counts = next;
    order = seen;
    fetchedAt = Date.now();
  }).catch(() => {}).finally(() => { inflight = null; });
  return inflight;
}

// Shows with new episodes, most recently updated first (Home "New Episodes" row).
export async function newEpisodeShows(limit = 30) {
  await refreshNewEpisodes();
  const ids = order.slice(0, limit);
  if (!ids.length) return [];
  const res = await api.items({
    Ids: ids.join(','), Fields: 'PrimaryImageAspectRatio,ProductionYear', EnableImageTypes: 'Primary,Thumb,Backdrop', ImageTypeLimit: 1,
  }).catch(() => null);
  const byId = new Map((res?.Items || []).map((s) => [s.Id, s]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}
