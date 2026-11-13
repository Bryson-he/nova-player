// @ts-check
// Jellyfin REST client. Every call is async with a timeout so a slow or
// unreachable server can never lock up the interface.
import { store } from './store.js';

export const TICKS = 10_000_000;
export const CLIENT_NAME = 'Nova Player';
export const CLIENT_VERSION = '1.0.0';
const DEVICE_NAME = 'Windows PC';

export const CARD_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,Overview,DateCreated';
const DETAIL_FIELDS = 'Overview,Genres,People,Studios,MediaSources,MediaStreams,Trickplay,Taglines,ChildCount,RecursiveItemCount,DateCreated,Chapters,ExternalUrls,RemoteTrailers';

/**
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {Record<string, unknown>} [query]
 * @property {unknown} [body]
 * @property {number} [timeout]  milliseconds
 * @property {AbortSignal} [signal]
 * @property {string} [base]  another server, used while signing in
 */

export class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Removes the query-string credentials Jellyfin puts in TranscodingUrl and
 * DeliveryUrl. The token travels in the Authorization header instead, which
 * the main process adds to every request for the signed-in server.
 * @param {string} url
 */
export function stripKeyParams(url) {
  const [head, hash = ''] = String(url).split('#');
  const q = head.indexOf('?');
  if (q < 0) return url;
  const kept = head.slice(q + 1).split('&').filter((p) => p && !/^(api_key|apikey)=/i.test(p));
  return head.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') + (hash ? '#' + hash : '');
}

class Api {
  base = '';
  userId = '';
  /** True when the main process holds a token for `base`. The page never sees the token. */
  signedIn = false;
  /** @type {(() => void) | null} */
  onUnauthorized = null;
  version = CLIENT_VERSION;
  serverVersion = '';

  /** @param {{ base?: string, signedIn?: boolean, userId?: string, serverVersion?: string }} opts */
  configure({ base, signedIn, userId, serverVersion }) {
    if (base !== undefined) this.base = base.replace(/\/+$/, '');
    if (signedIn !== undefined) this.signedIn = signedIn;
    if (userId !== undefined) this.userId = userId;
    if (serverVersion !== undefined) this.serverVersion = serverVersion || '';
  }

  // Identifies the client. The main process swaps in a header with the token
  // for requests to the signed-in server.
  authHeader() {
    const parts = [
      `Client="${CLIENT_NAME}"`,
      `Device="${DEVICE_NAME}"`,
      `DeviceId="${store.get('deviceId')}"`,
      `Version="${this.version}"`,
    ];
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

  // Makes a server-relative URL absolute, without any key in the query string.
  /** @param {string} relOrAbs */
  absolute(relOrAbs) {
    const full = /^https?:/i.test(relOrAbs) ? relOrAbs : this.base + (relOrAbs.startsWith('/') ? '' : '/') + relOrAbs;
    return stripKeyParams(full);
  }

  /** @param {string} path @param {RequestOptions} [opts] */
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
          if (this.signedIn) this.onUnauthorized?.();
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
      throw new Error(`Cannot reach server (${err.message})`, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Jellyfin 10.9 moved several user routes. Try the new route first, then the legacy one.
  /** @param {string[]} paths @param {RequestOptions} [opts] */
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

  // Probing and sign-in run in the main process, which keeps the token.
  /**
   * @param {string} input
   * @returns {Promise<{ base: string, info: { Id: string, ServerName: string, Version: string }, encrypted: boolean, privateHost: boolean }>}
   */
  async findServer(input) {
    const res = await window.nova.findServer(String(input));
    if ('error' in res && res.error) throw new Error(res.error);
    return /** @type {NovaFoundServer} */ (res);
  }

  publicUsers() {
    return this.request('/Users/Public', { timeout: 6000 }).catch(() => []);
  }

  /** @param {{ username: string, password: string } | { secret: string }} req */
  async #signIn(req) {
    const res = await window.nova.signIn({ base: this.base, ...req });
    if (res.ok === false) throw new ApiError(res.status || 0, res.status === 401 ? 'Not authorized.' : res.message);
    return res;
  }

  /** @param {string} username @param {string} password */
  login(username, password) {
    return this.#signIn({ username, password });
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

  /** @param {string} secret */
  quickConnectAuth(secret) {
    return this.#signIn({ secret });
  }

  logout() {
    return window.nova.signOut().catch(() => {});
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
      query: { userId: this.userId, Fields: 'Overview,PrimaryImageAspectRatio,DateCreated', ...query },
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

  /** @param {string} term @param {AbortSignal} [signal] */
  searchPeople(term, signal) {
    return this.request('/Persons', {
      query: { userId: this.userId, searchTerm: term, Limit: 20, EnableImageTypes: 'Primary', ImageTypeLimit: 1 }, signal,
    }).then((r) => r?.Items || []).catch(() => []);
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

  /**
   * @param {string} id
   * @param {string} [type]
   * @param {{ tag?: string, maxWidth?: number, maxHeight?: number, quality?: number, index?: number }} [opts]
   */
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
    });
  }

  // format: 'vtt' (converted by the server) or 'ass' (original styled file).
  subtitleUrl(itemId, mediaSourceId, index, format = 'vtt') {
    return this.url(`/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/0/Stream.${format}`);
  }

  attachmentUrl(itemId, mediaSourceId, index) {
    return this.url(`/Videos/${itemId}/${mediaSourceId}/Attachments/${index}`);
  }

  trickplayUrl(itemId, width, tileIndex, mediaSourceId) {
    return this.url(`/Videos/${itemId}/Trickplay/${width}/${tileIndex}.jpg`, { mediaSourceId });
  }
}

export const api = new Api();
