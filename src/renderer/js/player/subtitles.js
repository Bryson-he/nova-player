// Subtitles: text cues, styled ASS/SSA through JASSUB, fonts, prefetch and sync.
// Methods are mixed into Player (see player.js); `this` is the player.

import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../ui.js';
import { chooseAudio, chooseSubtitle, chooseSecondarySubtitle, subStreams, isTextSub, isAssSub } from '../tracks.js';
import { parseVtt } from '../subtitles.js';
import { JASSUB_DIR, FONT_RE } from './constants.js';
import { logError } from '../diagnostics.js';

export class SubtitleMixin {
  // ---------------------------------------------------------------- subtitles

  // Primary subtitle: ASS/SSA goes to libass (JASSUB) so fonts, positioning
  // and karaoke survive; everything else uses our styled VTT renderer.
  // Secondary subtitle (dual subs) always uses the VTT renderer at the top.
  //
  // Speed matters here: anime subtitles used to appear seconds after the video
  // because libass waited for every embedded font, and the first request for
  // a file's fonts makes Jellyfin extract them from the MKV. So:
  //   1. subtitle text and fonts are fetched as soon as the track is known
  //      (in parallel with starting the video, or during the previous episode),
  //   2. text is shown the moment it arrives and fonts are swapped in after,
  //   3. one libass instance lives for the whole player session.
  async loadSubtitles() {
    const my = ++this.subToken;
    this.clearSubs();
    const find = (i) => (i >= 0 ? subStreams(this.ms).find((x) => x.Index === i) : null);
    const s = find(this.subIndex);
    const s2 = this.sub2Index !== this.subIndex ? find(this.sub2Index) : null;
    this.el.classList.toggle('dual-subs', !!s2);

    const jobs = [];
    if (s && isTextSub(s)) {
      jobs.push((async () => {
        if (this.wantsStyled(s)) {
          try {
            await this.showAss(s, my);
            return;
          } catch (err) {
            console.warn('Styled subtitles failed, falling back to plain text', err);
          }
        }
        if (my === this.subToken) await this.loadVtt(this.subs, s, my);
      })());
    }
    if (s2 && isTextSub(s2)) jobs.push(this.loadVtt(this.subs2, s2, my));
    await Promise.all(jobs);
  }

  wantsStyled(stream) {
    return isAssSub(stream) && store.setting('styledSubs');
  }

  // Starts (or reuses) downloads for one subtitle track: its text, and for
  // styled ASS also the fonts embedded in the file.
  prefetchSubs(item, ms, index) {
    const stream = index >= 0 ? subStreams(ms).find((s) => s.Index === index) : null;
    if (!item || !ms || !stream || !isTextSub(stream)) return null;
    const styled = this.wantsStyled(stream);
    const key = `${item.Id}:${ms.Id}:${index}:${styled ? 'ass' : 'vtt'}`;
    let entry = this.subCache.get(key);
    if (entry) return entry;

    const get = (url) => fetch(url, { headers: { Authorization: api.authHeader() } }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    });
    const text = get(api.subtitleUrl(item.Id, ms.Id, index, styled ? 'ass' : 'vtt')).then((r) => r.text());
    text.catch(() => {});
    let fonts = Promise.resolve([]);
    if (styled) {
      const atts = (ms.MediaAttachments || []).filter((a) => FONT_RE.test(a.MimeType || '') || FONT_RE.test(a.FileName || ''));
      fonts = Promise.all(atts.map((a) => {
        const url = a.DeliveryUrl ? api.absolute(a.DeliveryUrl) : api.attachmentUrl(item.Id, ms.Id, a.Index);
        return get(url)
          .then((r) => r.arrayBuffer())
          .then((b) => ({ key: `${item.Id}:${a.Index}:${a.FileName || ''}`, data: new Uint8Array(b) }))
          .catch(() => null); // one broken font shouldn't hide the subtitles
      })).then((list) => list.filter(Boolean));
    }
    entry = { text, fonts };
    this.subCache.set(key, entry);
    while (this.subCache.size > 8) this.subCache.delete(this.subCache.keys().next().value);
    return entry;
  }

  async loadVtt(renderer, stream, my) {
    try {
      const entry = this.prefetchSubs(this.item, this.ms, stream.Index);
      const text = await entry.text;
      if (my !== this.subToken) return;
      renderer.setCues(parseVtt(text));
      renderer.setDelay(this.subDelay);
    } catch {
      if (my === this.subToken) toast('Could not load subtitles', 'error');
    }
  }

  // One libass renderer per player session; warmed up as soon as a styled
  // track is likely, so it's ready by the time the video starts.
  ensureAss() {
    if (!this.assPromise) {
      this.assPromise = import('../../vendor/jassub/jassub.js').then(async ({ default: JASSUB }) => {
        const ass = new JASSUB({
          video: this.video,
          subContent: '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n',
          workerUrl: JASSUB_DIR + 'worker/worker.js',
          wasmUrl: JASSUB_DIR + 'wasm/jassub-worker.wasm',
          modernWasmUrl: JASSUB_DIR + 'wasm/jassub-worker-modern.wasm',
          timeOffset: -this.subDelay,
          queryFonts: 'local',
        });
        await ass.ready;
        if (this.destroyed) {
          ass.destroy().catch(() => {});
          throw new Error('player closed');
        }
        // libass draws from a per-frame video callback, and that chain dies when
        // the <video> gets a new source (next episode, track/quality reload).
        // Note each tick so a dead loop can be restarted exactly once.
        const tick = ass._handleRVFC.bind(ass);
        ass._handleRVFC = (data) => {
          ass.lastTick = performance.now();
          tick(data);
        };
        this.assInstance = ass;
        return ass;
      });
      this.assPromise.catch((err) => {
        if (!this.destroyed) logError('styled subtitles', err);
        this.assPromise = null;
      });
    }
    return this.assPromise;
  }

  async showAss(stream, my) {
    const entry = this.prefetchSubs(this.item, this.ms, stream.Index);
    const [ass, text] = await Promise.all([this.ensureAss(), entry.text]);
    if (my !== this.subToken) return;
    ass.timeOffset = -this.subDelay;
    await ass.renderer.setTrack(text);
    if (my !== this.subToken) return;
    this.ass = ass;
    ass._canvas.style.visibility = '';
    this.assTextShown = true;
    this.reviveAss();
    this.assFontsLoaded = false;
    // Fonts arrive whenever they arrive; libass re-renders with them.
    entry.fonts.then(async (fonts) => {
      const fresh = fonts.filter((f) => !this.assFontKeys.has(f.key));
      if (fresh.length) {
        fresh.forEach((f) => this.assFontKeys.add(f.key));
        await ass.renderer.addFonts(fresh.map((f) => f.data));
      }
      if (my === this.subToken) {
        this.assFontsLoaded = true;
        if (this.video.paused) ass.resize(true).catch(() => {});
      }
    }).catch(() => {});
  }

  // Makes sure libass is actually drawing: restarts its frame loop if the
  // video source changed underneath it, and repaints once when paused.
  reviveAss() {
    const ass = this.assInstance;
    if (!ass || !this.ass) return;
    if (this.video.paused) {
      ass.resize(true).catch(() => {});
      return;
    }
    clearTimeout(this.assReviveTimer);
    this.assReviveTimer = setTimeout(() => {
      if (this.destroyed || !this.ass || this.video.paused) return;
      if (performance.now() - (ass.lastTick || 0) > 400) ass.setVideo(this.video).catch(() => {});
    }, 500);
  }

  // Next episode's subtitles and fonts are fetched while this one plays, so
  // they're instant when Up Next kicks in (and the server extracts early).
  prefetchNext() {
    if (this.nextPrefetched || !this.nextEp || this.queue) return;
    this.nextPrefetched = true;
    const id = this.nextEp.Id;
    api.item(id).then((item) => {
      if (this.destroyed) return;
      this.prefetchedItem = item;
      const ms = item.MediaSources?.[0];
      if (!ms) return;
      const audio = chooseAudio(item, ms);
      const sub = chooseSubtitle(item, ms, audio);
      this.prefetchSubs(item, ms, sub);
      this.prefetchSubs(item, ms, chooseSecondarySubtitle(item, ms, sub));
      const s = subStreams(ms).find((x) => x.Index === sub);
      if (s && this.wantsStyled(s)) this.ensureAss().catch(() => {});
    }).catch(() => {});
  }

  clearSubs() {
    this.subs.clear();
    this.subs2.clear();
    this.assTextShown = false;
    if (this.ass) {
      const ass = this.ass;
      this.ass = null;
      ass._canvas.style.visibility = 'hidden';
      ass.renderer.freeTrack().catch?.(() => {});
    }
  }

  delayKey() {
    return this.item?.SeriesId || this.item?.Id || '';
  }

  // Positive = subtitles appear later. Remembered per series (or movie).
  setSubDelay(sec, persist = true) {
    this.subDelay = Math.round(sec * 10) / 10;
    this.subs.setDelay(this.subDelay);
    this.subs2.setDelay(this.subDelay);
    if (this.assInstance) this.assInstance.timeOffset = -this.subDelay;
    if (persist && this.delayKey()) {
      const all = { ...(store.get('subDelays') || {}) };
      if (this.subDelay) all[this.delayKey()] = this.subDelay;
      else delete all[this.delayKey()];
      store.set('subDelays', all);
    }
    return this.subDelay;
  }

  adjustSubDelay(delta) {
    this.setSubDelay(this.subDelay + delta);
    this.osd(`Subtitle sync ${this.subDelay > 0 ? '+' : ''}${this.subDelay.toFixed(1)}s`);
    return this.subDelay;
  }
}
