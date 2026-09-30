const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('moteIdentityNative', {
  bootstrap: () => ipcRenderer.invoke('mote-identity:bootstrap'),
  config: () => ipcRenderer.invoke('mote-identity:config'),
  listTopics: id => ipcRenderer.invoke('mote-identity:list', id),
  readTopic: (workspace, topic) => ipcRenderer.invoke('mote-identity:read', workspace, topic),
  ensureMote: (workspace, topic) => ipcRenderer.invoke('mote-identity:ensure', workspace, topic),
  previewMoteAvatar: (...args) => ipcRenderer.invoke('mote-identity:preview-avatar', ...args),
  saveMoteAvatar: (...args) => ipcRenderer.invoke('mote-identity:save-avatar', ...args),
  readMoteAvatar: (...args) => ipcRenderer.invoke('mote-identity:read-avatar', ...args),
  requestStorageFlush: () => ipcRenderer.invoke('mote-identity:flush')
})
