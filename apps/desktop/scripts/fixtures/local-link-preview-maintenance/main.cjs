const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const [html, profile, evidence, phase, nativeModule, workspacePath, httpUrl, localUrl, home, lane] = process.argv.slice(2)
// This private proof uses Chromium software painting; it does not change the installed App.
app.disableHardwareAcceleration()
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: { codex: { label: 'Preview conversation', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } }, workspaces: [{ id: 'bookmark-private', name: 'Local preview', hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: false, screenshot: false, devTools: false, viewport: false, saveBookmark: true, more: true } } }
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
    const owner=Object.values((await evaluate('previewProbe.facts()')).surfaces).filter(r=>r.kind==='browser').map(r=>browsers.nativeOwner(r.browserId)).find(owner=>owner?.view===view)
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
const activeBrowser = `(()=>{const s=previewProbe.facts();const l=s.layouts[previewProbe.workspaceId];const g=l.groups.find(g=>g.id===l.activeGroupId);const t=s.tabs[g.activeTabId];return Object.values(t.regions).find(r=>r.kind==='browser')})()`
const browserControl = label => `(()=>{const b=${activeBrowser};return document.querySelector('[data-workbench-region-id="'+b.regionId+'"] button[aria-label=${JSON.stringify(label)}]')})()`
async function bookmarkTab(origin) { return evaluate(`Object.values(previewProbe.facts().tabs).find(t=>Object.values(t.regions).some(r=>r.kind==='browser'&&r.bookmarkOrigin?.path===${JSON.stringify(origin)}))`) }
async function page(expected, name) {
  stage('page:'+name)
  await wait(`${activeBrowser}?.url===${JSON.stringify(expected)}`)
  let owner; const until=Date.now()+15000
  while(Date.now()<until) { const id=await evaluate(`${activeBrowser}.browserId`); owner=browsers.nativeOwner(id); if(owner&&!owner.view.webContents.isLoading())break; await pause(50) }
  assert.ok(owner,'Real BrowserViewManager has a visible native page owner')
  const facts=await owner.view.webContents.executeJavaScript(`({href:location.href,title:document.title,heading:document.querySelector('h1')?.textContent,node:typeof require,bridge:typeof window.agentmux})`)
  assert.equal(facts.href,expected);assert.ok(facts.heading);assert.equal(facts.node,'undefined');assert.equal(facts.bridge,'undefined')
  const neighbor=await evaluate(`(()=>{const s=previewProbe.facts(),l=s.layouts[previewProbe.workspaceId],g=l.groups.find(g=>g.id===l.activeGroupId);return Object.values(s.tabs[g.activeTabId].regions).find(r=>r.kind==='file'&&r.path==='notes.md')})()`)
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
  const activeRegion=`(()=>{const s=previewProbe.facts(),l=s.layouts[previewProbe.workspaceId],g=l.groups.find(g=>g.id===l.activeGroupId),t=s.tabs[g.activeTabId];return t.regions[t.layout.activeRegionId]})()`
  await wait(`${activeRegion}?.kind==='file'&&${activeRegion}.path===${JSON.stringify(pathName)}`)
  const text=`(()=>{const region=${activeRegion};return document.querySelector('[data-workbench-region-id="'+region.regionId+'"] .monaco-editor .view-lines')?.textContent??''})()`
  await wait(`${text}.includes('<?xml')&&${text}.includes(${JSON.stringify(httpUrl)})`)
  report.sourceFiles=[...report.sourceFiles??[],{name,path:pathName,region:await evaluate(activeRegion),visibleText:await evaluate(text)}]
  await frame(name)
}

const currentTab = `(()=>{const s=previewProbe.facts(),l=s.layouts[previewProbe.workspaceId],g=l.groups.find(g=>g.id===l.activeGroupId);return s.tabs[g.activeTabId]})()`
const fileImage = `document.querySelector('.image-preview img')`
const imageLink = title => `document.querySelector('button[title='+${JSON.stringify(JSON.stringify(title))}+']')`
async function imagePage(name) {
 await wait(`document.querySelector('.image-preview')?.dataset.decodeState==='decoded'&&${fileImage}?.naturalWidth===640`)
 const image=await evaluate(`(()=>{const img=${fileImage},bounds=img.closest('[data-workbench-region-id]').getBoundingClientRect();return{width:img.naturalWidth,height:img.naturalHeight,src:img.src,alt:img.alt,regionBounds:{width:bounds.width,height:bounds.height}}})()`)
 if(name==='encoded-png-narrow-light')assert.ok(image.regionBounds.width<360&&image.regionBounds.width>=250,'The actual image Region is narrow')
 assert.equal(image.width,640);assert.equal(image.height,360);assert.ok(image.src.startsWith('blob:'));report.decodedImages=[...report.decodedImages??[],{name,image}];await frame(name)
}
async function attachment() {
 const good=path.join(home,'.agentmux/pasted/good.png'),bad=path.join(home,'.agentmux/pasted/bad.png')
 await evaluate(`(()=>{window.previewImageEvents=[];for(const kind of ['load','error'])document.addEventListener(kind,event=>{const img=event.target;if(img instanceof HTMLImageElement&&img.matches('.md-conversation-image__thumb,.md-conversation-image__full'))window.previewImageEvents.push({kind,trusted:event.isTrusted,className:img.className,src:img.src,naturalWidth:img.naturalWidth})},true)})()`)
 await evaluate(`previewProbe.conversation(${JSON.stringify('Original answer before @'+good+' after the image.')},.65)`)
 const thumb=`document.querySelector('.md-conversation-image__thumb')`,trigger=`document.querySelector('button.md-conversation-image')`
 await wait(`${thumb}?.complete&&${thumb}.naturalWidth===640`)
 const draft=previewProbeSource(await evaluate('previewProbe.durable()'))
 assert.equal(draft.dirty,true);assert.ok(draft.document.content.includes('Original unsaved source'));await frame('pasted-thumbnail-wide-dark')
 await click(trigger);const full=`document.querySelector('.md-conversation-image__full')`
 await wait(`${full}?.complete&&${full}.naturalWidth===640`);await frame('pasted-full-lightbox-wide-dark')
 for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape'})
 await wait(`!document.querySelector('[role="dialog"]')&&document.activeElement===${trigger}`);await frame('pasted-escape-focus-return')
 // The same actual img owner now receives invalid real PNG bytes. Chromium emits error; this is
 // a decode counterexample, not a synthetic DOM error event or a production data-owner replacement.
 await click(trigger);await wait(`Boolean(${full})`)
 await evaluate(`${full}.src='data:image/png;base64,aGVsbG8='`)
 await wait(`!document.querySelector('.md-conversation-image')&&!document.querySelector('[role="dialog"]')`)
 await frame('pasted-full-decode-failure-token')
 for(const [name,ratio,theme]of [['wide-dark',.65,'dark'],['narrow-light',.34,'light']]) {
  const content='Original answer before @'+bad+' after the unreadable image.'
  await evaluate(`previewProbe.conversation(${JSON.stringify(content)},${ratio});previewProbe.theme(${JSON.stringify(theme)})`)
  await wait(`window.previewImageEvents.some(event=>event.kind==='error'&&event.trusted&&event.className==='md-conversation-image__thumb'&&event.src==='data:image/png;base64,aGVsbG8=')&&document.querySelector('#fixture-conversation')?.textContent.includes(${JSON.stringify('@'+bad)})&&!document.querySelector('.md-conversation-image')`)
  assert.deepEqual(previewProbeSource(await evaluate('previewProbe.durable()')),draft)
  const messageBounds=await evaluate(`(()=>{const b=document.querySelector('[data-message-width]').getBoundingClientRect();return{width:b.width,height:b.height}})()`)
  if(name==='narrow-light')assert.ok(messageBounds.width<360&&messageBounds.width>250,'The actual message panel is narrow')
  report.messageBounds=[...report.messageBounds??[],{name,...messageBounds}]
  assert.ok(reads.some(read=>read.method==='readPastedImage'&&read.path===bad&&read.dataUrl==='data:image/png;base64,aGVsbG8='))
  await frame('pasted-thumbnail-decode-failure-'+name)
 }
 report.attachment={passed:true,normalDecode:{width:640,height:360},badBytesBase64:'aGVsbG8=',nativeImageEvents:await evaluate('window.previewImageEvents'),fullFailure:'Actual Chromium img src changed to the same real invalid PNG bytes; original callbacks handle the trusted native error.',originalDraft:draft}
 await evaluate(`previewProbe.hideConversation();previewProbe.activate(previewProbe.sourceTabId)`);await frame('attachment-original-file-workbench-retained')
}
async function capture() {
 await evaluate('previewProbe.source(.62);previewProbe.dirtySource()');await wait(`Boolean(document.querySelector('.file-markdown-preview'))`)
 const before=await evaluate('previewProbe.durable()');report.originalSource=before
 await frame('markdown-links-wide-dark')
 if(lane==='attachment'){await attachment();return}
 await click(imageLink('docs/images/photo one.png'));await imagePage('encoded-png-wide-dark')
 const pngTab=await evaluate(`${currentTab}.id`);await evaluate(`previewProbe.split(${JSON.stringify(pngTab)},.34);previewProbe.theme('light')`);await imagePage('encoded-png-narrow-light')
 await evaluate(`previewProbe.source(.4)`);await frame('markdown-links-narrow-light')
 await click(imageLink('docs/图片.png'));await imagePage('unicode-png-wide-light')
 await evaluate(`previewProbe.source(.62);previewProbe.theme('dark')`)
 await click(imageLink('docs/Research & Notes.webloc'));await page(httpUrl,'encoded-bookmark-browser-wide-dark')
 const tab=await bookmarkTab('docs/Research & Notes.webloc');assert.ok(tab)
 await evaluate(`previewProbe.split(${JSON.stringify(tab.id)},.34);previewProbe.theme('light')`);await page(httpUrl,'encoded-bookmark-browser-narrow-light')
 await menuSource(false,'encoded-bookmark-source-menu-narrow');await sourceFile('encoded-bookmark-original-source','docs/Research & Notes.webloc')
 await evaluate(`previewProbe.activate(${JSON.stringify(tab.id)})`);await page(httpUrl,'return-original-encoded-bookmark-browser')
 const after=await evaluate('previewProbe.durable()'),source=previewProbeSource(before),retained=previewProbeSource(after)
 assert.deepEqual(retained,source,'Navigation retains dirty original source and its nonempty split');assert.ok(writes.length===0)
 await evaluate('previewProbe.flush()');report.expected=await evaluate('previewProbe.durable()');await fs.writeFile(path.join(evidence,'expected-durable.json'),JSON.stringify(report.expected,null,2))
}
function previewProbeSource(value){const id=Object.keys(value.tabs).find(id=>Object.values(value.tabs[id].regions).some(r=>r.kind==='file'&&r.path==='docs/readme.md'));assert.ok(id);const key=Object.keys(value.documents).find(key=>value.documents[key].path==='docs/readme.md');assert.ok(key);return {tab:value.tabs[id],document:value.documents[key],dirty:value.dirtyDocuments[key]}}
async function restart() {
 const expected=JSON.parse(await fs.readFile(path.join(evidence,'expected-durable.json'),'utf8')),actual=await evaluate('previewProbe.beforeFixture'),stored=await evaluate('previewProbe.storedBeforeInitialize')
 const topology=value=>{const next={tabs:structuredClone(value.tabs),layouts:value.layouts,activeWorkspaceId:value.activeWorkspaceId};for(const tab of Object.values(next.tabs))for(const region of Object.values(tab.regions))if(region.kind==='browser')delete region.title;return next}
 assert.ok(Object.keys(actual.tabs).length>0);assert.deepEqual(topology(actual),topology(expected));assert.deepEqual(stored.restoredWorkbench.tabs,expected.tabs)
 assert.deepEqual(previewProbeSource(actual),previewProbeSource(expected))
 await page(httpUrl,'encoded-bookmark-after-restart')
 await menuSource(false,'encoded-source-menu-after-restart');await sourceFile('encoded-source-file-after-restart','docs/Research & Notes.webloc')
 await evaluate('previewProbe.source(.4)');await frame('dirty-markdown-source-after-restart')
 report.durable={passed:true,expected:topology(expected),actual:topology(actual),dirtySource:previewProbeSource(actual),boundary:'The second process reads the actual private durable profile before fixture setup; real Browser titles update from navigation. No Run is created or controlled.'}
}
app.whenReady().then(async()=>{try {
 if(phase==='capture') {
  const width=640,height=360,bitmap=Buffer.alloc(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4,grid=x%80<2||y%60<2;bitmap[at]=grid?220:60+Math.floor(100*x/width);bitmap[at+1]=grid?235:90+Math.floor(80*y/height);bitmap[at+2]=grid?250:70;bitmap[at+3]=255}
  const png=nativeImage.createFromBitmap(bitmap,{width,height}).toPNG()
  for(const file of [path.join(workspacePath,'docs/images/photo one.png'),path.join(workspacePath,'docs/图片.png'),path.join(home,'.agentmux/pasted/good.png')]){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,png)}
 }
 report.originalBytes={};for(const file of ['docs/readme.md','notes.md','docs/images/photo one.png','docs/图片.png','docs/Research & Notes.webloc'])report.originalBytes[file]=crypto.createHash('sha256').update(await fs.readFile(path.join(workspacePath,file))).digest('hex')
 report.loaded={};for(const [key,file]of [['nativeOwnerSha256',nativeModule],['preloadSha256',path.join(__dirname,'preload.cjs')],['mainSha256',__filename],['rendererHtmlSha256',html]])report.loaded[key]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
 const native=await import(nativeModule);files=new native.WorkspaceFiles(()=>({kind:'local'}))
 ipcMain.on('fixture:boot',event=>{console.error('PRIVATE_STAGE preload-boot');event.returnValue={config,phase,home,lane}})
 ipcMain.handle('git:status',()=>({kind:'not-a-git-repository',hostId:'local',workspacePath}))
 const workspace=id=>{assert.equal(id,config.workspaces[0].id);return config.workspaces[0]}
 // This narrow private adapter calls real production owners. The registered product IPC has a separate owning test.
 for(const [channel,method] of [['files:readDirectory','readDirectory'],['files:read','read'],['files:readPreview','readPreview'],['files:write','write']])ipcMain.handle(channel,async(_event,id,input,options)=>{const result=await files[method](workspace(id),input,options);if(method==='read'||method==='readPreview')reads.push({method,path:input,status:result.status});if(method==='write')writes.push({path:input.path,status:result.status});return result})
 ipcMain.handle('files:readBookmark',async(_event,id,file)=>{const kind=native.bookmarkKindForPath(file);if(!kind)return null;let bytes;try{bytes=await files.readBookmarkBytes(workspace(id),file)}catch(error){reads.push({method:'readBookmarkBytes',path:file,status:'failed',code:error.code,message:error.message});throw error}reads.push({method:'readBookmarkBytes',path:file,byteLength:bytes?.byteLength});return bytes?native.readBookmark(kind,bytes,native.runProcess):{url:null,binary:false}})
 ipcMain.handle('files:observe',async(event,id,file)=>{const key=id+'\0'+file;if(!observed.has(key))observed.set(key,await files.observe(workspace(id),file,()=>event.sender.send(native.WORKSPACE_FILE_INVALIDATED_CHANNEL,{workspaceId:id,path:file})))})
 ipcMain.handle('files:unobserve',async(_event,id,file)=>{const key=id+'\0'+file;await observed.get(key)?.();observed.delete(key)})
 ipcMain.handle('ui:readPastedImage',async(_event,file)=>{const result=await native.readPastedImage(home,file);reads.push({method:'readPastedImage',path:file,dataUrl:result?.dataUrl??null});return result})
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
 win.webContents.debugger.on('message',(_event,method,parameters)=>{if(method==='Runtime.exceptionThrown'){report.rendererExceptions=[...report.rendererExceptions??[],parameters.exceptionDetails];console.error('PRIVATE_RENDERER_EXCEPTION '+(parameters.exceptionDetails.exception?.description??parameters.exceptionDetails.text))}})
 const navigation={finished:false};report.navigation=navigation
 void win.loadFile(html,{query:{phase}}).then(()=>{navigation.finished=true},error=>{navigation.failure=error.message})
 await win.webContents.debugger.sendCommand('Runtime.enable');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 // A ready mounted Workbench can be usable while unrelated resources still hold the load event.
 stage('wait-mounted-workbench');await wait('Boolean(window.previewProbe)');assert.equal(navigation.failure,undefined)
 Object.assign(navigation,await evaluate('({readyState:document.readyState,url:location.href})'))
 if(phase==='restart')await restart();else await capture();report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};try{report.failedDOM=await evaluate('document.body.innerText.slice(0,12000)');report.failedFacts=await evaluate('previewProbe.facts()');await frame('failed-workface')}catch(diagnostic){report.diagnosticFailure=diagnostic.message}}
finally {if(report.passed)for(const [file,hash]of Object.entries(report.originalBytes))assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(workspacePath,file))).digest('hex'),hash,'Original file bytes preserved');for(const stop of observed.values())await stop();nativeChrome?.dispose();browsers?.dispose();await profiles?.dispose();await files?.dispose();await fs.writeFile(path.join(evidence,phase+'-render.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)}})
