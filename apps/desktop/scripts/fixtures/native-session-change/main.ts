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
 case'setup':return{phase,config,ids:phase==='seed'?null:JSON.parse(await fs.readFile(idFile,'utf8'))}
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
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){result.errors.push(message);console.error(message)}})
  runtime.attach(win.webContents);await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const read=(code:string)=>win.webContents.executeJavaScript(code)
  const until=async(label:string,fn:()=>Promise<any>,budget=20000)=>{const end=Date.now()+budget;do{if(await fn())return;await delay(35)}while(Date.now()<end);throw new Error('Native source scene did not settle: '+label)}
  await until('actual original workface and live terminal',()=>read('window.nativeReady && window.nativeLiveReady() && window.nativeState().terminalCount===1'))
  const ids=JSON.parse(await fs.readFile(idFile,'utf8')),client=runtime.rpcClients()[0].client
  const core=async()=> (await client.refreshAgentSession(ids.sessionId,ids.run))
  const run=async()=> (await client.statusAgent(ids.sessionId)).run
  const state=()=>read('window.nativeState()'),facts=()=>read('window.nativeNativeFacts()')
  const persisted=async()=> (await store.load()).find(s=>s.agentSessionId===ids.sessionId)!
  const menu=async()=>{await read('(()=>{const t=document.querySelector(".agent-region-header__more");t.focus();t.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}))})()');await until('original More menu',()=>read('!!document.querySelector(".agent-region-menu")'))}
  const select=async(label:string)=>{await read(`(()=>{const b=[...document.querySelectorAll('[role=menuitem],button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw new Error('Missing actual action '+${JSON.stringify(label)});b.click()})()`);await delay(20)}
  const dismiss=async()=>{await read('document.querySelector(".agent-region-menu")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await delay(25)}
  const command=async(mode:string,id:string)=>{await fs.writeFile(path.join(nativeRoot,ids.sessionId+'.control.json'),JSON.stringify({mode,id}));await until('actual native process FD transition',async()=>{try{return JSON.parse(await fs.readFile(path.join(nativeRoot,ids.sessionId+'.controlled.json'),'utf8')).command.id===id}catch{return false}})}
  const recheck=async()=>{await menu();await select('Check native source');await until('true Core native recheck finished',()=>read('!document.querySelector(".agent-region-menu")?.textContent.includes("Checking source…")'));await dismiss()}
  const raw=async(label:string)=>{
   await read('window.nativeTerminal(); window.terminals.find(t=>t.element?.isConnected).focus();true')
   await until('healthy actual raw terminal',()=>read('window.nativeLiveReady()'))
   const before=(await run()).acceptedInputBytes
   await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'char',text:'z'})
   await until('raw input ACK '+label,async()=> (await run()).acceptedInputBytes>before)
   const after=(await run()).acceptedInputBytes;result.raw??=[];result.raw.push({label,before,after,pid:(await run()).pid})
  }
  const shot=async(label:string)=>{
   for(const width of [1280,760]){
    win.setContentSize(width,820);await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    await read('Promise.allSettled([document.fonts.ready,...document.getAnimations().filter(a=>a.playState==="running"&&Number.isFinite(a.effect?.getComputedTiming().iterations)).map(a=>a.finished)])')
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const capture=await facts()
    if(capture.menuGeometry)assert.ok(capture.menuGeometry.y>=0&&capture.menuGeometry.bottom<=capture.menuGeometry.viewport.height,'Native source menu stays inside the actual viewport')
    result.screenshots.push({label,width,facts:capture,path:`${provider}-${phase}-${label}-${width}.png`})
    await fs.writeFile(path.join(evidence,`${provider}-${phase}-${label}-${width}.png`),(await win.capturePage()).toPNG())
    if(label==='confirm-review'){
     const menu=capture.menuGeometry
     assert.ok(menu&&menu.scrollHeight>menu.clientHeight,'Long source review uses real menu scrolling')
     await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:menu.x+menu.width/2,y:menu.y+menu.height/2,deltaX:0,deltaY:2000})
     await until('real pointer wheel scrolls original More menu',()=>read('window.nativeNativeFacts().menuGeometry.scrollTop>0'))
     await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35})
     await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35})
     await until('real End reaches last enabled original menu action',()=>read('(()=>{const m=window.nativeNativeFacts().menuGeometry;return m.focused===m.lastItem&&m.lastBounds.top>=m.y&&m.lastBounds.bottom<=m.bottom})()'))
     const endFacts=await facts();result.menuReachability??=[];result.menuReachability.push({label,width,geometry:endFacts.menuGeometry})
     result.screenshots.push({label:'menu-end',width,facts:endFacts,path:`${provider}-${phase}-menu-end-${width}.png`})
     await fs.writeFile(path.join(evidence,`${provider}-${phase}-menu-end-${width}.png`),(await win.capturePage()).toPNG())
     await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:menu.x+menu.width/2,y:menu.y+menu.height/2,deltaX:0,deltaY:-2000})
     await until('real wheel returns source review to the start',()=>read('window.nativeNativeFacts().menuGeometry.scrollTop===0'))
    }
   }
  }
  result.initial=await state();result.initialRun=await run();assert.ok(result.initialRun.pid)
  if(phase==='seed'){
   await fs.writeFile(path.join(nativeRoot,ids.sessionId+'.core-ready'),'Run creation returned; actual Hook fixture may begin')
   await until('real Core native binding and pending request',async()=>{const s=await core();return s.nativeHandle?.sessionId==='original-'+ids.sessionId&&s.pendingInteraction})
   await fs.writeFile(path.join(privateRoot,'lose-next-user-ack'),'armed')
   await read('window.terminals.find(t=>t.element?.isConnected).focus();true')
   await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
   await until('real accepted old input kept as unknown',async()=> (await persisted())?.pendingInteraction?.nativeInput?.delivery==='unknown')
   result.lostAck=JSON.parse(await fs.readFile(path.join(privateRoot,'lost-ack.json'),'utf8'))
   result.originalInteraction=(await persisted()).pendingInteraction
   await raw('before-source-change')
   await command('changed','candidate-'+ids.sessionId)
   await client.sessionHistoryPage(ids.sessionId,{refreshNativeSource:true,limit:1,commandOverride:nodeExecutable,args:[path.join(privateRoot,'native-cli.mjs')],env:config.executors.private.env})
   await until('changed native label from actual Core',()=>read('window.nativeNativeFacts().marker==="Source changed"'))
   await shot('changed');await menu();await select('Review source change…');await shot('review');await select('Cancel source change');await dismiss()
  } else {
   const expected=JSON.parse(await fs.readFile(expectedFile,'utf8'))
   for(const field of ['tabs','layouts','drafts','focus','activeWorkspaceId'])assert.deepEqual(result.initial[field],expected[field],field+' retained after real Electron restart')
   assert.equal(result.initialRun.runId,expected.session.control.run.runId);assert.equal(result.initialRun.pid,expected.runPID)
   assert.equal(calls.filter(c=>c.operation==='launch').length,0,'Restart cannot create a new Session')
   if(phase==='adopt'){
    assert.equal((await persisted()).nativeSourceObservation?.state,'changed');assert.deepEqual((await persisted()).pendingInteraction,expected.originalInteraction)
    await raw('candidate-restored')
    await command('unknown','unknown-'+ids.sessionId);await until('actual Native Hook unknown is published before its diagnostic',()=>read('window.nativeNativeFacts().marker==="Source unknown" && window.nativeState().error===null'));await recheck();await until('unknown is explicit',()=>read('window.nativeNativeFacts().marker==="Source unknown"'));await shot('unknown');await menu();assert.equal(await read('document.querySelector(".agent-region-menu").textContent.includes("Review source change…")'),false);await shot('unknown-info');await dismiss()
    const next='current-'+ids.sessionId+'-long-native-id-'+('abcdefghij'.repeat(6));await command('changed',next);await recheck()
    await menu();await select('Review source change…')
    const reviewed=(await core()).observedNativeHandle!
    const newest='newest-'+ids.sessionId;await command('changed',newest)
    await client.sessionHistoryPage(ids.sessionId,{refreshNativeSource:true,limit:1,commandOverride:nodeExecutable,args:[path.join(privateRoot,'native-cli.mjs')],env:config.executors.private.env})
    await select('Confirm this native source');await until('stale exact review refused',()=>read('document.querySelector(".agent-region-menu")?.textContent.includes("changed")'));assert.equal((await core()).nativeHandle!.sessionId,'original-'+ids.sessionId);result.staleReview={reviewed,retained:(await core()).nativeHandle,notice:await read('document.querySelector(".agent-region-menu").textContent')};await shot('stale');await select('Cancel source change');await dismiss()
    await menu();await select('Conversation history');await until('actual original history window',()=>read(`window.nativeNativeFacts().historySource===${JSON.stringify('original-'+ids.sessionId)}`))
    const oldWindow=await read('document.querySelector(".session-history__viewport").textContent');assert.ok(oldWindow.includes('Original history original-'+ids.sessionId),'Original reading window contains actual native records');await menu();await select('Review source change…');await shot('confirm-review');await select('Confirm this native source')
    await until('Core explicit binding persisted',async()=> (await persisted()).nativeHandle!.sessionId===newest)
    assert.equal((await core()).run.runId,ids.run.runId);assert.deepEqual((await persisted()).nativeConfirmation?.previousInteraction,expected.originalInteraction)
    result.confirmation=(await persisted()).nativeConfirmation
    await dismiss();assert.equal(await read('document.querySelector(".session-history__viewport").textContent'),oldWindow,'Confirmation retains original reading window')
    await select('Latest');await until('previous exact source re-read',()=>read(`window.nativeNativeFacts().historySource===${JSON.stringify('original-'+ids.sessionId)}`));assert.ok(calls.some(c=>c.operation==='history-page'&&c.args[1]?.nativeSource==='previous'))
    await shot('previous-history');await select('Current source');await until('independent current history',()=>read(`window.nativeNativeFacts().historySource===${JSON.stringify(newest)}`));await shot('current-history');await select('Terminal');await raw('confirmed-source')
    assert.equal((await facts()).marker,undefined);assert.equal((await state()).error,null,'Confirmed source leaves no resolved observation error');await shot('confirmed')
   } else {
    assert.equal((await facts()).marker,undefined);assert.equal((await state()).error,null,'Restored confirmed source stays quiet');assert.ok((await persisted()).nativeConfirmation);assert.deepEqual((await persisted()).nativeConfirmation?.previousInteraction,expected.originalInteraction);await raw('confirmed-restored');await shot('restored')
   }
  }
  result.saved=await state();result.saved.runPID=(await run()).pid;result.saved.originalInteraction=phase==='seed'?result.originalInteraction:JSON.parse(await fs.readFile(expectedFile,'utf8')).originalInteraction
  assert.equal(result.saved.drafts[ids.sessionId],'Keep this unsent draft');assert.equal(result.saved.session.control.run.runId,ids.run.runId);assert.equal((await run()).pid,result.initialRun.pid);result.persisted=await persisted();result.spatial=await spatial.read();assert.ok(result.spatial?.graph.tabs.length)
  await fs.writeFile(expectedFile,JSON.stringify(result.saved));await read('window.nativeFlush()');result.calls=calls;result.passed=true
 }catch(error:any){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())result.observationAtFailure=await win.webContents.executeJavaScript('window.nativeNativeFacts?.()').catch(()=>null);result.calls=calls;result.diagnostics={owner:await fs.readFile(path.join(privateRoot,'owner-diagnostic.jsonl'),'utf8').catch(()=>''),hooks:await fs.readdir(nativeRoot).then(async files=>Object.fromEntries(await Promise.all(files.filter(f=>f.endsWith('.hooks.jsonl')).map(async f=>[f,await fs.readFile(path.join(nativeRoot,f),'utf8')]))))};console.error(error)}
 finally {await runtime.dispose().catch(error=>{result.cleanupFailure=String(error);result.passed=false});await fs.writeFile(path.join(evidence,provider+'-'+phase+'.json'),JSON.stringify(result,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}
})
