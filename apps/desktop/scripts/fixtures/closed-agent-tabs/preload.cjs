const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('closedAgentTabsIO', {
  request: (operation, ...args) => ipcRenderer.invoke('closed-agent-tabs:request', operation, ...args),
  onEvent: listener => {
    const relay = (_event, event) => listener(event)
    ipcRenderer.on('closed-agent-tabs:event', relay)
    return () => ipcRenderer.removeListener('closed-agent-tabs:event', relay)
  }
})
