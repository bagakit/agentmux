// The actual product preload supplies the files bridge, including the media stream lease.
import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('mediaPlaybackFixtureBoot', ipcRenderer.sendSync('fixture:boot'))
