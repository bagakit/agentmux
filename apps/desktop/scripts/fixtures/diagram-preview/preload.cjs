const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('diagramHost', {
  render: request => ipcRenderer.invoke('diagram-proof:render', request),
  cancel: id => ipcRenderer.invoke('diagram-proof:cancel', id)
})
