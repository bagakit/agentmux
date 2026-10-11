import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('motionBridge', { publish: (value: unknown) => ipcRenderer.invoke('motion:publish', value) })
