const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('settingsProof', {
  get: () => ipcRenderer.invoke('proof:config:get'),
  save: (next, expected) => ipcRenderer.invoke('proof:config:save', next, expected),
  onChange: (listener) => {
    const receive = (_event, value) => listener(value)
    ipcRenderer.on('proof:config:changed', receive)
    return () => ipcRenderer.removeListener('proof:config:changed', receive)
  },
  external: (id, patch) => ipcRenderer.invoke('proof:config:external', id, patch),
  hold: () => ipcRenderer.invoke('proof:config:hold'),
  release: () => ipcRenderer.invoke('proof:config:release'),
  editorNavigation: {
    updateTool: (...args) => ipcRenderer.invoke('proof:toolkit:update', ...args),
    readProfiles: () => ipcRenderer.invoke('proof:profiles:read'),
    saveProxy: (...args) => ipcRenderer.invoke('proof:proxy:save', ...args)
  }
})
