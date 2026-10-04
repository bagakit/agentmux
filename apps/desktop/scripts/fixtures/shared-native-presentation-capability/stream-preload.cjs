const { contextBridge, ipcRenderer } = require('electron')

// Exclusive private fixture only. Each Main request checks this exact consumer mainFrame.
contextBridge.exposeInMainWorld('moteNative', {
  fixturePageUrl: ipcRenderer.sendSync('mote-native:page-url'),
  browser: { create: (...args) => ipcRenderer.invoke('mote-native:browser:create', ...args) }
})
contextBridge.exposeInMainWorld('streamProbe', {
  input: value => ipcRenderer.invoke('shared-native-stream:input', value)
})
