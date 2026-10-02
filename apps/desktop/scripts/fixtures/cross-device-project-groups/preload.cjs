const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('projectGroupsBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('project-groups:request', operation, ...args),
  onSpatialChange: listener => {
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('project-groups:spatial-change', receive)
    return () => ipcRenderer.removeListener('project-groups:spatial-change', receive)
  }
})
