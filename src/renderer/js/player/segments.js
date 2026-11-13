// Chapters, skip intro / credits segments, Up Next, trickplay and next-episode prefetch.
// Methods are mixed into Player (see player.js); `this` is the player.

import { store } from '../store.js';
import { h, fill, icon, iconBtn, formatTime, endsAt, epLabel, landscapeUrl } from '../ui.js';
import { streamLabel } from '../tracks.js';
import { SKIP_LABELS, humanize, spokenTime } from './constants.js';

export class SegmentMixin {
  // ---------------------------------------------------------------- chapters

  currentChapterIndex(t = this.video.currentTime) {
    let idx = -1;
    this.chapters.forEach((c, i) => {
      if (c.start <= t + 0.5) idx = i;
    });
    return idx;
  }

  jumpChapter(dir) {
    if (!this.chapters.length) return this.osd('No chapters');
    const t = this.video.currentTime;
    let target;
    if (dir > 0) target = this.chapters.find((c) => c.start > t + 1);
    else {
      const i = this.currentChapterIndex(t);
      // Within the first 3 s of a chapter, go to the previous one; otherwise restart this one.
      target = i > 0 && t - this.chapters[i].start < 3 ? this.chapters[i - 1] : this.chapters[Math.max(0, i)];
    }
    if (!target) return this.osd('Last chapter');
    this.seekTo(target.start);
    this.osd(target.name);
  }

  drawChapters() {
    const dur = this.duration();
    if (!dur || !this.chapLayer) return;
    this.chapLayer.replaceChildren(...this.chapters.filter((c) => c.start > 1 && c.start < dur - 1)
      .map((c) => h('div', { class: 'chap', style: { left: `${(c.start / dur) * 100}%` } })));
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
      ['Subtitle renderer', this.ass ? 'libass (styled)' : ss ? 'Text' : '—'],
      ['Second subtitle', this.sub2Index >= 0 ? streamLabel(streams.find((s) => s.Index === this.sub2Index)) : 'Off'],
      ['Subtitle sync', `${this.subDelay > 0 ? '+' : ''}${this.subDelay.toFixed(1)} s`],
      ['Sound', [store.setting('nightMode') ? 'Night mode' : '', (store.setting('volumeBoost') || 1) !== 1 ? `Boost ${Math.round(store.setting('volumeBoost') * 100)}%` : ''].filter(Boolean).join(' · ') || 'Normal'],
      ['Rendering', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
      ['Dropped frames', q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}` : '—'],
      ['Buffered ahead', `${this.bufferedAhead().toFixed(1)} s`],
      ['Speed', `${v.playbackRate}×`],
    ];
    this.infoEl.replaceChildren(
      h('div', { class: 'info-head' }, h('span', null, 'Playback info'), iconBtn('close', 'Close', () => this.toggleInfo(), 'small')),
      ...rows.map(([k, val]) => h('div', { class: 'info-row' }, h('span', null, k), h('span', null, val))));
  }

  // ---------------------------------------------------------------- time-driven features

  onTime() {
    const t = this.video.currentTime;
    if (t > 0) this.lastKnownTime = t;
    this.checkSegments(t);
    this.checkUpNext(t);
    const dur = this.duration();
    if (dur && t / dur > 0.5) this.prefetchNext();
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
    this.seekEl.setAttribute('aria-valuemax', String(Math.round(dur || 0)));
    this.seekEl.setAttribute('aria-valuenow', String(Math.round(t)));
    this.seekEl.setAttribute('aria-valuetext', `${spokenTime(t)} of ${spokenTime(dur)}`);
    this.endsEl.textContent = dur ? `Ends at ${endsAt((dur - t) / (v.playbackRate || 1))}` : '';
    if (performance.now() - (this.lastTaskbar || 0) > 1000) {
      this.lastTaskbar = performance.now();
      this.updateTaskbar();
    }
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
    this.prefetchNext();
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
        if (this.video.paused || this.upNextEl.matches(':hover, :focus-within')) return;
        remaining--;
        countEl.textContent = `${Math.max(0, remaining)}`;
        if (remaining <= 0) {
          clearInterval(this.countdownTimer);
          this.playNext(false, true);
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
    if (this.sleepAtEnd) {
      // Sleep timer: "end of this episode".
      this.sleepAtEnd = false;
      this.finish(true);
      this.destroy();
      return;
    }
    if (this.nextEp && store.setting('autoplayNext') && !this.upNextCancelled) {
      this.playNext(true);
      return;
    }
    this.finish(true);
    this.destroy();
  }

  // auto: the countdown or the end of an episode moved on, not the viewer.
  playNext(ended = false, auto = ended) {
    if (!this.nextEp) return;
    if (!auto) this.autoRun = 0;
    else {
      this.autoRun = (this.autoRun || 0) + 1;
      const limit = store.setting('stillWatching');
      if (limit && this.autoRun > limit) {
        this.askStillWatching(ended);
        return;
      }
    }
    this.playEpisode(this.nextEp, ended);
  }

  // After several episodes in a row with no input: check someone is there,
  // so a series doesn't run all night and mark everything watched.
  askStillWatching(ended) {
    this.hideUpNext();
    this.video.pause();
    this.setLoading(false);
    const next = this.nextEp;
    let timer = 0;
    const done = (keepGoing) => {
      clearTimeout(timer);
      this.upNextEl.classList.add('hidden');
      this.upNextEl.removeAttribute('role');
      if (keepGoing) {
        this.autoRun = 0;
        this.playEpisode(next, ended);
      } else {
        this.finish(ended);
        this.destroy();
      }
    };
    const keep = h('button', { class: 'btn btn-primary', onclick: () => done(true) }, icon('play'), h('span', null, 'Keep watching'));
    fill(this.upNextEl,
      h('div', { class: 'upnext-body' },
        h('div', { class: 'upnext-title' }, 'Still watching?'),
        h('div', { class: 'p-subtitle' }, `${this.autoRun - 1} episodes have played on their own. Nova will stop in 2 minutes unless you carry on.`),
        h('div', { class: 'upnext-actions' }, keep, h('button', { class: 'btn btn-secondary', onclick: () => done(false) }, 'Stop'))));
    this.upNextEl.setAttribute('role', 'alertdialog');
    this.upNextEl.classList.remove('hidden');
    this.showControls();
    keep.focus();
    timer = setTimeout(() => done(false), 120000);
  }

  // Sleep timer: pause after a while, or stop at the end of this episode.
  setSleep(minutes) {
    clearTimeout(this.sleepTimer);
    this.sleepAtEnd = minutes === 'end';
    this.sleepUntil = 0;
    if (typeof minutes === 'number' && minutes > 0) {
      this.sleepUntil = Date.now() + minutes * 60000;
      this.sleepTimer = setTimeout(() => {
        this.sleepUntil = 0;
        this.video.pause();
        this.osd('Sleep timer: paused');
      }, minutes * 60000);
    }
    this.osd(minutes === 'end' ? 'Stopping after this episode' : minutes ? `Sleep timer: ${minutes} minutes` : 'Sleep timer off');
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
    this.updateTaskbar();
  }

  // Taskbar progress and thumbnail buttons.
  updateTaskbar() {
    if (this.destroyed) return;
    const dur = this.duration();
    window.nova.taskbar({
      playing: !this.video.paused,
      progress: dur ? this.video.currentTime / dur : 0,
      hasPrev: !!this.prevEp,
      hasNext: !!this.nextEp,
    });
  }
}
