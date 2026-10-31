const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('durableRestart', {
  request: (operation, ...args) => ipcRenderer.invoke('durable-restart:request', operation, ...args),
  onSpatialChange: listener => {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('durable-restart:spatial', receive)
    return () => ipcRenderer.removeListener('durable-restart:spatial', receive)
  },
  onSessionEvent: listener => {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('agentmux:session-event', receive)
    return () => ipcRenderer.removeListener('agentmux:session-event', receive)
  }
})
