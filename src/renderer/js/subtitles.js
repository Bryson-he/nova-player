// Text subtitles are fetched as WebVTT from the server and drawn by our own
// renderer, which gives full control over size, colour, background, position
// and a live sync offset (things the stock <track> element can't do).

function parseTimestamp(s) {
  const parts = s.replace(',', '.').split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p);
  return sec;
}

const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cueToHtml(text) {
  let t = text
    .replace(/\{\\[^}]*\}/g, '') // ASS override tags
    .replace(/\\N/gi, '\n');
  t = escapeHtml(t);
  t = t.replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>'); // keep basic styling
  t = t.replace(/&lt;\/?[a-z][^&]*?&gt;/gi, ''); // drop voice/class/font tags
  return t.split('\n').map((l) => l.trim()).filter(Boolean).join('<br>');
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
    const html = cueToHtml(buf.join('\n'));
    if (html && end > start) cues.push({ start, end, html });
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
    this.render('');
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
      if (c.end > t) active.unshift(c.html);
    }
    this.render(active.join('<br>'));
  }

  render(html) {
    if (html === this.last) return;
    this.last = html;
    this.layer.innerHTML = html ? `<span class="sub-cue">${html}</span>` : '';
  }
}
