// @ts-check
'use strict';
// Builds window.nova from the shared IPC contract. The sandboxed preload can't
// require local files at runtime, so scripts/build-preload.js bundles this
// into src/main/generated/preload.js before every start and build.
const { contextBridge, ipcRenderer } = require('electron');
const { CHANNELS } = require('./ipc-contract');

const nova = {};
for (const [channel, def] of Object.entries(CHANNELS)) {
  if (def.kind === 'event') {
    // Returns an unsubscribe function.
    nova[def.expose] = (cb) => {
      const listener = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    };
    continue;
  }
  const call = def.kind === 'invoke' ? ipcRenderer.invoke : ipcRenderer.send;
  nova[def.expose] = (...args) => {
    const sent = def.args.map((_, i) => (def.coerce?.[i] ? def.coerce[i](args[i]) : args[i]));
    return call.call(ipcRenderer, channel, ...sent);
  };
}

contextBridge.exposeInMainWorld('nova', nova);
