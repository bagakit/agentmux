import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('inlineHtmlFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
