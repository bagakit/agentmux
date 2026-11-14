import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeAll, afterAll, test } from 'vitest'
import { stopProbeProcesses } from '../scripts/probe-process.mjs'
import { originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'

const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop'),require=createRequire(join(desktop,'package.json'))
let temporary='',userData='',runtimeDirectory='',configuration='',seed='',expectedInputs:Record<string,unknown>={},expectedRestoredInputs:Record<string,unknown>={},expectedTarget={reference:{spaceId:''},zoneId:''},expectedProjection={workspaceId:'',tabId:'',regionId:''},children=new Set<ChildProcess>()
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function waitFor<T>(label:string,read:()=>Promise<T|null>,budget=90_000):Promise<T>{const end=Date.now()+budget;while(Date.now()<end){const value=await read();if(value)return value;await delay(60)}throw Error(`Timed out: ${label}`)}
async function cdpConnect(url:string){
  const socket=new WebSocket(url);await new Promise<void>((done,fail)=>{const timer=setTimeout(()=>fail(Error('CDP connect timeout')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);done()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);fail(Error('CDP connect failed'))},{once:true})})
  let serial=0;const pending=new Map<number,{done:(value:any)=>void,fail:(error:Error)=>void,timer:NodeJS.Timeout}>()
  socket.addEventListener('message',({data})=>{const message=JSON.parse(String(data)),request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);if(message.error)request.fail(Error(message.error.message));else request.done(message.result)})
  const call=(method:string,params:Record<string,unknown>={})=>new Promise<any>((done,fail)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);fail(Error(`CDP timeout: ${method}`))},15_000);pending.set(id,{done,fail,timer});socket.send(JSON.stringify({id,method,params}))})
  return{call,close:()=>socket.close(),async evaluate(expression:string){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value}}
}
async function freePort():Promise<number>{const server=createServer();await new Promise<void>((done,fail)=>server.listen(0,'127.0.0.1',done).once('error',fail));const address=server.address();if(!address||typeof address==='string')throw Error('No private debugger port');const port=address.port;await new Promise<void>(done=>server.close(()=>done()));return port}
async function launch(label:string,withSeed:boolean){
  const port=await freePort(),ready=join(temporary,`${label}-ready.json`),report=join(temporary,`${label}-recovery.json`),env:NodeJS.ProcessEnv={...process.env,
    HOME:join(temporary,'home'),AGENTMUX_DESKTOP_USER_DATA:userData,AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory,
    AGENTMUX_STATE_DIRECTORY:join(runtimeDirectory,'state'),AGENTMUX_SPATIAL_STATE_STORE:join(runtimeDirectory,'state','spatial-state.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH:join(userData,'private-messages.ndjson'),AGENTMUX_DESKTOP_READY_FILE:ready,
    AGENTMUX_DESKTOP_RECOVERY_SEED:withSeed?seed:undefined,AGENTMUX_DESKTOP_RECOVERY_REPORT:withSeed?report:undefined,
    AGENTMUX_DESKTOP_EXIT_AFTER_READY:undefined,ELECTRON_RENDERER_URL:undefined,ELECTRON_RUN_AS_NODE:undefined}
  const child=spawn(require('electron'),[desktop,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{cwd:desktop,detached:true,stdio:['ignore','pipe','pipe'],env});children.add(child)
  let diagnostics='',debuggingUrl='',debugTail='';const observe=(value:unknown)=>{const text=debugTail+String(value);debuggingUrl??=/DevTools listening on (ws:\/\/\S+)/.exec(text)?.[1]??'';debugTail=text.slice(-200);diagnostics=(diagnostics+String(value)).slice(-12_000)};child.stdout!.on('data',observe);child.stderr!.on('data',observe)
  const endpoint=new URL(`http://127.0.0.1:${port}`)
  await waitFor(`${label} debugger`,async()=>{try{await fetch(`http://${endpoint.host}/json/list`,{signal:AbortSignal.timeout(3000)});return true}catch{return null}}).catch(error=>{throw Error(`${error.message}: ${diagnostics}`)})
  const target=await waitFor(`${label} renderer`,async()=>{try{const pages=await(await fetch(`http://${endpoint.host}/json/list`,{signal:AbortSignal.timeout(3000)})).json();return pages.find((page:any)=>page.type==='page'&&page.url.startsWith('file:'))??null}catch{return null}})
  const cdp=await cdpConnect(target.webSocketDebuggerUrl);await cdp.call('Runtime.enable');await cdp.call('Emulation.setFocusEmulationEnabled',{enabled:true})
  await waitFor(`${label} application`,async()=>await cdp.evaluate(`Boolean(document.querySelector('.app-shell'))`)).catch(async error=>{const body=await cdp.evaluate(`JSON.stringify({url:location.href,html:document.documentElement?.outerHTML.slice(0,1000),resources:performance.getEntriesByType('resource').map(entry=>entry.name).slice(-12)})`).catch(()=> 'unreadable');throw Error(`${error.message}: ${diagnostics}; body=${body}`)})
  await waitFor(`${label} ready`,async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error(`${label} Electron exited ${child.exitCode}/${child.signalCode}: ${diagnostics}`);try{return JSON.parse(await readFile(ready,'utf8'))}catch{return null}}).catch(async error=>{throw Error(`${error.message}: ${diagnostics}; dom=${await cdp.evaluate(`document.body?.innerText.slice(0,2000)`).catch(()=> 'unreadable')}`)})
  return{child,cdp,label}
}
async function stop(launched:Awaited<ReturnType<typeof launch>>){launched.cdp.close();const group=launched.child.pid;if(group)try{process.kill(-group,'SIGKILL')}catch{}children.delete(launched.child);await stopProbeProcesses(group,temporary)}
let expression=''

async function readNativeState(){const envelope=JSON.parse(await readFile(join(userData,'workbench-user-state.json'),'utf8')),state=envelope.state;return{selectedSpaceMount:state.selectedSpaceMount??null,activeWorkspaceId:state.activeWorkspaceId??null,selection:state.workbenchSpaceSelection??null,mountedSpaceInputs:state.mountedSpaceInputs,layouts:state.restoredWorkbench?.layouts??null,error:state.error??null,lastError:state.lastError??null,navigationNotice:state.desktopNavigationNotice??null}}

beforeAll(async()=>{
  const temporaryBase=root.includes('/.worktrees/')?resolve(root,'../..','.tmp'):join(root,'.tmp')
  await mkdir(temporaryBase,{recursive:true})
  temporary=await mkdtemp(join(temporaryBase,'s-'));userData=join(temporary,'user-data');runtimeDirectory=join(temporary,'runtime');configuration=join(userData,'agentmux.config.json')
  await mkdir(join(runtimeDirectory,'state'),{recursive:true});await mkdir(join(temporary,'home'),{recursive:true});await mkdir(userData,{recursive:true})
  const workspacePath=join(temporary,'original-project');await mkdir(workspacePath)
  await writeFile(configuration,JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private original Core'}],executors:{},workspaces:[{id:'private-original-workspace',name:'Private original project',hostId:'local',path:workspacePath,kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}))
  const [{AgentMuxSpatialStateStore},{createWorkspaceLayout,createWorkbenchViewLayout}]=await Promise.all([
    import(join(root,'packages/core/dist/spatial-state.js')),import(join(root,'packages/layout/src/index.ts'))])
  const spatial=new AgentMuxSpatialStateStore(join(runtimeDirectory,'state','spatial-state.json'))
  const saved=await spatial.registerDirectory({runtimeId:'private-source-runtime',directory:{hostId:'local',workspacePath,projectRootPath:workspacePath},workspaceId:'private-original-workspace'},
    async()=>[{id:'private-original-workspace',hostId:'local',path:workspacePath,name:'Private original project',kind:'folder'}],async()=>{})
  const before=(await spatial.read())!,graph=structuredClone(before.graph),tabId='private-original-tab',regionId='private-original-region'
  graph.tabs.push({tabId,zoneId:saved.zoneId,workspaceId:saved.workspaceId,name:'Private original Tab',regionIds:[regionId]})
  graph.regions.push({regionId,tabId,kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:workspacePath,runtimeId:'private-source-runtime'}})
  graph.resources[`tab:${tabId}`]={};graph.resources[`region:${regionId}`]={};graph.layouts[saved.workspaceId]=createWorkspaceLayout('private-original-group',[tabId]);graph.tabLayouts[tabId]=createWorkbenchViewLayout(regionId)
  await spatial.commit({expectedRevision:before.revision,graph})
  const reference={runtimeId:'private-source-runtime',spaceId:saved.spaceId},key=JSON.stringify([reference.runtimeId,reference.spaceId]),target={hostId:'local',reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId}
  expectedTarget=target
  expectedProjection={workspaceId:originalSourceWorkspaceId(target),tabId:originalSourceTabProjectionId(target,tabId),regionId:originalSourceRegionProjectionId(target,regionId)}
  expression=`(()=>{const visible=e=>!!e&&!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length>0,byId=(attribute,id)=>Array.from(document.querySelectorAll('['+attribute+']')).find(element=>element.getAttribute(attribute)===id);return{
    mountedDestinations:document.querySelectorAll('[data-mounted-space-nav],[data-mounted-space]').length,
    originalRegion:visible(byId('data-workbench-region-id',${JSON.stringify(expectedProjection.regionId)})),
    originalProjectActive:visible(byId('data-active-workspace-id',${JSON.stringify(expectedProjection.workspaceId)})),
    originalProjectActiveRaw:visible(byId('data-active-workspace-id','private-original-workspace')),
    tools:visible(document.querySelector('[aria-label="Space tools"]'))}})()`
  const initialComposition=createWorkspaceLayout('private-source-view-group',[tabId])
  const view={composition:{...initialComposition,root:{type:'split',direction:'horizontal',ratio:0.32,first:initialComposition.root,second:{type:'leaf',groupId:'private-source-view-split'}},
    groups:[...initialComposition.groups,{id:'private-source-view-split',tabOrder:[],activeTabId:null,recentTabIds:[]}]},tabLayouts:{[tabId]:createWorkbenchViewLayout(regionId)},selection:{groupId:'private-source-view-group',tabId,regionId}}
  const draftKey=JSON.stringify([reference.runtimeId,reference.spaceId,tabId,regionId]),pending={kind:'agent-open',operationId:'private-unresolved-OP',opaque:{keep:[1,2,3]}}
  expectedInputs={[key]:{target,view,drafts:{[draftKey]:'Private unsent Source draft'},memberInputs:{[draftKey]:{operationId:'private-member-input-OP',text:'Private member bytes'}},launchers:{private:{keep:true}}},'private-unresolved':pending}
  expectedRestoredInputs=structuredClone(expectedInputs);delete (expectedRestoredInputs[key] as {view?:unknown}).view
  seed=JSON.stringify({version:1,state:{activeWorkspaceId:saved.workspaceId,mainSurface:'workbench',selectedSpaceMount:key,workbenchSpaceSelection:null,mountedSpaceInputs:expectedInputs}})
})
afterAll(async()=>{for(const child of children)if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}children.clear();if(temporary){await stopProbeProcesses(undefined,temporary);await rm(temporary,{recursive:true,force:true,maxRetries:8,retryDelay:100})}})

test('two real Electron processes restore only the original project workface and exact private Source data without reseeding',async()=>{
  const originalConfig=await readFile(configuration,'utf8'),observed:Array<{pid:number|undefined;seed:boolean;value:any}>=[]
  for(const label of ['first','second']){
    const process=await launch(label,label==='first')
    try{
      await waitFor(`${label} navigation settled`,async()=>{const value=await process.cdp.evaluate(expression);return value.originalRegion||value.mountedDestinations>0?value:null}).catch(async error=>{const state=await readNativeState(),dom=await process.cdp.evaluate(`document.body?.innerText.slice(0,3000)`);throw Error(`${error.message}: ${JSON.stringify({state,dom})}`)})
      const native=await waitFor(`${label} native navigation`,async()=>{const state=await readNativeState();return state.selectedSpaceMount===null&&state.activeWorkspaceId===expectedProjection.workspaceId?state:null})
      const value={...await process.cdp.evaluate(expression),...native};observed.push({pid:process.child.pid,seed:label==='first',value});console.error(`SOURCE_NAV_${label}`,JSON.stringify(value))
      assert.equal(value.selectedSpaceMount,null,`${label}: old Mounted selection must not survive`)
      assert.equal(value.activeWorkspaceId,expectedProjection.workspaceId)
      assert.equal(value.selection?.spaceId,expectedTarget.reference.spaceId)
      assert.equal(value.selection?.zoneId,expectedTarget.zoneId)
      assert.equal(value.selection?.tabId,expectedProjection.tabId);assert.equal(value.selection?.regionId,expectedProjection.regionId)
      assert.equal(value.mountedDestinations,0,`${label}: no Mounted destination or fallback`)
      assert.equal(value.originalRegion,true,`${label}: ordinary WorkspaceWorkbench Region must be visible`)
      assert.equal(value.originalProjectActive,true,`${label}: original project row must be active`)
      assert.equal(value.tools,true,`${label}: ordinary Space tools must remain reachable`)
      assert.deepEqual(value.mountedSpaceInputs,expectedRestoredInputs,`${label}: locator/drafts/member inputs/unresolved operation without a second private view`)
      assert.equal(value.layouts?.[expectedProjection.workspaceId]?.root?.ratio,.32,`${label}: ordinary Source Group ratio`)
      // The native user document was read back before stopping; the next real process must restore those exact bytes.
      // An additional optional UI flush is not used as a substitute for this direct durability proof.
    }finally{await stop(process)}
  }
  assert.notEqual(observed[0]!.pid,observed[1]!.pid);assert.equal(observed[0]!.seed,true);assert.equal(observed[1]!.seed,false)
  const beforeConfig=JSON.parse(originalConfig),afterConfig=JSON.parse(await readFile(configuration,'utf8'))
  assert.deepEqual(afterConfig.workspaces.filter((workspace:any)=>workspace.id==='private-original-workspace'),beforeConfig.workspaces,'original project entry must not be rewritten')
  assert.equal(afterConfig.workspaces.filter((workspace:any)=>workspace.path===beforeConfig.workspaces[0].path).length,1,'navigation must not add a Source project copy')
})
