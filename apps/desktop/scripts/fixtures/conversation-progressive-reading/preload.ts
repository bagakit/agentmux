import { contextBridge, ipcRenderer } from 'electron'
import { createPreloadConversationRead } from '../../../src/preload/conversation-read'

contextBridge.exposeInMainWorld('readingBoundary', {
  request: (operation: string, ...args: unknown[]) => ipcRenderer.invoke('reading-proof:request', operation, ...args),
  conversation: createPreloadConversationRead(ipcRenderer),
  onSpatial: (listener: (state: unknown) => void) => {
    const relay = (_event: unknown, state: unknown) => listener(state)
    ipcRenderer.on('reading-proof:spatial', relay)
    return () => ipcRenderer.removeListener('reading-proof:spatial', relay)
  },
  onEvent: (listener: (event: unknown) => void) => {
    const relay = (_event: unknown, fact: unknown) => listener(fact)
    ipcRenderer.on('agentmux:session-event', relay)
    return () => ipcRenderer.removeListener('agentmux:session-event', relay)
  }
})
