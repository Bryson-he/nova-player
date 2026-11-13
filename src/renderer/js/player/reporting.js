// Progress reporting to the server.
// Methods are mixed into Player (see player.js); `this` is the player.

import { api, TICKS } from '../api.js';

export class ReportingMixin {
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

  // Resolves when the stop report (and transcode cleanup) has gone out.
  finish(ended = false) {
    clearInterval(this.countdownTimer);
    if (!this.item) return Promise.resolve();
    const pending = [];
    if (this.startedReported) {
      const body = this.reportBody();
      if (ended && this.item.RunTimeTicks) body.PositionTicks = this.item.RunTimeTicks;
      pending.push(api.reportStopped(body));
      this.startedReported = false;
    }
    if (this.playSessionId && this.method && this.method !== 'DirectPlay') pending.push(api.stopEncoding(this.playSessionId));
    return Promise.all(pending);
  }
}
