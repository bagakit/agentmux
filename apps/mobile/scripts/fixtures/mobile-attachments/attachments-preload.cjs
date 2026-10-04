const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('attachmentHost', { call: (method, params) => ipcRenderer.invoke('private-file-upload', method, params) })
