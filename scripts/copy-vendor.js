// Copies/bundles third-party browser code into the renderer so it ships inside the app.
//   hls.js  -> vendor/hls.min.js           (HLS streaming)
//   jassub  -> vendor/jassub/*             (libass WASM renderer for styled ASS/SSA subtitles)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');
const nm = (...p) => path.join(root, 'node_modules', ...p);
fs.mkdirSync(vendorDir, { recursive: true });

function copy(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`missing ${path.relative(root, src)}; run npm install again`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

if (copy(nm('hls.js', 'dist', 'hls.min.js'), path.join(vendorDir, 'hls.min.js'))) console.log('Copied hls.min.js');

// jassub ships as ESM with bare imports, so bundle the main thread entry and the
// module worker into self-contained files. Asset URLs (wasm, default font) are
// kept at the same relative paths so import.meta.url resolution still works.
const jassubDist = nm('jassub', 'dist');
const jassubOut = path.join(vendorDir, 'jassub');
if (fs.existsSync(jassubDist)) {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    console.warn('esbuild not installed; skipping jassub bundle');
  }
  if (esbuild) {
    const common = { bundle: true, format: 'esm', minify: true, target: 'chrome120', logLevel: 'warning', legalComments: 'none' };
    esbuild.buildSync({ ...common, entryPoints: [path.join(jassubDist, 'jassub.js')], outfile: path.join(jassubOut, 'jassub.js') });
    esbuild.buildSync({ ...common, entryPoints: [path.join(jassubDist, 'worker', 'worker.js')], outfile: path.join(jassubOut, 'worker', 'worker.js') });
    for (const f of ['jassub-worker.wasm', 'jassub-worker-modern.wasm']) {
      copy(path.join(jassubDist, 'wasm', f), path.join(jassubOut, 'wasm', f));
    }
    copy(path.join(jassubDist, 'default.woff2'), path.join(jassubOut, 'default.woff2'));
    console.log('Bundled jassub');
  }
}
