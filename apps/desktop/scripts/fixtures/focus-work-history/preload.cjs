const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('workHistorySource', {
  facts: () => ipcRenderer.invoke('focus-work-proof:facts'),
  timeline: id => ipcRenderer.invoke('focus-work-proof:timeline', id),
  sources: () => ipcRenderer.invoke('focus-work-proof:sources'),
  historyPage: id => ipcRenderer.invoke('focus-work-proof:history-page', id)
})
