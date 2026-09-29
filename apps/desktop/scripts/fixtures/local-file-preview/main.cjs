const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const [html, profile, evidence, phase, nativeModule, workspacePath] = process.argv.slice(2)
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native host' }], executors: {}, workspaces: [{ id: 'preview-private', name: 'File preview workspace', hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let win, files
const observed = new Map(), reads = [], writes = []
const report = { schema: 'agentmux.file-preview-renderer-process.v1', passed: false, phase, pid: process.pid, profile, frames: [], consoleMessages: [], reads, writes, userRunTouched: false }
const evaluate = code => win.webContents.executeJavaScript(code, true)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(code) { const until = Date.now() + 12000; while (Date.now() < until) { if (await evaluate(code)) return; await sleep(50) } assert.fail('Missing actual Renderer fact: ' + code) }
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(70) }
async function click(code) {
  await evaluate(`${code}.scrollIntoView({block:'nearest'})`); await paint()
  const point = await evaluate(`(()=>{const e=${code};if(!e)throw Error('Control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await paint()
}
async function frame(name, filePath) {
  await paint()
  const headers=await evaluate('filePreviewProbe.headerControls()');assert.ok(headers.length>0,'Visible production File headers are nonempty')
  report.lastHeaderControls=headers
  if(headers.some(header=>header.controls.some(control=>control.overlapsClose||!control.inside||(!control.disabled&&!control.hitOwnControl))))await fs.writeFile(path.join(evidence,'unreachable-header.png'),(await win.webContents.capturePage()).toPNG())
  for(const header of headers){assert.ok(header.controls.length>0,'Real header controls are nonempty');for(const control of header.controls){assert.ok(control.width>0&&control.inside,'Header control stays in Region: '+control.label);assert.equal(control.overlapsClose,false,'Close split must not cover File header control: '+control.label);if(!control.disabled)assert.equal(control.hitOwnControl,true,'Actual pointer hits own header control: '+control.label)}}
  const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); report.frames.push({ name, file, headerControls:headers, geometry: filePath ? await evaluate(`filePreviewProbe.geometry(${JSON.stringify(filePath)})`) : null })
}
const imageReady = path => `(()=>{const t=filePreviewProbe.geometry(${JSON.stringify(path)});return t.image?.naturalWidth>0})()`
const active = selector => `filePreviewProbe.activeRegion().querySelector(${JSON.stringify(selector)})`
async function open(file) { await evaluate(`filePreviewProbe.open(${JSON.stringify(file)})`); await paint() }
async function capture() {
  await wait(`Boolean(document.querySelector('[data-tree-path="original.png"]'))`); await click(`document.querySelector('[data-tree-path="original.png"]')`); await wait(imageReady('original.png'))
  const initial = await evaluate('filePreviewProbe.geometry("original.png")'); assert.ok(initial.image.naturalWidth > 600); assert.ok(initial.image.width <= initial.image.naturalWidth)
  await frame('png-fit-dark', 'original.png')
  await click(active('button[title="Original size (1)"]')); const zoom = await evaluate('filePreviewProbe.geometry("original.png")'); assert.equal(zoom.image.width, zoom.image.naturalWidth); assert.ok(zoom.viewport.scrollWidth > zoom.viewport.width)
  await evaluate(`${active('.image-preview__viewport')}.scrollLeft=180`); await frame('png-original-size-pan', 'original.png')
  await evaluate('filePreviewProbe.split("original.png",.24,"light")'); await wait(imageReady('original.png')); await click(active('button[title="Fit image (F or 0)"]'))
  await wait(`Array.from(document.querySelectorAll('[data-workbench-region-id="preview-neighbor"] .monaco-editor .view-line')).map(line=>line.textContent).join(' ').replace(/\\u00a0/g,' ').includes('Saved Markdown')`)
  const narrow = await evaluate('filePreviewProbe.geometry("original.png")'); assert.ok(narrow.region.width <= 240); assert.ok(narrow.image.width <= narrow.viewport.width)
  for (const control of narrow.controls.filter(control=>control.width>0)) assert.ok(control.right <= narrow.region.x+narrow.region.width+1, 'Actual control fits its own Region: '+control.label)
  await frame('png-small-region-light', 'original.png')
  win.setContentSize(1180,420); await paint(); const short=await evaluate('filePreviewProbe.geometry("original.png")'); assert.ok(short.region.height<=420)
  for(const control of short.controls.filter(control=>control.width>0))assert.ok(control.bottom<=short.region.y+short.region.height+1,'Actual control remains reachable in short Region: '+control.label)
  await frame('png-short-region-light','original.png'); win.setContentSize(1180,850); await paint(); await evaluate('filePreviewProbe.theme("dark")')
  for (const [file, name] of [['photo.jpg','jpeg-decoded'],['animation.gif','gif-decoded'],['small.png','small-image-no-upscale']]) { await open(file); await wait(imageReady(file)); const facts = await evaluate(`filePreviewProbe.geometry(${JSON.stringify(file)})`); if(file==='small.png')assert.equal(facts.image.width,facts.image.naturalWidth); await frame(name,file) }
  await open('drawing.svg'); await wait(imageReady('drawing.svg')); const xml = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" rx="24" fill="#171b21"/><circle cx="140" cy="180" r="72" fill="#8de3ae"/><text x="248" y="178" fill="#edf1ee" font-family="sans-serif" font-size="28">Unsaved SVG</text><text x="248" y="220" fill="#b6bfb9" font-family="sans-serif" font-size="18">The same editable document</text></svg>'
  await evaluate(`filePreviewProbe.edit('drawing.svg',${JSON.stringify(xml)})`); await wait(imageReady('drawing.svg')); await frame('svg-current-dirty-preview','drawing.svg')
  await click(active('button[title="Show source"]')); await wait(`Boolean(${active('.monaco-editor')})`); await frame('svg-source-draft','drawing.svg')
  await open('notes.md'); const markdown = '# Current unsaved Markdown\n\nThe preview uses **this draft**, with the original revision and save owner.\n\n- [PNG workspace result](original.png)\n- Native media controls\n- Transparent SVG\n\n<script>window.shouldNeverRun = true</script>'; await evaluate(`filePreviewProbe.edit('notes.md',${JSON.stringify(markdown)})`)
  await click(active('button[title="Preview current content"]')); await wait(`Boolean(${active('.file-markdown-preview')})`); assert.equal(await evaluate('window.shouldNeverRun'),undefined); await frame('markdown-current-dirty-preview','notes.md')
  const linkedBefore = await evaluate('filePreviewProbe.facts()'); await click(active('button.md-link--file[title="original.png"]')); await wait(imageReady('original.png')); const linkedAfter = await evaluate('filePreviewProbe.facts()'); assert.deepEqual(linkedAfter.tabs, linkedBefore.tabs); assert.deepEqual(linkedAfter.documents,linkedBefore.documents); assert.deepEqual(linkedAfter.dirtyDocuments,linkedBefore.dirtyDocuments); report.linkEntries={fileTreeClick:true,markdownClick:true,sameFileIdentity:true,dirtyDocumentsPreserved:true}
  for (const [file, kind] of [['tone.wav','audio'],['motion.webm','video']]) {
    await open(file); await wait(`${active(kind)}?.readyState>=1`); const player = active(kind)
    assert.equal(await evaluate(`${player}.autoplay`),false)
    await evaluate(`${player}.play()`); await wait(`${player}.paused===false`); await frame(kind+'-native-controls',file)
    await open('original.png'); assert.equal(await evaluate(`${player}`),null)
  }
  await open('sample.pdf'); await wait(`Boolean(${active('embed[type="application/pdf"]')})`)
  const pdfDeadline=Date.now()+12000
  let pdfLoaded=false
  while(Date.now()<pdfDeadline){
    report.pdfFrames=[]
    for(const frame of win.webContents.mainFrame.framesInSubtree){
      let timeout
      try{report.pdfFrames.push(await Promise.race([frame.executeJavaScript(`(()=>{const viewer=document.querySelector('pdf-viewer');return{url:location.href,hasViewer:Boolean(viewer),loadState:viewer?.loadState_,initialLoadComplete:viewer?.initialLoadComplete_,pageCount:viewer?.documentDimensions_?.pageDimensions?.length}})()`),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Native frame observation still pending')),500)})]))}
      catch(error){report.pdfFrames.push({url:frame.url,error:error.message})}finally{clearTimeout(timeout)}
    }
    if(report.pdfFrames.some(frame=>frame.hasViewer&&frame.loadState==='success'&&frame.initialLoadComplete===true)){pdfLoaded=true;break}
    assert.equal(report.pdfFrames.some(frame=>frame.hasViewer&&frame.loadState==='failed'),false,'The native PDF viewer reported a failed document load')
    await sleep(100)
  }
  assert.equal(pdfLoaded,true,'Observed native PDF document completion before capture: '+JSON.stringify(report.pdfFrames));await paint();await frame('pdf-native-viewer','sample.pdf')
  await open('opaque.unknown'); await wait(`Boolean(${active('[data-preview-state="binary"]')})`); assert.equal(await evaluate('filePreviewProbe.facts().documents[filePreviewProbe.key("opaque.unknown")]'),undefined); await frame('unknown-binary-readonly','opaque.unknown')
  await open('broken.png'); await wait(`Boolean(${active('[data-decode-state="error"]')})`); await frame('image-decode-failure','broken.png')
  await open('large.png'); await wait(`Boolean(${active('[data-preview-state="too-large"]')})`); await frame('preview-budget-failure','large.png')
  await evaluate('filePreviewProbe.split("original.png",.5,"dark")'); await wait(imageReady('original.png'))
  await wait(`Array.from(document.querySelectorAll('[data-workbench-region-id="preview-neighbor"] .monaco-editor .view-line')).map(line=>line.textContent).join(' ').replace(/\\u00a0/g,' ').includes('Current unsaved Markdown')`)
  await frame('durable-file-split-before-restart','original.png')
  await evaluate('filePreviewProbe.flush()'); const facts = await evaluate('filePreviewProbe.facts()')
  assert.ok(facts.dirtyDocuments[filePreviewKey('drawing.svg')]); assert.ok(facts.dirtyDocuments[filePreviewKey('notes.md')]); assert.equal(facts.documents[filePreviewKey('opaque.unknown')],undefined)
  report.expected = { tabs: facts.tabs, layouts: facts.layouts, activeWorkspaceId: facts.activeWorkspaceId, documents: Object.fromEntries(Object.entries(facts.documents).filter(([key])=>facts.dirtyDocuments[key])), dirtyDocuments: Object.fromEntries(Object.entries(facts.dirtyDocuments).filter(([,dirty])=>dirty)) }
  await fs.writeFile(path.join(evidence,'expected-durable.json'),JSON.stringify(report.expected,null,2))
}
const filePreviewKey = path => config.workspaces[0].id+'\0'+path
async function restart() {
  const expected = JSON.parse(await fs.readFile(path.join(evidence,'expected-durable.json'),'utf8')), actual = await evaluate('filePreviewProbe.beforeFixture')
  assert.deepEqual(actual.tabs,expected.tabs); assert.deepEqual(actual.layouts,expected.layouts); assert.equal(actual.activeWorkspaceId,expected.activeWorkspaceId)
  for(const [key,doc] of Object.entries(expected.documents)){assert.deepEqual(actual.documents[key],doc);assert.equal(actual.dirtyDocuments[key],true)}
  await wait(imageReady('original.png'));await wait(`Array.from(document.querySelectorAll('[data-workbench-region-id="preview-neighbor"] .monaco-editor .view-line')).map(line=>line.textContent).join(' ').replace(/\\u00a0/g,' ').includes('Current unsaved Markdown'))`)
  await frame('renderer-profile-file-restart','original.png'); report.durable={passed:true,expected,actual,boundary:'A second ordinary Electron process reads original durable File Tabs/Regions/layout/focus/dirty documents before any scene setup. Native workspace bytes pass through production preload into the actual WorkspaceFiles owner.'}
}
app.whenReady().then(async()=>{try{
  const { WorkspaceFiles, WORKSPACE_FILE_INVALIDATED_CHANNEL } = await import(nativeModule); files = new WorkspaceFiles(()=>({kind:'local'}))
  ipcMain.on('fixture:boot',event=>{event.returnValue={config,phase}})
  ipcMain.handle('git:status',()=>({kind:'not-a-git-repository',hostId:'local',workspacePath}))
  const workspace = id => {const found=config.workspaces.find(item=>item.id===id);if(!found)throw Error('Unknown private workspace');return found}
  for(const [channel,method] of [['files:readDirectory','readDirectory'],['files:read','read'],['files:readPreview','readPreview'],['files:write','write']])ipcMain.handle(channel,async(_event,id,input,options)=>{const result=await files[method](workspace(id),input,options);if(method==='read'||method==='readPreview')reads.push({method,workspaceId:id,path:input,status:result.status,byteLength:result.byteLength,readCost:result.readCost});if(method==='write')writes.push({workspaceId:id,path:input.path,status:result.status});return result})
  ipcMain.handle('files:observe',async(event,id,file)=>{const key=id+'\0'+file;if(!observed.has(key))observed.set(key,await files.observe(workspace(id),file,()=>event.sender.send(WORKSPACE_FILE_INVALIDATED_CHANNEL,{workspaceId:id,path:file})))})
  ipcMain.handle('files:unobserve',async(_event,id,file)=>{const key=id+'\0'+file;await observed.get(key)?.();observed.delete(key)})
  // External application actions are not exercised by this isolated capture; Main contract tests cover their original owner.
  ipcMain.handle('files:reveal',()=>{throw Error('Capture does not open system UI')});ipcMain.handle('files:openSystem',()=>{throw Error('Capture does not open system applications')})
  win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}})
  win.webContents.on('console-message',(_event,_level,message)=>{report.consoleMessages.push(message);console.log('RENDERER '+message)});await win.loadFile(html,{query:{phase}});win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await wait('Boolean(window.filePreviewProbe)')
  if(phase==='restart')await restart();else await capture();assert.equal(report.consoleMessages.some(message=>message.includes('Content Security Policy')),false,'No blocked production media/frame request');report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}}
finally{for(const dispose of observed.values())await dispose();await files?.dispose();await fs.writeFile(path.join(evidence,phase+'-render.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)}})
