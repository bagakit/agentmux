const { contextBridge, ipcRenderer } = require('electron')
const callbacks = new Set()
ipcRenderer.on('renderer-worker-memory-fixture-command', (_event, command) => {
  for (const callback of callbacks) callback(command)
})
contextBridge.exposeInMainWorld('workerMemoryFixture', {
  report: packet => { ipcRenderer.send('renderer-worker-memory-fixture-report', packet) },
  onCommand: callback => { callbacks.add(callback) }
})
