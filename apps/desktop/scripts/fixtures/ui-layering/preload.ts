import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('layeringBridge', {
  initialZoom: 1,
  publish: (regions: unknown) => ipcRenderer.invoke('layering:publish', regions),
  visibility: () => ipcRenderer.invoke('layering:visibility'),
  onVisibility: (listener: (value: unknown) => void) => { const handler = (_event: unknown, value: unknown) => listener(value); ipcRenderer.on('layering:visibility', handler); return () => ipcRenderer.off('layering:visibility', handler) },
  onWarning: (listener: (message: string, modalId?: string) => void) => { const handler = (_event: unknown, value: { message: string; modalId?: string }) => listener(value.message, value.modalId); ipcRenderer.on('layering:warning', handler); return () => ipcRenderer.off('layering:warning', handler) },
  onInput: (listener: (value: unknown) => void) => { const handler = (_event: unknown, value: unknown) => listener(value); ipcRenderer.on('layering:input', handler); return () => ipcRenderer.off('layering:input', handler) }
})
