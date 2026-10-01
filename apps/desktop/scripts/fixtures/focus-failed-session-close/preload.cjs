const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('failedCloseIO', {
  readRuntime: () => ipcRenderer.invoke('failed-close:read'),
  writeRuntime: value => ipcRenderer.invoke('failed-close:write', value),
  flush: () => ipcRenderer.invoke('failed-close:flush')
})
