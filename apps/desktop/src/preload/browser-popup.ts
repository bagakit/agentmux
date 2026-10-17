import { contextBridge, ipcRenderer } from 'electron'
import { BROWSER_POPUP_CHANNELS, type BrowserPopupAPI, type BrowserPopupSnapshot } from '../shared/browser-popup-navigation.js'

if (process.isMainFrame) {
  const api: BrowserPopupAPI = {
    inspect: () => ipcRenderer.invoke(BROWSER_POPUP_CHANNELS.inspect),
    command: command => ipcRenderer.invoke(BROWSER_POPUP_CHANNELS.command, command),
    onChanged: listener => {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: BrowserPopupSnapshot) => listener(snapshot)
      ipcRenderer.on(BROWSER_POPUP_CHANNELS.changed, receive)
      return () => { ipcRenderer.removeListener(BROWSER_POPUP_CHANNELS.changed, receive) }
    },
    onFocusAddress: listener => {
      const receive = () => listener()
      ipcRenderer.on(BROWSER_POPUP_CHANNELS.focusAddress, receive)
      return () => { ipcRenderer.removeListener(BROWSER_POPUP_CHANNELS.focusAddress, receive) }
    }
  }
  contextBridge.exposeInMainWorld('browserPopup', api)
}
