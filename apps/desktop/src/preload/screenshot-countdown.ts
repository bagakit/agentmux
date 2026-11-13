import { contextBridge, ipcRenderer } from 'electron'
import { SCREENSHOT_COUNTDOWN_CHANNEL, SCREENSHOT_COUNTDOWN_TICK, type ScreenshotCountdownApi } from '../shared/screenshot-countdown'

if (process.isMainFrame) {
  const api: ScreenshotCountdownApi = {
    load: () => ipcRenderer.invoke(SCREENSHOT_COUNTDOWN_CHANNEL, 'load'),
    onTick: listener => {
      const receive = (_event: Electron.IpcRendererEvent, seconds: unknown) => { if (typeof seconds === 'number') listener(seconds) }
      ipcRenderer.on(SCREENSHOT_COUNTDOWN_TICK, receive)
      return () => { ipcRenderer.removeListener(SCREENSHOT_COUNTDOWN_TICK, receive) }
    },
    cancel: () => ipcRenderer.invoke(SCREENSHOT_COUNTDOWN_CHANNEL, 'cancel')
  }
  contextBridge.exposeInMainWorld('screenshotCountdown', api)
}
