const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('identityProof', {
  get: () => ipcRenderer.invoke('identity:config:get'),
  add: (id, value) => ipcRenderer.invoke('identity:config:add', id, value),
  update: (id, changes, expected) => ipcRenderer.invoke('identity:config:update', id, changes, expected),
  remove: (id, expected) => ipcRenderer.invoke('identity:config:remove', id, expected),
  readTool: id => ipcRenderer.invoke('identity:config:tool', id),
  savePerformance: (value, expected) => ipcRenderer.invoke('identity:config:performance', value, expected),
  onChange: listener => {
    const read = (_event, config) => listener(config)
    ipcRenderer.on('identity:config:changed', read)
    return () => ipcRenderer.off('identity:config:changed', read)
  }
})
