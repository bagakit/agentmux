import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('isolationProof', {
  stop: (id: string) => ipcRenderer.invoke('proof:stop', id),
  returnControl: () => ipcRenderer.invoke('proof:return'),
  observe: (callback: (snapshot: unknown) => void) => { ipcRenderer.on('proof:snapshot', (_event, value) => callback(value)) }
})
