const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const [html, profile, evidence, phase, nativeModule, workspacePath, httpUrl, localUrl] = process.argv.slice(2)
// This private proof uses Chromium software painting; it does not change the installed App.
app.disableHardwareAcceleration()
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {}, workspaces: [{ id: 'bookmark-private', name: 'Bookmarks', hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: false, screenshot: false, devTools: false, viewport: false, saveBookmark: true, more: true } } }
let win, files, browsers, profiles, nativeChrome
const observed = new Map(), reads = [], writes = [], frames = []
const report = { schema: 'agentmux.bookmark-native-process.v1', passed: false, phase, pid: process.pid, frames, reads, writes, pageFacts: [], userRunTouched: false, consoleMessages: [] }
const stage = name => { report.driverStage=name;console.error('PRIVATE_DRIVER '+name) }
const evaluate = async code => {
  let timer
  let reply
  try{reply=await Promise.race([win.webContents.debugger.sendCommand('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true,userGesture:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Private Renderer evaluation timed out at '+report.driverStage+': '+code.slice(0,160))),5000)})])}finally{clearTimeout(timer)}
  if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description??reply.exceptionDetails.text)
  return reply.result.value
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(code) { const until = Date.now() + 15000; while (Date.now() < until) { if (await evaluate(code)) return; await pause(50) } assert.fail('Missing Renderer fact: ' + code) }
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await pause(70) }
async function click(code) {
  await evaluate(`${code}.scrollIntoView({block:'nearest'})`); await paint()
  const p = await evaluate(`(()=>{const e=${code};if(!e)throw Error('Missing control');const b=e.getBoundingClientRect();if(!b.width||!b.height)throw Error('Hidden control');return{x:b.x+b.width/2,y:b.y+b.height/2}})()`)
  for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
  await paint()
}
async function frame(name) {
  stage('frame:'+name)
  await paint();await nativeChrome.refresh();await paint()
  const root=await win.webContents.capturePage(),rootFile=name+'-root.png',size=root.getSize(),scale=size.width/win.getContentBounds().width
  await fs.writeFile(path.join(evidence,rootFile),root.toPNG())
  const bitmap=Buffer.from(root.toBitmap()),layers=[]
  assert.equal(bitmap.length,size.width*size.height*4)
  for(const view of win.contentView.children) {
    if(view.webContents===win.webContents||!view.getVisible()||view.webContents.isDestroyed())continue
    const bounds=view.getBounds();if(!bounds.width||!bounds.height)continue
    const owner=Object.values((await evaluate('bookmarkProbe.facts()')).surfaces).filter(r=>r.kind==='browser').map(r=>browsers.nativeOwner(r.browserId)).find(owner=>owner?.view===view)
    const raw=await view.webContents.capturePage(),file=name+'-native-'+layers.length+'.png'
    await fs.writeFile(path.join(evidence,file),raw.toPNG())
    const width=Math.round(bounds.width*scale),height=Math.round(bounds.height*scale),pixels=raw.resize({width,height}).toBitmap()
    assert.equal(pixels.length,width*height*4)
    const x=Math.round(bounds.x*scale),y=Math.round(bounds.y*scale)
    for(let row=0;row<height;row++)for(let col=0;col<width;col++) {
      if(x+col<0||y+row<0||x+col>=size.width||y+row>=size.height)continue
      const at=(row*width+col)*4,to=((y+row)*size.width+x+col)*4,alpha=pixels[at+3]/255
      for(let channel=0;channel<3;channel++)bitmap[to+channel]=Math.min(255,Math.round(pixels[at+channel]+bitmap[to+channel]*(1-alpha)))
      bitmap[to+3]=255
    }
    layers.push({file,bounds,visible:view.getVisible(),kind:owner?'browser':'native-chrome',browserId:owner?.browserId??null,url:view.webContents.getURL(),pixelSize:raw.getSize()})
  }
  const file=name+'.png';await fs.writeFile(path.join(evidence,file),nativeImage.createFromBitmap(bitmap,{width:size.width,height:size.height}).toPNG())
  frames.push({name,file,root:{file:rootFile,pixelSize:size},layers,method:'Actual Renderer root plus actual visible native child captures in contentView order and native bounds; native-chrome pixels come from the existing production overlay owner. This is an explicitly composed workface, not an OS screenshot.'})
}
const tree = name => `document.querySelector('[data-tree-path='+${JSON.stringify(JSON.stringify(name))}+']')`
const activeBrowser = `(()=>{const s=bookmarkProbe.facts();const l=s.layouts[bookmarkProbe.workspaceId];const g=l.groups.find(g=>g.id===l.activeGroupId);const t=s.tabs[g.activeTabId];return Object.values(t.regions).find(r=>r.kind==='browser')})()`
const browserControl = label => `(()=>{const b=${activeBrowser};return document.querySelector('[data-workbench-region-id="'+b.regionId+'"] button[aria-label=${JSON.stringify(label)}]')})()`
async function bookmarkTab(origin) { return evaluate(`Object.values(bookmarkProbe.facts().tabs).find(t=>Object.values(t.regions).some(r=>r.kind==='browser'&&r.bookmarkOrigin?.path===${JSON.stringify(origin)}))`) }
async function page(expected, name) {
  stage('page:'+name)
  await wait(`${activeBrowser}?.url===${JSON.stringify(expected)}`)
  let owner; const until=Date.now()+15000
  while(Date.now()<until) { const id=await evaluate(`${activeBrowser}.browserId`); owner=browsers.nativeOwner(id); if(owner&&!owner.view.webContents.isLoading())break; await pause(50) }
  assert.ok(owner,'Real BrowserViewManager has a visible native page owner')
  const facts=await owner.view.webContents.executeJavaScript(`({href:location.href,title:document.title,heading:document.querySelector('h1')?.textContent,node:typeof require,bridge:typeof window.agentmux})`)
  assert.equal(facts.href,expected);assert.ok(facts.heading);assert.equal(facts.node,'undefined');assert.equal(facts.bridge,'undefined')
  const neighbor=await evaluate(`(()=>{const s=bookmarkProbe.facts(),l=s.layouts[bookmarkProbe.workspaceId],g=l.groups.find(g=>g.id===l.activeGroupId);return Object.values(s.tabs[g.activeTabId].regions).find(r=>r.kind==='file'&&r.path==='notes.md')})()`)
  if(neighbor)await wait(`(()=>{const text=document.querySelector('[data-workbench-region-id="'+${JSON.stringify(neighbor.regionId)}+'"] .monaco-editor .view-lines')?.textContent??'';return text.includes('Original')&&text.includes('neighbor')})()`)
  report.pageFacts.push({name,browserId:owner.browserId,facts});await frame(name)
}
async function menuSource(binary, name) {
  stage('menu:'+name)
  await click(browserControl('More browser tools'))
  await wait(`Boolean(document.querySelector('[role="menuitem"][aria-label="View bookmark source"]'))`)
  const source=`document.querySelector('[role="menuitem"][aria-label="View bookmark source"]')`
  const fact=await evaluate(`(()=>{const e=${source};return{disabled:e.getAttribute('aria-disabled'),title:e.title,text:e.textContent,rect:{width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}})()`)
  assert.ok(fact.rect.width>0&&fact.rect.height>0);assert.ok(fact.text.includes('View bookmark source'))
  assert.equal(fact.disabled,binary?'true':null);if(binary)assert.ok(fact.title.includes('binary'))
  report.sourceControl = [...report.sourceControl??[],{name,binary,fact}];await frame(name)
  if(binary) { await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await paint();return }
  await click(source);await wait(`Boolean(document.querySelector('.editor-header'))`)
}
async function sourceFile(name,pathName) {
  const activeRegion=`(()=>{const s=bookmarkProbe.facts(),l=s.layouts[bookmarkProbe.workspaceId],g=l.groups.find(g=>g.id===l.activeGroupId),t=s.tabs[g.activeTabId];return t.regions[t.layout.activeRegionId]})()`
  await wait(`${activeRegion}?.kind==='file'&&${activeRegion}.path===${JSON.stringify(pathName)}`)
  const text=`(()=>{const region=${activeRegion};return document.querySelector('[data-workbench-region-id="'+region.regionId+'"] .monaco-editor .view-lines')?.textContent??''})()`
  await wait(`${text}.includes('<?xml')&&${text}.includes(${JSON.stringify(httpUrl)})`)
  report.sourceFiles=[...report.sourceFiles??[],{name,path:pathName,region:await evaluate(activeRegion),visibleText:await evaluate(text)}]
  await frame(name)
}
async function capture() {
  stage('create-original-browser')
  await evaluate(`bookmarkProbe.create(${JSON.stringify(httpUrl)})`);await page(httpUrl,'http-original-browser')
  await click(browserControl('Save this page as a bookmark'))
  const saved='Research & Notes.webloc';await wait(`Boolean(${tree(saved)})`);await click(tree(saved))
  await wait(`bookmarkProbe.facts().surfaces.some(r=>r.kind==='browser'&&r.bookmarkOrigin?.path===${JSON.stringify(saved)})`)
  const tab=await bookmarkTab(saved);assert.ok(tab);await page(httpUrl,'saved-webloc-default-browser')
  await evaluate(`bookmarkProbe.split(${JSON.stringify(tab.id)},.34)`);await paint()
  assert.equal(await evaluate(`${browserControl('View bookmark source')}.getBoundingClientRect().width`),0,'Narrow toolbar hides its secondary button')
  await menuSource(false,'text-bookmark-source-menu-narrow')
  await wait(`Object.values(bookmarkProbe.facts().documents).some(d=>d.path===${JSON.stringify(saved)})`)
  assert.equal(await evaluate(`Object.values(bookmarkProbe.facts().documents).find(d=>d.path===${JSON.stringify(saved)}).content.includes(${JSON.stringify(httpUrl)})`),true)
  await sourceFile('text-bookmark-original-file-source',saved)
  await evaluate(`bookmarkProbe.activate(${JSON.stringify(tab.id)})`);await page(httpUrl,'return-original-bookmark-browser')
  await click(tree('Local.url'));await page(localUrl,'url-shortcut-local-file-browser')
  await click(tree('Numeric.webloc'));await page(httpUrl+'?a=1&b=2','numeric-xml-http-browser')
  await click(tree('Binary.webloc'));await wait(`bookmarkProbe.facts().surfaces.some(r=>r.kind==='browser'&&r.bookmarkOrigin?.path==='Binary.webloc')`);const binary=await bookmarkTab('Binary.webloc');assert.ok(binary);await page(localUrl,'binary-bookmark-file-browser')
  await evaluate(`bookmarkProbe.split(${JSON.stringify(binary.id)},.34);bookmarkProbe.theme('light')`);await menuSource(true,'binary-source-disabled-menu-narrow-light')
  const before=await evaluate('bookmarkProbe.durable()'), readCount=reads.filter(r=>r.method==='read').length
  await click(tree('Large.webloc'));await wait(`document.querySelector('.error-notice')?.textContent.includes('4 MiB preview limit')`)
  assert.deepEqual(await evaluate('bookmarkProbe.durable()'),before,'Budget failure retains the original Tabs, split, focus and documents')
  assert.equal(reads.filter(r=>r.method==='read').length,readCount,'Native IPC budget rejection cannot reread the bookmark as text')
  await frame('bookmark-budget-visible-error')
  await evaluate(`bookmarkProbe.activate(${JSON.stringify(tab.id)});bookmarkProbe.theme('dark')`);await page(httpUrl,'durable-bookmark-browser-before-restart')
  await evaluate('bookmarkProbe.flush()');report.expected=await evaluate('bookmarkProbe.durable()')
  await fs.writeFile(path.join(evidence,'expected-durable.json'),JSON.stringify(report.expected,null,2))
}
async function restart() {
  const expected=JSON.parse(await fs.readFile(path.join(evidence,'expected-durable.json'),'utf8')),actual=await evaluate('bookmarkProbe.beforeFixture')
  const stored=await evaluate('bookmarkProbe.storedBeforeInitialize')
  const workspace=value=>({tabs:value.tabs,layouts:value.layouts,activeWorkspaceId:value.activeWorkspaceId})
  const storedWorkspace={...stored.restoredWorkbench,activeWorkspaceId:stored.activeWorkspaceId}
  assert.ok(Object.keys(storedWorkspace.tabs).length>0);assert.ok(Object.keys(storedWorkspace.layouts).length>0)
  assert.deepEqual(workspace(storedWorkspace),workspace(expected),'The second process reads the exact durable Tab/Region/URL/title/bookmark-source identity before initialization')
  const topology=value=>{const copy=structuredClone(workspace(value));for(const tab of Object.values(copy.tabs))for(const region of Object.values(tab.regions))if(region.kind==='browser')delete region.title;return copy}
  assert.deepEqual(topology(actual),topology(expected),'Initialization restores the same bookmark sources, Tabs, Regions, split ratios and focus before scene setup')
  await page(httpUrl,'bookmark-browser-after-restart')
  await menuSource(false,'restored-text-source-menu')
  await sourceFile('restored-bookmark-source-file','Research & Notes.webloc')
  const binary=await bookmarkTab('Binary.webloc');await evaluate(`bookmarkProbe.activate(${JSON.stringify(binary.id)});bookmarkProbe.theme('light')`);await page(localUrl,'restored-binary-browser')
  await menuSource(true,'restored-binary-source-disabled')
  report.durable={passed:true,expected:workspace(expected),storedBeforeInitialize:workspace(storedWorkspace),actual:workspace(actual),boundary:'Browser titles in the new Main snapshots are initially unconfirmed and update from real navigation; File document caches are lazily reread. All persisted title/source fields are verified before initialization, and every identity/layout/URL/source field is verified after initialization.'}
}
app.whenReady().then(async()=>{try {
 report.loaded={};for(const [key,file]of [['nativeOwnerSha256',nativeModule],['preloadSha256',path.join(__dirname,'preload.cjs')],['mainSha256',__filename],['rendererHtmlSha256',html]])report.loaded[key]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
 const native=await import(nativeModule);files=new native.WorkspaceFiles(()=>({kind:'local'}))
 ipcMain.on('fixture:boot',event=>{console.error('PRIVATE_STAGE preload-boot');event.returnValue={config,phase}})
 ipcMain.handle('git:status',()=>({kind:'not-a-git-repository',hostId:'local',workspacePath}))
 const workspace=id=>{assert.equal(id,config.workspaces[0].id);return config.workspaces[0]}
 // This narrow private adapter calls real production owners. The registered product IPC has a separate owning test.
 for(const [channel,method] of [['files:readDirectory','readDirectory'],['files:read','read'],['files:readPreview','readPreview'],['files:write','write']])ipcMain.handle(channel,async(_event,id,input,options)=>{const result=await files[method](workspace(id),input,options);if(method==='read'||method==='readPreview')reads.push({method,path:input,status:result.status});if(method==='write')writes.push({path:input.path,status:result.status});return result})
 ipcMain.handle('files:readBookmark',async(_event,id,file)=>{const kind=native.bookmarkKindForPath(file);if(!kind)return null;let bytes;try{bytes=await files.readBookmarkBytes(workspace(id),file)}catch(error){reads.push({method:'readBookmarkBytes',path:file,status:'failed',code:error.code,message:error.message});throw error}reads.push({method:'readBookmarkBytes',path:file,byteLength:bytes?.byteLength});return bytes?native.readBookmark(kind,bytes,native.runProcess):{url:null,binary:false}})
 ipcMain.handle('files:observe',async(event,id,file)=>{const key=id+'\0'+file;if(!observed.has(key))observed.set(key,await files.observe(workspace(id),file,()=>event.sender.send(native.WORKSPACE_FILE_INVALIDATED_CHANNEL,{workspaceId:id,path:file})))})
 ipcMain.handle('files:unobserve',async(_event,id,file)=>{const key=id+'\0'+file;await observed.get(key)?.();observed.delete(key)})
 ipcMain.handle('ui:requestStorageFlush',event=>event.sender.session.flushStorageData())
 win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}})
 profiles=new native.BrowserProfileManager(new native.BrowserProfileStore(path.join(profile,'profiles.json')));await profiles.initialize()
 browsers=new native.BrowserViewManager(win,profiles,new native.BrowserRefLedgerStore(path.join(profile,'ledger.json')),{rememberedSchemes:async()=>({}),rememberScheme:async()=>{throw Error('No system-app preferences in this proof')},openExternal:async()=>{throw Error('No system-app handoff in this proof')}})
 nativeChrome=new native.NativeOverlaySurfaces(win,browsers,warning=>win.webContents.send(native.NATIVE_OVERLAY_WARNING_CHANNEL,warning),input=>win.webContents.send(native.NATIVE_BROWSER_INPUT_CHANNEL,input))
 browsers.onNativeInput=(owner,input)=>nativeChrome.forwardBrowserInput(owner,input)
 ipcMain.handle('ui:publishNativeOverlays',async(_event,regions)=>nativeChrome.update(regions))
 for(const method of ['registerPresentation','updatePresentation','removePresentation','armPresentationCapture','ackPresentationCapture','activatePresentation'])ipcMain.handle('browser:'+method,(event,...args)=>browsers[method](event.sender,event.senderFrame,...args))
 for(const method of ['create','navigate','back','forward','reload','setBounds','release','restore','close','cancelElementSelection','setAnnotationMarkers'])ipcMain.handle('browser:'+method,(_event,...args)=>browsers[method](...args))
 ipcMain.handle('browser:listProfiles',()=>profiles.listProfiles())
 ipcMain.handle('browser:listInputHistory',()=>({status:'unavailable',reason:'Private proof does not exercise input history'}))
 win.webContents.on('console-message',(_event,_level,message)=>{report.consoleMessages.push(message);console.error('RENDERER '+message)})
 win.webContents.on('render-process-gone',(_event,details)=>console.error('PRIVATE_RENDERER_GONE '+JSON.stringify(details)))
 win.webContents.on('did-start-loading',()=>console.error('PRIVATE_STAGE loading'))
 win.webContents.on('dom-ready',()=>console.error('PRIVATE_STAGE dom-ready'))
 win.webContents.on('did-finish-load',()=>console.error('PRIVATE_STAGE loaded'))
 win.webContents.debugger.attach('1.3')
 const navigation={finished:false};report.navigation=navigation
 void win.loadFile(html,{query:{phase}}).then(()=>{navigation.finished=true},error=>{navigation.failure=error.message})
 await win.webContents.debugger.sendCommand('Runtime.enable');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 // A ready mounted Workbench can be usable while unrelated resources still hold the load event.
 stage('wait-mounted-workbench');await wait('Boolean(window.bookmarkProbe)');assert.equal(navigation.failure,undefined)
 Object.assign(navigation,await evaluate('({readyState:document.readyState,url:location.href})'))
 if(phase==='restart')await restart();else await capture();report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}}
finally {for(const stop of observed.values())await stop();nativeChrome?.dispose();browsers?.dispose();await profiles?.dispose();await files?.dispose();await fs.writeFile(path.join(evidence,phase+'-render.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)}})
