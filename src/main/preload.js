'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nova', {
  getStore: () => ipcRenderer.invoke('store:get'),
  set: (key, value) => ipcRenderer.send('store:set', key, value),
  setToken: (token) => ipcRenderer.send('store:token', token),
  keepAwake: (on) => ipcRenderer.send('power:block', !!on),
  setFullscreen: (value) => ipcRenderer.invoke('win:fullscreen', value),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, value) => cb(value)),
  setDarkOverlay: (dark) => ipcRenderer.send('win:overlay', !!dark),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, state) => cb(state)),
});
