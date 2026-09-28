const { contextBridge, ipcRenderer } = require('electron')
const subscribe = channel => listener => {
  const relay = (_event, value) => listener(value)
  ipcRenderer.on(channel, relay)
  return () => ipcRenderer.removeListener(channel, relay)
}
contextBridge.exposeInMainWorld('focusProofBoundary', {
  request: (operation, ...args) => ipcRenderer.invoke('focus-proof:request', operation, ...args),
  onEvent: subscribe('agentmux:session-event'),
  control: {
    onRequest: subscribe('agentmux:control-request'),
    onCancellation: subscribe('agentmux:control-cancel'),
    respond: response => ipcRenderer.send('control:response', response)
  }
})
