const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('remoteProof', {
  request: (operation, ...args) => ipcRenderer.invoke('remote-proof:request', operation, ...args),
  onSpatialChange: listener => {
    const relay = (_event, state) => listener(state)
    ipcRenderer.on('remote-proof:spatial-changed', relay)
    return () => ipcRenderer.removeListener('remote-proof:spatial-changed', relay)
  },
  onEvent: listener => {
    const relay = (_event, fact) => listener(fact)
    ipcRenderer.on('agentmux:session-event', relay)
    return () => ipcRenderer.removeListener('agentmux:session-event', relay)
  }
})
