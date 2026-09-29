// The actual product preload supplies files:read/readPreview/write/observe, not a second byte reader.
import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('filePreviewFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
