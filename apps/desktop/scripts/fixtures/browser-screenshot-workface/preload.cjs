const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('screenshotNative', {
  call: (method, ...args) => ipcRenderer.invoke('screenshot:call', method, ...args),
  subscribe: (kind, listener) => {
    const channel = kind === 'presentation' ? 'agentmux:browser-presentation-event' : 'screenshot:' + kind
    const receive = (_event, value) => listener(value)
    ipcRenderer.on(channel, receive)
    return () => ipcRenderer.removeListener(channel, receive)
  }
})
