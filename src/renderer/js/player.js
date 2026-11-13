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
  h, icon, iconBtn, closeMenu, isMenuOpen, toast, formatTime, epLabel,
} from './ui.js';
import { SubtitleRenderer } from './subtitles.js';
import { refreshCurrent } from './router.js';
import { applySubtitleStyle } from './views/settings.js';
import { showShortcuts } from './shortcuts.js';
import { StreamMixin } from './player/stream.js';
import { SubtitleMixin } from './player/subtitles.js';
import { MenuMixin } from './player/menus.js';
import { SegmentMixin } from './player/segments.js';
import { ReportingMixin } from './player/reporting.js';
import { CropMixin } from './player/crop.js';

let active = null;
let fsState = false;

window.nova.onFullscreen((value) => {
  fsState = value;
  active?.onFullscreenChange(value);
});

// Taskbar thumbnail buttons control whatever is playing.
window.nova.onTaskbarAction((action) => {
  if (!active) return;
  if (action === 'toggle') active.togglePlay();
  else if (action === 'prev') active.playAdjacent(-1);
  else if (action === 'next') active.playAdjacent(1);
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

// Closes the player and resolves once the server has been told playback stopped.
export function closePlayerAndReport() {
  return active ? active.destroy(true) : Promise.resolve();
}

export function isPlayerOpen() {
  return !!active;
}


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
    this.sub2Index = -1;
    this.subDelay = 0;
    this.ass = null; // libass renderer currently showing a track
    this.assInstance = null; // the session's libass renderer (kept across episodes)
    this.assPromise = null;
    this.assFontKeys = new Set();
    this.subCache = new Map();
    this.prefetchedItem = null;
    this.audioGraph = null;
    this.mini = false;
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
    this.chapters = [];
    this.sub2Index = -1;
    this.nextPrefetched = false;
    clearInterval(this.countdownTimer);
    if (this.upNextEl) this.upNextEl.classList.add('hidden');
    if (this.skipBtn) this.skipBtn.classList.add('hidden');
    if (this.segLayer) this.segLayer.replaceChildren();
    if (this.chapLayer) this.chapLayer.replaceChildren();
  }

  // ---------------------------------------------------------------- DOM

  build() {
    const v = h('video', { class: 'player-video', autoplay: true, playsinline: true, preload: 'auto' });
    // CORS mode lets the audio go through Web Audio (boost / night mode) and
    // lets screenshots read the frame. Jellyfin (and the CORS shim) allow it.
    v.crossOrigin = 'anonymous';
    v.volume = store.get('volume') ?? 1;
    v.muted = !!store.get('muted');
    this.video = v;

    this.subLayer = h('div', { class: 'sub-layer' });
    applySubtitleStyle(this.subLayer);
    this.subs = new SubtitleRenderer(v, this.subLayer);
    // Secondary subtitle line (dual subtitles), drawn at the top of the picture.
    this.sub2Layer = h('div', { class: 'sub-layer top' });
    applySubtitleStyle(this.sub2Layer);
    this.subs2 = new SubtitleRenderer(v, this.sub2Layer);

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
      h('div', { class: 'p-titles' }, this.titleEl, this.subtitleEl),
      iconBtn('fullscreen', 'Exit mini player (T)', () => this.setMini(false), 'p-btn mini-only'));

    this.segLayer = h('div', { class: 'seek-segs' });
    this.chapLayer = h('div', { class: 'seek-chapters' });
    this.tipChapter = h('div', { class: 'seek-chapter hidden' });
    this.bufEl = h('div', { class: 'seek-buf' });
    this.progEl = h('div', { class: 'seek-prog' });
    this.knob = h('div', { class: 'seek-knob' });
    this.tipThumb = h('div', { class: 'seek-thumb hidden' });
    this.tipTime = h('div', { class: 'seek-time' });
    this.hoverTip = h('div', { class: 'seek-tip hidden' }, this.tipThumb, this.tipChapter, this.tipTime);
    this.seekEl = h('div', { class: 'seek', role: 'slider', tabindex: 0, 'aria-label': 'Seek', 'aria-valuemin': 0, 'aria-valuemax': 0, 'aria-valuenow': 0 },
      h('div', { class: 'seek-track' }, this.bufEl, this.segLayer, this.progEl, this.chapLayer),
      this.knob,
      this.hoverTip);

    this.playBtn = iconBtn('play', 'Play / Pause (Space)', () => this.togglePlay(), 'p-btn big');
    this.prevBtn = iconBtn('prev', 'Previous episode (P)', () => this.playAdjacent(-1), 'p-btn');
    this.nextBtn = iconBtn('next', 'Next episode (N)', () => this.playAdjacent(1), 'p-btn');
    const rewBtn = iconBtn('replay', 'Rewind (←)', () => this.seekBy(-store.setting('seekBack')), 'p-btn');
    const fwdBtn = iconBtn('forward', 'Fast forward (→)', () => this.seekBy(store.setting('seekForward')), 'p-btn');
    this.muteBtn = iconBtn(v.muted ? 'mute' : 'volume', 'Mute (M)', () => this.toggleMute(), 'p-btn');
    this.volSlider = h('input', { type: 'range', min: 0, max: 1, step: 0.01, class: 'vol-slider', value: v.muted ? 0 : v.volume, 'aria-label': 'Volume' });
    this.timeEl = h('div', { class: 'p-time' }, '0:00 / 0:00');
    this.endsEl = h('div', { class: 'p-ends' });
    this.tracksBtn = iconBtn('subtitles', 'Audio and subtitles (A, S)', (e) => this.tracksMenu(e.currentTarget), 'p-btn');
    this.tracksBtn.setAttribute('aria-haspopup', 'menu');
    const setBtn = iconBtn('settings', 'Playback settings', (e) => this.settingsMenu(e.currentTarget), 'p-btn');
    setBtn.setAttribute('aria-haspopup', 'menu');
    this.infoBtn = iconBtn('info', 'Playback info (I)', () => this.toggleInfo(), 'p-btn');
    const pipBtn = iconBtn('pip', 'Mini player, always on top (T)', () => this.setMini(!this.mini), 'p-btn');
    this.fsBtn = iconBtn(fsState ? 'fullscreenExit' : 'fullscreen', 'Fullscreen (F)', () => this.toggleFullscreen(), 'p-btn');

    this.bottom = h('div', { class: 'p-bottom' },
      this.seekEl,
      h('div', { class: 'p-row' },
        h('div', { class: 'p-left' },
          this.prevBtn, rewBtn, this.playBtn, fwdBtn, this.nextBtn,
          h('div', { class: 'vol' }, this.muteBtn, this.volSlider),
          this.timeEl),
        h('div', { class: 'p-right' },
          this.endsEl, this.tracksBtn, setBtn, this.infoBtn, pipBtn, this.fsBtn)));

    this.controls = h('div', { class: 'p-controls' }, top, this.bottom);
    this.el = h('div', { class: `player show-controls${fsState ? ' fs' : ''}` },
      v, this.subLayer, this.sub2Layer, this.controls, this.skipBtn, this.upNextEl, this.infoEl, this.osdEl, this.loadingEl, this.errorEl);
    document.body.append(this.el);
    window.nova.setDarkOverlay(true);
    this.setFit(store.setting('videoFit'), false);
    // How far styled subtitles shrink to clear the controls (see player.css).
    this.resizeObs = new ResizeObserver(() => {
      const ht = this.el.clientHeight || 1;
      this.el.style.setProperty('--ass-lift', String(Math.max(0.6, (ht - 110) / ht)));
      this.el.style.setProperty('--ass-lift-mini', String(Math.max(0.6, (ht - 60) / ht)));
      this.applyCrop();
    });
    this.resizeObs.observe(this.el);
    this.updateEpButtons();
  }

  bind() {
    const v = this.video;

    v.addEventListener('playing', () => {
      this.hasPlayed = true;
      this.setLoading(false);
      this.reviveAss();
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
    this.el.addEventListener('pointerdown', () => { this.autoRun = 0; });
    v.addEventListener('error', () => this.onVideoError());
    v.addEventListener('loadedmetadata', () => this.onMetadata());
    v.addEventListener('seeked', () => {
      this.subs.update();
      this.subs2.update();
      this.reviveAss();
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
    this.autoRun = 0; // someone is here
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    // A dialog (shortcuts, an error) has the keyboard while it's open.
    if (document.querySelector('.modal-backdrop')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.screenshot();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    let handled = true;
    switch (k) {
      case 't': case 'T': this.setMini(!this.mini); break;
      case 'v': case 'V': this.cycleFit(); break;
      case '?': showShortcuts(this.el); break;
      case 'PageUp': this.jumpChapter(-1); break;
      case 'PageDown': this.jumpChapter(1); break;
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
        else if (this.mini) this.setMini(false);
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

  // ---------------------------------------------------------------- screenshots

  async screenshot() {
    const v = this.video;
    if (!v.videoWidth) return this.osd('Nothing to capture yet');
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      const it = this.item;
      const title = it?.Type === 'Episode' ? `${it.SeriesName} ${epLabel(it).replace(':', '')}` : it?.Name || 'Nova';
      const file = await window.nova.saveScreenshot(await blob.arrayBuffer(), `${title} ${formatTime(v.currentTime).replace(/:/g, '-')}`);
      this.osd('Screenshot saved');
      toast('Screenshot saved to Pictures\\Nova Player', 'info', 4000, { label: 'Show', onClick: () => window.nova.showInFolder(file) });
    } catch (err) {
      toast(`Screenshot failed: ${err.message}`, 'error');
    }
  }

  // ---------------------------------------------------------------- mini player

  async setMini(on) {
    if (on === this.mini) return;
    if (on && fsState) await window.nova.setFullscreen(false);
    this.mini = await window.nova.setMini(on);
    this.el.classList.toggle('mini', this.mini);
    this.osd(this.mini ? 'Mini player · always on top' : 'Mini player off');
    // Let JASSUB re-measure the new video size.
    requestAnimationFrame(() => this.assInstance?.resize?.());
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
    const ci = this.currentChapterIndex(t);
    this.tipChapter.textContent = ci >= 0 ? this.chapters[ci].name : '';
    this.tipChapter.classList.toggle('hidden', ci < 0);
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

  async toggleFullscreen() {
    if (this.mini) await this.setMini(false);
    this.setFullscreen(!fsState);
  }

  setFullscreen(on) {
    window.nova.setFullscreen(on);
  }

  isFullscreen() {
    return fsState;
  }

  onFullscreenChange(on) {
    this.el.classList.toggle('fs', on);
    this.fsBtn.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
  }

  // ---------------------------------------------------------------- chrome

  updatePlayState() {
    const paused = this.video.paused;
    this.updateTaskbar();
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
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    this.loadToken++;
    this.subToken++;
    this.abort?.abort();
    const reported = this.finish(false);
    this.teardownStream();
    for (const t of [this.hideTimer, this.osdTimer, this.waitTimer, this.stall1, this.stall2, this.sleepTimer]) clearTimeout(t);
    clearInterval(this.countdownTimer);
    clearInterval(this.infoTimer);
    closeMenu();
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (fsState) window.nova.setFullscreen(false);
    if (this.mini) window.nova.setMini(false);
    this.audioGraph?.ctx.close().catch(() => {});
    this.assInstance?.destroy().catch(() => {});
    window.nova.keepAwake(false);
    window.nova.setDarkOverlay(false);
    window.nova.taskbar(null);
    this.resizeObs?.disconnect();
    this.stopCrop();
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
    return reported;
  }
}

// The player is one class split across files by area; copy each part's methods in.
for (const part of [StreamMixin, SubtitleMixin, MenuMixin, SegmentMixin, ReportingMixin, CropMixin]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Player.prototype, name)) throw new Error(`Player method defined twice: ${name}`);
    Object.defineProperty(Player.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}
