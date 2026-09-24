const { contextBridge, ipcRenderer } = require('electron')
const invoke = method => (...args) => ipcRenderer.invoke(`mote-native:${method}`, ...args)
const listen = channel => listener => {
  const receive = (_event, value) => listener(value)
  ipcRenderer.on(channel, receive)
  return () => ipcRenderer.off(channel, receive)
}

// This bridge is loaded only in the original isolated fixture Renderer. Main checks its exact
// WebContents/mainFrame on every request. Native pages receive no preload or Node authority.
contextBridge.exposeInMainWorld('moteNative', {
  fixturePageUrl: ipcRenderer.sendSync('mote-native:page-url'),
  browser: {
    create: invoke('browser:create'), navigate: invoke('browser:navigate'),
    back: invoke('browser:back'), forward: invoke('browser:forward'), reload: invoke('browser:reload'),
    listProfiles: invoke('browser:listProfiles'), setViewport: invoke('browser:setViewport'),
    setBounds: invoke('browser:setBounds'), release: invoke('browser:release'), restore: invoke('browser:restore'),
    close: invoke('browser:close'), cancelElementSelection: invoke('browser:cancelElementSelection'),
    setAnnotationMarkers: invoke('browser:setAnnotationMarkers'),
    onEvent: listen('agentmux:browser-event')
  },
  ui: {
    publishNativeOverlays: invoke('ui:publishNativeOverlays'),
    onNativeOverlayWarning: listen('ui:nativeOverlayWarning'),
    onNativeBrowserInput: listen('ui:nativeBrowserInput')
  }
})
