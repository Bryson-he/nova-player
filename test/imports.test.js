'use strict';
// Every relative import (static or dynamic) and every new URL(..., import.meta.url)
// in the renderer must point at a file that exists. Moving a module into a
// subfolder breaks these silently at runtime otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src', 'renderer', 'js');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);

test('relative imports and asset URLs resolve', () => {
  const bad = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g),
      ...src.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g),
      ...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g),
      ...src.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) && !(spec.includes('vendor/') && !fs.existsSync(path.join(root, '..', 'vendor')))) {
        bad.push(`${path.relative(root, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// The bundled JASSUB (built by scripts/copy-vendor.js) loads its worker, wasm
// and glue files by URL. A file missing from vendor/ silently turns styled
// subtitles into plain text, as happened when JASSUB 2.5.37 started loading
// wasm/jassub-worker-modern.js.
test('bundled JASSUB files it loads by URL are present', (t) => {
  const bundle = path.join(root, '..', 'vendor', 'jassub', 'jassub.js');
  if (!fs.existsSync(bundle)) {
    t.skip('vendor not built (npm install builds it)');
    return;
  }
  const src = fs.readFileSync(bundle, 'utf8');
  const urls = [...src.matchAll(/new URL\(\s*["'](\.\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3, `expected asset URLs in jassub.js, found ${urls.length}`);
  const missing = urls.filter((u) => !fs.existsSync(path.resolve(path.dirname(bundle), u)));
  assert.deepEqual(missing, []);
});
