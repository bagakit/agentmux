const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('startPageNativeConfig', {
  initialize: value => ipcRenderer.invoke('probe:start-page:config:initialize', value),
  read: () => ipcRenderer.invoke('probe:start-page:config:read'),
  save: (value, expected) => ipcRenderer.invoke('probe:start-page:config:save', value, expected)
})
