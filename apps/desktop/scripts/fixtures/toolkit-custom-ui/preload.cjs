// Product preload owns the complete Toolkit API; this is only private scene control.
require('../../../src/preload/index.ts')
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('toolkitProof', {
  seed: config => ipcRenderer.invoke('proof:toolkit:seed', config),
  get: () => ipcRenderer.invoke('proof:toolkit:config:get'),
  save: (next, expected) => ipcRenderer.invoke('proof:toolkit:config:save', next, expected),
  onChange: listener => { const receive = (_event, next) => listener(next); ipcRenderer.on('proof:toolkit:config:changed', receive); return () => ipcRenderer.off('proof:toolkit:config:changed', receive) },
  facts: () => ipcRenderer.invoke('proof:toolkit:facts'),
  flush: () => ipcRenderer.invoke('proof:toolkit:flush'),
  holdSave: () => ipcRenderer.invoke('proof:toolkit:hold-save'),
  saveHeld: () => ipcRenderer.invoke('proof:toolkit:save-held'),
  releaseSave: () => ipcRenderer.invoke('proof:toolkit:release-save')
})
