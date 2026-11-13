// Auto crop: finding black bars that are part of the video.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findPicture, barsFrom } from '../src/renderer/js/player/crop.js';

// A w×h RGBA frame: black outside `pic`, a busy mid-grey picture inside.
function frame(w, h, pic, { dark = false } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = x >= pic.left && x <= pic.right && y >= pic.top && y <= pic.bottom;
      const v = !inside ? 0 : dark ? 10 : 60 + ((x * 7 + y * 13) % 120);
      px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
    }
  }
  return px;
}

test('a 2.39:1 film stored as 16:9 has bars top and bottom', () => {
  const w = 192;
  const h = 108;
  const picH = Math.round(w / 2.39); // 80
  const top = Math.round((h - picH) / 2); // 14
  const found = findPicture(frame(w, h, { left: 0, right: w - 1, top, bottom: top + picH - 1 }), w, h);
  assert.deepEqual(found, { top, bottom: top + picH - 1, left: 0, right: w - 1 });
  const bars = barsFrom(found, w, h);
  assert.ok(Math.abs(bars.v - top / h) < 0.001);
  assert.equal(bars.h, 0);
});

test('a 4:3 picture stored as 16:9 has bars on the sides', () => {
  const w = 192;
  const h = 108;
  const picW = 144;
  const left = 24;
  const found = findPicture(frame(w, h, { left, right: left + picW - 1, top: 0, bottom: h - 1 }), w, h);
  const bars = barsFrom(found, w, h);
  assert.equal(bars.v, 0);
  assert.ok(Math.abs(bars.h - left / w) < 0.001);
});

test('a dark scene tells us nothing', () => {
  assert.equal(findPicture(frame(192, 108, { left: 0, right: 191, top: 0, bottom: 107 }, { dark: true }), 192, 108), null);
});

test('a dark edge of the picture on one side is not cropped (bars stay symmetric)', () => {
  // Picture runs to the very bottom but starts 20 rows down: not a letterbox.
  const found = findPicture(frame(192, 108, { left: 0, right: 191, top: 20, bottom: 107 }), 192, 108);
  assert.deepEqual(barsFrom(found, 192, 108), { v: 0, h: 0 });
});

test('a full-frame video needs no crop', () => {
  const found = findPicture(frame(192, 108, { left: 0, right: 191, top: 0, bottom: 107 }), 192, 108);
  assert.deepEqual(barsFrom(found, 192, 108), { v: 0, h: 0 });
});
