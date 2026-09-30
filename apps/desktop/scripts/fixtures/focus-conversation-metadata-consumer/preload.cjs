const { contextBridge, ipcRenderer } = require('electron')
const bridge = {
  initial: () => ipcRenderer.invoke('focus-metadata-initial'),
  historySources: () => ipcRenderer.invoke('focus-metadata-sources'),
  historyPage: reference => ipcRenderer.invoke('focus-metadata-page', reference),
  timeline: reference => ipcRenderer.invoke('focus-metadata-timeline', reference)
}
contextBridge.exposeInMainWorld('focusMetadataProof', bridge)
// Real desktop API branch with explicit isolated read-only transport.
contextBridge.exposeInMainWorld('agentmux', {
  control: {}, sessions: { ...bridge, onEvent: () => () => {} },
  workspaces: { appearance: async () => ({ kind: 'directory', icon: null }) }
})
