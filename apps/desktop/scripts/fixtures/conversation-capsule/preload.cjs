const { contextBridge, ipcRenderer } = require('electron')
const listen = channel => callback => { const handler = (_event, value) => callback(value); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler) }
contextBridge.exposeInMainWorld('capsuleProbe', { call: (method, ...args) => ipcRenderer.invoke('capsule-proof', method, ...args),
  onEvent: listen('agentmux:browser-event'), onPresentation: listen('agentmux:browser-presentation-event') })
