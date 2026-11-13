import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('fileSourceFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
