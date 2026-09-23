const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('spaceAppearanceBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('space-appearance:request', operation, ...args)
})
