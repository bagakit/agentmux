const { contextBridge, ipcRenderer } = require('electron')
let observationId = 0
const bridge = {
  initial: () => ipcRenderer.invoke('focus-proof-initial'),
  historyPage: (reference, options) => ipcRenderer.invoke('focus-proof-page', reference, options),
  historySources: () => ipcRenderer.invoke('focus-proof-sources'),
  observe: async (reference, callback) => {
    const id = `private-${++observationId}`, channel = `focus-proof-observation:${id}`
    const listener = (_, observation) => callback(observation)
    ipcRenderer.on(channel, listener)
    const source = await ipcRenderer.invoke('focus-proof-observe', reference, id)
    return { source, dispose() { ipcRenderer.removeListener(channel, listener); ipcRenderer.send('focus-proof-unobserve', id) } }
  },
  burst: () => ipcRenderer.invoke('focus-proof-burst'),
  pause: () => ipcRenderer.invoke('focus-proof-pause'),
  release: () => ipcRenderer.invoke('focus-proof-release')
}
contextBridge.exposeInMainWorld('focusObservationProof', bridge)
// The ordinary desktop API branch is used; only read-only proof transports are registered.
contextBridge.exposeInMainWorld('agentmux', {
  control: {},
  sessions: { historyPage: bridge.historyPage, historySources: bridge.historySources, onEvent: () => () => {} },
  workspaces: { appearance: async () => ({ kind: 'directory', icon: null }) }
})
