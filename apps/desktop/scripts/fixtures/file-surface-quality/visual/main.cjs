const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const [html, profile, evidence, phase, nativeModule, workspacePath] = process.argv.slice(2)
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native host' }], executors: {}, workspaces: [{ id: 'preview-private', name: 'File preview workspace', hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let win, files, spatial, disposeSpatial
const observed = new Map(), reads = [], writes = []
const report = { schema: 'agentmux.file-preview-renderer-process.v1', passed: false, phase, pid: process.pid, profile, frames: [], consoleMessages: [], reads, writes, userRunTouched: false }
const evaluate = code => win.webContents.executeJavaScript(code, true)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(code) { const until = Date.now() + 12000; while (Date.now() < until) { if (await evaluate(code)) return; await sleep(50) } assert.fail('Missing actual Renderer fact: ' + code) }
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(70) }
async function click(code, button = 'left') {
  await evaluate(`${code}.scrollIntoView({block:'nearest'})`); await paint()
  const point = await evaluate(`(()=>{const e=${code};if(!e)throw Error('Control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 })
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
const active = selector => `filePreviewProbe.activeRegion()?.querySelector(${JSON.stringify(selector)})`
const select = selector => `document.querySelector(${JSON.stringify(selector)})`
async function open(file) { await evaluate(`filePreviewProbe.open(${JSON.stringify(file)})`); await wait(`Boolean(${active('.editor-header')})`); await paint() }
async function preview(file, selector) {
  await open(file)
  if ((selector === '.file-markdown-preview' || selector === '.file-data-preview') && !await evaluate(`Boolean(${active(selector)})`)) await click(active('button[title="Preview current content"]'))
  await wait(`Boolean(${active(selector)})`)
}
async function capture() {
  for (const theme of ['dark', 'light']) {
    await evaluate(`filePreviewProbe.theme(${JSON.stringify(theme)})`)
    await preview('notes.md', '.file-markdown-preview'); await wait(`${active('.file-markdown-preview img')}?.naturalWidth>0`)
    const table = await evaluate(`(()=>{const e=${active('.md-table-scroll')};return {height:e?.clientHeight, width:e?.clientWidth, rows:e?.querySelectorAll('tbody tr').length}})()`);assert.ok(table.height>0 && table.width>0 && table.rows===3,'Markdown table keeps its intrinsic geometry'); await frame('markdown-document-'+theme, 'notes.md')
    await open('preferences.json'); if(!await evaluate(`Boolean(${active('.file-data-preview')})`)) await click(active('button[title="Preview current content"]'))
    await wait(`Boolean(${active('.file-data-preview')})`); await frame('json-tree-'+theme, 'preferences.json')
    await open('measurements.csv'); if(!await evaluate(`Boolean(${active('.file-data-preview')})`)) await click(active('button[title="Preview current content"]'))
    await wait(`Boolean(${active('table')})`); await frame('csv-table-'+theme, 'measurements.csv')
    await open('knowledge.note.json'); await wait(`Boolean(${active('.tiptap')})`); await frame('note-document-'+theme, 'knowledge.note.json')
    await open('sample.pdf'); await wait(`${active('.pdf-content')}?.dataset.decodeState==='ready'`)
    await wait(`${active('.textLayer')}?.textContent.includes('File surface')`); await frame('pdf-reader-'+theme, 'sample.pdf')
    await click(active('button[aria-label="Next PDF page"]')); await wait(`${active('input[aria-label="PDF page"]')}?.value==='2'`)
    await wait(`${active('.pdf-content .page[data-page-number="2"] canvas')}?.width>0`); await frame('pdf-chinese-page-'+theme,'sample.pdf')
    await open('drawing.svg'); await wait(imageReady('drawing.svg')); await frame('svg-preview-'+theme, 'drawing.svg')
    await open('original.png'); await wait(imageReady('original.png')); await frame('image-fit-'+theme, 'original.png')
    await open('code.ts'); await wait(`Boolean(${active('.monaco-editor')})`); await frame('source-code-'+theme,'code.ts')
  }
  for (const [file, selector, name] of [['tone.wav','audio','audio'], ['motion.webm','video','video']]) {
    await open(file); await wait(`${active(selector)}?.readyState>=1`); assert.equal(await evaluate(`${active(selector)}.autoplay`),false); await evaluate(`${active(selector)}.play()`); await wait(`${active(selector)}.currentTime>0 && ${active(selector)}.readyState>=4`); await evaluate(`${active(selector)}.pause()`); await sleep(300); await frame(name+'-controls',file)
  }
  for (const [file,name,selector] of [['opaque.unknown','binary-fallback','[data-preview-state="binary"]'], ['broken.png','image-error','[data-decode-state="error"]'], ['broken.pdf','pdf-error','[data-decode-state="error"]']]) {
    await open(file); await wait(`Boolean(${active(selector)})`); await frame(name,file)
  }
  await open('broken.json'); await click(active('button[title="Preview current content"]')); await wait(`Boolean(${active('[role="alert"]')})`); await frame('json-error','broken.json')
  await open('lookup.tsv'); await click(active('button[title="Preview current content"]')); await wait(`Boolean(${active('table')})`); await frame('tsv-table','lookup.tsv')
  await click(select('button[aria-label="Expand many-files"]'))
  // Expanding above the active file preserves its scroll anchor. Navigate to
  // the top through the real tree before inspecting its first virtual rows.
  await evaluate('document.querySelector(".file-tree").focus()')
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36})
  await wait(`Boolean(${select('[data-tree-path="many-files/item-0000.ts"]')})`)
  const loadedTree = await evaluate('({rows:document.querySelectorAll(".tree-row").length,height:document.querySelector(".file-tree__rows").clientHeight})')
  assert.ok(loadedTree.rows<60 && loadedTree.height>1200*20,'Large directory keeps actual DOM bounded')
  report.loadedTree=loadedTree
  await frame('directory-large-light','lookup.tsv')
  await evaluate('document.querySelector(".file-tree").focus()')
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'End',code:'End',windowsVirtualKeyCode:35})
  await wait(`Boolean(${select('.tree-row[aria-selected="true"][data-tree-path="tone.wav"]')})`)
  await frame('directory-keyboard-end-light','lookup.tsv')
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36})
  await wait(`Boolean(${select('.tree-row[aria-selected="true"][data-tree-path="many-files"]')})`)
  await click(select('button[aria-label="Collapse many-files"]'))
  for (const [file, selector, name] of [['measurements.csv','.file-data-preview','csv'], ['sample.pdf','.pdf-content','pdf'], ['original.png','.image-preview','image'], ['notes.md','.file-markdown-preview','markdown'], ['preferences.json','.file-data-preview','json'], ['knowledge.note.json','.note-surface','note'], ['code.ts','.monaco-editor','source'], ['drawing.svg','.image-preview','svg'], ['tone.wav','audio','audio'], ['motion.webm','video','video']]) {
    await evaluate(`filePreviewProbe.split(${JSON.stringify(file)},.3,'light')`)
    if (file==='notes.md' && !await evaluate(`Boolean(${active(selector)})`)) await click(active('button[title="Preview current content"]'))
    await wait(`Boolean(${active(selector)})`); if(file==='sample.pdf')await wait(`${active(selector)}.dataset.decodeState==='ready'`)
    if(file==='motion.webm' || file==='tone.wav') { const media=active(file==='motion.webm'?'video':'audio');await wait(`${media}?.readyState>=1`);await evaluate(`${media}.play()`);await wait(`${media}.currentTime>0 && ${media}.readyState>=4`);await evaluate(`${media}.pause()`);await sleep(300) }
    await frame(name+'-narrow-light',file)
    win.setContentSize(1180,420); await paint(); await frame(name+'-short-light',file);win.setContentSize(1180,850);await paint()
  }
  await open('code.ts'); await paint(); await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
  const beforeHeap = await win.webContents.debugger.sendCommand('Runtime.getHeapUsage')
  for (let index=0;index<4;index++) { const file='large-photo-'+index+'.png'; await open(file);await wait(imageReady(file)) }
  await open('code.ts');await paint();await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
  const afterHeap = await win.webContents.debugger.sendCommand('Runtime.getHeapUsage')
  report.hiddenMediaMemory = { before:beforeHeap, after:afterHeap, loadedBytes:4*4*1024*1024 }
  if(typeof beforeHeap.backingStorageSize==='number') assert.ok(afterHeap.backingStorageSize-beforeHeap.backingStorageSize < 6*1024*1024,'Hidden media releases its 16MB byte snapshots')
  await open('notes.md'); await evaluate(`filePreviewProbe.edit('notes.md',${JSON.stringify('# Current unsaved Markdown\n\nDraft identity survives a real Renderer restart.')})`)
  await open('drawing.svg'); await evaluate(`filePreviewProbe.edit('drawing.svg','<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#6e96a8"/></svg>')`)
  await evaluate('filePreviewProbe.split("original.png",.5,"dark")'); await wait(imageReady('original.png')); await evaluate("filePreviewProbe.source('notes.md')")
  await wait(`Array.from(document.querySelectorAll('[data-workbench-region-id="preview-neighbor:original.png"] .monaco-editor .view-line')).map(line=>line.textContent).join(' ').replace(/\\u00a0/g,' ').includes('Current unsaved Markdown')`)
  await frame('durable-file-split-before-restart','original.png')
  await evaluate('filePreviewProbe.flush()'); const facts = await evaluate('filePreviewProbe.facts()')
  assert.ok(facts.dirtyDocuments[filePreviewKey('drawing.svg')]); assert.ok(facts.dirtyDocuments[filePreviewKey('notes.md')]); assert.equal(facts.documents[filePreviewKey('opaque.unknown')],undefined)
  report.expected = { tabs: facts.tabs, layouts: facts.layouts, activeWorkspaceId: facts.activeWorkspaceId, documents: Object.fromEntries(Object.entries(facts.documents).filter(([key])=>facts.dirtyDocuments[key])), dirtyDocuments: Object.fromEntries(Object.entries(facts.dirtyDocuments).filter(([,dirty])=>dirty)) }
  await fs.writeFile(path.join(evidence,'expected-durable.json'),JSON.stringify(report.expected,null,2))
}
const filePreviewKey = path => config.workspaces[0].id+'\0'+path
async function activation() {
  await wait(`Boolean(${select('[data-tree-path="code.ts"] .tree-row__label')})`)
  assert.equal((await evaluate('filePreviewProbe.facts()')).mainSurface, 'agents')
  await click(select('[data-tree-path="code.ts"] .tree-row__label'))
  await wait(`${active('.monaco-editor')}?.contains(document.activeElement)`)
  assert.equal((await evaluate('filePreviewProbe.facts()')).mainSurface, 'workbench')
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '// Typed after clicking the file name\n' })
  await wait(`filePreviewProbe.facts().documents[filePreviewProbe.key('code.ts')]?.content.includes('Typed after clicking the file name')`)
  await frame('filename-opens-and-focuses-source', 'code.ts')
  await evaluate(`filePreviewProbe.split('code.ts',.5,'light')`)
  await click(select('[data-workbench-region-id="preview-neighbor:code.ts"] .editor-header'))
  await click(select('[data-tree-path="code.ts"] .tree-row__label'))
  await wait(`${active('.monaco-editor')}?.contains(document.activeElement)`)
  const selected = await evaluate('filePreviewProbe.facts()')
  assert.equal(selected.selection.regionId, await evaluate(`filePreviewProbe.geometry('code.ts').regionId`))
  assert.ok(selected.documents[filePreviewKey('code.ts')].content.includes('Typed after clicking the file name'))
  await frame('existing-file-region-reselected', 'code.ts')
  await click(select('[data-tree-path="assets"] .tree-row__label'))
  await wait(`Boolean(${select('[data-tree-path="assets/inside.ts"]')})`)
  report.directoryNameExpanded = true
  await click(select('[data-tree-path="drawing.svg"] .tree-row__label'))
  await wait(`${active('.image-preview__viewport img')}?.naturalWidth>0`)
  assert.equal((await evaluate('filePreviewProbe.facts()')).mainSurface, 'workbench')
  win.setContentSize(780, 520); await paint(); await frame('filename-opens-preview-narrow', 'drawing.svg')
  await click(select('[data-tree-path="code.ts"] .tree-row__label'))
  await wait(`${active('.monaco-editor')}?.contains(document.activeElement)`)
  await evaluate('filePreviewProbe.flush()')
  const facts = await evaluate('filePreviewProbe.facts()')
  report.expected = { tabs: facts.tabs, layouts: facts.layouts, activeWorkspaceId: facts.activeWorkspaceId,
    documents: { [filePreviewKey('code.ts')]: facts.documents[filePreviewKey('code.ts')] }, dirtyDocuments: { [filePreviewKey('code.ts')]: true } }
  await fs.writeFile(path.join(evidence, 'activation-expected.json'), JSON.stringify(report.expected, null, 2))
  assert.ok(reads.some(read => read.path === 'code.ts' && read.status === 'read'))
  assert.equal(writes.length, 0)
  await click(select('[data-tree-path="code.ts"] .tree-row__label'), 'right')
  await wait(`Boolean(${select('.file-context-menu__danger')})`)
  await click(select('.file-context-menu__danger'))
  await wait(`Boolean(${select('[role="dialog"]')})`)
  await click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent==='Cancel')`)
  await wait(`!document.querySelector('[role="dialog"]')`)
  report.menuDeleteCancelled = true
}

async function activationRestart() {
  const expected = JSON.parse(await fs.readFile(path.join(evidence,'activation-expected.json'),'utf8'))
  const actual = await evaluate('filePreviewProbe.beforeFixture')
  assert.deepEqual(actual.tabs,expected.tabs); assert.deepEqual(actual.layouts,expected.layouts)
  assert.equal(actual.activeWorkspaceId,expected.activeWorkspaceId)
  assert.deepEqual(actual.documents[filePreviewKey('code.ts')], expected.documents[filePreviewKey('code.ts')])
  assert.equal(actual.dirtyDocuments[filePreviewKey('code.ts')],true)
  // The restored graph is read before this explicit user-like activation.
  await wait(`Boolean(${select('[data-tree-path="code.ts"] .tree-row__label')})`)
  await click(select('[data-tree-path="code.ts"] .tree-row__label'))
  await wait(`${active('.monaco-editor')}?.contains(document.activeElement)`)
  await frame('original-file-workface-after-restart','code.ts')
  report.durable={passed:true,expected,actual,boundary:'Second ordinary process restores original Tab/Region/Group/layout/focus and dirty source before explicit name activation; native workspace files unchanged.'}
}
async function restart() {
  const expected = JSON.parse(await fs.readFile(path.join(evidence,'expected-durable.json'),'utf8')), actual = await evaluate('filePreviewProbe.beforeFixture')
  assert.deepEqual(actual.tabs,expected.tabs); assert.deepEqual(actual.layouts,expected.layouts); assert.equal(actual.activeWorkspaceId,expected.activeWorkspaceId)
  for(const [key,doc] of Object.entries(expected.documents)){assert.deepEqual(actual.documents[key],doc);assert.equal(actual.dirtyDocuments[key],true)}
  await wait(imageReady('original.png'));await wait(`Array.from(document.querySelectorAll('[data-workbench-region-id="preview-neighbor:original.png"] .monaco-editor .view-line')).map(line=>line.textContent).join(' ').replace(/\\u00a0/g,' ').includes('Current unsaved Markdown')`)
  await frame('renderer-profile-file-restart','original.png'); report.durable={passed:true,expected,actual,boundary:'A second ordinary Electron process reads original durable File Tabs/Regions/layout/focus/dirty documents before any scene setup. Native workspace bytes pass through production preload into the actual WorkspaceFiles owner.'}
}
app.whenReady().then(async()=>{try{
  const { WorkspaceFiles, WORKSPACE_FILE_INVALIDATED_CHANNEL, AgentMuxSpatialStateStore } = await import(nativeModule); files = new WorkspaceFiles(()=>({kind:'local'}))
  spatial = new AgentMuxSpatialStateStore(path.join(profile,'spatial-state.json'))
  ipcMain.handle('spatial:read',()=>spatial.read());ipcMain.handle('spatial:commit',(_event,input)=>spatial.commit(input))
  disposeSpatial = spatial.subscribe(state=>win?.webContents.send('spatial:changed',state))
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
  if(phase==='activation')await activation();else if(phase==='activation-restart')await activationRestart();else if(phase==='restart')await restart();else await capture();assert.equal(report.consoleMessages.some(message=>message.includes('Content Security Policy')),false,'No blocked production media/frame request');report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}; if(win){await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG());report.failureState=await evaluate('({text:document.body.innerText,active:filePreviewProbe.activeRegion()?.outerHTML,focus:document.activeElement?.outerHTML,pointerEvents:getComputedStyle(document.body).pointerEvents,facts:filePreviewProbe.facts()})').catch(()=>null)}}
finally{disposeSpatial?.();for(const dispose of observed.values())await dispose();await files?.dispose();await fs.writeFile(path.join(evidence,phase+'-render.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)}})
