const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('topicTerminalBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('topic-terminal:request', operation, ...args),
  onSpatialChange: listener => {
    const relay = (_event, fact) => listener(fact)
    ipcRenderer.on('topic-terminal:spatial-change', relay)
    return () => ipcRenderer.removeListener('topic-terminal:spatial-change', relay)
  },
  onEvent: listener => {
    const relay = (_event, fact) => listener(fact)
    ipcRenderer.on('agentmux:session-event', relay)
    return () => ipcRenderer.removeListener('agentmux:session-event', relay)
  }
})
