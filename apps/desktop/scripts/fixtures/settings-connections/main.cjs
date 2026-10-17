const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const { nativeRendererInput } = require('./native-input.cjs')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.equal(section, 'amux-conversation')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned Device Connections Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Edit',submenu:[{role:'copy'},{role:'selectAll'}]}]))
const result = { completed:false, section, frames:[], interactions:[], console:[],
  boundary:'Actual SettingsPanel and original DeviceManagementSettings, full production CSS and native Renderer input in an owned private Electron process. Controlled exact device DTO and public offer link; no real authorization, user App, Runtime, Run, installation or Main durability claim.' }
let win
app.whenReady().then(async()=>{
  try {
    win=new BrowserWindow({width:1480,height:980,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
    win.webContents.on('console-message',(_event,...details)=>result.console.push(details))
    await win.loadFile(html)
    const pane='[data-settings-pane="amux-conversation"]'
    const {read,until,settle,click}=nativeRendererInput(win,result.interactions,pane)
    await until('window.connectionsProof?.ready&&document.querySelector(".settings-page")')
    await read(`window.__connectionsTrustedEvents=[];for(const type of ['click','keydown','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,target:event.target.tagName}),true)`)
    for(const width of [320,640,1480])for(const theme of ['light','dark']){
      win.setContentSize(width,980)
      await read('window.connectionsProof.reset()')
      await read('window.connectionsProof.reopen("amux-conversation")')
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      await until(`innerWidth===${width}&&document.documentElement.dataset.appearance===${JSON.stringify(theme)}&&document.querySelector(${JSON.stringify(pane)})?.textContent.includes('Personal phone')`)
      win.showInactive();win.focus();win.webContents.focus();await until('document.hasFocus()');await settle()
      assert.equal(await read('window.connectionsProof.calls.filter(call=>call.kind==="device.link").length'),0,'Entering Devices does not create a link or change authorization')
      await click(`js:[...document.querySelectorAll('${pane} button')].find(node=>node.textContent.includes('Copy connection link'))`)
      await until(`document.querySelector(${JSON.stringify(pane+' [aria-label="Phone connection link"]')})`)
      assert.equal(await read('window.connectionsProof.calls.filter(call=>call.kind==="device.link").length'),1)
      assert.equal(await read(`document.querySelector(${JSON.stringify(pane+' [aria-label="Phone connection link"]')}).value`),'http://192.168.1.20:8443/#offer=controlled-preview')
      assert.equal(await read('window.connectionsProof.calls.some(call=>/revoke|approve|reject/.test(call.kind))'),false)
      const facts=await read(`(()=>{const p=document.querySelector(${JSON.stringify(pane)}),visible=n=>n.isConnected&&n.checkVisibility();return{theme:document.documentElement.dataset.appearance,originalDevice:p.querySelectorAll('.device-management').length,closeVisible:visible(document.querySelector('[aria-label="Close settings"]')),errors:window.connectionsProof.errors.slice(),calls:window.connectionsProof.calls.slice()}})()`)
      assert.equal(facts.originalDevice,1);assert.equal(facts.closeVisible,true);assert.deepEqual(facts.errors,[])
      const image=`devices-${width}-${theme}.png`,png=(await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence,image),png)
      result.frames.push({section,width,theme,image,pngPixels:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},facts})
      await click('[aria-label="Close settings"]');await until('!document.querySelector(".settings-page")')
    }
    assert.equal(result.frames.length,6);result.completed=true
  }catch(error){
    result.failure={name:error.name,message:error.message,stack:error.stack}
    if(win&&!win.isDestroyed())fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())
  }finally{
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.completed?0:1)
  }
})
