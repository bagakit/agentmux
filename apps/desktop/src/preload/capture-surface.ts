import { contextBridge, ipcRenderer } from 'electron'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT, type CaptureSurfaceApi, type CaptureSurfaceEvent } from '../shared/capture-surface'

if (process.isMainFrame) {
  const api: CaptureSurfaceApi = {
    load: () => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'load'),
    presented: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'presented', { requestId }),
    select: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'select', { requestId }),
    onEvent: listener => {
      const receive = (_event: Electron.IpcRendererEvent, event: CaptureSurfaceEvent) => listener(event)
      ipcRenderer.on(CAPTURE_SURFACE_EVENT, receive)
      return () => { ipcRenderer.removeListener(CAPTURE_SURFACE_EVENT, receive) }
    },
    finish: (requestId, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'finish', { requestId, image, selection }),
    pin: (requestId, operationId, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'pin', { requestId, operationId, image, selection }),
    savePng: (requestId, image) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'save-png', { requestId, image }),
    copyText: (requestId, text) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'copy-text', { requestId, text }),
    expand: (requestId, handoff) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'expand', { requestId, handoff }),
    cancel: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'cancel', { requestId })
  }
  contextBridge.exposeInMainWorld('captureSurface', api)
}
