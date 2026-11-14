const {contextBridge,ipcRenderer}=require('electron')
const listen=(channel,listener)=>{const relay=(_event,value)=>listener(value);ipcRenderer.on(channel,relay);return()=>ipcRenderer.removeListener(channel,relay)}
contextBridge.exposeInMainWorld('nativeWindowProof',{
 data:()=>ipcRenderer.invoke('native-window:data'),
 browser:(method,...args)=>ipcRenderer.invoke('native-window:browser',method,args),
 windows:{call:(method,input)=>ipcRenderer.invoke('native-window:call',method,input),ready:()=>ipcRenderer.invoke('native-window:ready'),respond:value=>ipcRenderer.send('native-window:response',value),onRequest:listener=>listen('workbenchWindows:request',listener),onChanged:listener=>listen('workbenchWindows:changed',listener)},
 onBrowser:listener=>listen('agentmux:browser-event',listener),onPresentation:listener=>listen('agentmux:browser-presentation-event',listener),
 inspect:(...args)=>ipcRenderer.invoke('native-window:inspect',...args),fill:()=>ipcRenderer.invoke('native-window:fill'),done:result=>ipcRenderer.invoke('native-window:done',result)
})
