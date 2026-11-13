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
