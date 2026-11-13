import { contextBridge, ipcRenderer } from 'electron'
import type { BookBytesPort } from '@agentmux/editor-extensions/book-reader/protocol'

// This isolated document receives only its assigned source. It has no App API or generic IPC bridge.
const bytes: BookBytesPort = {
  read: (id, offset, length) => ipcRenderer.invoke('book-reader:read', id, offset, length),
  cancel: id => ipcRenderer.invoke('book-reader:cancel', id),
  entries: id => ipcRenderer.invoke('book-reader:entries', id),
  entry: (id, path) => ipcRenderer.invoke('book-reader:entry', id, path),
}
contextBridge.exposeInMainWorld('bookBytes', bytes)
