// The video player.
//
// Why it doesn't freeze: the player overlay appears instantly, every server
// call is async with a timeout and is cancelled the moment you press Back,
// decoding happens in Chromium's media pipeline (HLS parsing in a worker), and
// if direct play fails it falls back to server transcoding automatically
// instead of hanging.
import { api, TICKS } from './api.js';
import { store } from './store.js';
import {
  h, fill, icon, iconBtn, popupMenu, closeMenu, isMenuOpen, toast, formatTime, endsAt, epLabel, landscapeUrl, posterUrl,
} from './ui.js';
import { buildDeviceProfile } from './profile.js';
import {
  chooseAudio, chooseSubtitle, audioStreams, subStreams, streamLabel, rememberTrack, isTextSub, containerDefaultAudio,
} from './tracks.js';
import { parseVtt, SubtitleRenderer } from './subtitles.js';
import { refreshCurrent } from './router.js';
import { applySubtitleStyle } from './views/settings.js';

let active = null;
let fsState = false;

window.nova.onFullscreen((value) => {
  fsState = value;
  active?.onFullscreenChange(value);
});

export function openPlayer(id, opts = {}) {
  if (active) active.destroy(true);
  active = new Player();
  active.start(id, opts);
}

export async function shufflePlay(parentId, includeItemTypes) {
  try {
    const queue = await api.shuffle(parentId, includeItemTypes);
    if (!queue.length) {
      toast('Nothing to shuffle here', 'error');
      return;
    }
    openPlayer(queue[0].Id, { queue, startTicks: 0 });
  } catch (err) {
    toast(`Couldn't shuffle: ${err.message}`, 'error');
  }
}

export function closePlayer() {
  active?.destroy(true);
}

export function isPlayerOpen() {
  return !!active;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const QUALITIES = [
  [0, 'Auto (from settings)'], [120000000, 'Maximum'], [40000000, '40 Mbps'], [20000000, '20 Mbps'],
  [10000000, '10 Mbps'], [6000000, '6 Mbps'], [3000000, '3 Mbps'], [1500000, '1.5 Mbps'],
];
const SKIP_LABELS = { Intro: 'Skip Intro', Recap: 'Skip Recap', Preview: 'Skip Preview', Commercial: 'Skip Ad', Outro: 'Skip Credits' };

const PLAYBACK_ERRORS = {
  NotAllowed: 'Your account is not allowed to play this.',
  NoCompatibleStream: 'The server could not find a way to stream this file.',
  RateLimitExceeded: 'The server is busy (too many streams). Try again shortly.',
};

const REASON_LABELS = {
  DirectPlayError: 'Direct play turned off (setting, quality or track choice)',
  ContainerNotSupported: 'File container not supported here (remuxing, no quality loss)',
  VideoCodecNotSupported: 'Video codec not supported on this PC',
  AudioCodecNotSupported: 'Audio codec not supported on this PC',
  SubtitleCodecNotSupported: 'Subtitles must be burned in',
  ContainerBitrateExceedsLimit: 'File bitrate is above your quality limit',
};
const humanize = (s) => REASON_LABELS[s] || s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());

class Player {
  constructor() {
    this.loadToken = 0;
    this.subToken = 0;
    this.item = null;
    this.ms = null;
    this.method = null;
    this.playSessionId = null;
    this.audioIndex = null;
    this.subIndex = -1;
    this.burning = false;
    this.hls = null;
    this.attached = false;
    this.isHls = false;
    this.bitrateOverride = 0;
    this.noLocalAudio = false;
    this.lastKnownTime = 0;
    this.lastReport = 0;
    this.lastUiUpdate = 0;
    this.transcodeReasons = [];
    this.timers = new Set();
    this.resetEpisodeState();
    this.build();
    this.bind();
  }

  resetEpisodeState() {
    this.segments = [];
    this.currentSegment = null;
    this.skippedSegments = new Set();
    this.prevEp = null;
    this.nextEp = null;
    this.upNextShown = false;
    this.upNextCancelled = false;
    this.endedHandled = false;
    this.fallbackTried = false;
    this.forcedTranscode = false;
    this.startedReported = false;
    this.hasPlayed = false;
    this.pendingSeek = 0;
    this.trickplay = null;
    clearInterval(this.countdownTimer);
    if (this.upNextEl) this.upNextEl.classList.add('hidden');
    if (this.skipBtn) this.skipBtn.classList.add('hidden');
    if (this.segLayer) this.segLayer.replaceChildren();
    if (this.subs) this.subs.setDelay(0);
  }

  // ---------------------------------------------------------------- DOM

  build() {
    const v = h('video', { class: 'player-video', autoplay: true, playsinline: true, preload: 'auto' });
    v.volume = store.get('volume') ?? 1;
    v.muted = !!store.get('muted');
    this.video = v;

    this.subLayer = h('div', { class: 'sub-layer' });
    applySubtitleStyle(this.subLayer);
    this.subs = new SubtitleRenderer(v, this.subLayer);

    this.loadingText = h('div', { class: 'loading-text' }, 'Loading…');
    this.loadingEl = h('div', { class: 'player-loading' },
      h('div', { class: 'spinner big' }),
      this.loadingText,
      h('button', { class: 'btn btn-secondary', onclick: () => this.destroy() }, 'Cancel'));

    this.osdEl = h('div', { class: 'osd' });
    this.skipBtn = h('button', { class: 'skip-btn hidden', onclick: () => this.skipSegment() });
    this.upNextEl = h('div', { class: 'upnext hidden' });
    this.infoEl = h('div', { class: 'info-panel hidden' });
    this.errorEl = h('div', { class: 'player-error hidden' });

    this.titleEl = h('div', { class: 'p-title' });
    this.subtitleEl = h('div', { class: 'p-subtitle' });
    const top = h('div', { class: 'p-top' },
      iconBtn('back', 'Back (Esc)', () => this.destroy(), 'p-btn'),
      h('div', { class: 'p-titles' }, this.titleEl, this.subtitleEl));

    this.segLayer = h('div', { class: 'seek-segs' });
    this.bufEl = h('div', { class: 'seek-buf' });
    this.progEl = h('div', { class: 'seek-prog' });
    this.knob = h('div', { class: 'seek-knob' });
    this.tipThumb = h('div', { class: 'seek-thumb hidden' });
    this.tipTime = h('div', { class: 'seek-time' });
    this.hoverTip = h('div', { class: 'seek-tip hidden' }, this.tipThumb, this.tipTime);
    this.seekEl = h('div', { class: 'seek' },
      h('div', { class: 'seek-track' }, this.bufEl, this.segLayer, this.progEl),
      this.knob,
      this.hoverTip);

    this.playBtn = iconBtn('play', 'Play / Pause (Space)', () => this.togglePlay(), 'p-btn big');
    this.prevBtn = iconBtn('prev', 'Previous episode (P)', () => this.playAdjacent(-1), 'p-btn');
    this.nextBtn = iconBtn('next', 'Next episode (N)', () => this.playAdjacent(1), 'p-btn');
    const rewBtn = iconBtn('replay', 'Rewind (←)', () => this.seekBy(-store.setting('seekBack')), 'p-btn');
    const fwdBtn = iconBtn('forward', 'Fast forward (→)', () => this.seekBy(store.setting('seekForward')), 'p-btn');
    this.muteBtn = iconBtn(v.muted ? 'mute' : 'volume', 'Mute (M)', () => this.toggleMute(), 'p-btn');
    this.volSlider = h('input', { type: 'range', min: 0, max: 1, step: 0.01, class: 'vol-slider', value: v.muted ? 0 : v.volume });
    this.timeEl = h('div', { class: 'p-time' }, '0:00 / 0:00');
    this.endsEl = h('div', { class: 'p-ends' });
    this.audioBtn = iconBtn('audio', 'Audio track (A)', (e) => this.audioMenu(e.currentTarget), 'p-btn');
    this.subBtn = iconBtn('subtitles', 'Subtitles (S)', (e) => this.subMenu(e.currentTarget), 'p-btn');
    const setBtn = iconBtn('settings', 'Speed & quality', (e) => this.settingsMenu(e.currentTarget), 'p-btn');
    this.infoBtn = iconBtn('info', 'Playback info (I)', () => this.toggleInfo(), 'p-btn');
    const pipBtn = iconBtn('pip', 'Picture in picture', () => this.togglePip(), 'p-btn');
    this.fsBtn = iconBtn(fsState ? 'fullscreenExit' : 'fullscreen', 'Fullscreen (F)', () => this.toggleFullscreen(), 'p-btn');

    this.bottom = h('div', { class: 'p-bottom' },
      this.seekEl,
      h('div', { class: 'p-row' },
        h('div', { class: 'p-left' },
          this.prevBtn, rewBtn, this.playBtn, fwdBtn, this.nextBtn,
          h('div', { class: 'vol' }, this.muteBtn, this.volSlider),
          this.timeEl),
        h('div', { class: 'p-right' },
          this.endsEl, this.audioBtn, this.subBtn, setBtn, this.infoBtn, pipBtn, this.fsBtn)));

    this.controls = h('div', { class: 'p-controls' }, top, this.bottom);
    this.el = h('div', { class: `player show-controls${fsState ? ' fs' : ''}` },
      v, this.subLayer, this.controls, this.skipBtn, this.upNextEl, this.infoEl, this.osdEl, this.loadingEl, this.errorEl);
    document.body.append(this.el);
    window.nova.setDarkOverlay(true);
    this.updateEpButtons();
  }

  bind() {
    const v = this.video;

    v.addEventListener('playing', () => {
      this.hasPlayed = true;
      this.setLoading(false);
      if (!this.startedReported && this.item) {
        this.startedReported = true;
        this.lastReport = performance.now();
        api.reportStart(this.reportBody());
      }
      this.updatePlayState();
    });
    v.addEventListener('waiting', () => {
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => this.setLoading(true, 'Buffering…', false), 500);
    });
    v.addEventListener('canplay', () => {
      clearTimeout(this.waitTimer);
      if (this.hasPlayed) this.setLoading(false);
    });
    v.addEventListener('play', () => this.updatePlayState());
    v.addEventListener('pause', () => {
      this.updatePlayState();
      this.report();
    });
    v.addEventListener('timeupdate', () => this.onTime());
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('error', () => this.onVideoError());
    v.addEventListener('loadedmetadata', () => this.onMetadata());
    v.addEventListener('seeked', () => {
      this.subs.update();
      this.updateTimeUi();
    });
    v.addEventListener('volumechange', () => {
      this.muteBtn.replaceChildren(icon(v.muted || v.volume === 0 ? 'mute' : 'volume'));
      this.volSlider.value = v.muted ? 0 : v.volume;
      store.set('volume', v.volume);
      store.set('muted', v.muted);
    });

    this.volSlider.addEventListener('input', () => {
      v.volume = Number(this.volSlider.value);
      v.muted = v.volume === 0;
    });

    let clickTimer = null;
    v.addEventListener('click', () => {
      if (isMenuOpen()) {
        closeMenu();
        return;
      }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => this.togglePlay(), 220);
    });
    v.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      this.toggleFullscreen();
    });

    this.el.addEventListener('mousemove', () => this.showControls());
    this.el.addEventListener('wheel', (e) => {
      if (e.target.closest('.menu, .info-panel')) return;
      this.changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
    }, { passive: true });
    // Buttons lose focus after a click so Space never "re-clicks" them.
    this.el.addEventListener('click', (e) => e.target.closest('button')?.blur());
    this.bottom.addEventListener('mouseenter', () => { this.controlsHovered = true; });
    this.bottom.addEventListener('mouseleave', () => { this.controlsHovered = false; });

    // Seek bar
    const posFromEvent = (e) => {
      const r = this.seekEl.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    this.seekEl.addEventListener('pointerdown', (e) => {
      this.seeking = true;
      this.seekEl.setPointerCapture(e.pointerId);
      this.previewSeek(posFromEvent(e));
    });
    this.seekEl.addEventListener('pointermove', (e) => {
      const p = posFromEvent(e);
      this.showTip(p);
      if (this.seeking) this.previewSeek(p);
    });
    this.seekEl.addEventListener('pointerup', (e) => {
      if (!this.seeking) return;
      this.seeking = false;
      this.seekTo(posFromEvent(e) * this.duration());
    });
    this.seekEl.addEventListener('pointerleave', () => {
      if (!this.seeking) this.hoverTip.classList.add('hidden');
    });

    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
    this.onMouseUp = (e) => {
      if (e.button === 3) {
        e.preventDefault();
        this.destroy();
      }
    };
    window.addEventListener('mouseup', this.onMouseUp);

    const msess = navigator.mediaSession;
    if (msess) {
      const set = (action, fn) => {
        try {
          msess.setActionHandler(action, fn);
        } catch {
          // unsupported action
        }
      };
      set('play', () => v.play());
      set('pause', () => v.pause());
      set('seekbackward', () => this.seekBy(-store.setting('seekBack')));
      set('seekforward', () => this.seekBy(store.setting('seekForward')));
      set('previoustrack', () => this.playAdjacent(-1));
      set('nexttrack', () => this.playAdjacent(1));
      set('stop', () => this.destroy());
    }
  }

  handleKey(e) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    let handled = true;
    switch (k) {
      case ' ': case 'k': case 'K': case 'MediaPlayPause': this.togglePlay(); break;
      case 'ArrowLeft': this.seekBy(-(e.shiftKey ? 60 : store.setting('seekBack'))); break;
      case 'ArrowRight': this.seekBy(e.shiftKey ? 60 : store.setting('seekForward')); break;
      case 'j': case 'J': this.seekBy(-10); break;
      case 'l': case 'L': this.seekBy(10); break;
      case 'ArrowUp': this.changeVolume(0.05); break;
      case 'ArrowDown': this.changeVolume(-0.05); break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case 'm': case 'M': this.toggleMute(); break;
      case 's': case 'S': this.cycleSubtitle(); break;
      case 'a': case 'A': this.cycleAudio(); break;
      case 'n': case 'N': this.playAdjacent(1); break;
      case 'p': case 'P': this.playAdjacent(-1); break;
      case 'i': case 'I': this.toggleInfo(); break;
      case 'z': case 'Z': this.adjustSubDelay(-0.1); break;
      case 'x': case 'X': this.adjustSubDelay(0.1); break;
      case '[': this.stepSpeed(-1); break;
      case ']': this.stepSpeed(1); break;
      case 'Enter':
        if (!this.skipBtn.classList.contains('hidden')) this.skipSegment();
        else handled = false;
        break;
      case 'Escape':
        if (fsState) this.setFullscreen(false);
        else this.destroy();
        break;
      case 'Backspace': case 'BrowserBack': this.destroy(); break;
      default:
        if (/^[0-9]$/.test(k)) this.seekTo((this.duration() * Number(k)) / 10);
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.showControls();
    }
  }

  // ---------------------------------------------------------------- loading

  // opts.queue: optional list of items (e.g. a shuffle) that drives next/previous.
  async start(id, opts = {}) {
    this.queue = Array.isArray(opts.queue) && opts.queue.length ? opts.queue : null;
    if (store.setting('startFullscreen') && !fsState) this.setFullscreen(true);
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
        item = await api.item(id, { signal: abort.signal });
        if (my !== this.loadToken) return;
        this.item = item;
        this.onNewItem(item);
      }

      const base = (mediaSourceId && item.MediaSources?.find((m) => m.Id === mediaSourceId)) || item.MediaSources?.[0];
      if (!base) throw new Error('This item has no playable media.');
      if (audioIndex === undefined || audioIndex === null) audioIndex = chooseAudio(item, base);
      if (subIndex === undefined || subIndex === null) subIndex = chooseSubtitle(item, base, audioIndex);
      if (startTicks === undefined || startTicks === null) startTicks = item.UserData?.PlaybackPositionTicks || 0;
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
      this.burning = needsBurn && method !== 'DirectPlay';
      this.transcodeReasons = method === 'DirectPlay'
        ? []
        : (new URL(url).searchParams.get('TranscodeReasons') || '').split(',').filter(Boolean);

      this.attach(url, startSec, my);
      this.loadSubtitles();
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
        maxBufferLength: 60,
        maxMaxBufferLength: 300,
        backBufferLength: 90,
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
    this.subs.clear();
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
    this.fail(`Playback failed: ${err.message || 'media error ' + err.code}`);
  }

  fail(message) {
    this.setLoading(false);
    clearTimeout(this.stall1);
    clearTimeout(this.stall2);
    const retry = (force) => {
      this.hideError();
      this.fallbackTried = force;
      this.forcedTranscode = force;
      this.reload({ forceTranscode: force });
    };
    fill(this.errorEl, 
      h('div', { class: 'error-title' }, "Couldn't play this video"),
      h('div', { class: 'error-msg' }, message),
      h('div', { class: 'error-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => retry(this.forcedTranscode) }, 'Retry'),
        this.forcedTranscode ? null : h('button', { class: 'btn btn-secondary', onclick: () => retry(true) }, 'Retry with transcoding'),
        h('button', { class: 'btn btn-secondary', onclick: () => this.destroy() }, 'Close')));
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

  // ---------------------------------------------------------------- subtitles

  async loadSubtitles() {
    const my = ++this.subToken;
    this.subs.clear();
    const s = this.subIndex >= 0 ? subStreams(this.ms).find((x) => x.Index === this.subIndex) : null;
    if (!s || !isTextSub(s)) return;
    try {
      const res = await fetch(api.subtitleUrl(this.item.Id, this.ms.Id, s.Index));
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      if (my !== this.subToken) return;
      this.subs.setCues(parseVtt(text));
    } catch {
      if (my === this.subToken) toast('Could not load subtitles', 'error');
    }
  }

  adjustSubDelay(delta) {
    this.subs.setDelay(this.subs.delay + delta);
    this.osd(`Subtitle sync ${this.subs.delay > 0 ? '+' : ''}${this.subs.delay.toFixed(1)}s`);
    return this.subs.delay;
  }

  // ---------------------------------------------------------------- track switching

  audioMenu(anchor) {
    const streams = audioStreams(this.ms);
    if (!streams.length) return this.osd('No audio tracks');
    popupMenu(anchor, streams.map((s) => ({
      label: streamLabel(s),
      checked: s.Index === this.audioIndex,
      onClick: () => this.setAudio(s.Index),
    })), { title: 'Audio' });
  }

  setAudio(index) {
    if (index === this.audioIndex || !this.ms) return;
    const stream = audioStreams(this.ms).find((s) => s.Index === index);
    if (!stream) return;
    rememberTrack(this.item, 'audio', stream);
    this.osd(`Audio: ${streamLabel(stream)}`);
    if (this.method === 'DirectPlay' && !stream.IsExternal && this.applyLocalAudio(index)) {
      this.audioIndex = index;
      this.report();
      return;
    }
    this.audioIndex = index;
    this.reload({ audioIndex: index, message: 'Switching audio…' });
  }

  cycleAudio() {
    const list = audioStreams(this.ms);
    if (list.length < 2) return this.osd('Only one audio track');
    const i = list.findIndex((s) => s.Index === this.audioIndex);
    this.setAudio(list[(i + 1) % list.length].Index);
  }

  subMenu(anchor) {
    const subs = subStreams(this.ms);
    const delayVal = h('span', { class: 'delay-val' }, `${this.subs.delay.toFixed(1)}s`);
    const bump = (d) => (e) => {
      e.stopPropagation();
      const val = d === 0 ? (this.subs.setDelay(0), 0) : this.adjustSubDelay(d);
      delayVal.textContent = `${val.toFixed(1)}s`;
    };
    const delayRow = h('div', { class: 'menu-row' },
      h('span', { class: 'menu-row-label' }, 'Sync'),
      h('button', { class: 'mini-btn', title: 'Show earlier (Z)', onclick: bump(-0.1) }, '−'),
      delayVal,
      h('button', { class: 'mini-btn', title: 'Show later (X)', onclick: bump(0.1) }, '+'),
      h('button', { class: 'mini-btn', onclick: bump(0) }, 'Reset'));
    popupMenu(anchor, [
      { label: 'Off', checked: this.subIndex === -1, onClick: () => this.setSubtitle(-1) },
      ...subs.map((s) => ({
        label: streamLabel(s),
        sub: isTextSub(s) ? '' : 'Image subtitle · server burns it in',
        checked: s.Index === this.subIndex,
        onClick: () => this.setSubtitle(s.Index),
      })),
      { divider: true },
      { el: delayRow },
    ], { title: 'Subtitles' });
  }

  setSubtitle(index) {
    if (index === this.subIndex || !this.ms) return;
    const stream = index >= 0 ? subStreams(this.ms).find((s) => s.Index === index) : null;
    rememberTrack(this.item, 'subtitle', stream);
    this.osd(`Subtitles: ${stream ? streamLabel(stream) : 'Off'}`);
    const needsBurn = !!stream && !isTextSub(stream);
    this.subIndex = index;
    this.updateTrackButtons();
    if (needsBurn || this.burning) {
      this.reload({ subIndex: index, message: needsBurn ? 'Preparing subtitles…' : 'Loading…' });
      return;
    }
    this.loadSubtitles();
    this.report();
  }

  cycleSubtitle() {
    const list = [-1, ...subStreams(this.ms).map((s) => s.Index)];
    if (list.length < 2) return this.osd('No subtitles available');
    const i = list.indexOf(this.subIndex);
    this.setSubtitle(list[(i + 1) % list.length]);
  }

  updateTrackButtons() {
    this.subBtn.classList.toggle('on', this.subIndex >= 0);
    this.audioBtn.classList.toggle('dim', audioStreams(this.ms).length < 2);
  }

  // ---------------------------------------------------------------- speed / quality / info

  settingsMenu(anchor) {
    const rate = this.video.playbackRate;
    popupMenu(anchor, [
      { header: 'Playback speed' },
      ...SPEEDS.map((s) => ({ label: s === 1 ? 'Normal' : `${s}×`, checked: Math.abs(rate - s) < 0.01, onClick: () => this.setSpeed(s) })),
      { header: 'Quality' },
      ...QUALITIES.map(([b, label]) => ({
        label,
        checked: this.bitrateOverride === b,
        onClick: () => {
          if (this.bitrateOverride === b) return;
          this.bitrateOverride = b;
          this.reload({ message: 'Changing quality…' });
        },
      })),
    ]);
  }

  setSpeed(s) {
    this.video.playbackRate = s;
    this.osd(`Speed ${s}×`);
  }

  stepSpeed(dir) {
    const i = SPEEDS.findIndex((s) => Math.abs(s - this.video.playbackRate) < 0.01);
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
    this.setSpeed(next);
  }

  toggleInfo() {
    this.infoOpen = !this.infoOpen;
    this.infoEl.classList.toggle('hidden', !this.infoOpen);
    clearInterval(this.infoTimer);
    if (this.infoOpen) {
      this.renderInfo();
      this.infoTimer = setInterval(() => this.renderInfo(), 1000);
    }
  }

  renderInfo() {
    const v = this.video;
    const ms = this.ms;
    if (!ms) return;
    const streams = ms.MediaStreams || [];
    const vs = streams.find((s) => s.Type === 'Video');
    const as = streams.find((s) => s.Index === this.audioIndex);
    const ss = streams.find((s) => s.Type === 'Subtitle' && s.Index === this.subIndex);
    const q = v.getVideoPlaybackQuality?.();
    let method = 'Direct play';
    if (this.method !== 'DirectPlay') {
      const onlyContainer = this.transcodeReasons.length && this.transcodeReasons.every((r) => /Container/i.test(r));
      method = onlyContainer ? 'Direct stream (remux)' : 'Transcoding';
    }
    const rows = [
      ['Play method', method],
      ['Why', this.transcodeReasons.map(humanize).join(', ') || '—'],
      ['Delivery', this.isHls ? 'HLS' : 'Progressive'],
      ['Container', (ms.Container || '').toUpperCase()],
      ['Video', vs ? [vs.Codec?.toUpperCase(), vs.Width && `${vs.Width}×${vs.Height}`, vs.RealFrameRate && `${Math.round(vs.RealFrameRate * 100) / 100} fps`, vs.VideoRangeType].filter(Boolean).join(' · ') : '—'],
      ['Source bitrate', ms.Bitrate ? `${(ms.Bitrate / 1e6).toFixed(1)} Mbps` : '—'],
      ['Audio', as ? streamLabel(as) : '—'],
      ['Subtitles', ss ? `${streamLabel(ss)}${this.burning ? ' (burned in)' : ''}` : 'Off'],
      ['Subtitle sync', `${this.subs.delay > 0 ? '+' : ''}${this.subs.delay.toFixed(1)} s`],
      ['Rendering', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
      ['Dropped frames', q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}` : '—'],
      ['Buffered ahead', `${this.bufferedAhead().toFixed(1)} s`],
      ['Speed', `${v.playbackRate}×`],
    ];
    this.infoEl.replaceChildren(
      h('div', { class: 'info-head' }, h('span', null, 'Playback info'), iconBtn('close', 'Close', () => this.toggleInfo(), 'small')),
      ...rows.map(([k, val]) => h('div', { class: 'info-row' }, h('span', null, k), h('span', null, val))));
  }

  // ---------------------------------------------------------------- transport

  duration() {
    const d = this.video.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return (this.item?.RunTimeTicks || 0) / TICKS;
  }

  currentPosition() {
    const t = this.video.currentTime;
    if (this.attached && t > 0) return t;
    return this.pendingSeek || this.lastKnownTime || 0;
  }

  togglePlay() {
    const v = this.video;
    if (!this.attached) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  seekTo(sec) {
    const dur = this.duration();
    if (!dur || !this.attached) return;
    sec = Math.min(Math.max(0, sec), dur - 0.5);
    this.video.currentTime = sec;
    this.endedHandled = false;
    if (this.upNextShown && dur - sec > store.setting('nextUpCountdown') + 15) {
      this.hideUpNext();
      this.upNextCancelled = false;
    }
    this.currentSegment = undefined;
    this.updateTimeUi(sec);
  }

  seekBy(delta) {
    this.seekTo(this.currentPosition() + delta);
  }

  previewSeek(p) {
    const dur = this.duration();
    this.progEl.style.width = `${p * 100}%`;
    this.knob.style.left = `${p * 100}%`;
    this.timeEl.textContent = `${formatTime(p * dur)} / ${formatTime(dur)}`;
  }

  showTip(p) {
    const dur = this.duration();
    if (!dur) return;
    const t = p * dur;
    this.tipTime.textContent = formatTime(t);
    const tp = this.trickplay;
    if (tp?.info) {
      const info = tp.info;
      const perTile = info.TileWidth * info.TileHeight;
      const idx = Math.min(Math.floor((t * 1000) / info.Interval), (info.ThumbnailCount || Infinity) - 1);
      const tile = Math.floor(idx / perTile);
      const inner = idx % perTile;
      const x = inner % info.TileWidth;
      const y = Math.floor(inner / info.TileWidth);
      const scale = 220 / info.Width;
      Object.assign(this.tipThumb.style, {
        width: '220px',
        height: `${info.Height * scale}px`,
        backgroundImage: `url("${api.trickplayUrl(this.item.Id, tp.width, tile, tp.msId)}")`,
        backgroundSize: `${info.Width * info.TileWidth * scale}px auto`,
        backgroundPosition: `-${x * info.Width * scale}px -${y * info.Height * scale}px`,
      });
      this.tipThumb.classList.remove('hidden');
    } else {
      this.tipThumb.classList.add('hidden');
    }
    this.hoverTip.classList.remove('hidden');
    const w = this.seekEl.clientWidth;
    const tw = this.hoverTip.offsetWidth || 80;
    this.hoverTip.style.left = `${Math.min(Math.max(p * w, tw / 2), w - tw / 2)}px`;
  }

  changeVolume(d) {
    const v = this.video;
    v.volume = Math.min(1, Math.max(0, Math.round((v.volume + d) * 100) / 100));
    v.muted = v.volume === 0;
    this.osd(`Volume ${Math.round(v.volume * 100)}%`);
  }

  toggleMute() {
    const v = this.video;
    if (v.muted && v.volume === 0) v.volume = 0.5;
    v.muted = !v.muted;
    this.osd(v.muted ? 'Muted' : `Volume ${Math.round(v.volume * 100)}%`);
  }

  toggleFullscreen() {
    this.setFullscreen(!fsState);
  }

  setFullscreen(on) {
    window.nova.setFullscreen(on);
  }

  onFullscreenChange(on) {
    this.el.classList.toggle('fs', on);
    this.fsBtn.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
  }

  togglePip() {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      this.video.requestPictureInPicture().catch((e) => toast(`Picture-in-picture unavailable: ${e.message}`, 'error'));
    }
  }

  // ---------------------------------------------------------------- time-driven features

  onTime() {
    const t = this.video.currentTime;
    if (t > 0) this.lastKnownTime = t;
    this.checkSegments(t);
    this.checkUpNext(t);
    const now = performance.now();
    if (now - this.lastUiUpdate >= 250) {
      this.lastUiUpdate = now;
      this.updateTimeUi();
    }
    if (this.startedReported && now - this.lastReport > 10000) this.report();
  }

  updateTimeUi(at) {
    if (this.seeking) return;
    const v = this.video;
    const t = at ?? v.currentTime;
    const dur = this.duration();
    const p = dur ? Math.min(1, t / dur) : 0;
    this.progEl.style.width = `${p * 100}%`;
    this.knob.style.left = `${p * 100}%`;
    this.timeEl.textContent = `${formatTime(t)} / ${formatTime(dur)}`;
    this.endsEl.textContent = dur ? `Ends at ${endsAt((dur - t) / (v.playbackRate || 1))}` : '';
    this.updateBuffer();
  }

  bufferedAhead() {
    const v = this.video;
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
    }
    return 0;
  }

  updateBuffer() {
    const dur = this.duration();
    if (!dur) return;
    const end = this.video.currentTime + this.bufferedAhead();
    this.bufEl.style.width = `${Math.min(1, end / dur) * 100}%`;
  }

  drawSegments() {
    const dur = this.duration();
    if (!dur) return;
    this.segLayer.replaceChildren(...this.segments.map((s) => h('div', {
      class: `seg seg-${s.type.toLowerCase()}`,
      title: s.type,
      style: { left: `${(s.start / dur) * 100}%`, width: `${((s.end - s.start) / dur) * 100}%` },
    })));
  }

  checkSegments(t) {
    const seg = this.segments.find((s) => t >= s.start && t < s.end - 0.5) || null;
    if (seg === this.currentSegment) return;
    this.currentSegment = seg;
    if (!seg) {
      this.skipBtn.classList.add('hidden');
      return;
    }
    if (seg.type === 'Outro' && this.nextEp && store.setting('skipCredits')) {
      this.skipBtn.classList.add('hidden');
      this.showUpNext();
      return;
    }
    const mode = store.setting('skipIntro');
    if (mode === 'off') {
      this.skipBtn.classList.add('hidden');
      return;
    }
    if (mode === 'auto' && seg.type !== 'Outro' && !this.skippedSegments.has(seg)) {
      this.skippedSegments.add(seg);
      this.seekTo(seg.end);
      this.osd(`Skipped ${seg.type.toLowerCase()}`);
      return;
    }
    this.skipBtn.textContent = SKIP_LABELS[seg.type];
    this.skipBtn.classList.remove('hidden');
  }

  skipSegment() {
    const seg = this.currentSegment;
    if (!seg) return;
    this.skipBtn.classList.add('hidden');
    if (seg.end >= this.duration() - 1) {
      if (this.nextEp) this.playNext();
      else this.onEnded();
      return;
    }
    this.seekTo(seg.end);
  }

  checkUpNext(t) {
    if (!this.nextEp || this.upNextShown || this.upNextCancelled) return;
    const dur = this.duration();
    if (!dur || dur < 120) return;
    const lead = Math.max(store.setting('nextUpCountdown'), 5) + 2;
    if (dur - t <= lead) this.showUpNext();
  }

  showUpNext() {
    if (this.upNextShown || !this.nextEp) return;
    this.upNextShown = true;
    const ep = this.nextEp;
    const auto = store.setting('autoplayNext');
    let remaining = store.setting('nextUpCountdown');
    const img = landscapeUrl(ep, 400);
    const countEl = h('span', { class: 'countdown' }, auto ? `${remaining}` : '');
    fill(this.upNextEl, 
      img ? h('img', { src: img, alt: '' }) : null,
      h('div', { class: 'upnext-body' },
        h('div', { class: 'eyebrow' }, 'Up next'),
        h('div', { class: 'upnext-title' }, ep.Type === 'Episode' ? `${epLabel(ep)} · ${ep.Name}` : ep.Name),
        ep.Type === 'Episode' && ep.SeriesId !== this.item?.SeriesId ? h('div', { class: 'p-subtitle' }, ep.SeriesName) : null,
        h('div', { class: 'upnext-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => this.playNext() }, icon('play'), h('span', null, 'Play now'), auto ? countEl : null),
          h('button', { class: 'btn btn-secondary', onclick: () => this.cancelUpNext() }, 'Hide'))));
    this.upNextEl.classList.remove('hidden');
    clearInterval(this.countdownTimer);
    if (auto) {
      this.countdownTimer = setInterval(() => {
        if (this.video.paused) return;
        remaining--;
        countEl.textContent = `${Math.max(0, remaining)}`;
        if (remaining <= 0) {
          clearInterval(this.countdownTimer);
          this.playNext();
        }
      }, 1000);
    }
  }

  hideUpNext() {
    clearInterval(this.countdownTimer);
    this.upNextEl.classList.add('hidden');
    this.upNextShown = false;
  }

  cancelUpNext() {
    this.hideUpNext();
    this.upNextCancelled = true;
  }

  onEnded() {
    if (this.endedHandled) return;
    this.endedHandled = true;
    if (this.nextEp && store.setting('autoplayNext') && !this.upNextCancelled) {
      this.playNext(true);
      return;
    }
    this.finish(true);
    this.destroy();
  }

  playNext(ended = false) {
    if (this.nextEp) this.playEpisode(this.nextEp, ended);
  }

  playAdjacent(dir) {
    const ep = dir > 0 ? this.nextEp : this.prevEp;
    if (!ep) {
      this.osd(dir > 0 ? 'Nothing after this one' : 'Nothing before this one');
      return;
    }
    this.playEpisode(ep, false);
  }

  playEpisode(ep, ended) {
    this.finish(ended);
    this.teardownStream();
    this.item = null;
    this.ms = null;
    this.method = null;
    this.playSessionId = null;
    this.resetEpisodeState();
    this.updateEpButtons();
    this.load(ep.Id, { announce: true });
  }

  updateEpButtons() {
    const show = this.item?.Type === 'Episode' || !!this.queue;
    this.prevBtn.classList.toggle('hidden', !show);
    this.nextBtn.classList.toggle('hidden', !show);
    this.prevBtn.title = this.queue ? 'Previous (P)' : 'Previous episode (P)';
    this.nextBtn.title = this.queue ? 'Next (N)' : 'Next episode (N)';
    this.prevBtn.disabled = !this.prevEp;
    this.nextBtn.disabled = !this.nextEp;
  }

  // ---------------------------------------------------------------- reporting

  reportBody() {
    const v = this.video;
    return {
      ItemId: this.item?.Id,
      MediaSourceId: this.ms?.Id,
      PlaySessionId: this.playSessionId,
      PositionTicks: Math.floor(this.currentPosition() * TICKS),
      IsPaused: v.paused,
      IsMuted: v.muted,
      VolumeLevel: Math.round(v.volume * 100),
      AudioStreamIndex: this.audioIndex ?? undefined,
      SubtitleStreamIndex: this.subIndex ?? -1,
      PlayMethod: this.method,
      PlaybackRate: v.playbackRate,
      CanSeek: true,
    };
  }

  report() {
    if (!this.startedReported || !this.item) return;
    this.lastReport = performance.now();
    api.reportProgress(this.reportBody());
  }

  finish(ended = false) {
    clearInterval(this.countdownTimer);
    if (!this.item) return;
    if (this.startedReported) {
      const body = this.reportBody();
      if (ended && this.item.RunTimeTicks) body.PositionTicks = this.item.RunTimeTicks;
      api.reportStopped(body);
      this.startedReported = false;
    }
    if (this.playSessionId && this.method && this.method !== 'DirectPlay') api.stopEncoding(this.playSessionId);
  }

  // ---------------------------------------------------------------- chrome

  updatePlayState() {
    const paused = this.video.paused;
    this.playBtn.replaceChildren(icon(paused ? 'play' : 'pause'));
    this.el.classList.toggle('paused', paused);
    window.nova.keepAwake(!paused);
    this.showControls();
  }

  showControls() {
    this.el.classList.add('show-controls');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.video.paused || this.seeking || isMenuOpen() || this.controlsHovered || this.loadingVisible) return;
      this.el.classList.remove('show-controls');
    }, 3000);
  }

  osd(msg) {
    this.osdEl.textContent = msg;
    this.osdEl.classList.add('show');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => this.osdEl.classList.remove('show'), 1400);
  }

  destroy(silent = false) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadToken++;
    this.subToken++;
    this.abort?.abort();
    this.finish(false);
    this.teardownStream();
    for (const t of [this.hideTimer, this.osdTimer, this.waitTimer, this.stall1, this.stall2]) clearTimeout(t);
    clearInterval(this.countdownTimer);
    clearInterval(this.infoTimer);
    closeMenu();
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (fsState) window.nova.setFullscreen(false);
    window.nova.keepAwake(false);
    window.nova.setDarkOverlay(false);
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = null;
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'stop']) {
        try {
          navigator.mediaSession.setActionHandler(a, null);
        } catch {
          // ignore
        }
      }
    }
    this.el.remove();
    document.title = 'Nova Player';
    if (active === this) active = null;
    if (!silent) refreshCurrent();
  }
}
