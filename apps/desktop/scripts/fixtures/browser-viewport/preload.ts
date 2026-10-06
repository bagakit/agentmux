import '../../../src/preload/index'
import { contextBridge, ipcRenderer } from 'electron'

// Product browser/ui APIs above cross the actual production preload. Only private
// fixture setup and observations use this separate, bounded test channel.
contextBridge.exposeInMainWorld('viewportNative', {
  setup: () => ipcRenderer.invoke('viewport:setup')
})
