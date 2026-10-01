import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('bookmarkFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
