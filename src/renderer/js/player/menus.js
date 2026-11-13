// Track switching and the audio, subtitle, speed, quality and sound menus.
// Methods are mixed into Player (see player.js); `this` is the player.

import { store } from '../store.js';
import { h, popupMenu, toast, formatTime } from '../ui.js';
import { audioStreams, subStreams, streamLabel, rememberTrack, isTextSub, isAssSub } from '../tracks.js';
import { SPEEDS, QUALITIES, BOOSTS } from './constants.js';

export class MenuMixin {
  // ---------------------------------------------------------------- track switching

  // One menu for audio and subtitles (the A and S keys still cycle each).
  tracksMenu(anchor) {
    const audios = audioStreams(this.ms);
    const subs = subStreams(this.ms);
    const delayVal = h('span', { class: 'delay-val' }, `${this.subDelay.toFixed(1)}s`);
    const bump = (d) => (e) => {
      e.stopPropagation();
      const val = d === 0 ? this.setSubDelay(0) : this.adjustSubDelay(d);
      delayVal.textContent = `${val.toFixed(1)}s`;
    };
    const textSubs = subs.filter((s) => isTextSub(s));
    const delayRow = h('div', { class: 'menu-row' },
      h('span', { class: 'menu-row-label' }, 'Subtitle sync'),
      h('button', { class: 'mini-btn', title: 'Show earlier (Z)', 'aria-label': 'Show subtitles earlier', onclick: bump(-0.1) }, '−'),
      delayVal,
      h('button', { class: 'mini-btn', title: 'Show later (X)', 'aria-label': 'Show subtitles later', onclick: bump(0.1) }, '+'),
      h('button', { class: 'mini-btn', onclick: bump(0) }, 'Reset'));
    popupMenu(anchor, [
      { header: 'Audio' },
      ...(audios.length ? audios.map((s) => ({
        label: streamLabel(s), checked: s.Index === this.audioIndex, key: 'A', onClick: () => this.setAudio(s.Index),
      })) : [{ label: 'No audio tracks', disabled: true }]),
      { divider: true },
      { header: 'Subtitles' },
      { label: 'Off', checked: this.subIndex === -1, onClick: () => this.setSubtitle(-1) },
      ...subs.map((s) => ({
        label: streamLabel(s),
        sub: !isTextSub(s) ? 'Image subtitle · the server burns it in'
          : isAssSub(s) && store.setting('styledSubs') ? 'Styled: fonts and positions kept' : '',
        checked: s.Index === this.subIndex,
        onClick: () => this.setSubtitle(s.Index),
      })),
      { el: delayRow },
      ...(textSubs.length >= 2 ? [
        { divider: true },
        { header: 'Second subtitle (top of the picture)' },
        { label: 'Off', checked: this.sub2Index === -1, onClick: () => this.setSecondarySubtitle(-1) },
        ...textSubs.map((s) => ({
          label: streamLabel(s),
          checked: s.Index === this.sub2Index,
          disabled: s.Index === this.subIndex,
          onClick: () => this.setSecondarySubtitle(s.Index),
        })),
      ] : []),
    ]);
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

  setSecondarySubtitle(index) {
    if (index === this.sub2Index || !this.ms) return;
    const stream = index >= 0 ? subStreams(this.ms).find((s) => s.Index === index) : null;
    rememberTrack(this.item, 'subtitle2', stream);
    this.sub2Index = index;
    this.osd(`Second subtitle: ${stream ? streamLabel(stream) : 'Off'}`);
    this.loadSubtitles();
  }

  setSubtitle(index) {
    if (index === this.subIndex || !this.ms) return;
    const stream = index >= 0 ? subStreams(this.ms).find((s) => s.Index === index) : null;
    rememberTrack(this.item, 'subtitle', stream);
    this.osd(`Subtitles: ${stream ? streamLabel(stream) : 'Off'}`);
    const needsBurn = !!stream && !isTextSub(stream);
    this.subIndex = index;
    if (index >= 0 && index === this.sub2Index) this.sub2Index = -1;
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
    this.tracksBtn.classList.toggle('on', this.subIndex >= 0);
  }

  // Video fit: fit (letterbox), fill (crop), stretch, zoom. V cycles.
  setFit(mode, announce = true) {
    const modes = ['fit', 'fill', 'stretch', 'zoom'];
    const fit = modes.includes(mode) ? mode : 'fit';
    for (const m of modes) this.el.classList.toggle(`fit-${m}`, m === fit && m !== 'fit');
    this.fit = fit;
    if (announce) this.osd(`Video: ${{ fit: 'Fit', fill: 'Fill', stretch: 'Stretch', zoom: 'Zoom' }[fit]}`);
  }

  cycleFit() {
    const modes = ['fit', 'fill', 'stretch', 'zoom'];
    const next = modes[(modes.indexOf(this.fit || 'fit') + 1) % modes.length];
    this.setFit(next);
    store.setSetting('videoFit', next);
  }

  // ---------------------------------------------------------------- speed / quality / info

  settingsMenu(anchor) {
    const rate = this.video.playbackRate;
    const boost = store.setting('volumeBoost');
    const cur = this.currentChapterIndex();
    popupMenu(anchor, [
      { label: 'Take screenshot', sub: 'Ctrl+S · saved to Pictures\\Nova Player', onClick: () => this.screenshot() },
      { label: this.mini ? 'Exit mini player' : 'Mini player (always on top)', sub: 'T', onClick: () => this.setMini(!this.mini) },
      { header: 'Sound' },
      {
        label: 'Night mode',
        sub: 'Quieter explosions, clearer dialogue',
        checked: store.setting('nightMode'),
        onClick: () => {
          store.setSetting('nightMode', !store.setting('nightMode'));
          this.applyAudio();
          this.osd(`Night mode ${store.setting('nightMode') ? 'on' : 'off'}`);
        },
      },
      ...BOOSTS.map(([b, label]) => ({
        label: `Volume boost ${label}`,
        checked: boost === b,
        onClick: () => {
          store.setSetting('volumeBoost', b);
          this.applyAudio();
          this.osd(`Volume boost ${Math.round(b * 100)}%`);
        },
      })),
      ...(this.chapters.length ? [
        { header: 'Chapters  (PgUp / PgDn)' },
        ...this.chapters.map((c, i) => ({
          label: c.name,
          sub: formatTime(c.start),
          checked: i === cur,
          onClick: () => this.seekTo(c.start),
        })),
      ] : []),
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

  // ---------------------------------------------------------------- sound: boost & night mode
  //
  // Audio is routed through Web Audio only once one of these is turned on, so
  // normal playback stays on the plain, zero-overhead path.
  applyAudio() {
    const boost = store.setting('volumeBoost') || 1;
    const night = !!store.setting('nightMode');
    if (!this.audioGraph && boost === 1 && !night) return;
    if (!this.audioGraph) {
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaElementSource(this.video);
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -32;
        comp.knee.value = 24;
        comp.ratio.value = 6;
        comp.attack.value = 0.004;
        comp.release.value = 0.25;
        const makeup = ctx.createGain();
        makeup.gain.value = 2.2; // lifts quiet dialogue back up after compression
        const gain = ctx.createGain();
        this.audioGraph = { ctx, src, comp, makeup, gain };
      } catch (err) {
        toast(`Sound effects unavailable: ${err.message}`, 'error');
        return;
      }
    }
    const { ctx, src, comp, makeup, gain } = this.audioGraph;
    for (const n of [src, comp, makeup, gain]) n.disconnect();
    if (night) src.connect(comp).connect(makeup).connect(gain);
    else src.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = boost;
    ctx.resume().catch(() => {});
  }
}
