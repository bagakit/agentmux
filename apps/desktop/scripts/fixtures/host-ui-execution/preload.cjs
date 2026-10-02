const { contextBridge, ipcRenderer } = require('electron')
const subscribe = channel => listener => {
  const relay = (_event, value) => listener(value)
  ipcRenderer.on(channel, relay)
  return () => ipcRenderer.removeListener(channel, relay)
}
contextBridge.exposeInMainWorld('hostUiBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('host-ui:request', operation, ...args),
  onEvent: subscribe('agentmux:session-event'),
  onSpatialChange: subscribe('host-ui:spatial-change')
})
