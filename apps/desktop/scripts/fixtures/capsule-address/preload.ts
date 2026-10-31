import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('capsuleAddressBoot', ipcRenderer.sendSync('fixture:boot'))
