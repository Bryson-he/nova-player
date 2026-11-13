'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  isInside, originOf, isPrivateHost, serverCandidates, safeFileName, validStoreWrite, STORE_KEYS, buildCsp,
} = require('../src/main/security');
const { CHANNELS } = require('../src/main/ipc-contract');

test('isInside accepts the folder and its children only', () => {
  const base = path.join('C:', 'Users', 'me', 'Pictures', 'Nova Player');
  assert.ok(isInside(base, base));
  assert.ok(isInside(base, path.join(base, 'shot.png')));
  assert.ok(isInside(base, path.join(base, 'a', 'b.png')));
  assert.ok(!isInside(base, base + '2'), 'sibling with the same prefix');
  assert.ok(!isInside(base, path.join(base, '..', 'other.png')));
  assert.ok(!isInside(base, path.join('D:', 'shot.png')));
});

test('originOf only accepts http(s) URLs', () => {
  assert.equal(originOf('https://demo.jellyfin.org/stable/x?y=1'), 'https://demo.jellyfin.org');
  assert.equal(originOf('http://10.0.0.5:8096/'), 'http://10.0.0.5:8096');
  assert.equal(originOf('file:///C:/x'), null);
  assert.equal(originOf('not a url'), null);
});

test('isPrivateHost recognises home and tailnet addresses', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20',
    '169.254.1.1', '100.64.0.1', '100.127.255.254', 'tower', 'NAS', 'jellyfin.local', 'box.lan', 'srv.home.arpa',
    '[::1]', 'fd12:3456::1', 'fe80::1']) {
    assert.ok(isPrivateHost(h), h);
  }
  for (const h of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1',
    'jellyfin.example.com', 'demo.jellyfin.org', '2001:db8::1', '', '256.1.1.1']) {
    assert.ok(!isPrivateHost(h), h);
  }
});

test('serverCandidates tries HTTPS first for public hosts', () => {
  assert.deepEqual(serverCandidates('jellyfin.example.com'),
    ['https://jellyfin.example.com', 'http://jellyfin.example.com:8096', 'http://jellyfin.example.com']);
  assert.deepEqual(serverCandidates('media.example.com/jf/'),
    ['https://media.example.com/jf', 'http://media.example.com:8096/jf', 'http://media.example.com/jf']);
  assert.deepEqual(serverCandidates('example.com:8920'), ['https://example.com:8920', 'http://example.com:8920']);
});

test('serverCandidates keeps http://host:8096 first on the home network', () => {
  assert.deepEqual(serverCandidates('192.168.1.20'),
    ['http://192.168.1.20:8096', 'https://192.168.1.20', 'http://192.168.1.20']);
  assert.deepEqual(serverCandidates('tower'), ['http://tower:8096', 'https://tower', 'http://tower']);
  assert.deepEqual(serverCandidates('100.101.1.2:8096'), ['https://100.101.1.2:8096', 'http://100.101.1.2:8096']);
});

test('serverCandidates uses an address with a scheme as typed', () => {
  assert.deepEqual(serverCandidates(' http://example.com:8096/ '), ['http://example.com:8096']);
  assert.deepEqual(serverCandidates('HTTPS://x.org'), ['HTTPS://x.org']);
  assert.deepEqual(serverCandidates('   '), []);
});

test('safeFileName strips bad characters and reserved names', () => {
  assert.equal(safeFileName('Show: S1/E2 <x>'), 'Show S1E2 x');
  assert.equal(safeFileName('name. . '), 'name');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName('nul.png'), '_nul.png');
  assert.equal(safeFileName('com1'), '_com1');
  assert.equal(safeFileName('Concert'), 'Concert');
  assert.equal(safeFileName(''), 'screenshot');
  assert.equal(safeFileName('...'), 'screenshot');
  assert.equal(safeFileName('x'.repeat(400)).length, 150);
});

test('store writes are limited to known keys with the right shape', () => {
  assert.deepEqual(Object.keys(STORE_KEYS).sort(), ['deviceId', 'lastUsername', 'lastVersion', 'librarySort', 'muted',
    'seriesTracks', 'server', 'settings', 'subDelays', 'user', 'volume'].sort());
  assert.ok(validStoreWrite('volume', 0.5));
  assert.ok(!validStoreWrite('volume', 2));
  assert.ok(validStoreWrite('muted', false));
  assert.ok(!validStoreWrite('muted', 'no'));
  assert.ok(validStoreWrite('deviceId', 'abcdef0123456789'));
  assert.ok(!validStoreWrite('deviceId', 'x" , Token="evil'));
  assert.ok(validStoreWrite('server', { url: 'https://jf.example.com', name: 'x' }));
  assert.ok(!validStoreWrite('server', { url: 'javascript:alert(1)' }));
  assert.ok(validStoreWrite('user', { Id: 'abc', Name: 'me' }));
  assert.ok(!validStoreWrite('settings', [1, 2]));
  assert.ok(validStoreWrite('seriesTracks', null), 'null deletes');
  for (const k of ['token', 'tokenBase', 'window', '__proto__', 'constructor']) assert.ok(!validStoreWrite(k, {}), k);
  assert.ok(!validStoreWrite('librarySort', { big: 'x'.repeat(1024 * 1024) }), 'size cap');
});

test('content security policy names only the signed-in server', () => {
  const csp = buildCsp('https://jf.example.com');
  assert.match(csp, /connect-src 'self' https:\/\/jf\.example\.com(;|$)/);
  assert.match(csp, /img-src 'self' data: blob: https:\/\/jf\.example\.com(;|$)/);
  for (const d of ["base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-src 'none'", "require-trusted-types-for 'script'"]) {
    assert.ok(csp.includes(d), d);
  }
  assert.ok(!csp.includes('unsafe-inline'));
  assert.match(buildCsp(null), /connect-src 'self' http: https:/);
});

test('every IPC channel is well formed', () => {
  const names = new Set();
  for (const [ch, def] of Object.entries(CHANNELS)) {
    assert.ok(['invoke', 'send', 'event'].includes(def.kind), ch);
    assert.ok(def.expose && !names.has(def.expose), `${ch} exposes a unique name`);
    names.add(def.expose);
    if (def.kind !== 'event') assert.ok(def.args.every((a) => typeof a === 'function'), ch);
  }
  assert.ok(!('store:token' in CHANNELS), 'no channel carries the token');
});
