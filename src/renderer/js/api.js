// Jellyfin REST client. Every call is async with a timeout so a slow or
// unreachable server can never lock up the interface.
import { store } from './store.js';

export const TICKS = 10_000_000;
export const CLIENT_NAME = 'Nova Player';
export const CLIENT_VERSION = '1.0.0';
const DEVICE_NAME = 'Windows PC';

export const CARD_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,Overview';
const DETAIL_FIELDS = 'Overview,Genres,People,Studios,MediaSources,MediaStreams,Trickplay,Taglines,ChildCount,RecursiveItemCount,DateCreated,Chapters,ExternalUrls,RemoteTrailers';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Api {
  base = '';
  token = '';
  userId = '';
  onUnauthorized = null;
  version = CLIENT_VERSION;

  configure({ base, token, userId }) {
    if (base !== undefined) this.base = base.replace(/\/+$/, '');
    if (token !== undefined) this.token = token;
    if (userId !== undefined) this.userId = userId;
  }

  authHeader() {
    const parts = [
      `Client="${CLIENT_NAME}"`,
      `Device="${DEVICE_NAME}"`,
      `DeviceId="${store.get('deviceId')}"`,
      `Version="${this.version}"`,
    ];
    if (this.token) parts.push(`Token="${this.token}"`);
    return 'MediaBrowser ' + parts.join(', ');
  }

  url(path, query, base = this.base) {
    const u = new URL(base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
    }
    return u.toString();
  }

  // Makes a server-relative URL absolute and makes sure it carries the API key.
  absolute(relOrAbs) {
    const full = /^https?:/i.test(relOrAbs) ? relOrAbs : this.base + (relOrAbs.startsWith('/') ? '' : '/') + relOrAbs;
    return this.withKey(full);
  }

  withKey(url) {
    if (/[?&](api_key|apikey)=/i.test(url)) return url;
    return url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(this.token);
  }

  async request(path, { method = 'GET', query, body, timeout = 20000, signal, base } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('Request timed out')), timeout);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(this.url(path, query, base ?? this.base), {
        method,
        headers: {
          Authorization: this.authHeader(),
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        if (res.status === 401) {
          msg = 'Not authorized. Please sign in again.';
          // A revoked or expired token: send the user back to sign-in once.
          if (this.token && path !== '/Sessions/Logout') this.onUnauthorized?.();
        }
        throw new ApiError(res.status, msg);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (ctrl.signal.aborted) {
        const reason = ctrl.signal.reason;
        throw reason instanceof Error ? reason : new Error('Request cancelled');
      }
      throw new Error(`Cannot reach server (${err.message})`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Jellyfin 10.9 moved several user routes. Try the new route first, then the legacy one.
  async tryPaths(paths, opts) {
    let lastErr;
    for (const p of paths) {
      try {
        return await this.request(p, opts);
      } catch (err) {
        lastErr = err;
        if (err.status !== 404 && err.status !== 405) throw err;
      }
    }
    throw lastErr;
  }

  // ---- Server & auth ----

  async findServer(input) {
    const raw = input.trim().replace(/\/+$/, '');
    if (!raw) throw new Error('Enter your server address');
    const candidates = [];
    if (/^https?:\/\//i.test(raw)) {
      candidates.push(raw);
    } else {
      const host = raw.split('/')[0];
      const hasPort = /:\d+$/.test(host);
      if (!hasPort) candidates.push(`http://${host}:8096${raw.slice(host.length)}`);
      candidates.push(`https://${raw}`, `http://${raw}`);
    }
    let lastErr;
    for (const base of candidates) {
      try {
        const info = await this.request('/System/Info/Public', { base, timeout: 6000 });
        if (info?.Id) return { base, info };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Couldn't find a Jellyfin server at "${raw}". ${lastErr ? lastErr.message : ''}`);
  }

  publicUsers() {
    return this.request('/Users/Public', { timeout: 6000 }).catch(() => []);
  }

  login(username, password) {
    return this.request('/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });
  }

  quickConnectEnabled() {
    return this.request('/QuickConnect/Enabled', { timeout: 6000 }).catch(() => false);
  }

  quickConnectInitiate() {
    return this.tryPaths(['/QuickConnect/Initiate'], { method: 'POST' })
      .catch(() => this.request('/QuickConnect/Initiate'));
  }

  quickConnectCheck(secret) {
    return this.request('/QuickConnect/Connect', { query: { secret }, timeout: 8000 });
  }

  quickConnectAuth(secret) {
    return this.request('/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: secret } });
  }

  logout() {
    return this.request('/Sessions/Logout', { method: 'POST', timeout: 4000 }).catch(() => {});
  }

  me() {
    return this.tryPaths(['/Users/Me', `/Users/${this.userId}`], { timeout: 10000 });
  }

  // ---- Browsing ----

  views() {
    return this.tryPaths(['/UserViews', `/Users/${this.userId}/Views`], { query: { userId: this.userId } });
  }

  items(query, opts = {}) {
    return this.request('/Items', { query: { userId: this.userId, ...query }, ...opts });
  }

  item(id, opts = {}) {
    return this.tryPaths([`/Items/${id}`, `/Users/${this.userId}/Items/${id}`], {
      query: { userId: this.userId, Fields: DETAIL_FIELDS },
      ...opts,
    });
  }

  resume(query = {}) {
    return this.tryPaths(['/UserItems/Resume', `/Users/${this.userId}/Items/Resume`], {
      query: {
        userId: this.userId, Limit: 24, MediaTypes: 'Video', Fields: CARD_FIELDS,
        EnableImageTypes: 'Primary,Backdrop,Thumb', ImageTypeLimit: 1, ...query,
      },
    });
  }

  nextUp(query = {}) {
    return this.request('/Shows/NextUp', {
      query: { userId: this.userId, Limit: 24, Fields: CARD_FIELDS, EnableImageTypes: 'Primary,Backdrop,Thumb', ImageTypeLimit: 1, ...query },
    });
  }

  latest(parentId, limit = 20) {
    return this.tryPaths(['/Items/Latest', `/Users/${this.userId}/Items/Latest`], {
      query: {
        userId: this.userId, parentId, Limit: limit, Fields: CARD_FIELDS,
        EnableImageTypes: 'Primary,Backdrop,Thumb', ImageTypeLimit: 1,
      },
    });
  }

  similar(id, limit = 16) {
    return this.request(`/Items/${id}/Similar`, { query: { userId: this.userId, Limit: limit, Fields: CARD_FIELDS } })
      .then((r) => r?.Items || [])
      .catch(() => []);
  }

  genres(parentId, includeItemTypes) {
    return this.request('/Genres', { query: { userId: this.userId, parentId, IncludeItemTypes: includeItemTypes, SortBy: 'SortName' } })
      .then((r) => r?.Items || [])
      .catch(() => []);
  }

  seasons(seriesId) {
    return this.request(`/Shows/${seriesId}/Seasons`, { query: { userId: this.userId, Fields: 'PrimaryImageAspectRatio' } })
      .then((r) => r?.Items || []);
  }

  episodes(seriesId, query = {}) {
    return this.request(`/Shows/${seriesId}/Episodes`, {
      query: { userId: this.userId, Fields: 'Overview,PrimaryImageAspectRatio', ...query },
    }).then((r) => r?.Items || []);
  }

  adjacentEpisodes(seriesId, id) {
    return this.episodes(seriesId, { adjacentTo: id }).catch(() => []);
  }

  search(term, signal) {
    return this.items({
      searchTerm: term, Recursive: true, IncludeItemTypes: 'Movie,Series,Episode,BoxSet,Video',
      Limit: 80, Fields: CARD_FIELDS, EnableImageTypes: 'Primary,Thumb,Backdrop', ImageTypeLimit: 1,
    }, { signal });
  }

  setPlayed(id, played) {
    return this.tryPaths([`/UserPlayedItems/${id}`, `/Users/${this.userId}/PlayedItems/${id}`], {
      method: played ? 'POST' : 'DELETE', query: { userId: this.userId },
    });
  }

  setFavorite(id, fav) {
    return this.tryPaths([`/UserFavoriteItems/${id}`, `/Users/${this.userId}/FavoriteItems/${id}`], {
      method: fav ? 'POST' : 'DELETE', query: { userId: this.userId },
    });
  }

  // Clears the resume point so the item drops off "Continue Watching".
  hideFromResume(id) {
    return this.tryPaths([`/UserItems/${id}/UserData`, `/Users/${this.userId}/Items/${id}/UserData`], {
      method: 'POST', query: { userId: this.userId }, body: { PlaybackPositionTicks: 0 },
    });
  }

  favorites() {
    return this.items({
      Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: 'Movie,Series,Episode',
      SortBy: 'SortName', Limit: 40, Fields: CARD_FIELDS, EnableImageTypes: 'Primary,Thumb,Backdrop', ImageTypeLimit: 1,
    }).then((r) => r?.Items || []).catch(() => []);
  }

  // A random play queue. parentId may be a series, a season or a whole library.
  shuffle(parentId, includeItemTypes = 'Episode,Movie,Video', limit = 200) {
    return this.items({
      ParentId: parentId, Recursive: true, IncludeItemTypes: includeItemTypes, SortBy: 'Random',
      Limit: limit, Fields: 'PrimaryImageAspectRatio', IsMissing: false,
    }).then((r) => r?.Items || []);
  }

  // ---- Playback ----

  playbackInfo(id, body, signal) {
    return this.request(`/Items/${id}/PlaybackInfo`, {
      method: 'POST', query: { userId: this.userId }, body: { UserId: this.userId, ...body }, signal, timeout: 30000,
    });
  }

  reportStart(body) {
    return this.request('/Sessions/Playing', { method: 'POST', body, timeout: 8000 }).catch(() => {});
  }

  reportProgress(body) {
    return this.request('/Sessions/Playing/Progress', { method: 'POST', body, timeout: 8000 }).catch(() => {});
  }

  reportStopped(body) {
    return this.request('/Sessions/Playing/Stopped', { method: 'POST', body, timeout: 8000 }).catch(() => {});
  }

  stopEncoding(playSessionId) {
    return this.request('/Videos/ActiveEncodings', {
      method: 'DELETE', query: { deviceId: store.get('deviceId'), playSessionId }, timeout: 5000,
    }).catch(() => {});
  }

  segments(id) {
    return this.request(`/MediaSegments/${id}`, { timeout: 8000 })
      .then((r) => r?.Items || [])
      .catch(() => []);
  }

  // ---- URLs ----

  image(id, type = 'Primary', { tag, maxWidth, maxHeight, quality = 90, index } = {}) {
    const path = `/Items/${id}/Images/${type}${index != null ? '/' + index : ''}`;
    return this.url(path, { tag, maxWidth, maxHeight, quality });
  }

  userImage(userId, tag) {
    return this.url(`/Users/${userId}/Images/Primary`, { tag, maxWidth: 160, quality: 90 });
  }

  directStreamUrl(itemId, ms, playSessionId) {
    return this.url(`/Videos/${itemId}/stream`, {
      static: 'true',
      mediaSourceId: ms.Id,
      deviceId: store.get('deviceId'),
      PlaySessionId: playSessionId,
      Tag: ms.ETag,
      api_key: this.token,
    });
  }

  // format: 'vtt' (converted by the server) or 'ass' (original styled file).
  subtitleUrl(itemId, mediaSourceId, index, format = 'vtt') {
    return this.url(`/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/0/Stream.${format}`, { api_key: this.token });
  }

  attachmentUrl(itemId, mediaSourceId, index) {
    return this.url(`/Videos/${itemId}/${mediaSourceId}/Attachments/${index}`, { api_key: this.token });
  }

  trickplayUrl(itemId, width, tileIndex, mediaSourceId) {
    return this.url(`/Videos/${itemId}/Trickplay/${width}/${tileIndex}.jpg`, { mediaSourceId, api_key: this.token });
  }
}

export const api = new Api();
