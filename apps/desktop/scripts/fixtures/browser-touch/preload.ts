import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('touchProof', {
  current: () => ipcRenderer.invoke('touch-proof:current'),
  initial: () => ipcRenderer.invoke('touch-proof:initial'),
  save: (draft: unknown) => ipcRenderer.invoke('touch-proof:save', draft),
  run: (version: number) => ipcRenderer.invoke('touch-proof:run', version)
})
