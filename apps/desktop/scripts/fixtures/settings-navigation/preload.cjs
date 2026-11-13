const { contextBridge, ipcRenderer } = require('electron')
const subscribe = channel => listener => {
  const relay = (_event, value) => listener(value)
  ipcRenderer.on(channel, relay)
  return () => ipcRenderer.removeListener(channel, relay)
}
contextBridge.exposeInMainWorld('settingsNavigationBoundary', {
  setup: () => ipcRenderer.invoke('settings-navigation:setup'),
  control: { onRequest: subscribe('agentmux:control-request'), onCancellation: subscribe('agentmux:control-cancel'),
    respond: response => ipcRenderer.send('control:response', response) }
})
