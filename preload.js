'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('player', Object.freeze({
  catalog: options => ipcRenderer.invoke('catalog', options),
  detail: id => ipcRenderer.invoke('detail', id),
  play: options => ipcRenderer.invoke('play', options),
  onProgress: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('playback-progress', listener);
    return () => ipcRenderer.removeListener('playback-progress', listener);
  },
  updates: Object.freeze({
    status: () => ipcRenderer.invoke('update-status'),
    check: () => ipcRenderer.invoke('update-check'),
    download: () => ipcRenderer.invoke('update-download'),
    install: () => ipcRenderer.invoke('update-install'),
    onStatus: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('update-state', listener);
      return () => ipcRenderer.removeListener('update-state', listener);
    }
  }),
  external: url => ipcRenderer.invoke('external', url)
}));
