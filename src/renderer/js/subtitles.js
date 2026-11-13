// Text subtitles are fetched as WebVTT from the server and drawn by our own
// renderer, which gives full control over size, colour, background, position
// and a live sync offset (things the stock <track> element can't do).

function parseTimestamp(s) {
  const parts = s.replace(',', '.').split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p);
  return sec;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * A cue's text as lines of styled runs. <i>, <b> and <u> are kept; every
 * other tag (voice, class, font) is dropped. The result is plain data that
 * the renderer turns into text nodes, so cue text can never become markup.
 * @param {string} text
 * @returns {{ text: string, i?: boolean, b?: boolean, u?: boolean }[][]}
 */
export function cueToLines(text) {
  const t = text
    .replace(/\{\\[^}]*\}/g, '') // ASS override tags
    .replace(/\\N/gi, '\n');
  const style = { i: 0, b: 0, u: 0 };
  const lines = [];
  for (const rawLine of t.split('\n')) {
    const runs = [];
    for (const part of rawLine.split(/(<\/?[a-z][^>]*>)/i)) {
      const tag = /^<(\/?)(i|b|u)(?:[\s.][^>]*)?>$/i.exec(part);
      if (tag) {
        const k = tag[2].toLowerCase();
        style[k] = Math.max(0, style[k] + (tag[1] ? -1 : 1));
        continue;
      }
      if (/^<\/?[a-z]/i.test(part)) continue; // voice/class/font tags
      const plain = part.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, e) => ENTITIES[e]);
      if (!plain) continue;
      const run = { text: plain };
      if (style.i) run.i = true;
      if (style.b) run.b = true;
      if (style.u) run.u = true;
      runs.push(run);
    }
    if (runs.length) {
      runs[0].text = runs[0].text.replace(/^\s+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
    }
    const kept = runs.filter((r) => r.text);
    if (kept.length) lines.push(kept);
  }
  return lines;
}

export function parseVtt(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const re = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    const buf = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(lines[i]);
      i++;
    }
    const cueLines = cueToLines(buf.join('\n'));
    if (cueLines.length && end > start) cues.push({ start, end, lines: cueLines, key: JSON.stringify(cueLines) });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export class SubtitleRenderer {
  constructor(video, layer) {
    this.video = video;
    this.layer = layer;
    this.cues = [];
    this.delay = 0;
    this.last = null;
    this.raf = 0;
    this.tick = this.tick.bind(this);
  }

  setCues(cues) {
    this.cues = cues;
    this.last = null;
    this.update();
    this.start();
  }

  clear() {
    this.cues = [];
    this.stop();
    this.render([]);
  }

  setDelay(sec) {
    this.delay = Math.round(sec * 10) / 10;
    this.update();
  }

  start() {
    if (!this.raf && this.cues.length) this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  tick() {
    this.raf = 0;
    this.update();
    if (this.cues.length) this.raf = requestAnimationFrame(this.tick);
  }

  update() {
    if (!this.cues.length) return;
    const t = this.video.currentTime - this.delay;
    // Binary search for the last cue that starts at or before t.
    let lo = 0;
    let hi = this.cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const active = [];
    for (let i = idx; i >= 0 && i > idx - 30; i--) {
      const c = this.cues[i];
      if (c.end > t) active.unshift(c);
    }
    this.render(active);
  }

  // Cue text only ever becomes text nodes (plus <i>/<b>/<u> wrappers), never markup.
  render(cues) {
    const key = cues.map((c) => c.key).join('|');
    if (key === this.last) return;
    this.last = key;
    if (!cues.length) {
      this.layer.replaceChildren();
      return;
    }
    const span = document.createElement('span');
    span.className = 'sub-cue';
    cues.flatMap((c) => c.lines).forEach((line, n) => {
      if (n) span.append(document.createElement('br'));
      for (const run of line) {
        let node = document.createTextNode(run.text);
        for (const tag of ['u', 'b', 'i']) {
          if (!run[tag]) continue;
          const wrap = document.createElement(tag);
          wrap.append(node);
          node = wrap;
        }
        span.append(node);
      }
    });
    this.layer.replaceChildren(span);
  }
}
