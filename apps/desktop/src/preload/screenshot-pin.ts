import { contextBridge, ipcRenderer } from 'electron'
import { SCREENSHOT_PIN_CHANNEL, type ScreenshotPinApi } from '../shared/screenshot-pin'

if (process.isMainFrame) {
  const api: ScreenshotPinApi = {
    load: () => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'load'),
    copy: (pinId, operationId) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'copy', { pinId, operationId }),
    save: (pinId, operationId) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'save', { pinId, operationId }),
    close: pinId => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'close', { pinId }),
    layout: (pinId, chromeHeight) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'layout', { pinId, chromeHeight })
  }
  contextBridge.exposeInMainWorld('screenshotPin', api)
}
