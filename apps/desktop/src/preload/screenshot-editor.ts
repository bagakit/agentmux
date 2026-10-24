import { contextBridge, ipcRenderer } from 'electron'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL, type SystemScreenshotEditorApi } from '../shared/system-screenshot-editor'

if (process.isMainFrame) {
  const api: SystemScreenshotEditorApi = {
    load: () => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'load'),
    finish: (requestId, operationId, image) => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'finish', { requestId, operationId, image }),
    cancel: requestId => ipcRenderer.invoke(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, 'cancel', { requestId })
  }
  contextBridge.exposeInMainWorld('screenshotEditor', api)
}
