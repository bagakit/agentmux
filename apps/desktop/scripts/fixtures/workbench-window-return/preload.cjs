const { contextBridge, ipcRenderer } = require('electron')
const listen = (channel, listener) => {
  const relay = (_event, value) => listener(value)
  ipcRenderer.on(channel, relay)
  return () => ipcRenderer.removeListener(channel, relay)
}
contextBridge.exposeInMainWorld('windowProof', {
  call: (method, input) => ipcRenderer.invoke('window-proof:call', method, input),
  ready: () => ipcRenderer.invoke('window-proof:ready'),
  respond: response => ipcRenderer.send('window-proof:response', response),
  onRequest: listener => listen('workbenchWindows:request', listener),
  onChanged: listener => listen('workbenchWindows:changed', listener),
  done: result => ipcRenderer.invoke('window-proof:done', result)
})
