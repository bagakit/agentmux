const { contextBridge, ipcRenderer } = require('electron')
let loseFirstReply = true
contextBridge.exposeInMainWorld('taskProof', {
  source: () => ipcRenderer.invoke('task-proof:source'),
  state: () => ipcRenderer.invoke('task-proof:state'),
  inspect: input => ipcRenderer.invoke('task-proof:inspect', input),
  create: async input => {
    const result = await ipcRenderer.invoke('task-proof:create', input)
    if (loseFirstReply) { loseFirstReply = false; throw new Error('The import reply was not received. Check the original request before continuing.') }
    return result
  }
})
