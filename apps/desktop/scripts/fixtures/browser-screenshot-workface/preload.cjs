const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('screenshotNative', {
  call: (method, ...args) => ipcRenderer.invoke('screenshot:call', method, ...args),
  subscribe: (kind, listener) => {
    const channel = 'screenshot:' + kind
    const receive = (_event, value) => listener(value)
    ipcRenderer.on(channel, receive)
    return () => ipcRenderer.removeListener(channel, receive)
  }
})
