// Actual product preload owns Toolkit/contextBridge; this adds only private fixture control.
require('../../../src/preload/index.ts')
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('performanceProof', {
  setup: config => ipcRenderer.invoke('proof:setup', config),
  get: () => ipcRenderer.invoke('proof:config:get'),
  save: (next, expected) => ipcRenderer.invoke('proof:config:save', next, expected),
  onChange: listener => { const receive = (_event, next) => listener(next); ipcRenderer.on('proof:config:changed', receive); return () => ipcRenderer.off('proof:config:changed', receive) },
  publish: snapshot => ipcRenderer.invoke('proof:snapshot', snapshot),
  flush: () => ipcRenderer.invoke('proof:flush'),
  facts: () => ipcRenderer.invoke('proof:facts')
})
