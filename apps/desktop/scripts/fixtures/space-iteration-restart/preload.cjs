const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('spaceRestartBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('space-restart:request', operation, ...args),
  onEvent: listener => {
    const relay = (_event, fact) => listener(fact)
    ipcRenderer.on('space-restart:event', relay)
    return () => ipcRenderer.removeListener('space-restart:event', relay)
  }
})
