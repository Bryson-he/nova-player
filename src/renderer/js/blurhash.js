// BlurHash decoder (https://blurha.sh). Jellyfin sends a blur hash for every
// image, so posters fade in from a colour-accurate blur instead of grey.
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str, from, to) {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 83 + CHARS.indexOf(str[i]);
  return v;
}

const sRGBToLinear = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const linearTosRGB = (v) => {
  const x = Math.max(0, Math.min(1, v));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255);
};
const signPow = (v, e) => Math.sign(v) * Math.abs(v) ** e;

/**
 * @param {string} hash
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray | null} RGBA pixels
 */
export function decodeBlurHash(hash, width, height) {
  if (!hash || hash.length < 6) return null;
  const size = decode83(hash, 0, 1);
  const nx = (size % 9) + 1;
  const ny = Math.floor(size / 9) + 1;
  if (hash.length !== 4 + 2 * nx * ny) return null;
  const maxAc = (decode83(hash, 1, 2) + 1) / 166;
  const colors = new Array(nx * ny);
  const dc = decode83(hash, 2, 6);
  colors[0] = [sRGBToLinear(dc >> 16), sRGBToLinear((dc >> 8) & 255), sRGBToLinear(dc & 255)];
  for (let i = 1; i < colors.length; i++) {
    const v = decode83(hash, 4 + i * 2, 6 + i * 2);
    colors[i] = [
      signPow((Math.floor(v / 361) - 9) / 9, 2) * maxAc,
      signPow(((Math.floor(v / 19) % 19) - 9) / 9, 2) * maxAc,
      signPow(((v % 19) - 9) / 9, 2) * maxAc,
    ];
  }
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ny; j++) {
        const cy = Math.cos((Math.PI * y * j) / height);
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * cy;
          const c = colors[i + j * nx];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const o = 4 * (x + y * width);
      px[o] = linearTosRGB(r);
      px[o + 1] = linearTosRGB(g);
      px[o + 2] = linearTosRGB(b);
      px[o + 3] = 255;
    }
  }
  return px;
}

const cache = new Map();

/** A small canvas painted with the blur, or null if the hash is unusable. */
export function blurCanvas(hash, w = 24, h = 24) {
  if (!hash) return null;
  let px = cache.get(hash);
  if (!px) {
    px = decodeBlurHash(hash, w, h);
    if (!px) return null;
    if (cache.size > 600) cache.delete(cache.keys().next().value);
    cache.set(hash, px);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.className = 'blur';
  c.setAttribute('aria-hidden', 'true');
  c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}
