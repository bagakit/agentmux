import assert from 'node:assert/strict'
import { startAgentMuxHost } from '../../../../../apps/host/src/host'
import { persistentTask } from './persistent-task'
import { admissionGeometry } from './admission-geometry'
import { profileSwitchPorts } from './profile-switch-ports'
import { profileSwitchCase } from './profile-switch-case'
import { surfaceWindowsCase } from './surface-windows-case'
import { completeCase } from './complete-case'
import { completePorts } from './complete-ports'
import { contextMenuCase } from './context-menu-case'
import { addressSelectionCase } from './address-selection-case'
import { cliFollow } from './cli-follow'
import { browserProfilePartition } from '../../../src/main/browser-profile-store'
import { settingsCase } from './settings-case'
import { surveyBrowsingCase } from './survey-browsing-case'
import { settingsLayoutCase } from './settings-layout-case'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session, type WebContentsView } from 'electron'
import { AgentMuxFileAgentSessionStore, connectHostedAgentMux, connectAgentMuxRpc } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'

const directory = process.env.AGENTMUX_PROFILE_SURVEY_ROOT!, source = process.env.AGENTMUX_PROFILE_SURVEY_SOURCE!, phase = process.env.AGENTMUX_PROFILE_SURVEY_PHASE!
const selectedCase = process.env.AGENTMUX_PROFILE_SURVEY_CASE!, workspaceId = 'profile-survey-workspace', legacyWorkspaceId = 'profile-survey-legacy-workspace', pageUrl = process.env.AGENTMUX_PROFILE_SURVEY_PAGE_URL!
if (selectedCase === 'address-selection') app.commandLine.appendSwitch('host-resolver-rules', 'MAP www.google.com ~NOTFOUND')
assert.ok(directory && source && ['first','restart'].includes(phase))
app.on('window-all-closed', () => {})
const receipt: any = { schema: 'agentmux.browser-profile-survey-workface.native.v1', phase, selectedCase, pid: process.pid, passed: false, businessPassed: false, cases: [], cli: [], ipc: [], closeCalls: [], frames: [], physicalInputQualified: false, independentVisualReview: 'not-performed', boundary: 'Actual production App/Survey/Region projection, full preload/registerIpc/Core/compiled CLI and private native pages in two PIDs. Repository fake Provider over actual ctxmux is not an authenticated upstream model or user Session. CDP/explicit fixture input is not physical OS input.' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T> | T, label: string, budget = 15000): Promise<T> {
  const deadline = Date.now() + budget
  do { const value = await read(); if (value) return value; await delay(30) } while (Date.now() < deadline)
  throw new Error('Private Browser handoff observation did not confirm: ' + label)
}
let window: BrowserWindow | undefined, core: any, sdk: any, rpc: any, hosted: any, hostServer: any, runtime: RuntimeController | undefined,
  privateHost: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined, releaseIpc: (() => Promise<void>) | undefined, windows: WorkbenchWindows | undefined, access: any
let releaseObservationFaults = () => {}
async function cliEnvironment(actor?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json') })
  if (actor) {
    const credential = JSON.parse(await readFile(join(directory, actor + '-credential.json'), 'utf8'))
    Object.assign(env, { AGENTMUX_AGENT_SESSION_ID: credential.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credential.capability })
  }
  return env
}
async function cli(args: string[], code = '', actor?: string): Promise<any> {
  const env=await cliEnvironment(actor)
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.AGENTMUX_PROFILE_SURVEY_NODE!, [process.env.AGENTMUX_PROFILE_SURVEY_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private CLI observation did not complete')) }, 25000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      try { const raw = stdout.trim() || stderr.trim(), value = JSON.parse(raw)
        receipt.cli.push({ args, actor: actor ?? 'person', code, value }); resolve({ code, value })
      } catch { reject(new Error('Private CLI returned no original JSON receipt: ' + stdout + stderr)) }
    })
    child.stdin.end(code)
  })
}

function nativePage(window: BrowserWindow, url: string, profileId: string) {
 const matches=window.contentView.children.filter((view:any)=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===url) as WebContentsView[]
 assert.ok(matches.length<=1,'Only one exact fixture URL may identify this private native page')
 const view=matches[0];if(!view)return null
 assert.ok(typeof view.webContents.session.storagePath==='string'&&view.webContents.session.storagePath.startsWith(directory),'Only this private persistent native partition may be observed')
 assert.equal(view.webContents.session,session.fromPartition(browserProfilePartition(profileId)),'Main-confirmed Profile must own the actual native Session')
 return {contentsId:view.webContents.id,visible:view.getVisible(),bounds:view.getBounds(),loading:view.webContents.isLoading(),storagePath:view.webContents.session.storagePath,url:view.webContents.getURL()}
}
async function result(args: string[], input = '') { const value = await cli(args,input); assert.equal(value.code,0,JSON.stringify(value.value)); assert.equal(value.value.ok,true); return value.value.result }
async function run() {
 await app.whenReady()
 if (phase === 'first') { await mkdir(join(directory,'state'),{recursive:true}); await mkdir(join(directory,'workspace'),{recursive:true}); await mkdir(join(directory,'legacy-workspace'),{recursive:true}); if(selectedCase==='profile-switch'||selectedCase==='complete'||selectedCase==='surface-windows'){await mkdir(join(directory,'notes'),{recursive:true});await writeFile(join(directory,'legacy-workspace/original.txt'),'Original complete research input.')} await writeFile(join(directory,'workspace/original.txt'),'Original authorized Workspace file.'); await writeFile(join(directory,'state/notes-location.json'),JSON.stringify({schemaVersion:1,directory:join(directory,'notes'),operations:{},pending:null})) }
 const store = new AgentMuxFileAgentSessionStore(join(directory,'sessions.json'))
 const configStore=new ConfigStore(join(directory,'config.json'))
 const initial={...structuredClone(DEFAULT_CONFIG),hosts:[{id:'local',kind:'local',label:'Private Profile Survey proof'}],workspaces:[{id:workspaceId,name:'Private mixed task',kind:'folder',hostId:'local',path:join(directory,'workspace')},{id:legacyWorkspaceId,name:'Original whole-Zone exploration',kind:'folder',hostId:'local',path:join(directory,'legacy-workspace')}],executors:{proof:{providerId:'codex',label:'Private synthetic Provider',command:join(source,'packages/core/test/fixtures/fake-codex-cli.mjs'),args:[],injectAgentMuxGuide:false,env:{AGENTMUX_FAKE_READY_MODE:'before',AGENTMUX_FAKE_NATIVE_RECORD:'1',AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY:join(directory,'native-records')}}},browser:{...DEFAULT_CONFIG.browser,agentAutomation:true},notifications:{mode:'off'}}
 if(selectedCase==='complete')(initial.executors.proof.env as Record<string,string>).AGENTMUX_FAKE_CAPABILITY_RECEIPT=join(directory,'workface-credential.json')
 let config=phase==='first'?await configStore.save(initial as any):await configStore.get()
 if(selectedCase==='profile-switch'||selectedCase==='complete'||selectedCase==='surface-windows'||selectedCase==='survey-browsing'||selectedCase==='settings-layout')config=await configStore.get()
 privateHost=await startAgentMuxHost({store,socketPath:join(directory,'semantic.sock'),desktopSocketPath:desktopBusinessSocketPath(),configurationPath:configStore.filePath,mobilePort:0,mobileBuildDirectory:join(directory,'no-mobile-assets')})
 core=privateHost.client;hosted=privateHost.hosted;hostServer=privateHost.server
 rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:join(directory,'semantic.sock')}})
 sdk=await connectHostedAgentMux({rpc,subscribeRpc:rpc.subscribe.bind(rpc),forwardRpc:(method,params,context,expectedOwner)=>rpc.call(method,params,{...(context?.signal?{signal:context.signal}:{}),...(context?.caller?{credentials:context.caller}:{}),...(expectedOwner?{runtimeFence:expectedOwner}:{})})})
 runtime=new RuntimeController(store,async()=>sdk)
 app.setActivationPolicy?.('prohibited')
 window=new BrowserWindow({width:1280,height:900,show:false,title:'Private Profile Survey workface',webPreferences:{preload:join(directory,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
 const contents=window.webContents; contents.on('console-message',(event:any)=>{if(event.level==='error')console.error('Profile Survey Renderer:',event.message)})
 windows=new WorkbenchWindows(window,new WorkbenchWindowStore(join(directory,'windows.json')),()=>[{x:0,y:0,width:1600,height:1000}])
 if(selectedCase==='complete'||selectedCase==='surface-windows'){
  // Same thin Main bootstrap wiring as production index.ts; policy stays in WorkbenchWindows.
  contents.setWindowOpenHandler(details=>{
   const outcome=windows!.windowOpen(details,()=>{throw new Error('External App opening is outside this private fixture')})
   ;(receipt.auxiliaryBootstrap??=[]).push({event:'window-open',senderContentsId:contents.id,path:new URL(details.url).pathname,outcome:outcome.action})
   return outcome
  })
  contents.on('did-create-window',(child,details)=>{
   windows!.createdWindow(child,details)
   const url=new URL(details.url)
   ;(receipt.auxiliaryBootstrap??=[]).push({event:'did-create-window',senderContentsId:contents.id,contentsId:child.webContents.id,path:url.pathname,windowId:url.searchParams.get('window'),documentGeneration:url.searchParams.get('document')})
  })
 }
 access=createDesktopApplicationAccessOwner(runtime,join(directory,'application-access.sqlite'))
 let rejectSurveyWrites=false, rejectedWrites=0, rejectedSurveyBrowserId:string|null=null, loseProfileDirectoryAck=selectedCase==='profile-switch'&&phase==='first'
 const switchPorts=selectedCase==='profile-switch'||selectedCase==='complete'?profileSwitchPorts(window,receipt,enabled=>{loseProfileDirectoryAck=enabled},browserId=>{rejectSurveyWrites=browserId!==null;rejectedSurveyBrowserId=browserId},()=>{rejectSurveyWrites=true;rejectedSurveyBrowserId=null}):null
 const completeObserver=['complete','context-menu','address-selection'].includes(selectedCase)?completePorts(receipt):null
 const completeReaders:ReturnType<typeof cliFollow>[]=[]
 let holdProbeAck=false, releaseProbeAck: ((lose:boolean)=>void)|undefined
 let releaseAddressDetails: (() => void) | undefined
 const releaseDetails = () => { receipt.addressDetailsReleased = true; releaseAddressDetails?.() }
 const probeAck={hold(){holdProbeAck=true},release(lose:boolean){releaseProbeAck?.(lose)}}
 releaseObservationFaults=()=>{switchPorts?.dispose();completeObserver?.dispose();for(const reader of completeReaders)void reader.dispose();rejectSurveyWrites=false;loseProfileDirectoryAck=false;probeAck.release(false)}
 const userState=new WorkbenchUserStateStore(join(directory,'workbench-user-state.json'))
 const originalSend=contents.send.bind(contents);contents.send=(channel,...args)=>{completeObserver?.event(channel,args);if(loseProfileDirectoryAck&&channel==='browser:profilesChanged'){receipt.droppedProfileListPushes=(receipt.droppedProfileListPushes??0)+1;return}if(switchPorts?.observeSend(channel,args,originalSend))return;originalSend(channel,...args)}
 const originalHandle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>originalHandle(channel,async(event,...args)=>{
  if(channel.startsWith('browser:')||channel==='ui:writeWorkbenchState'||selectedCase==='complete'&&channel.startsWith('ui:workbenchWindows'))receipt.ipc.push({channel,exactSender:event.sender===contents,exactFrame:event.senderFrame===contents.mainFrame})
  if (channel === 'ui:writeWorkbenchState' && rejectSurveyWrites) {
    const request = JSON.parse(args[0].value)
    if (request.state?.surveyPageReferences?.some((page: { browserId: string }) => page.browserId === rejectedSurveyBrowserId)) {
      rejectedWrites++
      if (selectedCase === 'profile-switch') (receipt.profileSwitchPreferenceFailures ??= []).push({ browserId: rejectedSurveyBrowserId })
      throw Object.assign(new Error('Private fixture original preference writer unavailable'), { code: 'EIO' })
    }
  }
  if (selectedCase === 'address-selection' && channel === 'browser:listInputHistory' && args[1] !== 'saved' && !receipt.addressDetailsReleased) {
   receipt.addressDetailsHeld = true
   await new Promise<void>(resolve => { releaseAddressDetails = resolve })
  }
  const close=channel==='browser:close'?{browserId:args[0],ack:'pending'}:null
  if(close)receipt.closeCalls.push(close)
  let observed
  try{observed=await(switchPorts?switchPorts.observe(channel,args,async()=>handler(event,...args)):handler(event,...args));if(close)close.ack='confirmed'}catch(error){if(close)close.ack='failed';throw error}
  if (channel === 'workbenchClose:call') (receipt.workbenchCloseCalls ??= []).push({ method: args[0], result: observed })
  if(channel==='browser:create'&&rejectSurveyWrites)rejectedSurveyBrowserId=observed.id
  if(channel==='browser:choosePageMenu')(receipt.pageMenuChoices??=[]).push({choice:args[1],accepted:observed})
  if(['browser:listProfiles','browser:readProfiles'].includes(channel)&&loseProfileDirectoryAck)throw new Error('Private fixture lost the original Profile directory read ACK')
  if(channel==='browser:probeProfileNetwork'&&holdProbeAck){receipt.originalProbeReply=observed;const lose=await new Promise<boolean>(resolve=>{releaseProbeAck=resolve});holdProbeAck=false;if(lose)throw new Error('Private fixture lost the original probe ACK; inspect the same operation')}
  return observed
 })
 releaseIpc=await registerIpc({appDocumentSources:()=>({current:{mode:'prod',filePath:join(directory,'renderer/index.html')},loading:null}),window,workbenchWindows:windows,initialConfig:config,configStore,runtime,applicationAccess:access,workbenchUserState:userState,scratchTopics:new ScratchTopics()})
 await window.loadFile(join(directory,'renderer/index.html'));window.showInactive()
 receipt.loadedPrograms={main:import.meta.url,cli:process.env.AGENTMUX_PROFILE_SURVEY_CLI,preloadConfigured:join(directory,'preload.cjs'),renderer:contents.getURL()}
 const evaluate=(expression:string)=>contents.executeJavaScript(expression)
 await until(()=>evaluate('Boolean(window.profileSurveyNative)&&!profileSurveyNative.read().loading'),'production App initialization',45000)
 const facts=()=>evaluate('profileSurveyNative.read()')
 const click=async(selector:string)=>{const point=await until(()=>evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.checkVisibility());if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`),'actual pointer target');for(const type of ['mouseMoved','mousePressed','mouseReleased'])await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});await delay(80)}
 receipt.initial=await facts()
 assert.ok(await evaluate('Boolean(document.querySelector(".surface-navigation"))'),'Full production App must mount')
 if (selectedCase === 'address-selection') {
  assert.ok(completeObserver)
  await addressSelectionCase({ directory, window, observation: completeObserver, evaluate, result, receipt, workspaceId, pageUrl, releaseDetails })
  receipt.businessPassed = true; receipt.passed = true; return
 }
 if(selectedCase==='context-menu'){
  assert.ok(completeObserver)
  receipt.boundary='Two private production Desktop App processes with original BrowserViewManager, Renderer, preload and CLI. Chromium receives guest and chrome pointer and key events. The fixture supplies the native window focus observation and never operates the current user App.'
  await contextMenuCase({phase,directory,window,observation:completeObserver,evaluate,result,cli,receipt,workspaceId,pageUrl,
   runId:sessionId=>core?.agentSession(sessionId)?.run?.runId})
  receipt.businessPassed=true;receipt.passed=true;return
 }
 if(selectedCase==='complete'){
  assert.ok(switchPorts&&completeObserver)
  await completeCase({phase,directory,window,core,store,evaluate,result,cli,receipt,ports:switchPorts,observation:completeObserver,taskWorkspaceId:workspaceId,pageUrl,
   follow:async(operationId:string)=>{const reader=cliFollow(process.env.AGENTMUX_PROFILE_SURVEY_NODE!,process.env.AGENTMUX_PROFILE_SURVEY_CLI!,'unix:'+desktopBusinessSocketPath(),await cliEnvironment('workface'),operationId,receipt);completeReaders.push(reader);return reader}})
  assert.equal(receipt.complete?.completed,true,'Only the dedicated nonempty complete workface oracle may qualify T004')
  receipt.businessPassed=true;receipt.passed=true;return
 }
 if (selectedCase === 'surface-windows') {
  await surfaceWindowsCase({ phase, directory, window, result, cli, evaluate, workspaceId, pageUrl, core, receipt })
  await windows.prepareQuit()
  receipt.businessPassed=true; receipt.passed=true; return
 }
 if(selectedCase==='settings'){await settingsCase({phase,directory,window,evaluate,result,receipt,probeAck});receipt.businessPassed=true;receipt.passed=true;return}
 if (selectedCase === 'survey-browsing') {
  await surveyBrowsingCase({ phase, directory, window, evaluate, result, receipt, pageUrl })
  receipt.businessPassed = true; receipt.passed = true; return
 }
 if (selectedCase === 'settings-layout') {
  contents.debugger.attach('1.3')
  await settingsLayoutCase({ phase, directory, window, evaluate, click, result, receipt, pageUrl })
  receipt.businessPassed = true; receipt.passed = true; return
 }
 if(selectedCase==='profile-switch'){
  assert.ok(switchPorts)
  await profileSwitchCase({phase,directory,window,core,evaluate,result,cli,receipt,ports:switchPorts,taskWorkspaceId:workspaceId,legacyWorkspaceId,pageUrl, readWorkbenchState: () => userState.read()})
  assert.equal(receipt.profileSwitch.completed,true,'Only the complete dedicated Profile workface oracle can qualify T002')
  receipt.businessPassed=true;receipt.passed=true;return
 }
 if(selectedCase!=='admission')throw new Error('This case awaits its own nonempty business oracle; admission cannot qualify T002/T004')
 contents.debugger.attach('1.3')
 if(phase==='first'){
  await evaluate(`profileSurveyNative.prepareLegacyWorkspace(${JSON.stringify(legacyWorkspaceId)})`)
  receipt.taskPreparation=await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(workspaceId)})`)
 }
 const graph=await until(async()=>{const read=await cli(['space','ls','--presentation']);if(read.code===0&&read.value.ok)return read.value.result;if(read.value.error?.code==='SPATIAL_STATE_ABSENT')return null;throw new Error(JSON.stringify(read.value))},'original durable spatial graph')
 receipt.graphBefore=graph
 if(phase==='first'){
  const zone=graph.catalog.zones.find((value:any)=>value.workspaceId===workspaceId);assert.ok(zone,'Original Core execution Workspace has a Zone')
  const legacyZone=graph.catalog.zones.find((value:any)=>value.workspaceId===legacyWorkspaceId);assert.ok(legacyZone,'The separate original whole-Zone exploration must exist')
  const originalList=await result(['space','survey-list'])
  const legacyCollection=await result(['space','survey-list','--input','-'],JSON.stringify({collection:{zoneIds:[...originalList.collectedZoneIds,legacyZone.zoneId],expectedZoneIds:originalList.collectedZoneIds}}))
  assert.equal(legacyCollection.outcome,'changed');assert.ok(legacyCollection.collectedZoneIds.includes(legacyZone.zoneId));receipt.legacyZoneId=legacyZone.zoneId
  const file=await result(['file','open','--path','original.txt','--zone',zone.zoneId]);receipt.file=file
  const fileRegion=file.placement;assert.ok(fileRegion?.regionId,'Actual public File open must provide its original Region')
  const agent=await result(['agent','open','--executor','proof','--execution-workspace',workspaceId,'--zone',zone.zoneId,'--tab',fileRegion.tabId,'--region',fileRegion.regionId,'--split','right']);receipt.agent=agent
  const terminal=await result(['terminal','open','--right-of',fileRegion.regionId,'--command','cat']);receipt.terminal=terminal
  const defaultPage=await result(['browser','open','--url',pageUrl+'?default','--right-of',terminal.region.regionId]);assert.equal(defaultPage.survey.outcome,'not-requested')
  const mixed=await facts();receipt.mixed=mixed; const mixedTab=mixed.tabs[fileRegion.tabId];for(const kind of ['file','agent','terminal','browser'])assert.ok(Object.values(mixedTab.regions).some((region:any)=>region.kind===kind),'The mixed Task must contain a real '+kind+' Region');assert.equal(mixedTab.regions[agent.to.regionId].sessionId,agent.agent.agentSessionId)
  const a=await result(['browser','profile','create','--label','Same visible Profile name']),b=await result(['browser','profile','create','--label','Same visible Profile name'])
  receipt.profiles=[a,b];assert.notEqual(a.profile.id,b.profile.id)
  const opened:any[]=[]
  for(const [index,profile] of [a.profile,b.profile].entries()){
   const created=await result(['browser','open','--url',pageUrl+'?profile='+index,'--profile',profile.id,'--right-of',defaultPage.region.regionId]);receipt.cases.push({kind:'explicit-CLI-profile-open',created});assert.equal(created.survey.outcome,'registered');assert.equal(created.region.profileId,profile.id);assert.deepEqual(created.survey.reference,{regionId:created.region.regionId,browserId:created.region.browserId});opened.push(created)
  }
  const afterOpen=await facts();assert.deepEqual(afterOpen.launcherDrafts,mixed.launcherDrafts);assert.deepEqual(afterOpen.workbenchSpaceSelection,mixed.workbenchSpaceSelection);assert.equal(afterOpen.mainSurface,mixed.mainSurface)
  const list=await result(['space','survey-list']);assert.deepEqual(list.pageReferences,opened.map(value=>value.survey.reference));assert.equal(list.collectedZoneIds.includes(zone.zoneId),false,'Exact page admission cannot collect its mixed task Zone')
  assert.deepEqual(list.collectedZoneIds,legacyCollection.collectedZoneIds,'Exact page admission preserves the separate original whole-Zone membership')
  await click('.surface-navigation__utilities button:first-child');await click(`[data-survey-page-browser-id="${opened[0].region.browserId}"] .survey-item`)
  await until(()=>evaluate(`document.querySelector('[data-workbench-region-id="${opened[0].region.regionId}"]')?.getBoundingClientRect().width>0`),'actual production Survey Region projection')
  receipt.nativePage=await until(()=>{const value=nativePage(window!,pageUrl+'?profile=0',opened[0].region.profileId);return value?.visible&&!value.loading&&value.bounds.width>0?value:null},'visible original Profile native view after actual Region projection')
  const visibleRegions=await evaluate(`[...document.querySelectorAll('[data-workbench-region-id]')].filter(element=>element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&element.getBoundingClientRect().right>0&&element.getBoundingClientRect().bottom>0&&element.getBoundingClientRect().left<innerWidth&&element.getBoundingClientRect().top<innerHeight).map(element=>element.dataset.workbenchRegionId)`);assert.deepEqual([...new Set(visibleRegions)],[opened[0].region.regionId],'Exact Survey projection cannot include mixed Task siblings')
  receipt.projectionGeometry=await admissionGeometry(window!,evaluate,opened[0],pageUrl+'?profile=0',value=>{receipt.projectionGeometry=value})
  loseProfileDirectoryAck=true
  const unlabeledProfile=await result(['browser','profile','create','--label','Label read ACK unavailable'])
  const unlabeled=await result(['browser','open','--url',pageUrl+'?label-unknown','--profile',unlabeledProfile.profile.id,'--right-of',defaultPage.region.regionId]);receipt.unlabeled=unlabeled;assert.equal(unlabeled.region.profileId,unlabeledProfile.profile.id);assert.ok(unlabeled.region.profileIssue);assert.equal(unlabeled.region.profile,undefined);assert.equal(unlabeled.survey.outcome,'registered');assert.ok(receipt.droppedProfileListPushes>0);loseProfileDirectoryAck=false;await evaluate('profileSurveyNative.refreshProfiles()')
  await until(()=>nativePage(window!,pageUrl+'?label-unknown',unlabeled.region.profileId),'Main-created unlabeled native page')
  await click(`[data-survey-page-browser-id="${unlabeled.region.browserId}"] .survey-item`)
  await click(`[data-workbench-region-id="${unlabeled.region.regionId}"] [aria-label="Close split"]`)
  await until(async()=>!Object.values((await facts()).tabs).some((tab:any)=>tab.regions[unlabeled.region.regionId]),'actual GUI closes only the exact original Browser Region')
  receipt.closedAck=await until(()=>receipt.closeCalls.find((call:any)=>call.browserId===unlabeled.region.browserId&&call.ack==='confirmed'),'the original exact Main Close IPC ACK')
  const afterClose=await result(['space','survey-list']);assert.ok(afterClose.pageReferences.some((page:any)=>page.regionId===unlabeled.region.regionId&&page.browserId===unlabeled.region.browserId),'An unconfirmed original retains its exact reference')
  assert.equal(nativePage(window!,pageUrl+'?label-unknown',unlabeled.region.profileId),null,'GUI Close disposes the original native page')
  const closedTargets=await result(['browser','targets']);receipt.closedDiscovery=closedTargets.targets.find((target:any)=>target.id===unlabeled.region.browserId)??null
  // Discovery also projects the last durable Core graph. Before that graph's
  // deletion ACK a retained cold row is not a live Main/native Browser.
  if(receipt.closedDiscovery){assert.equal(receipt.closedDiscovery.status,'unavailable');assert.equal(receipt.closedDiscovery.resource?.state,'cold');assert.deepEqual(receipt.closedDiscovery.resource.processes,[]);assert.deepEqual(receipt.closedDiscovery.capabilities,[])}
  const unknownSelector=`[data-survey-page-browser-id="${unlabeled.region.browserId}"] [role="status"]`
  receipt.unknownReference=await until(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(unknownSelector)});return e?.checkVisibility()?e.textContent:null})()`),'unknown original reference remains visible in Survey')
  rejectSurveyWrites=true
  const weak=await result(['browser','open','--url',pageUrl+'?weak','--profile',a.profile.id,'--right-of',defaultPage.region.regionId]);receipt.weak=weak;assert.ok(['partial','unknown'].includes(weak.survey.outcome),'Preference writer failure must be separate from healthy page creation');assert.ok(rejectedWrites>0)
  const targets=await result(['browser','targets']);assert.ok(targets.targets.some((value:any)=>value.id===weak.region.browserId),'Weak Survey failure must preserve the Main-created Browser');receipt.weakNative=await until(()=>nativePage(window!,pageUrl+'?weak',weak.region.profileId),'weak preference failure preserves its native owner');rejectSurveyWrites=false
  const current=await result(['space','survey-list']);const retained=current.pageReferences.filter((ref:any)=>ref.browserId!==opened[1].region.browserId)
  await click(`[data-survey-page-browser-id="${opened[1].region.browserId}"] [aria-label="Remove page from Survey"]`);await until(async()=>{const list=await result(['space','survey-list']);return list.pageReferences.some((page:any)=>page.browserId===opened[1].region.browserId)?null:list},'actual GUI removal without closing original Browser');assert.ok(nativePage(window!,pageUrl+'?profile=1',opened[1].region.profileId),'Removing only the Survey reference preserves its original native page')
  await evaluate('profileSurveyNative.checkpoint()')
  receipt.closedPostCheckpointReads=[]
  await until(async()=>{
   const read=await result(['browser','targets']);assert.equal(read.coverage,'complete','Only complete original discovery can confirm the closed identity is absent')
   receipt.closedAfterCheckpoint=read.targets.find((target:any)=>target.id===unlabeled.region.browserId)??null
   receipt.closedPostCheckpointReads.push(receipt.closedAfterCheckpoint)
   if(receipt.closedAfterCheckpoint){assert.equal(receipt.closedAfterCheckpoint.resource?.state,'cold');assert.deepEqual(receipt.closedAfterCheckpoint.resource.processes,[])}
   return receipt.closedAfterCheckpoint===null
  },'original Core deletion acknowledged by read-only discovery, without restoring a page')
  assert.equal(receipt.closedAfterCheckpoint,null,'After the original spatial deletion ACK the GUI-closed Browser has no live or cold target')
  receipt.savedIdentity={opened,weak,retained,defaultPage,fileRegion,closed:unlabeled,legacyZoneId:legacyZone.zoneId,taskTab:persistentTask((await facts()).tabs[fileRegion.tabId]),launcherDrafts:(await facts()).launcherDrafts,agent:agent.agent,nativeStoragePath:receipt.nativePage.storagePath,survey:(await result(['space','survey-list'])).pageReferences}
  await writeFile(join(directory,'retained.json'),JSON.stringify(receipt.savedIdentity))
 }else{
  const prior=JSON.parse(await readFile(join(directory,'retained.json'),'utf8'))
  const actual=await facts();assert.deepEqual(persistentTask(actual.tabs[prior.fileRegion.tabId]),prior.taskTab,'Second PID reads the original mixed Task Tab without reseeding')
  assert.deepEqual(actual.launcherDrafts,prior.launcherDrafts,'Original unsent application input survives the second PID');assert.equal(core.agentSession(prior.agent.agentSessionId).run.runId,prior.agent.runId,'The original fake Provider Run identity is retained, not recreated')
  const list=await result(['space','survey-list']);assert.deepEqual(list.pageReferences,prior.survey,'Cold reads cannot revive a manually hidden exact page')
  assert.ok(list.collectedZoneIds.includes(prior.legacyZoneId),'Second PID retains the original whole-Zone exploration beside exact pages')
  assert.equal(Object.values(actual.tabs).some((tab:any)=>tab.regions[prior.closed.region.regionId]),false,'Second PID cannot revive the GUI-closed original Region')
  assert.equal((await result(['browser','targets'])).targets.some((target:any)=>target.id===prior.closed.region.browserId),false,'Reading unknown references cannot recreate a GUI-closed Browser')
  await click('.surface-navigation__utilities button:first-child');await click(`[data-survey-page-browser-id="${prior.opened[0].region.browserId}"] .survey-item`)
  await until(()=>evaluate(`document.querySelector('[data-workbench-region-id="${prior.opened[0].region.regionId}"]')?.getBoundingClientRect().width>0`),'restored Survey original Region')
  const restoredNative=await until(()=>{const value=nativePage(window!,pageUrl+'?profile=0',prior.opened[0].region.profileId);return value?.visible&&!value.loading?value:null},'restored original native Profile page');assert.ok(restoredNative);assert.equal(restoredNative.storagePath,prior.nativeStoragePath);receipt.restoredNative=restoredNative
  receipt.projectionGeometry=await admissionGeometry(window!,evaluate,prior.opened[0],pageUrl+'?profile=0',value=>{receipt.projectionGeometry=value})
  receipt.recoveredIdentity=prior;receipt.cases.push({kind:'actual-second-PID-original-Survey-and-mixed-Task',passed:true})
 }
 if(phase==='first'){
  const identity=receipt.savedIdentity
  for(const mode of ['dark','light']){
   await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)})`)
   window.setSize(1280,900);await click(`[data-survey-page-browser-id="${identity.opened[0].region.browserId}"] .survey-item`);await delay(250)
   receipt.frames.push({file:`first-admission-${mode}-normal.png`,geometry:await admissionGeometry(window!,evaluate,identity.opened[0],pageUrl+'?profile=0',value=>{receipt.lastCaptureGeometry=value})})
   await writeFile(join(directory,`first-admission-${mode}-normal.png`),(await window.capturePage()).toPNG())
   if(mode==='dark'){
    const original=window.contentView.children.find((view:any)=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL()===pageUrl+'?profile=0') as WebContentsView
    const image=await original.webContents.capturePage();await writeFile(join(directory,'first-admission-native-page.png'),image.toPNG())
    receipt.nativeCaptureBoundary='App frames capture the production Renderer; first-admission-native-page.png separately captures the exact original native child. They are not a composite or an OS screenshot.'
   }
   window.setSize(740,840);await click(`[data-survey-page-browser-id="${identity.closed.region.browserId}"] .survey-item`);await delay(250)
   assert.ok(await evaluate(`document.querySelector('[data-survey-page-browser-id="${identity.closed.region.browserId}"] [role="status"]')?.checkVisibility()`),'Unknown original reference stays visible in the narrow real Survey')
   await writeFile(join(directory,`first-admission-${mode}-unknown.png`),(await window.capturePage()).toPNG())
  }
  window.setSize(1280,900);await click(`[data-survey-page-browser-id="${identity.opened[0].region.browserId}"] .survey-item`)
 }
 await writeFile(join(directory,phase+'-app.png'),(await window.capturePage()).toPNG())
 receipt.businessPassed=true;receipt.passed=true
}
void run().catch(async error=>{receipt.failure={name:error.name,message:error.message,stack:error.stack};console.error(error);if(window&&!window.isDestroyed())try{receipt.failureFacts=await window.webContents.executeJavaScript('profileSurveyNative.read()');await writeFile(join(directory,phase+'-failure.png'),(await window.capturePage()).toPNG())}catch{}}).finally(async()=>{
 const failures:string[]=[]
 releaseObservationFaults()
 for(const release of [async()=>{if(window&&!window.isDestroyed())await window.webContents.executeJavaScript('profileSurveyNative.checkpoint()')},async()=>{if((phase==='restart'||!receipt.passed)&&core)for(const session of core.agentSessions()){if(selectedCase==='complete'&&receipt.complete?.unstartedColdSessionIds?.includes(session.agentSessionId))continue;await core.stopAgent(session.agentSessionId,session.run)}},()=>releaseIpc?.(),()=>runtime?.dispose(),()=>access?.dispose(),()=>windows?.dispose(),()=>sdk?.dispose(),()=>rpc?.dispose(),()=>privateHost?.dispose(),()=>{if(window&&!window.isDestroyed())window.destroy()}])try{await release()}catch(error){failures.push(String(error))}
 receipt.cleanupFailures=failures;await writeFile(join(directory,phase+'-receipt.json'),JSON.stringify(receipt,null,2));if(receipt.passed&&!failures.length)app.quit();else app.exit(1)
})
