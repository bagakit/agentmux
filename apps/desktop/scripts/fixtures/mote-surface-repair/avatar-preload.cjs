const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('avatarVisual',{read:ref=>ipcRenderer.invoke('fixture:read-immutable-avatar',ref)})
