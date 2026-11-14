import { contextBridge, ipcRenderer } from 'electron'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL, SYSTEM_SCREENSHOT_EDITOR_NOTICE, type SystemScreenshotEditorApi } from '../shared/system-screenshot-editor'

if (process.isMainFrame) {
  const api: SystemScreenshotEditorApi = {
    recognizeText: (requestId, image) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'recognize-text', { requestId, image }),
    load: () => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'load'),
    onNotice: listener => {
      const receive = (_event: Electron.IpcRendererEvent, message: unknown) => { if (typeof message === 'string') listener(message) }
      ipcRenderer.on(SYSTEM_SCREENSHOT_EDITOR_NOTICE, receive)
      return () => { ipcRenderer.removeListener(SYSTEM_SCREENSHOT_EDITOR_NOTICE, receive) }
    },
    finish: (requestId, operationId, image) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'finish', { requestId, operationId, image }),
    cancel: requestId => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'cancel', { requestId }),
    retake: requestId => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'retake', { requestId }),
    savePng: (requestId, image, options) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'save-png', { requestId, image, ...options }),
    pin: (requestId, operationId, image) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'pin', { requestId, operationId, image }),
    inspectPin: (requestId, operationId) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'inspect-pin', { requestId, operationId }),
    copyContext: (requestId, operationId, text) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'context', { requestId, operationId, text }),
    openOriginal: (requestId, operationId) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'open-original', { requestId, operationId }),
    saveOriginal: (requestId, operationId, document) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'save-original', { requestId, operationId, document }),
    inspectOriginal: (requestId, grantId) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'inspect-original', { requestId, grantId }),
    inspectOriginalOperation: (requestId, operationId) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'original-operation', { requestId, operationId })
  }
  contextBridge.exposeInMainWorld('screenshotEditor', api)
}
