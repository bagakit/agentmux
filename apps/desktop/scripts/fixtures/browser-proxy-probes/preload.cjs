const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('profileProbe',{initial:()=>ipcRenderer.invoke('profile-probe:initial'),probeProfileNetwork:(profile,id)=>ipcRenderer.invoke('profile-probe:run',profile,id),profileNetworkHistory:(profile,id,before)=>ipcRenderer.invoke('profile-probe:history',profile,id,before)})
