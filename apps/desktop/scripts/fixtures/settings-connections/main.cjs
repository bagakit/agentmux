const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const { nativeRendererInput } = require('./native-input.cjs')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.equal(section, 'mobile')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned Device Connections Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Edit',submenu:[{role:'copy'},{role:'selectAll'}]}]))
const result = { completed:false, section, frames:[], supplementalFrames:[], interactions:[], console:[],
  boundary:'Actual SettingsPanel and original DeviceManagementSettings, full production CSS and native Renderer input in an owned private Electron process. Controlled exact device DTO and public offer link; no real authorization, user App, Runtime, Run, installation or Main durability claim.' }
let win
app.whenReady().then(async()=>{
  try {
    win=new BrowserWindow({width:1480,height:980,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
    win.webContents.on('console-message',(_event,...details)=>result.console.push(details))
    await win.loadFile(html)
    const pane='[data-settings-pane="mobile"]'
    const {read,until,settle,click}=nativeRendererInput(win,result.interactions,pane)
    await until('window.connectionsProof?.ready&&document.querySelector(".settings-page")')
    const stableCode = async () => {
      await until(`document.querySelector('.phone-link-card')?.dataset.state==='current'`)
      await read(`Promise.all([...document.querySelectorAll('.phone-link-card__frame')].flatMap(n=>n.getAnimations({subtree:true})).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`)
      await settle()
      await until(`(()=>{const n=document.querySelector('.phone-link-card__frame');return !!n&&getComputedStyle(n).opacity==='1'&&n.getAnimations().every(a=>a.playState==='finished')})()`)
    }
    const networkGeometry = async () => {
      const facts = await read(`(()=>{const rect=n=>n?n.getBoundingClientRect().toJSON():null;return [...document.querySelectorAll('.phone-network-choice > button')].map(n=>({box:rect(n),label:rect(n.querySelector('strong')),address:rect(n.querySelector('small')),badge:rect(n.querySelector('.phone-network-choice__badge')),text:n.textContent}))})()`)
      const overlaps = (a,b) => a&&b&&a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5
      assert.ok(facts.length>1,'Actual multi-network controls remain present')
      for(const fact of facts){
        assert.equal(Boolean(overlaps(fact.label,fact.badge)||overlaps(fact.address,fact.badge)),false,'Network badge does not cover its name or complete address')
        assert.ok(fact.label.left>=fact.box.left&&fact.label.right<=fact.box.right+.5&&fact.address.right<=fact.box.right+.5,'Original network text remains inside its choice')
      }
      return facts
    }
    const supplemental = async (scenario,width,theme,facts) => {
      await settle()
      const image=`${scenario}-${width}-${theme}.png`,png=(await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence,image),png)
      result.supplementalFrames.push({section,width,theme,scenario,image,pngPixels:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},facts})
    }
    await read(`window.__connectionsTrustedEvents=[];for(const type of ['click','keydown','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,target:event.target.tagName}),true)`)
    for(const width of [320,640,1480])for(const theme of ['light','dark']){
      win.setContentSize(width,980)
      await read('window.connectionsProof.reset()')
      await read('window.connectionsProof.reopen("mobile")')
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      await until(`innerWidth===${width}&&document.documentElement.dataset.appearance===${JSON.stringify(theme)}&&document.querySelector(${JSON.stringify(pane)})?.textContent.includes('Personal phone')`)
      win.showInactive();win.focus();win.webContents.focus();await until('document.hasFocus()');await settle()
      assert.equal(await read('window.connectionsProof.calls.filter(call=>call.kind==="device.link").length'),0,'Entering Devices does not create a link or change authorization')
      await click(`js:[...document.querySelectorAll('${pane} button')].find(node=>node.textContent.includes('Copy connection link'))`)
      await until(`document.querySelector(${JSON.stringify(pane+' [aria-label="Phone connection link"]')})`)
      assert.equal(await read('window.connectionsProof.calls.filter(call=>call.kind==="device.link").length'),1)
      assert.equal(await read(`document.querySelector(${JSON.stringify(pane+' [aria-label="Phone connection link"]')}).value`),'http://192.168.1.20:8443/#AgControlledPreview')
      assert.equal(await read('window.connectionsProof.calls.some(call=>/revoke|approve|reject/.test(call.kind))'),false)
      await stableCode()
      const networks=await networkGeometry()
      const facts=await read(`(()=>{const p=document.querySelector(${JSON.stringify(pane)}),visible=n=>n.isConnected&&n.checkVisibility();return{theme:document.documentElement.dataset.appearance,originalDevice:p.querySelectorAll('.device-management').length,closeVisible:visible(document.querySelector('[aria-label="Close settings"]')),errors:window.connectionsProof.errors.slice(),calls:window.connectionsProof.calls.slice()}})()`)
      facts.networks=networks
      assert.equal(facts.originalDevice,1);assert.equal(facts.closeVisible,true);assert.deepEqual(facts.errors,[])
      const image=`devices-${width}-${theme}.png`,png=(await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence,image),png)
      result.frames.push({section,width,theme,image,pngPixels:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},facts})
      await click('[aria-label="Close settings"]');await until('!document.querySelector(".settings-page")')
    }
    for(const width of [320,640])for(const theme of ['light','dark']){
      win.setContentSize(width,980)
      await read('window.connectionsProof.reset()')
      await read('window.connectionsProof.reopen("toolkit")')
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      await until(`!!document.querySelector('[data-tool-id="builtin:mobile-connection"]')`)
      await click('[data-tool-id="builtin:mobile-connection"]')
      await until(`document.querySelector('[aria-label="Phone connection tool"]')?.checkVisibility()`)
      const settings=await read(`(()=>{const tool=document.querySelector('[aria-label="Phone connection tool"]'),button=tool.querySelector('[data-phone-settings]'),r=button.getBoundingClientRect();return {label:button.textContent,visible:button.checkVisibility(),insideHeader:!!button.closest('.toolkit-settings__identity'),bounds:r.toJSON()}})()`)
      assert.ok(settings.visible&&settings.insideHeader&&settings.bounds.right<=width,'Direct phone settings action is visible in the actual tool identity header')
      await supplemental('phone-tool-settings',width,theme,settings)
      await click('[aria-label="Phone connection tool"] [data-phone-settings]')
      await until(`document.querySelector('[data-settings-pane="mobile"] .device-management')?.checkVisibility()`)
      result.interactions.push({kind:'phone-tool-settings-direct',width,theme,originalTarget:'mobile'})
      await read('window.connectionsProof.onlineDevices(true)')
      await read('window.connectionsProof.reopen("mobile")')
      await until(`document.querySelector('.device-management__count')?.textContent.includes('1 online')`)
      await click('[data-device-records] > summary')
      await click('[data-device-record="controlled-phone"] > summary')
      await read(`document.querySelector('[data-device-record="controlled-phone"]').scrollIntoView({block:'start'})`)
      await settle()
      const device=await read(`(()=>{const n=document.querySelector('[data-device-record="controlled-phone"]'),r=n.getBoundingClientRect();return {open:n.open,listOpen:n.closest('[data-device-records]').open,online:n.querySelector('.phone-device-presence')?.dataset.online,text:n.textContent,fingerprint:n.querySelector('.device-management__identity code')?.textContent,box:r.toJSON(),overflow:n.scrollWidth>n.clientWidth}})()`)
      assert.ok(device.open&&device.listOpen&&device.online==='true','Original online device and both disclosure owners remain visible')
      assert.equal(device.fingerprint,'sha256:'+'a'.repeat(64));assert.equal(device.overflow,false,'Long fingerprint, IPv6 and browser declaration do not widen the original device record')
      assert.equal(await read('window.connectionsProof.calls.some(call=>/revoke|approve|reject/.test(call.kind))'),false,'Disclosing the original online device changes no authorization')
      await supplemental('online-device-details',width,theme,device)
      await click('[aria-label="Close settings"]')
    }
    assert.equal(result.frames.length,6);assert.equal(result.supplementalFrames.length,8);result.completed=true
  }catch(error){
    result.failure={name:error.name,message:error.message,stack:error.stack}
    if(win&&!win.isDestroyed())fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())
  }finally{
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.completed?0:1)
  }
})
