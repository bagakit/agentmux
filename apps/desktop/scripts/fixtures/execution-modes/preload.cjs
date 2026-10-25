const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('executionModesSpatial', {
  read: () => ipcRenderer.invoke('execution-modes:spatial', 'read'),
  commit: input => ipcRenderer.invoke('execution-modes:spatial', 'commit', input),
  retainLabels: values => ipcRenderer.invoke('execution-modes:spatial', 'retain-labels', values),
  onChange: listener => {
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('execution-modes:spatial-changed', receive)
    return () => ipcRenderer.removeListener('execution-modes:spatial-changed', receive)
  }
})
