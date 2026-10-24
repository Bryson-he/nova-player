// Copies third-party browser bundles into the renderer so they ship inside the app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const src = path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
if (fs.existsSync(src)) {
  fs.copyFileSync(src, path.join(vendorDir, 'hls.min.js'));
  console.log('Copied hls.min.js');
} else {
  console.warn('hls.js not installed yet; run npm install again');
}
