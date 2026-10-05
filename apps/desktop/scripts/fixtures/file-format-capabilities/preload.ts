import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('filePreviewFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
