const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),{app,BrowserWindow}=require('electron')
const [html,privateRoot,evidence]=process.argv.slice(2),result={passed:false,pid:process.pid,frames:[],checks:[],input:[],editorVisibility:[],errors:[],boundary:'Actual full production App and original Store/ordinary Topic/Files/Source request consumer; controlled public API replies, no real Agent operation or Source filesystem mutation.'}
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));let win
app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({width:1180,height:820,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)result.errors.push(message)})
  await win.loadFile(html,{query:{phase:'seed'}})
  const read=code=>win.webContents.executeJavaScript(code),until=async(code,label)=>{const end=Date.now()+15000;do{if(await read('Boolean('+code+')'))return;await sleep(30)}while(Date.now()<end);throw Error('Original complete App did not settle: '+label)}
  await until('window.filesFrameLayout?.ready && document.querySelector(".workspace-tool-explorer--directory-first .topic-navigation-panel")','original directory-first Topic')
  win.showInactive();win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const click=async(expression,label)=>{
   const hit=await read(`(()=>{const e=${expression};if(!e)throw Error('Missing original control: '+${JSON.stringify(label)});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,actual=document.elementFromPoint(x,y);return {x,y,width:r.width,height:r.height,hit:!!actual&&(e===actual||e.contains(actual)),actual:actual?.outerHTML.slice(0,400)}})()`)
   result.input.push({label,...hit});assert(hit.width>0&&hit.height>0&&hit.hit,'Original Chromium hit test: '+label+' '+JSON.stringify(hit))
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:hit.x,y:hit.y});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:hit.x,y:hit.y});await sleep(80)
  }
  result.baseline=await read('window.filesFrameLayout.facts()')
  for(const service of [false,true]){
   await read('window.filesFrameLayout.service('+service+')');await sleep(120)
   for(const width of [1180,760]){
    win.setContentSize(width,820);await sleep(120)
    const geometry=await read(`(()=>{const root=document.querySelector('.workspace-tool-explorer--directory-first'),nav=root?.querySelector('.topic-navigation-panel'),files=root?.querySelector('.workspace-topic-files'),service=root?.querySelector('.file-operation-service'),group=root?.querySelector('[data-panel-group]');const describe=e=>e?{class:e.className,rect:e.getBoundingClientRect().toJSON(),clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,display:getComputedStyle(e).display,gridTemplateRows:getComputedStyle(e).gridTemplateRows}:null;return {root:describe(root),nav:describe(nav),files:describe(files),service:describe(service),group:describe(group),children:[...root?.children??[]].map(describe),treeRows:[...root?.querySelectorAll('[data-tree-path]')??[]].map(e=>({path:e.dataset.treePath,text:e.textContent,rect:e.getBoundingClientRect().toJSON()}))}})()`)
    result.checks.push({service,width,geometry})
    assert(geometry.root?.rect.height>250&&geometry.nav?.rect.height>100&&geometry.files?.rect.height>34,'Original Topic and Files each retain rendered height')
    assert(geometry.files.rect.bottom<=geometry.root.rect.bottom+1&&geometry.nav.rect.top>=geometry.root.rect.top-1,'Original Topic and Files remain within their original frame')
    assert.equal(!!geometry.service,service,'Source service empty/nonempty follows original component rendering')
    assert(geometry.treeRows.some(row=>row.path.endsWith('/next-step.md')),'Original nonempty FileExplorer rows remain')
    const root="document.querySelector('.workspace-tool-explorer--directory-first')"
    await click(root+".querySelector('[aria-label=\"Show Topics\"]')",'Original Topic navigation '+service+'/'+width)
    await click(root+".querySelector('[data-tree-path$=\"/next-step.md\"]')",'Original file row '+service+'/'+width)
    if(service){
      await click('[...'+root+".querySelectorAll('.file-operation-service button')].find(e=>e.textContent.trim()==='Check original operation')",'Original Source operation inspection '+width)
      const facts=await read('window.filesFrameLayout.facts()');assert(facts.sourceCalls.some(c=>c.operation==='file.mutation.inspect'&&c.params.operationId==='original-retained-files-operation'));assert(facts.sourceFilesInputs.pending['original-retained-files-operation'],'Checking unknown preserves the original request')
    }
    const visibleEditor="[...document.querySelectorAll('.monaco-editor .view-line')].some(e=>{if(!e.textContent.includes('useful')||!e.textContent.includes('step'))return false;const r=e.getBoundingClientRect(),x=r.left+Math.min(r.width,150)/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&hit?.closest('.monaco-editor')===e.closest('.monaco-editor')})"
    await until(visibleEditor,'original nonempty file editor is actually hit-testable')
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await until(visibleEditor,'original nonempty file editor remains presented after paint')
    result.editorVisibility.push({service,width,actualHit:true,afterTwoAnimationFrames:true})
    const file=(service?'service':'empty')+'-'+width+'.png',bytes=(await win.webContents.capturePage()).toPNG();await fs.writeFile(path.join(evidence,file),bytes);result.frames.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),service,width})
   }
  }
  result.final=await read('window.filesFrameLayout.facts()')
  const forbidden=['stop','launchAgent','launchTerminal','write','submitPrompt'];assert.deepEqual(result.final.original.calls.filter(c=>forbidden.includes(c.operation)),result.baseline.original.calls.filter(c=>forbidden.includes(c.operation)),'UI layout performs no new lifecycle or Agent input')
  assert.deepEqual(result.final.original.runs,result.baseline.original.runs);assert.deepEqual(result.final.original.drafts,result.baseline.original.drafts)
  assert(result.final.sourceCalls.filter(c=>c.operation==='file.mutation.inspect').length>=2);assert(!result.final.sourceCalls.some(c=>['file.mkdir','file.move','file.delete'].includes(c.operation)))
  result.passed=true
 }catch(error){result.failure={message:error.message,stack:error.stack};if(win&&!win.isDestroyed()){result.failedFacts=await win.webContents.executeJavaScript('window.filesFrameLayout?.facts()').catch(()=>null);const png=(await win.webContents.capturePage()).toPNG();await fs.writeFile(path.join(evidence,'failure.png'),png)}}
 finally{await fs.writeFile(path.join(evidence,'app.json'),JSON.stringify(result,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}
})
