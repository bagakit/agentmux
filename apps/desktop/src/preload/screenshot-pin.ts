import { contextBridge, ipcRenderer } from 'electron'
import { SCREENSHOT_PIN_CHANNEL, type ScreenshotPinApi } from '../shared/screenshot-pin'

if (process.isMainFrame) {
  const api: ScreenshotPinApi = {
    load: () => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'load'),
    copy: (pinId, operationId) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'copy', { pinId, operationId }),
    save: (pinId, operationId, options) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'save', { pinId, operationId, ...options }),
    close: pinId => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'close', { pinId }),
    zoom: (pinId, factor, point) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'zoom', { pinId, factor, point }),
    move: (pinId, position) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'move', { pinId, position }),
    opacity: (pinId, opacity) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'opacity', { pinId, opacity }),
    clickThrough: (pinId, enabled) => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'click-through', { pinId, enabled }),
    drag: pinId => ipcRenderer.invoke(SCREENSHOT_PIN_CHANNEL, 'drag', { pinId })
  }
  contextBridge.exposeInMainWorld('screenshotPin', api)
}
