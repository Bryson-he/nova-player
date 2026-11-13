// Stream setup: playback info, direct play, HLS (hls.js), reloads and errors.
// Methods are mixed into Player (see player.js); `this` is the player.

import { api, TICKS } from '../api.js';
import { store } from '../store.js';
import { h, fill, toast, formatTime, epLabel, posterUrl, copyText } from '../ui.js';
import { buildDeviceProfile } from '../profile.js';
import { chooseAudio, chooseSubtitle, chooseSecondarySubtitle, audioStreams, subStreams, isTextSub, containerDefaultAudio } from '../tracks.js';
import { BUFFERS, SKIP_LABELS, PLAYBACK_ERRORS } from './constants.js';

export class StreamMixin {
  // ---------------------------------------------------------------- loading

  // opts.queue: optional list of items (e.g. a shuffle) that drives next/previous.
  async start(id, opts = {}) {
    this.queue = Array.isArray(opts.queue) && opts.queue.length ? opts.queue : null;
    if (store.setting('startFullscreen') && !this.isFullscreen()) this.setFullscreen(true);
    window.nova.keepAwake(true);
    this.showControls();
    await this.load(id, { ...opts, announce: true });
  }

  async load(id, opts = {}) {
    let { startTicks, audioIndex, subIndex } = opts;
    const { mediaSourceId, forceTranscode = this.forcedTranscode, message, announce } = opts;
    const my = ++this.loadToken;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.hideError();
    this.setLoading(true, message || 'Loading…');

    try {
      let item = this.item;
      if (!item || item.Id !== id || !item.MediaSources) {
        item = this.prefetchedItem?.Id === id ? this.prefetchedItem : await api.item(id, { signal: abort.signal });
        if (my !== this.loadToken) return;
        this.item = item;
        this.onNewItem(item);
      }

      const base = (mediaSourceId && item.MediaSources?.find((m) => m.Id === mediaSourceId)) || item.MediaSources?.[0];
      if (!base) throw new Error('This item has no playable media.');
      if (audioIndex === undefined || audioIndex === null) audioIndex = chooseAudio(item, base);
      if (subIndex === undefined || subIndex === null) subIndex = chooseSubtitle(item, base, audioIndex);
      if (startTicks === undefined || startTicks === null) startTicks = item.UserData?.PlaybackPositionTicks || 0;

      // Kick off subtitle (and font) downloads now, in parallel with the
      // playback request, so they're ready by the time the video starts.
      const early = this.prefetchSubs(item, base, subIndex ?? -1);
      if (announce) this.prefetchSubs(item, base, chooseSecondarySubtitle(item, base, subIndex ?? -1));
      if (early && this.wantsStyled(subStreams(base).find((s) => s.Index === subIndex))) this.ensureAss().catch(() => {});
      const startSec = startTicks / TICKS;

      const streams = base.MediaStreams || [];
      const subStream = streams.find((s) => s.Type === 'Subtitle' && s.Index === subIndex) || null;
      const audioStream = streams.find((s) => s.Type === 'Audio' && s.Index === audioIndex) || null;
      const needsBurn = !!subStream && !isTextSub(subStream);
      const defAudio = containerDefaultAudio(base);
      const nonDefaultAudio = !!(audioStream && defAudio && audioStream.Index !== defAudio.Index);
      const localAudioOk = 'audioTracks' in HTMLMediaElement.prototype && !this.noLocalAudio && !audioStream?.IsExternal;
      const allowDirect = !forceTranscode && !store.setting('forceTranscode') && !needsBurn && (!nonDefaultAudio || localAudioOk);
      const maxBitrate = this.bitrateOverride || store.setting('maxBitrate');

      const info = await api.playbackInfo(id, {
        DeviceProfile: buildDeviceProfile(maxBitrate),
        MaxStreamingBitrate: maxBitrate,
        StartTimeTicks: 0,
        AudioStreamIndex: audioIndex ?? undefined,
        SubtitleStreamIndex: subIndex ?? -1,
        MediaSourceId: base.Id,
        EnableDirectPlay: allowDirect,
        EnableDirectStream: true,
        EnableTranscoding: true,
        AllowVideoStreamCopy: true,
        AllowAudioStreamCopy: true,
        AutoOpenLiveStream: true,
      }, abort.signal);
      if (my !== this.loadToken) return;
      if (info?.ErrorCode) throw new Error(PLAYBACK_ERRORS[info.ErrorCode] || `Server error: ${info.ErrorCode}`);
      const ms = info?.MediaSources?.find((m) => m.Id === base.Id) || info?.MediaSources?.[0];
      if (!ms) throw new Error('The server returned no playable source.');

      // Stop the previous transcode (track/quality switch) so the server doesn't keep encoding it.
      if (this.playSessionId && this.method && this.method !== 'DirectPlay') api.stopEncoding(this.playSessionId);

      let url;
      let method;
      if (allowDirect && ms.SupportsDirectPlay) {
        url = api.directStreamUrl(id, ms, info.PlaySessionId);
        method = 'DirectPlay';
      } else if (ms.TranscodingUrl) {
        url = api.absolute(ms.TranscodingUrl);
        method = 'Transcode';
      } else {
        throw new Error('No compatible stream is available for this file.');
      }

      this.ms = ms;
      this.playSessionId = info.PlaySessionId;
      this.method = method;
      this.audioIndex = audioIndex;
      this.subIndex = subIndex ?? -1;
      // Secondary subtitle is picked once per episode; track/quality reloads keep it.
      if (announce) this.sub2Index = chooseSecondarySubtitle(item, ms, this.subIndex);
      this.burning = needsBurn && method !== 'DirectPlay';
      this.transcodeReasons = method === 'DirectPlay'
        ? []
        : (new URL(url).searchParams.get('TranscodeReasons') || '').split(',').filter(Boolean);

      this.attach(url, startSec, my);
      this.loadSubtitles();
      this.applyAudio();
      this.updateTrackButtons();
      if (announce && startSec > 5) this.osd(`Resuming from ${formatTime(startSec)}`);
    } catch (err) {
      if (my !== this.loadToken || abort.signal.aborted) return;
      this.fail(err.message || String(err));
    }
  }

  onNewItem(item) {
    const isEp = item.Type === 'Episode';
    this.titleEl.textContent = isEp ? item.SeriesName : item.Name;
    this.subtitleEl.textContent = isEp ? `${epLabel(item)} · ${item.Name}` : (item.ProductionYear || '');
    document.title = isEp ? `${item.SeriesName} ${epLabel(item)} — Nova` : `${item.Name} — Nova`;

    if (navigator.mediaSession && window.MediaMetadata) {
      const art = posterUrl(item, 512);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: isEp ? `${epLabel(item)} ${item.Name}` : item.Name,
        artist: isEp ? item.SeriesName : String(item.ProductionYear || ''),
        artwork: art ? [{ src: art, sizes: '512x512' }] : [],
      });
    }

    const id = item.Id;
    api.segments(id).then((segs) => {
      if (this.item?.Id !== id) return;
      this.segments = segs
        .map((s) => ({ type: s.Type, start: s.StartTicks / TICKS, end: s.EndTicks / TICKS }))
        .filter((s) => s.end > s.start && SKIP_LABELS[s.type]);
      this.currentSegment = undefined;
      this.drawSegments();
    });

    if (this.queue) {
      const i = this.queue.findIndex((q) => q.Id === id);
      this.prevEp = i > 0 ? this.queue[i - 1] : null;
      this.nextEp = i >= 0 && i < this.queue.length - 1 ? this.queue[i + 1] : null;
    } else if (isEp && item.SeriesId) {
      api.adjacentEpisodes(item.SeriesId, id).then((eps) => {
        if (this.item?.Id !== id) return;
        const i = eps.findIndex((e) => e.Id === id);
        this.prevEp = i > 0 ? eps[i - 1] : null;
        this.nextEp = i >= 0 && i < eps.length - 1 ? eps[i + 1] : null;
        this.updateEpButtons();
      });
    }
    this.updateEpButtons();

    // Chapters (only useful when there are at least two).
    const chapters = (item.Chapters || [])
      .map((c, i) => ({ start: (c.StartPositionTicks || 0) / TICKS, name: c.Name || `Chapter ${i + 1}` }))
      .sort((a, b) => a.start - b.start);
    this.chapters = chapters.length >= 2 ? chapters : [];
    this.drawChapters();

    // Subtitle sync is remembered per series (or per movie).
    this.setSubDelay(store.get('subDelays')?.[this.delayKey()] || 0, false);

    const tp = item.Trickplay?.[item.MediaSources?.[0]?.Id] || (item.Trickplay && Object.values(item.Trickplay)[0]);
    if (tp) {
      const widths = Object.keys(tp).map(Number).sort((a, b) => a - b);
      const w = widths.find((x) => x >= 240) || widths[widths.length - 1];
      this.trickplay = { width: w, info: tp[w], msId: item.MediaSources?.[0]?.Id };
    }
  }

  attach(url, startSec, my) {
    this.teardownStream();
    this.attached = true;
    this.pendingSeek = startSec;
    this.netRetries = 0;
    this.mediaRecovered = false;
    const v = this.video;
    this.isHls = /\.m3u8(\?|$)/i.test(url);

    if (this.isHls && window.Hls?.isSupported()) {
      const Hls = window.Hls;
      const hls = new Hls({
        startPosition: startSec > 0 ? startSec : -1,
        enableWorker: true,
        ...(BUFFERS[store.setting('bufferSize')] || BUFFERS.normal),
        manifestLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 30000,
        fragLoadingTimeOut: 120000,
      });
      this.hls = hls;
      this.pendingSeek = 0;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (this.hls !== hls || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered) {
          this.mediaRecovered = true;
          hls.recoverMediaError();
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.netRetries < 3) {
          this.netRetries++;
          setTimeout(() => this.hls === hls && hls.startLoad(), 1500 * this.netRetries);
          return;
        }
        this.fail(`Streaming error (${data.details}).`);
      });
      hls.attachMedia(v);
      hls.loadSource(url);
    } else {
      v.src = url;
    }
    v.play().catch(() => {});
    this.armStallWatch(my);
  }

  armStallWatch(my) {
    clearTimeout(this.stall1);
    clearTimeout(this.stall2);
    this.stall1 = setTimeout(() => {
      if (my === this.loadToken && !this.hasPlayed) {
        this.loadingText.textContent = this.method === 'DirectPlay' ? 'Still loading…' : 'The server is preparing your stream…';
      }
    }, 8000);
    this.stall2 = setTimeout(() => {
      if (my === this.loadToken && !this.hasPlayed && this.attached) {
        this.fail('The server took too long to start this video.');
      }
    }, 90000);
  }

  teardownStream() {
    this.attached = false;
    clearTimeout(this.waitTimer);
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // ignore
      }
      this.hls = null;
    }
    const v = this.video;
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      // ignore
    }
    this.clearSubs();
  }

  reload(overrides = {}) {
    if (!this.item) return;
    const pos = this.currentPosition();
    this.hasPlayed = false;
    this.load(this.item.Id, {
      startTicks: Math.floor(pos * TICKS),
      audioIndex: this.audioIndex,
      subIndex: this.subIndex,
      mediaSourceId: this.ms?.Id,
      forceTranscode: this.forcedTranscode,
      ...overrides,
    });
  }

  onMetadata() {
    const v = this.video;
    if (this.pendingSeek > 0) {
      v.currentTime = this.pendingSeek;
      this.pendingSeek = 0;
    }
    if (this.method === 'DirectPlay') {
      const def = containerDefaultAudio(this.ms);
      if (this.audioIndex != null && def && this.audioIndex !== def.Index && !this.applyLocalAudio(this.audioIndex)) {
        this.noLocalAudio = true;
        this.reload({ message: 'Switching audio track…' });
      }
    }
    this.drawSegments();
    this.drawChapters();
    this.updateTimeUi();
  }

  applyLocalAudio(index) {
    const tracks = this.video.audioTracks;
    if (!tracks) return false;
    const embedded = audioStreams(this.ms).filter((s) => !s.IsExternal);
    const ord = embedded.findIndex((s) => s.Index === index);
    if (ord < 0 || tracks.length !== embedded.length) return false;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === ord;
    return true;
  }

  onVideoError() {
    if (!this.attached || this.hls) return;
    const err = this.video.error;
    if (!err) return;
    if (this.method === 'DirectPlay' && !this.fallbackTried) {
      this.fallbackTried = true;
      this.forcedTranscode = true;
      toast("This file can't play directly on this PC — switching to server transcoding.");
      this.reload({ forceTranscode: true, message: 'Switching to transcoding…' });
      return;
    }
    const cause = {
      1: 'Playback was stopped before the video loaded.',
      2: 'The connection to your server dropped while loading the video.',
      3: "This PC couldn't decode the video. Transcoding usually fixes it.",
      4: "This video's format can't play here. Transcoding usually fixes it.",
    }[err.code] || 'The video stopped with an error.';
    this.fail(cause, `${err.message || ''} (media error ${err.code})`);
  }

  fail(message, details = '') {
    this.setLoading(false);
    clearTimeout(this.stall1);
    clearTimeout(this.stall2);
    const retry = (force) => {
      this.hideError();
      this.fallbackTried = force;
      this.forcedTranscode = force;
      this.reload({ forceTranscode: force });
    };
    const info = [message, details, `Method: ${this.method || 'none'}`, `Item: ${this.item?.Id || '?'}`, `Container: ${this.ms?.Container || '?'}`].filter(Boolean).join('\n');
    this.errorEl.setAttribute('role', 'alertdialog');
    fill(this.errorEl,
      h('div', { class: 'error-title' }, "Couldn't play this video"),
      h('div', { class: 'error-msg' }, message),
      h('div', { class: 'error-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => retry(this.forcedTranscode) }, 'Retry'),
        this.forcedTranscode ? null : h('button', { class: 'btn btn-secondary', onclick: () => retry(true) }, 'Retry with transcoding'),
        h('button', { class: 'btn btn-secondary', onclick: () => copyText(info, 'Details copied') }, 'Copy details'),
        h('button', { class: 'btn btn-quiet', onclick: () => this.destroy() }, 'Close')));
    requestAnimationFrame(() => this.errorEl.querySelector('.btn-primary')?.focus());
    this.errorEl.classList.remove('hidden');
    this.showControls();
  }

  hideError() {
    this.errorEl.classList.add('hidden');
  }

  setLoading(on, text, showCancel = true) {
    this.loadingVisible = on;
    if (!on) clearTimeout(this.waitTimer);
    if (text) this.loadingText.textContent = text;
    this.loadingEl.classList.toggle('show', on);
    this.loadingEl.classList.toggle('no-cancel', !showCancel);
  }
}
