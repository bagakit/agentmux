import { contextBridge, ipcRenderer } from 'electron'
import './capture-sequence'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT, type CaptureSurfaceApi, type CaptureSurfaceEvent, type CaptureSurfaceInput } from '../shared/capture-surface'

if (process.isMainFrame) {
  type Snapshot = Extract<CaptureSurfaceEvent, { kind: 'snapshot' }>
  const listeners = new Set<(event: CaptureSurfaceEvent) => void>()
  let latest: CaptureSurfaceInput | null = null, deferred: Snapshot | null = null, unheard: Snapshot | null = null
  const merge = (input: CaptureSurfaceInput, event: Snapshot): CaptureSurfaceInput => input.requestId !== event.requestId || event.revision <= input.revision ? input
    : { ...input, revision: event.revision, backgrounds: { ...input.backgrounds, [event.background]: event.frame } }
  const receive = (_event: Electron.IpcRendererEvent, event: CaptureSurfaceEvent) => {
    if (event.kind !== 'snapshot') { for (const listener of listeners) listener(event); return }
    const currentRevision = latest?.requestId === event.requestId ? latest.revision : deferred?.requestId === event.requestId ? deferred.revision : 0
    if (event.revision <= currentRevision) return
    deferred = event
    if (latest) latest = merge(latest, event)
    void ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'frame-ack', { requestId: event.requestId, revision: event.revision }).catch(() => {})
    if (listeners.size) for (const listener of listeners) listener(event)
    else unheard = event
  }
  ipcRenderer.on(CAPTURE_SURFACE_EVENT, receive)
  const api: CaptureSurfaceApi = {
    load: async () => {
      const loaded = await ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'load') as CaptureSurfaceInput
      latest = deferred ? merge(loaded, deferred) : loaded
      return latest
    },
    presented: (requestId, background, timing) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'presented', { requestId, background, timing }),
    select: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'select', { requestId }),
    switchBackground: (requestId, background) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'switch-background', { requestId, background }),
    onEvent: listener => {
      listeners.add(listener)
      if (unheard) {
        const event = unheard
        unheard = null
        queueMicrotask(() => { if (listeners.has(listener)) listener(event) })
      }
      return () => { listeners.delete(listener) }
    },
    finish: (requestId, background, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'finish', { requestId, background, image, selection }),
    pin: (requestId, background, operationId, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'pin', { requestId, background, operationId, image, selection }),
    savePng: (requestId, background, image, selection) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'save-png', { requestId, background, image, selection }),
    copyText: (requestId, text) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'copy-text', { requestId, text }),
    expand: (requestId, background, handoff) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'expand', { requestId, background, handoff }),
    source: (requestId, mode) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'source', { requestId, mode }),
    sequence: (requestId, background, image, selection, mode, toolbar) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'sequence', { requestId, background, image, selection, mode, toolbar }),
    liveInput: (requestId, toolbar) => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'live-input', { requestId, toolbar }),
    cancel: requestId => ipcRenderer.invoke(CAPTURE_SURFACE_CHANNEL, 'cancel', { requestId })
  }
  contextBridge.exposeInMainWorld('captureSurface', api)
}
