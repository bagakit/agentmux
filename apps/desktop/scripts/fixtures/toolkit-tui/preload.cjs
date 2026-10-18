// Product preload owns Toolkit and every terminal operation; only scene setup is private.
require('../../../src/preload/index.ts')
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('tuiProof', {
  seed: config => ipcRenderer.invoke('proof:tui:seed', config),
  get: () => ipcRenderer.invoke('proof:tui:config:get'),
  save: (next, expected) => ipcRenderer.invoke('proof:tui:config:save', next, expected),
  onChange: listener => { const read = (_event, config) => listener(config); ipcRenderer.on('proof:tui:config:changed', read); return () => ipcRenderer.off('proof:tui:config:changed', read) }
})
