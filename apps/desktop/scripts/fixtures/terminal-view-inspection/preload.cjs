const { contextBridge, ipcRenderer } = require('electron')
require(process.env.AGENTMUX_PROBE_PRODUCT_PRELOAD)
contextBridge.exposeInMainWorld('inspectionFixture', {
  setup: (input) => ipcRenderer.invoke('inspection-fixture:setup', input)
})
