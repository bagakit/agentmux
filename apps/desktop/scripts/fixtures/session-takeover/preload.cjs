const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('takeoverNative', {
  boot: () => ipcRenderer.invoke('takeover:boot'),
  saveRuntime: value => ipcRenderer.invoke('takeover:runtime', value),
  spatialRead: () => ipcRenderer.invoke('takeover:spatial-read'),
  spatialCommit: value => ipcRenderer.invoke('takeover:spatial-commit', value),
  flush: () => ipcRenderer.invoke('takeover:flush')
})
