const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('takeoverFlowNative', {
  boot: () => ipcRenderer.invoke('takeover-flow:boot'),
  saveTopics: value => ipcRenderer.invoke('takeover-flow:topics', value),
  spatialRead: () => ipcRenderer.invoke('takeover-flow:spatial-read'),
  spatialCommit: value => ipcRenderer.invoke('takeover-flow:spatial-commit', value),
  flush: () => ipcRenderer.invoke('takeover-flow:flush')
})
