const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('newProjectBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('new-project:request', operation, ...args),
  onSpatialChange: listener => {
    const relay = (_event, value) => listener(value)
    ipcRenderer.on('new-project:spatial-change', relay)
    return () => ipcRenderer.removeListener('new-project:spatial-change', relay)
  }
})
