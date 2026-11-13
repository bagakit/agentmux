const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('taskFiles',{initial:()=>ipcRenderer.invoke('task-files:initial'),save:draft=>ipcRenderer.invoke('task-files:save',draft),publish:draft=>ipcRenderer.invoke('task-files:publish',draft),run:input=>ipcRenderer.invoke('task-files:run',input)})
