const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('startupProof', {
  stage: process.argv.find(argument => argument.startsWith('--startup-proof-stage='))?.split('=')[1],
  connectionProgress: process.argv.includes('--startup-proof-connection-progress'),
  onRuntime: listener => {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('startup-proof:runtime', receive)
    return () => ipcRenderer.off('startup-proof:runtime', receive)
  },
  config: () => ipcRenderer.invoke('startup-proof:config:get'),
  saveConfig: (next, expected) => ipcRenderer.invoke('startup-proof:config:save', next, expected),
  readSpatial: () => ipcRenderer.invoke('startup-proof:spatial:read'),
  commitSpatial: input => ipcRenderer.invoke('startup-proof:spatial:commit', input),
  retainLabels: values => ipcRenderer.invoke('startup-proof:spatial:retain', values),
  flush: () => ipcRenderer.invoke('startup-proof:flush'),
  onConfig: listener => {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('startup-proof:config:changed', receive)
    return () => ipcRenderer.off('startup-proof:config:changed', receive)
  },
  onSpatial: listener => {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('startup-proof:spatial:changed', receive)
    return () => ipcRenderer.off('startup-proof:spatial:changed', receive)
  }
})
