const { contextBridge, ipcRenderer } = require('electron')
const invoke = channel => (...args) => ipcRenderer.invoke('mote-paperdoll:' + channel, ...args)
contextBridge.exposeInMainWorld('motePaperdollNative', {
  bootstrap: invoke('bootstrap'), config: invoke('config'), listTopics: invoke('list'), readTopic: invoke('read'), ensureMote: invoke('ensure'),
  readMoteAvatar: invoke('read-avatar'), previewMoteAvatar: invoke('preview-avatar'), saveMoteAvatar: invoke('save-avatar'), flushStorage: invoke('flush')
})
