// Auto crop: finds black bars that are part of the video itself (a 2.39:1
// film stored as 16:9, or 4:3 stored with side bars) and zooms the picture
// so the real image fills the window. Mostly for ultrawide screens.
// Methods are mixed into Player (see player.js); `this` is the player.

const SAMPLE_W = 320; // frames are checked at this width: enough to tell film shapes apart
const DARK = 24; // a row or column this dark on average (0-255)...
const BRIGHT = 48; // ...with no pixel brighter than this, is a bar

/**
 * The picture inside a frame, as edges in sample pixels, or null when the
 * frame is too dark to tell (a fade, a night scene).
 * @param {Uint8ClampedArray} px  RGBA
 * @param {number} w
 * @param {number} h
 */
export function findPicture(px, w, h) {
  const luma = (i) => (px[i] * 2 + px[i + 1] * 5 + px[i + 2]) >> 3;
  const rowDark = (y) => {
    let sum = 0;
    let max = 0;
    for (let x = 0; x < w; x++) {
      const l = luma((y * w + x) * 4);
      sum += l;
      if (l > max) max = l;
    }
    return sum / w < DARK && max < BRIGHT;
  };
  const colDark = (x, top, bottom) => {
    let sum = 0;
    let max = 0;
    for (let y = top; y <= bottom; y++) {
      const l = luma((y * w + x) * 4);
      sum += l;
      if (l > max) max = l;
    }
    return sum / (bottom - top + 1) < DARK && max < BRIGHT;
  };
  let top = 0;
  while (top < h && rowDark(top)) top++;
  if (top >= h) return null; // all dark
  let bottom = h - 1;
  while (bottom > top && rowDark(bottom)) bottom--;
  let left = 0;
  while (left < w && colDark(left, top, bottom)) left++;
  let right = w - 1;
  while (right > left && colDark(right, top, bottom)) right--;
  // Too little picture to trust (a title card on black, say).
  if ((bottom - top + 1) < h * 0.3 || (right - left + 1) < w * 0.3) return null;
  return { top, bottom, left, right };
}

// Shapes films are actually made in. Bars that leave any other shape are a
// dark scene, not a letterbox, and are ignored.
const WIDE = [1.85, 2.0, 2.2, 2.35, 2.39, 2.76];
const NARROW = [4 / 3, 1.37];

/**
 * Bars to remove, as fractions of the frame, from the widest picture seen so
 * far: kept symmetric (the smaller side wins), snapped to the nearest real
 * film shape within 2.5%, or nothing at all.
 * @param {{ top: number, bottom: number, left: number, right: number }} seen
 * @param {number} w  frame width (sample pixels)
 * @param {number} h  frame height
 */
const nearest = (shape, list) => {
  const best = list.reduce((a, r) => (Math.abs(shape - r) < Math.abs(shape - a) ? r : a));
  return Math.abs(shape - best) / best < 0.025 ? best : null;
};

export function barsFrom(seen, w, h) {
  const v = Math.min(seen.top, h - 1 - seen.bottom) / h;
  const s = Math.min(seen.left, w - 1 - seen.right) / w;
  const frame = w / h;
  if (v >= 0.02 && s < 0.02) {
    const shape = frame / (1 - 2 * v);
    const film = nearest(shape, WIDE);
    return film && film > frame ? { v: (1 - frame / film) / 2, h: 0 } : { v: 0, h: 0 };
  }
  if (s >= 0.02 && v < 0.02) {
    const shape = frame * (1 - 2 * s);
    const film = nearest(shape, NARROW);
    return film && film < frame ? { v: 0, h: (1 - film / frame) / 2 } : { v: 0, h: 0 };
  }
  return { v: 0, h: 0 }; // bars on all sides, or none: leave it
}

export class CropMixin {
  startCrop() {
    this.stopCrop();
    this.cropSeen = null;
    this.cropBars = { v: 0, h: 0 };
    this.cropSamples = 0;
    const tick = () => {
      this.sampleCrop();
      // Quickly at first, then now and then for scenes with a wider picture.
      this.cropTimer = setTimeout(tick, this.cropSamples < 20 ? 1500 : 8000);
    };
    this.cropTimer = setTimeout(tick, 600);
  }

  stopCrop() {
    clearTimeout(this.cropTimer);
    this.cropTimer = 0;
    this.video.style.transform = '';
  }

  sampleCrop() {
    const v = this.video;
    if (this.fit !== 'crop' || v.paused || v.readyState < 2 || !v.videoWidth) return;
    const w = SAMPLE_W;
    const h = Math.max(8, Math.round((SAMPLE_W * v.videoHeight) / v.videoWidth));
    this.cropCanvas ??= document.createElement('canvas');
    const c = this.cropCanvas;
    c.width = w;
    c.height = h;
    let px;
    try {
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      px = ctx.getImageData(0, 0, w, h).data;
    } catch {
      // The browser won't let us read this video's pixels; leave it as Fit.
      if (!this.cropWarned) this.osd("Auto crop can't read this video");
      this.cropWarned = true;
      return;
    }
    const found = findPicture(px, w, h);
    if (!found) return;
    this.cropSamples++;
    // Keep the widest picture seen, so a dark scene never crops more.
    const s = this.cropSeen;
    this.cropSeen = s ? {
      top: Math.min(s.top, found.top),
      bottom: Math.max(s.bottom, found.bottom),
      left: Math.min(s.left, found.left),
      right: Math.max(s.right, found.right),
    } : found;
    // Wait for a few frames before trusting it; the widest-seen picture only
    // ever shrinks the bars from there.
    if (this.cropSamples < 4) return;
    const bars = barsFrom(this.cropSeen, w, h);
    if (bars.v !== this.cropBars.v || bars.h !== this.cropBars.h) {
      this.cropBars = bars;
      this.applyCrop();
    }
  }

  // Zooms and centres the picture inside the bars so it fits the player.
  applyCrop() {
    const v = this.video;
    if (this.fit !== 'crop' || !v.videoWidth) return;
    const { v: bv, h: bh } = this.cropBars;
    if (!bv && !bh) {
      v.style.transform = '';
      return;
    }
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const base = Math.min(W / vw, H / vh); // the scale object-fit: contain uses
    const cw = vw * (1 - 2 * bh);
    const ch = vh * (1 - 2 * bv);
    // 1% extra hides the hairline a soft bar edge or rounding would leave.
    const scale = (Math.min(W / cw, H / ch) / base) * 1.01;
    v.style.transformOrigin = '50% 50%';
    v.style.transform = `scale(${scale.toFixed(4)})`;
  }
}
