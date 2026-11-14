const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('privateWorkbenchDocument', {
  read: () => ipcRenderer.invoke('private-workbench:read'),
  write: value => ipcRenderer.invoke('private-workbench:write', value),
  import: value => ipcRenderer.invoke('private-workbench:import', value)
})
