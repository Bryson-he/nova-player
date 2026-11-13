// Renders the app icon from build/icon.svg (and build/icon-small.svg, drawn
// separately for 16-24 px) into build/icon.png, build/icon.ico and
// docs/icon.png. Run it after changing the SVGs: node scripts/build-icons.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const big = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(root, 'build', 'icon-small.svg'), 'utf8');

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const images = ICO_SIZES.map((size) => ({ size, png: render(size <= 24 ? small : big, size) }));

// An .ico holding PNG images (supported since Windows Vista).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const dir = Buffer.alloc(16 * images.length);
let offset = 6 + dir.length;
images.forEach(({ size, png }, i) => {
  const o = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, o);
  dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
  dir.writeUInt8(0, o + 2);
  dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(png.length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, dir, ...images.map((i) => i.png)]));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(big, 512));
fs.writeFileSync(path.join(root, 'docs', 'icon.png'), render(big, 256));
// A preview sheet of every size on dark and light taskbars, for checking by eye.
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="560" height="160">
  <rect width="560" height="80" fill="#1c1c1c"/><rect y="80" width="560" height="80" fill="#f3f3f3"/>
  ${[0, 80].map((y) => images.filter((i) => i.size <= 64).map((img, n) => {
    const x = 16 + n * 80;
    return `<image x="${x}" y="${y + (80 - img.size) / 2}" width="${img.size}" height="${img.size}" href="data:image/png;base64,${img.png.toString('base64')}"/>`;
  }).join('')).join('')}
</svg>`;
fs.writeFileSync(path.join(root, 'build', 'icon-preview.png'), new Resvg(sheet).render().asPng());
console.log(`Wrote build/icon.ico (${ICO_SIZES.join(', ')} px), build/icon.png, docs/icon.png`);
