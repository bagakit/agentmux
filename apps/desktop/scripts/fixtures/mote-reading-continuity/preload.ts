import { contextBridge, ipcRenderer } from 'electron'
import { createPreloadConversationRead } from '../../../src/preload/conversation-read'
contextBridge.exposeInMainWorld('privateReadingPort', {
  conversation: createPreloadConversationRead(ipcRenderer),
  seed: () => ipcRenderer.invoke('private-reading:seed')
})
