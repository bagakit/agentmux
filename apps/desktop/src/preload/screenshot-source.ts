import { contextBridge, ipcRenderer } from 'electron'
import { SCREENSHOT_SOURCE_CHANNEL, type ScreenshotSourceApi } from '../shared/screenshot-source'
if (process.isMainFrame) {
  const api: ScreenshotSourceApi = {
    load: () => ipcRenderer.invoke(SCREENSHOT_SOURCE_CHANNEL, 'load'),
    list: requestId => ipcRenderer.invoke(SCREENSHOT_SOURCE_CHANNEL, 'list', { requestId }),
    windows: (requestId, key) => ipcRenderer.invoke(SCREENSHOT_SOURCE_CHANNEL, 'windows', { requestId, key }),
    thumbnail: (requestId, key) => ipcRenderer.invoke(SCREENSHOT_SOURCE_CHANNEL, 'thumbnail', { requestId, key }),
    select: (requestId, key) => ipcRenderer.invoke(SCREENSHOT_SOURCE_CHANNEL, 'select', { requestId, key }),
    cancel: requestId => ipcRenderer.invoke(SCREENSHOT_SOURCE_CHANNEL, 'cancel', { requestId })
  }
  contextBridge.exposeInMainWorld('screenshotSources', api)
}
