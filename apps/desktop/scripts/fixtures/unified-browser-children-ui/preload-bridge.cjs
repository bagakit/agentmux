const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('childrenUiBoundary', { request: (operation, ...args) => ipcRenderer.invoke('children-ui:request', operation, ...args) })
