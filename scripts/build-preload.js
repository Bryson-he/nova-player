// Bundles the preload script with the shared IPC contract (the sandboxed
// preload can only require 'electron' and a few built-ins at runtime).
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'preload.js')],
  outfile: path.join(root, 'src', 'main', 'generated', 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});
