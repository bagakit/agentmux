const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('topicsRestartBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('topics-restart:request', operation, ...args),
  onSpatialChange: listener => {
    const relay = (_event, fact) => listener(fact)
    ipcRenderer.on('topics-restart:spatial-change', relay)
    return () => ipcRenderer.removeListener('topics-restart:spatial-change', relay)
  }
})
