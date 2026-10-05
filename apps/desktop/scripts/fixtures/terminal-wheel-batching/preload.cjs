const { contextBridge, ipcRenderer } = require('electron')
// Use the same channels and byte-preserving structured clone as the product preload.
contextBridge.exposeInMainWorld('wheelNative', {
  setup: () => ipcRenderer.invoke('wheel-proof:setup'),
  configure: options => ipcRenderer.invoke('wheel-proof:configure', options),
  drain: () => ipcRenderer.invoke('wheel-proof:drain')
})
contextBridge.exposeInMainWorld('agentmux', {
  continuousProgress: { list: async () => [], onChanged: () => () => {} },
  schedule: { list: async () => ({ schedules: [] }), onChanged: () => () => {} },
  control: {}, system: { platform: process.platform },
  ui: { requestStorageFlush: async () => {}, setAgentAttentionCount: async () => false },
  sessions: {
    attach: (...args) => ipcRenderer.invoke('sessions:attach', ...args),
    resize: (...args) => ipcRenderer.invoke('sessions:resize', ...args),
    detach: (...args) => ipcRenderer.invoke('sessions:detach', ...args),
    acknowledge: async () => {}, redraw: async () => true,
    replay: (...args) => ipcRenderer.invoke('sessions:replay', ...args),
    write: (...args) => ipcRenderer.invoke('sessions:write', ...args),
    paste: (...args) => ipcRenderer.invoke('sessions:paste', ...args),
    historyPage: async () => ({ items: [], nextCursor: null }),
    onEvent: listener => {
      const accept = (_event, value) => listener(value)
      ipcRenderer.on('agentmux:session-event', accept)
      return () => ipcRenderer.removeListener('agentmux:session-event', accept)
    }
  }
})
