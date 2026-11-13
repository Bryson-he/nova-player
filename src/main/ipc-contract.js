// @ts-check
'use strict';
// Every channel between the page and the main process, in one place. main.js
// registers handlers only through this list (checking the sender and each
// argument), and preload.js builds window.nova from it, so a channel cannot
// exist on one side without the other.
//
//   invoke: page awaits a reply      send: fire and forget      event: main -> page

/** @typedef {(v: unknown) => boolean} Check */

/** @type {Check} */ const bool = (v) => typeof v === 'boolean';
/** @type {Check} */ const optBool = (v) => v === undefined || typeof v === 'boolean';
/** @type {(max: number) => Check} */ const str = (max) => (v) => typeof v === 'string' && v.length <= max;
/** @type {Check} */ const any = () => true;
/** @type {Check} */ const zoom = (v) => typeof v === 'number' && v >= 0.5 && v <= 2;
/** @type {Check} */ const bytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);
/** @type {Check} */ const signIn = (v) => {
  if (!v || typeof v !== 'object') return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  if (typeof o.base !== 'string' || o.base.length > 2048) return false;
  if (o.secret !== undefined) return typeof o.secret === 'string' && o.secret.length <= 256;
  return typeof o.username === 'string' && o.username.length <= 256
    && typeof o.password === 'string' && o.password.length <= 1024;
};

/**
 * @typedef {{ kind: 'invoke' | 'send', expose: string, args: Check[], coerce?: ((v: any) => any)[] }
 *   | { kind: 'event', expose: string }} Channel
 */

/** @type {Record<string, Channel>} */
const CHANNELS = {
  'store:get': { kind: 'invoke', expose: 'getStore', args: [] },
  // Key allowlist and value shapes are checked in main (security.js STORE_KEYS).
  'store:set': { kind: 'send', expose: 'set', args: [str(64), any] },

  'server:find': { kind: 'invoke', expose: 'findServer', args: [str(2048)] },
  'server:discover': { kind: 'invoke', expose: 'discoverServers', args: [] },
  'auth:signIn': { kind: 'invoke', expose: 'signIn', args: [signIn] },
  'auth:signOut': { kind: 'invoke', expose: 'signOut', args: [] },

  'power:block': { kind: 'send', expose: 'keepAwake', args: [bool], coerce: [Boolean] },
  'win:fullscreen': { kind: 'invoke', expose: 'setFullscreen', args: [optBool] },
  'win:overlay': { kind: 'send', expose: 'setDarkOverlay', args: [bool], coerce: [Boolean] },
  'win:mini': { kind: 'invoke', expose: 'setMini', args: [bool], coerce: [Boolean] },
  'win:zoom': { kind: 'send', expose: 'setZoom', args: [zoom], coerce: [Number] },
  'app:accent': { kind: 'invoke', expose: 'accentColor', args: [] },
  'open-external': { kind: 'send', expose: 'openExternal', args: [str(4096)] },
  'screenshot:save': { kind: 'invoke', expose: 'saveScreenshot', args: [bytes, str(1024)] },
  'shell:show': { kind: 'send', expose: 'showInFolder', args: [str(4096)] },

  'app:info': { kind: 'invoke', expose: 'appInfo', args: [] },
  'app:close-ready': { kind: 'send', expose: 'closeReady', args: [] },
  'update:state': { kind: 'invoke', expose: 'updateState', args: [] },
  'update:check': { kind: 'invoke', expose: 'checkForUpdates', args: [] },
  'update:install': { kind: 'send', expose: 'installUpdate', args: [] },

  fullscreen: { kind: 'event', expose: 'onFullscreen' },
  update: { kind: 'event', expose: 'onUpdate' },
  'app:before-close': { kind: 'event', expose: 'onBeforeClose' },
};

module.exports = { CHANNELS };
