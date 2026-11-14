import { contextBridge, ipcRenderer } from 'electron'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT, type CaptureSurfaceApi, type CaptureSurfaceEvent } from '../shared/capture-surface'

if (process.isMainFrame) {
  const api: CaptureSurfaceApi = {
    load: () => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'load'),
    presented: (requestId, background) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'presented', { requestId, background }),
    select: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'select', { requestId }),
    switchBackground: (requestId, background) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'switch-background', { requestId, background }),
    onEvent: listener => {
      const receive = (_event: Electron.IpcRendererEvent, event: CaptureSurfaceEvent) => listener(event)
      ipcRenderer.on(CAPTURE_SURFACE_EVENT, receive)
      return () => { ipcRenderer.removeListener(CAPTURE_SURFACE_EVENT, receive) }
    },
    finish: (requestId, background, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'finish', { requestId, background, image, selection }),
    pin: (requestId, background, operationId, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'pin', { requestId, background, operationId, image, selection }),
    savePng: (requestId, background, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'save-png', { requestId, background, image, selection }),
    copyText: (requestId, text) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'copy-text', { requestId, text }),
    expand: (requestId, background, handoff) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'expand', { requestId, background, handoff }),
    cancel: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'cancel', { requestId })
  }
  contextBridge.exposeInMainWorld('captureSurface', api)
}
