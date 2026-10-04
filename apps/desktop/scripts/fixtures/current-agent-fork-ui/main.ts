import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { RuntimeController } from '../../../src/main/runtime-controller'
const [html,privateRoot,preload,evidence,nodeExecutable,phase='exercise']=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'profile'));app.setPath('sessionData',path.join(privateRoot,'session'))
const nativeRoot=path.join(privateRoot,'native')
const config={version:9,hosts:[{id:'local',kind:'local',label:'Private Mac'}],executors:{private:{providerId:'codex',label:'Private current conversation',command:path.join(privateRoot,'native-cli.mjs'),args:[],env:{PRIVATE_NATIVE_DIRECTORY:nativeRoot,PRIVATE_NATIVE_REQUESTS:path.join(privateRoot,'native-read-requests.jsonl'),CODEX_HOME:path.join(privateRoot,'codex-home')},injectAgentMuxGuide:false}},workspaces:[{id:'fork-workspace',hostId:'local',kind:'folder',name:'Current conversation fork',path:nativeRoot}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}} as any
const store=new AgentMuxFileAgentSessionStore(path.join(privateRoot,'agent-sessions.json')),spatial=new AgentMuxSpatialStateStore(path.join(privateRoot,'spatial.json'))
const runtime=new RuntimeController(store,connectDesktopAgentMuxHost),calls:any[]=[],result:any={passed:false,phase,pid:process.pid,screenshots:[],cases:[],errors:[]}
let win:BrowserWindow,source:any,heldLaunch:Promise<void>|undefined,releaseLaunch:(()=>void)|undefined
ipcMain.handle('native-proof:request',async(_event,operation,...args)=>{
 calls.push({operation,args})
 switch(operation){
 case'setup':return{config,session:source,phase}
 case'providers':return (runtime.rpcClients()[0].client as any).providers.catalog()
 case'snapshot':return runtime.snapshot(config)
 case'attach':return runtime.attachSession(win.webContents.id,args[0],args[1],config)
 case'replay':return runtime.readSessionReplay(win.webContents.id,args[0],args[1])
 case'detach':return runtime.detachSession(win.webContents.id,args[0])
 case'resize':return runtime.resizeSessionAttachment(win.webContents.id,args[0],args[1],args[2])
 case'write':return runtime.write(args[0],args[1],args[2])
 case'paste':return runtime.paste(args[0],args[1],args[2])
 case'resolve':return runtime.resolveSession(args[0],config)
 case'refresh':return runtime.refresh(args[0],config)
 case'history-sources':return runtime.sessionHistorySources()
 case'history-page':return runtime.sessionHistoryPage(args[0],args[1],config)
 case'creation':return runtime.agentCreation(args[0],args[1])
 case'launch':{if(heldLaunch)await heldLaunch;const launched=await runtime.launchAgent(args[0],config);await fs.writeFile(path.join(nativeRoot,launched.created.agentSessionId+'.core-ready'),'Private fork launch returned');return launched}
 case'flush':await win.webContents.session.flushStorageData();return
 case'spatial-read':return spatial.read()
 case'spatial-commit':return spatial.commit(args[0])
 case'spatial-labels':return spatial.retainDisplayLabels(args[0])
 default:throw new Error('Unexpected fork UI private operation '+operation)
 }
})
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 try{
  runtime.commit(await runtime.prepare(config))
  const client=runtime.rpcClients()[0].client
  const until=async(label:string,fn:()=>Promise<any>,budget=20000)=>{const end=Date.now()+budget;do{if(await fn())return;await delay(35)}while(Date.now()<end);throw new Error('Fork UI did not settle: '+label)}
  if(phase==='restore'){
   const ids=JSON.parse(await fs.readFile(path.join(privateRoot,'source-ids.json'),'utf8'))
   source=(await runtime.snapshot(config)).sessions.find(s=>s.id===ids.sessionId)
   assert.equal(source.control.run.runId,ids.runId);assert.equal((await client.statusAgent(source.id)).run.pid,ids.pid)
  }else{
   const launched=await runtime.launchAgent({hostId:'local',executorId:'private',workspacePath:nativeRoot},config)
   await fs.writeFile(path.join(nativeRoot,launched.created.agentSessionId+'.core-ready'),'Original actual creation returned')
   await until('main native FD',async()=>{try{await client.sessionHistoryPage(launched.created.agentSessionId,{refreshNativeSource:true,limit:1,commandOverride:config.executors.private.command,args:config.executors.private.args,env:config.executors.private.env});return !!client.agentSession(launched.created.agentSessionId).nativeHandle}catch{return false}})
   source=(await runtime.snapshot(config)).sessions.find(s=>s.id===launched.created.agentSessionId)
   await fs.writeFile(path.join(privateRoot,'source-ids.json'),JSON.stringify({sessionId:source.id,runId:source.control.run.runId,pid:(await client.statusAgent(source.id)).run.pid}))
  }
  assert.ok(source?.nativeHandle);assert.equal(source?.capabilities.providerFork?.current,true)
  win=new BrowserWindow({width:1280,height:820,useContentSize:true,show:false,webPreferences:{preload,contextIsolation:true,sandbox:true,backgroundThrottling:false}})
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)result.errors.push(message)})
  runtime.attach(win.webContents);await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const read=(code:string)=>win.webContents.executeJavaScript(code)
  const state=()=>read('window.forkState()')
  await until('actual App original Region and live terminal attachment',()=>read('window.forkReady && window.forkLiveReady() && document.querySelector(".agent-region-header__more") && window.forkState().tabs["original-tab"]'))
  const click=async(selector:string)=>{
   const rect=await read(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b)throw new Error('Missing '+${JSON.stringify(selector)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});await delay(50)
  }
  const action=async(text:string)=>{const id='action-'+Date.now();await read(`(()=>{const b=[...document.querySelectorAll('[role=menuitem],button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Missing '+${JSON.stringify(text)});b.id=${JSON.stringify(id)}})()`);await click('#'+id)}
  const escape=async()=>{await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await delay(40)}
  const menu=async()=>{await read('window.forkOriginal()');await click('[data-owner-region-id="original-region"] .agent-region-header__more');await until('original menu',()=>read('!!document.querySelector("[data-current-fork-action]")'))}
  const review=async()=>{await menu();await action('Fork current conversation…');await until('exact reviewed source',()=>read('!!document.querySelector("[data-current-fork-review]")'))}
  const shot=async(label:string)=>{
   for(const width of [1280,760]){win.setContentSize(width,820);await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await read('document.fonts.ready');await delay(40);const name=phase+'-'+label+'-'+width+'.png';await fs.writeFile(path.join(evidence,name),(await win.capturePage()).toPNG());const bounds=await read('(()=>{const e=document.querySelector(".agent-region-menu");const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}:null})()');result.screenshots.push({path:name,width,bounds});assert.ok(bounds);assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1);assert.ok(bounds.scrollWidth<=bounds.clientWidth+1);assert.ok(bounds.y>=-1&&bounds.y+bounds.height<=820+1)}win.setContentSize(1280,820)
  }
  result.initial=await state();result.originalRun=(await client.statusAgent(source.id)).run
  if(phase==='restore'){
   const previous=JSON.parse(await fs.readFile(path.join(evidence,'exercise-electron.json'),'utf8'))
   for(const field of ['tabs','layouts','drafts','spatialRequests'])assert.deepEqual(result.initial[field],previous.final[field],'True App restart retained '+field)
   assert.equal(result.originalRun.pid,previous.originalRun.pid)
   await menu();assert.equal(await read('document.querySelector("[data-current-fork-operation]").dataset.currentForkOperation'),previous.cases.at(-1).operationId)
   await action('Check fork operation');await until('restored original operation inspected',()=>read('!document.querySelector(".agent-region-menu")?.textContent.includes("Checking fork…")'))
   assert.equal(calls.filter(c=>c.operation==='launch').length,0);await shot('fork-restored');result.cases.push({name:'true second Electron intent/operation restore',sourceRunPID:result.originalRun.pid,operationId:previous.cases.at(-1).operationId})
  }else{
  await review();assert.equal(await read('document.querySelectorAll("[data-destination]").length'),5);assert.equal(await read('!!document.querySelector("[data-destination=system]")'),false);await shot('fork-picker');await action('Cancel fork');assert.equal(calls.filter(c=>c.operation==='launch').length,0);await action('Fork current conversation…');await until('toolbar keyboard entry',()=>read('document.activeElement?.dataset.destination==="tab"'));await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});assert.equal(await read('document.activeElement?.dataset.destination'),'up');await escape();await until('Escape dismisses original More menu',()=>read('!document.querySelector(".agent-region-menu")'));assert.equal(calls.filter(c=>c.operation==='launch').length,0);await menu();assert.equal(await read('!!document.querySelector("[data-current-fork-review]")'),false,'Escape must clear the reviewed intent before the menu reopens');await action('Fork current conversation…');await click('[data-destination=tab]')
  await until('new Tab exact launch',async()=>calls.filter(c=>c.operation==='launch').length===1&&(await state()).sessions.length>=2)
  await escape();const first=await state(),newSession=first.sessions.find(s=>s.id!==source.id);assert.ok(newSession);const childRun=(await client.statusAgent(newSession.id)).run;assert.equal(childRun.state,'running');assert.ok(childRun.pid&&childRun.pid!==result.originalRun.pid);assert.ok(Object.keys(first.tabs).length===2);assert.equal(first.drafts[source.id],result.initial.drafts[source.id]);const firstCall=calls.find(c=>c.operation==='launch');assert.equal(firstCall.args[0].forkSource.agentSessionId,source.id);assert.deepEqual(firstCall.args[0].forkSource.expectedNativeHandle,source.nativeHandle);assert.equal((await client.statusAgent(source.id)).run.pid,result.originalRun.pid);result.cases.push({name:'actual new Tab',session:newSession,run:childRun,launch:firstCall})
  await menu();await shot('fork-complete');await escape()
  await read('window.forkDegrade("unsupported")');await menu();assert.equal(await read('document.querySelector("[data-current-fork-action]").getAttribute("aria-disabled")'), 'true');assert.ok(await read('document.querySelector(".agent-region-menu").textContent.includes("does not support")'));await shot('fork-unsupported');await escape()
  await read('window.forkDegrade("unknown")');await menu();assert.equal(await read('document.querySelector("[data-current-fork-action]").getAttribute("aria-disabled")'),'true');assert.ok(await read('document.querySelector(".agent-region-menu").textContent.includes("unconfirmed")'));await shot('fork-source-unknown');await escape();await read('window.forkDegrade("supported")')
  // The actual owner finishes a second fork, then only its UI return receipt is lost.
  await read('window.forkLoseReceipt()');heldLaunch=new Promise(resolve=>releaseLaunch=resolve);await review();await click('[data-destination=right]');await until('second exact intent before Core launch',async()=>calls.filter(c=>c.operation==='launch').length===2);assert.equal((await state()).sessions.length,2);await escape();await menu();const admittedOperation=calls.filter(c=>c.operation==='launch')[1].args[0].createOperationId;assert.equal(await read('document.querySelector("[data-current-fork-operation]").dataset.currentForkOperation'),admittedOperation);assert.equal(await read('document.querySelector("[data-current-fork-action]").getAttribute("aria-disabled")'),'true');await action('Check fork operation');await until('pre-creation read-only inspect',()=>read('!document.querySelector(".agent-region-menu")?.textContent.includes("Checking fork…")'));assert.equal(calls.filter(c=>c.operation==='launch').length,2);await shot('fork-before-launch');await escape();await read('window.forkOriginal()');releaseLaunch!();heldLaunch=undefined;await until('second exact launch returned',async()=>(await state()).sessions.length>=3);await delay(120);assert.equal((await state()).tabs['original-tab'].layout.activeRegionId,'original-region','Late launch must retain deliberately moved focus');await escape();await menu();await until('unknown original operation retained after split remount',()=>read('!!document.querySelector("[data-current-fork-operation]")'));const second=await state();assert.equal(calls.filter(c=>c.operation==='launch').length,2);const operationId=await read('document.querySelector("[data-current-fork-operation]").dataset.currentForkOperation');assert.equal(operationId,calls.filter(c=>c.operation==='launch')[1].args[0].createOperationId);await shot('fork-receipt-unknown');await escape();await menu();assert.equal(await read('document.querySelector("[data-current-fork-operation]").dataset.currentForkOperation'),operationId);await action('Check fork operation');await until('original receipt reconciled',()=>read('!document.querySelector(".agent-region-menu")?.textContent.includes("Checking fork…")'));assert.equal(calls.filter(c=>c.operation==='launch').length,2);await shot('fork-checked');result.cases.push({name:'unknown inspect no repeat',operationId,regions:Object.values(second.tabs).flatMap((tab:any)=>Object.keys(tab.regions))});await escape()
  }
  const before=(await client.statusAgent(source.id)).run.acceptedInputBytes;await runtime.write(source.control,'raw-after-fork','user');assert.ok((await client.statusAgent(source.id)).run.acceptedInputBytes>before)
  await read('window.forkFlush()');result.final=await state();result.spatial=await spatial.read();assert.ok(result.spatial.graph.regions.length>=3);result.calls=calls;result.passed=true
 }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};result.calls=calls;result.failureState=await win?.webContents.executeJavaScript('({state:window.forkState?.(),menu:document.querySelector(".agent-region-menu")?.textContent,active:document.activeElement?.outerHTML,liveReady:window.forkLiveReady?.()})').catch(()=>null);console.error(error)}
 finally{await fs.writeFile(path.join(evidence,phase+'-electron.json'),JSON.stringify(result,null,2));await runtime.dispose();win?.destroy();app.quit()}
})
