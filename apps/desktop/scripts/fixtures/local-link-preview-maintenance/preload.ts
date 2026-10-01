import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('previewFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
