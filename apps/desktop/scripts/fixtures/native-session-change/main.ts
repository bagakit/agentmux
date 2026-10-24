import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { RuntimeController } from '../../../src/main/runtime-controller'
const [html,privateRoot,provider,phase,preload,evidence,nodeExecutable]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'profile-'+provider));app.setPath('sessionData',path.join(privateRoot,'session-'+provider))
const nativeRoot=path.join(privateRoot,'native-'+provider)
const config={version:9,hosts:[{id:'local',kind:'local' as const,label:'Private Mac'}],executors:{private:{providerId:provider,label:'Private '+provider,command:nodeExecutable,args:[path.join(privateRoot,'native-cli.mjs')],env:{PRIVATE_NATIVE_DIRECTORY:nativeRoot,PRIVATE_NATIVE_REQUESTS:path.join(privateRoot,'native-read-requests.jsonl'),CODEX_HOME:path.join(privateRoot,'codex-home'),CLAUDE_CONFIG_DIR:path.join(privateRoot,'claude-home')},injectAgentMuxGuide:false}},workspaces:[{id:'native-workspace',hostId:'local',kind:'folder' as const,name:'Native source proof',path:nativeRoot}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}} as any
const store=new AgentMuxFileAgentSessionStore(path.join(privateRoot,'agent-sessions.json'))
const spatial=new AgentMuxSpatialStateStore(path.join(privateRoot,'spatial-'+provider+'.json'))
const runtime=new RuntimeController(store,connectDesktopAgentMuxHost),calls:any[]=[],result:any={phase,provider,pid:process.pid,passed:false,screenshots:[],errors:[]}
let win:BrowserWindow
const idFile=path.join(privateRoot,provider+'-ids.json'),expectedFile=path.join(privateRoot,provider+'-expected.json')
ipcMain.handle('native-proof:request',async(_event,operation,...args)=>{
 calls.push({operation,args})
 switch(operation){
 case'setup':return{phase,config,ids:phase==='select'?null:JSON.parse(await fs.readFile(idFile,'utf8'))}
 case'launch':return runtime.launchAgent({hostId:'local',executorId:'private',workspacePath:nativeRoot},config)
 case'snapshot':return runtime.snapshot(config)
 case'providers':return (runtime.rpcClients()[0].client as any).providers.catalog()
 case'attach':return runtime.attachSession(win.webContents.id,args[0],args[1],config)
 case'replay':return runtime.readSessionReplay(win.webContents.id,args[0],args[1])
 case'detach':return runtime.detachSession(win.webContents.id,args[0])
 case'resize':return runtime.resizeSessionAttachment(win.webContents.id,args[0],args[1],args[2])
 case'write':return runtime.write(args[0],args[1],args[2])
 case'paste':return runtime.paste(args[0],args[1],args[2])
 case'respond':return runtime.respondInteraction(args[0],args[1])
 case'resolve':return runtime.resolveSession(args[0],config)
 case'refresh':return runtime.refresh(args[0],config)
 case'history-sources':return runtime.sessionHistorySources()
 case'history-page':return runtime.sessionHistoryPage(args[0],args[1],config)
 case'confirm-native':return runtime.confirmNativeSession(args[0],args[1])
 case'save-ids':await fs.writeFile(idFile,JSON.stringify(args[0]));return
 case'flush':await win.webContents.session.flushStorageData();return
 case'spatial-read':return spatial.read()
 case'spatial-commit':return spatial.commit(args[0])
 case'spatial-labels':return spatial.retainDisplayLabels(args[0])
 default:throw new Error('Unexpected private native operation: '+operation)
 }
})
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 try {
  runtime.commit(await runtime.prepare(config))
  win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{preload,contextIsolation:true,sandbox:true,backgroundThrottling:false}})
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)result.errors.push(message)})
  runtime.attach(win.webContents);await win.loadFile(html)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const read=(code:string)=>win.webContents.executeJavaScript(code)
  const until=async(label:string,fn:()=>Promise<any>,budget=20000)=>{
   const end=Date.now()+budget
   do {if(await fn())return;await delay(35)} while(Date.now()<end)
   throw new Error('Native target scene did not settle: '+label)
  }
  await until('original workface and live terminal',()=>read('window.nativeReady && window.nativeLiveReady() && window.nativeState().terminalCount===1'))
  const ids=JSON.parse(await fs.readFile(idFile,'utf8')),client=runtime.rpcClients()[0].client
  const core=()=>client.refreshAgentSession(ids.sessionId,ids.run)
  const run=async()=> (await client.statusAgent(ids.sessionId)).run
  const persisted=async()=> (await store.load()).find(s=>s.agentSessionId===ids.sessionId)!
  const state=()=>read('window.nativeState()'),facts=()=>read('window.nativeNativeFacts()')
  await read('window.originalTerminalForProof=window.nativeTerminalNode();true')
  const click=async(selector:string,label?:string)=>{
   const point=await read(`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>${label===undefined?'true':`node.textContent.trim()===${JSON.stringify(label)}`});if(!element)throw new Error('Missing product action');element.scrollIntoView({block:'nearest'});const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
  }
  const key=async(value:string)=>{
   await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:value,code:value})
   await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:value,code:value})
  }
  const dismiss=async()=>{
   if(!await read('!!document.querySelector("[data-menu-entry=more]")'))return
   for(let count=0;count<3&&await read('!!document.querySelector("[data-menu-entry=more]")');count++){await key('Escape');await delay(30)}
   await until('menu dismissed and original trigger focus restored',()=>read('!document.querySelector("[data-menu-entry=more]") && document.activeElement===document.querySelector(".agent-region-header__more")'))
  }
  const menu=async()=>{
   await dismiss();await click('.agent-region-header__more')
   await until('original More menu',()=>read('!!document.querySelector("[data-menu-entry=more]")'))
   await click('[role=menuitem]','Session details')
   await until('original Session details submenu',()=>read('!!document.querySelector(".agent-region-menu__details .agent-native-source")'))
  }
  const select=(label:string)=>click('[role=menuitem],button',label)
  const recheck=async()=>{
   await menu();await select('Check native source')
   await until('source discovery returned',()=>read('!document.querySelector(".agent-region-menu__details")?.textContent.includes("Checking source…")'))
   await dismiss()
  }
  const members=async(values:string[])=>{
   const id=globalThis.crypto.randomUUID()
   await fs.writeFile(path.join(nativeRoot,ids.sessionId+'.control.json'),JSON.stringify({id,members:values}))
   await until('private native actor holds exact members',async()=>{
    try{return JSON.parse(await fs.readFile(path.join(nativeRoot,ids.sessionId+'.controlled.json'),'utf8')).command.id===id}catch{return false}
   })
   await recheck()
  }
  const shot=async(label:string)=>{
   for(const mode of ['dark','light'])for(const width of [1280,760]){
    win.setContentSize(width,820)
    assert.equal(await read(`window.nativeTheme(${JSON.stringify(mode)}).applied`),true)
    await read('Promise.allSettled([document.fonts.ready,...document.getAnimations().filter(a=>a.playState==="running"&&Number.isFinite(a.effect?.getComputedTiming().iterations)).map(a=>a.finished)])')
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const observation=await facts(),geometry=observation.menuGeometry
    if(geometry)assert.ok(geometry.y>=0&&geometry.bottom<=geometry.viewport.height,'Actual Session details stays inside the viewport')
    assert.equal(observation.state.terminalCount,1)
    assert.equal(await read('window.nativeTerminalNode()===window.originalTerminalForProof'),true,'Original terminal component remains mounted')
    const file=`${phase}-${label}-${mode}-${width}.png`,image=await win.capturePage()
    assert.equal(image.isEmpty(),false)
    await fs.writeFile(path.join(evidence,file),image.toPNG())
    result.screenshots.push({label,mode,width,file,facts:observation})
   }
  }
  const raw=async()=>{
   await dismiss();await read('window.nativeTerminalNode().focus();true')
   const before=(await run()).acceptedInputBytes
   await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'char',text:'z'})
   await until('original healthy raw input ACK',async()=> (await run()).acceptedInputBytes>before)
   result.raw={before,after:(await run()).acceptedInputBytes}
  }
  const workface=async()=>{
   const value=await state()
   return{tabs:value.tabs,layouts:value.layouts,drafts:value.drafts,focus:value.focus,activeWorkspaceId:value.activeWorkspaceId}
  }
  const targetA='original-'+ids.sessionId,targetB='selected-'+ids.sessionId+'-'+('reader'.repeat(7))
  result.initialRun=await run();assert.ok(result.initialRun.pid)
  const originalWorkface=await workface()
  if(phase==='select'){
   await fs.writeFile(path.join(nativeRoot,ids.sessionId+'.core-ready'),'Original Run creation returned')
   await until('original native binding',async()=> (await core()).nativeHandle?.sessionId===targetA)
   await members([])
   await until('unknown observation',async()=> (await core()).nativeSourceObservation?.state==='unknown')
   await menu();await shot('unknown');await dismiss();await raw()
   await members([targetA,targetB])
   await until('verified main candidates',async()=> (await core()).nativeSourceObservation?.candidates?.length===2)
   await menu();await shot('candidates')
   const count=()=>calls.filter(call=>call.operation==='confirm-native').length
   const before=count()
   await select('Choose target: '+targetB)
   await until('explicit reviewed target',()=>read('document.querySelector("[data-native-source-review]")?.textContent.includes("Confirm conversation target?")'))
   await shot('review');await select('Cancel source change')
   assert.equal(count(),before,'Cancelling the review sends no confirmation')
   assert.equal((await persisted()).nativeHandle?.sessionId,targetA)
   const choose=async(target:string)=>{
    await menu();await select('Choose target: '+target);await select('Confirm this native source')
    await until('exact explicit target persisted',async()=>{
     const session=await persisted()
     return session.nativeHandle?.sessionId===target&&session.nativeBinding?.source==='user-selected'
    })
    await until('selected marker from actual Core projection',()=>read('window.nativeNativeFacts().marker==="Target selected"'))
    const invocation=calls.filter(call=>call.operation==='confirm-native').at(-1)
    assert.equal(invocation.args[1].candidateNativeHandle.sessionId,target)
    assert.ok(invocation.args[1].operationId)
    assert.equal((await core()).nativeSourceObservation?.state,'ambiguous','Choosing a semantic target does not invent terminal selection')
    await dismiss()
   }
   await choose(targetB);await menu();await shot('selected-b');await dismiss()
   await choose(targetA);await menu();await shot('selected-a');await dismiss()
   await choose(targetB);await raw()
   assert.equal(calls.filter(call=>call.operation==='launch').length,1)
   assert.deepEqual(await workface(),originalWorkface,'Target selection retains the original workface and draft')
   await fs.writeFile(expectedFile,JSON.stringify({workface:await workface(),run:await run(),target:targetB,confirmation:(await persisted()).nativeConfirmation}))
  }else{
   assert.equal(phase,'restore')
   const expected=JSON.parse(await fs.readFile(expectedFile,'utf8'))
   assert.deepEqual(await workface(),expected.workface,'Independent Electron process restores original workface')
   assert.equal((await run()).pid,expected.run.pid)
   assert.equal((await run()).runId,expected.run.runId)
   assert.equal(calls.filter(call=>call.operation==='launch').length,0,'Restore cannot create a new Session')
   assert.equal((await persisted()).nativeHandle?.sessionId,expected.target)
   assert.equal((await persisted()).nativeBinding?.source,'user-selected')
   assert.deepEqual((await persisted()).nativeConfirmation,expected.confirmation)
   await menu();await shot('selected-restored');await raw()
  }
  result.saved=await state();result.persisted=await persisted();result.spatial=await spatial.read()
  assert.equal(result.saved.drafts[ids.sessionId],'Keep this unsent draft')
  assert.equal(result.saved.session.control.run.runId,ids.run.runId)
  assert.equal((await run()).pid,result.initialRun.pid)
  assert.ok(result.spatial?.graph.tabs.length)
  await read('window.nativeFlush()');result.calls=calls;result.passed=true
 }catch(error:any){
  result.failure={name:error.name,message:error.message,stack:error.stack};result.calls=calls
  if(win&&!win.isDestroyed()){
   result.observationAtFailure=await win.webContents.executeJavaScript('window.nativeNativeFacts?.()').catch(()=>null)
   await fs.writeFile(path.join(evidence,phase+'-failure.png'),(await win.capturePage()).toPNG()).catch(()=>undefined)
  }
  console.error(error)
 }finally{
  await runtime.dispose().catch(error=>{result.cleanupFailure=String(error);result.passed=false})
  await fs.writeFile(path.join(evidence,provider+'-'+phase+'.json'),JSON.stringify(result,null,2))
  if(win&&!win.isDestroyed())win.destroy()
  app.exit(result.passed?0:1)
 }
})
