const { contextBridge, ipcRenderer } = require('electron')
const invoke = channel => (...args) => ipcRenderer.invoke('mote-archive:' + channel, ...args)
contextBridge.exposeInMainWorld('moteArchiveNative', {
  bootstrap: invoke('bootstrap'), config: invoke('config'),
  listTopics: invoke('list'), readTopic: invoke('read'), ensureMote: invoke('ensure'),
  setMoteArchived: invoke('set-archived'), flushStorage: invoke('flush')
})
