import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('dragProof', {
  initial: () => ipcRenderer.invoke('drag-proof:initial'),
  save: (draft: unknown) => ipcRenderer.invoke('drag-proof:save', draft),
  run: (version: number) => ipcRenderer.invoke('drag-proof:run', version)
})
