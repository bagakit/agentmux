const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url')
const {app,BrowserWindow,ipcMain}=require('electron')
const [html,temporary,evidence,phase]=process.argv.slice(2)
app.setPath('userData',path.join(temporary,'user-data'));app.setPath('sessionData',path.join(temporary,'session-data'))
const result={passed:false,phase,pid:process.pid,calls:[],console:[]};let win,unsubscribe
app.whenReady().then(async()=>{try{
  const {AgentMuxSpatialStateStore}=await import(pathToFileURL(path.resolve(__dirname,'../../../../../packages/core/dist/spatial-state.js')).href)
  const spatial=new AgentMuxSpatialStateStore(path.join(temporary,'spatial-state.json'))
  ipcMain.handle('topics-restart:request',async(_event,operation,...args)=>{
    result.calls.push({operation})
    if(operation==='setup')return {phase}
    if(operation==='spatial-read')return spatial.readForLayout()
    if(operation==='spatial-commit')return spatial.commit(args[0])
    if(operation==='spatial-labels')return spatial.retainDisplayLabels(args[0])
    if(operation==='flush')return win.webContents.session.flushStorageData()
    throw Error('Unsupported private layout request: '+operation)
  })
  win=new BrowserWindow({width:1320,height:820,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false,preload:path.join(__dirname,'restart-preload.cjs')}})
  unsubscribe=spatial.subscribe(state=>{if(!win.isDestroyed())win.webContents.send('topics-restart:spatial-change',state)})
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)result.console.push(String(message).slice(0,1200))})
  const read=code=>win.webContents.executeJavaScript(code)
  const click=async selector=>{
    const point=await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
  }
  const until=async(label,code)=>{const end=Date.now()+15000;do{if(await read(code))return;await new Promise(done=>setTimeout(done,40))}while(Date.now()<end);throw Error('Restart scene not ready: '+label)}
  await win.loadFile(html);win.webContents.debugger.attach('1.3')
  await until('original Topics workface','window.topicsRestartReady && topicsRestartFacts().rows===8 && document.querySelectorAll(".editor-pane").length>=2')
  if(phase==='restore'){
    result.restoredBeforeInspection=await read('topicsRestartFacts()')
    const original=JSON.parse(await fs.readFile(path.join(temporary,'expected.json'),'utf8'))
    for(const key of ['tabs','layouts','selection','drafts','documents','dirtyDocuments','collapsed','activeWorkspaceId','mainSurface','focus','regions'])assert.deepEqual(result.restoredBeforeInspection[key],original[key],key+' restores before any presentation interaction')
  }
  // Source/preview is transient. Let the original restored source editor load its
  // original document; Monaco renders spaces as NBSP. No focus-changing inspection
  // is needed to verify the unsaved body and the second file in their own Regions.
  await until('original unsaved file body',`document.querySelector('[data-workbench-region-id="topic-region-0"]')?.textContent.replaceAll('\u00a0',' ').includes('Original unsaved file annotation.')`)
  await until('original second file body',`document.querySelector('[data-workbench-region-id="original-decisions-region"]')?.textContent.replaceAll('\u00a0',' ').includes('Original research workface')`)
  if(phase==='seed'){
    await click('[aria-label="Show file tree"]')
  }
  await until('explicit Files expansion',`document.querySelector('[aria-label="Hide file tree"]')?.getAttribute('aria-expanded')==='true' && document.querySelector('.file-explorer')!==null`)
  await new Promise(done=>setTimeout(done,350))
  result.state=await read('topicsRestartFacts()');result.spatial=await spatial.readForLayout()
  assert.equal(result.state.error,null)
  assert.deepEqual(result.state.controls,[])
  assert.equal(result.state.rows,8)
  assert.equal(result.state.collapsed.__scratch__,false)
  assert.ok(result.spatial.graph.tabs.some(tab=>tab.tabId==='topic-tab-0'))
  if(phase==='seed')await fs.writeFile(path.join(temporary,'expected.json'),JSON.stringify(result.state))
  else{
    const original=JSON.parse(await fs.readFile(path.join(temporary,'expected.json'),'utf8'))
    assert.equal(result.state.seeded,false,'Second process must not seed or reconstruct fixture identities')
    for(const key of ['tabs','layouts','selection','drafts','documents','dirtyDocuments','collapsed','activeWorkspaceId','mainSurface','focus','regions'])assert.deepEqual(result.state[key],original[key],key+' survives the original Core/UI persistence owners')
  }
  await win.webContents.session.flushStorageData()
  await fs.writeFile(path.join(evidence,'topics-restart-'+phase+'.png'),(await win.webContents.capturePage()).toPNG())
  if(phase==='restore'){
    // Exercise the original surface navigation after restore. Focus has no
    // execution contexts here, but retains the original selected file workface.
    await click('[aria-label^="Focus: show execution contexts."]')
    win.setContentSize(320,640)
    await until('narrow original Focus surface',`topicsRestartFacts().mainSurface==='agents' && document.querySelector('.global-focus-surface')?.getBoundingClientRect().width>0`)
    await new Promise(done=>setTimeout(done,200))
    const narrow=await read('topicsRestartFacts()')
    for(const key of ['tabs','layouts','selection','drafts','documents','dirtyDocuments','collapsed','activeWorkspaceId','focus'])assert.deepEqual(narrow[key],result.state[key],key+' remains while the narrow Focus surface is open')
    assert.deepEqual(narrow.controls,[])
    assert.equal(narrow.error,null)
    const geometry=await read(`(()=>{const r=document.querySelector('.global-focus-surface').getBoundingClientRect();const original=document.querySelector('[data-workbench-region-id="topic-region-0"]');const file=original.getBoundingClientRect();return {viewport:innerWidth,x:r.x,width:r.width,height:r.height,file:{x:file.x,y:file.y,width:file.width,height:file.height},bodyVisible:original.textContent.replaceAll('\u00a0',' ').includes('Original unsaved file annotation.')}})()`)
    assert.equal(geometry.viewport,320)
    assert.ok(geometry.width>0&&geometry.x+geometry.width<=320)
    assert.ok(geometry.file.width>0&&geometry.file.height>0&&geometry.file.x>=0&&geometry.file.x+geometry.file.width<=320&&geometry.file.y>=0&&geometry.file.y+geometry.file.height<=640)
    assert.equal(geometry.bodyVisible,true)
    await fs.writeFile(path.join(evidence,'topics-restart-focus-narrow.png'),(await win.webContents.capturePage()).toPNG())
    win.setContentSize(1320,820)
    await click('[aria-label="Space: show terminal and file workbench"]')
    await until('original file workface after returning from Focus',`topicsRestartFacts().mainSurface==='workbench' && document.querySelector('[data-workbench-region-id="topic-region-0"]')?.textContent.replaceAll('\u00a0',' ').includes('Original unsaved file annotation.')`)
    const returned=await read('topicsRestartFacts()')
    for(const key of ['tabs','layouts','selection','drafts','documents','dirtyDocuments','collapsed','activeWorkspaceId','mainSurface','focus','regions'])assert.deepEqual(returned[key],result.state[key],key+' remains after returning from narrow Focus')
    assert.equal(returned.rows,8)
    assert.deepEqual(returned.controls,[])
    result.focusRoundTrip={geometry,narrow,returned,preserved:true,boundary:'Original Focus navigation at 320px and return preserve the restored file workface. No Session exists; this is not Focus Agent/Run recovery evidence.'}
    await fs.writeFile(path.join(evidence,'topics-restart-returned.png'),(await win.webContents.capturePage()).toPNG())
    await win.webContents.session.flushStorageData()
  }
  result.passed=true
}catch(error){result.failure={message:error.message,stack:error.stack};if(win&&!win.isDestroyed()){
  result.observed=await win.webContents.executeJavaScript('window.topicsRestartFacts?.()').catch(()=>null)
  result.visible=await win.webContents.executeJavaScript('[...document.querySelectorAll(".editor-pane")].map(node=>({text:node.textContent,buttons:[...node.querySelectorAll("button")].map(b=>({label:b.getAttribute("aria-label"),title:b.title,text:b.textContent}))}))').catch(()=>null)
  await fs.writeFile(path.join(evidence,'restart-'+phase+'-failure.png'),(await win.webContents.capturePage()).toPNG())
}}
finally{unsubscribe?.();await fs.writeFile(path.join(evidence,'restart-'+phase+'.json'),JSON.stringify(result,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
