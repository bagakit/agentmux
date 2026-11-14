import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeAll, afterAll, test } from 'vitest'
import { stopProbeProcesses } from '../scripts/probe-process.mjs'
import { originalSourceInputOwnerKey, originalSourceRegionProjectionId, originalSourceScopeFromGraph, originalSourceTabProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'
import { mountedRegionKey } from '../src/renderer/src/lib/space-mount-view'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'

const legacyDraft='Legacy Mounted bytes must remain opaque',sharedDraft='Private shared Source draft',queuedText='Private queued Source message'
const root=resolve(import.meta.dirname,'../../..'),desktop=join(root,'apps/desktop'),require=createRequire(join(desktop,'package.json'))
let temporary='',userData='',runtimeDirectory='',configuration='',seed='',expectedInputs:Record<string,unknown>={},expectedRestoredInputs:Record<string,unknown>={},expectedTarget={reference:{spaceId:''},zoneId:''},expectedProjection={workspaceId:'',tabId:'',regionId:''},expectedSourceKey='',expectedDraftKey='',expectedInputOwnerKey='',expectedQueue:Array<Record<string,unknown>>=[],expectedRatio=.32,children=new Set<ChildProcess>()
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

async function readNativeState(process:Awaited<ReturnType<typeof launch>>){const envelope=JSON.parse(await process.cdp.evaluate('window.agentmux.ui.readWorkbenchState()')),state=envelope.state;return{selectedSpaceMount:state.selectedSpaceMount??null,activeWorkspaceId:state.activeWorkspaceId??null,selection:state.workbenchSpaceSelection??null,mountedSpaceInputs:state.mountedSpaceInputs,agentComposerDrafts:state.agentComposerDrafts??{},agentSteerQueues:state.agentSteerQueues??{},layouts:state.restoredWorkbench?.layouts??null,error:state.error??null,lastError:state.lastError??null,navigationNotice:state.desktopNavigationNotice??null}}

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
  const admitted=await spatial.admitAgentOpen({request:{schemaVersion:5,requestId:'private-original-open',operation:'agent.open',
    content:{kind:'new-agent',executorId:'private-original-executor'},destination:{spaceId:saved.spaceId,zoneId:saved.zoneId,newTab:true},focus:false},
    agentSessionId:'private-original-agent',execution:{hostId:'local',runtimeId:'private-source-runtime',workspacePath,workspaceId:saved.workspaceId,executorRevision:'private-original-executor-revision'},
    placement:{runtimeId:'private-source-runtime',hostId:'local',workspacePath,workspaceId:saved.workspaceId},regionResource:{}})
  const tabId=admitted.record.address.tabId,regionId=admitted.record.address.regionId
  const settled=await spatial.settleAgentOpen('private-original-open',{agentSessionId:'private-original-agent',run:{runId:'private-original-run'}},{})
  assert.equal(settled.attached,true,'the original Agent Run receipt must attach to its reserved Region')
  const before=(await spatial.read())!,graph=structuredClone(before.graph)
  // This proof owns a qualified projection only: no raw ordinary occurrence exists in the current layout.
  delete graph.layouts[saved.workspaceId];delete graph.tabLayouts[tabId]
  await spatial.commit({expectedRevision:before.revision,graph})
  assert.equal((await spatial.read())!.graph.regions.find(region=>region.regionId===regionId)?.runId,'private-original-run')
  const reference={runtimeId:'private-source-runtime',spaceId:saved.spaceId},key=JSON.stringify([reference.runtimeId,reference.spaceId]),target={hostId:'local',reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId}
  expectedTarget=target
  expectedInputOwnerKey=originalSourceInputOwnerKey(admitted.record.execution.runtimeId!,'private-original-agent')
  assert.ok(originalSourceScopeFromGraph(target,(await spatial.read())!.graph),'the admitted Agent fixture must be recoverable from its exact graph and locator')
  expectedProjection={workspaceId:originalSourceWorkspaceId(target),tabId:originalSourceTabProjectionId(target,tabId),regionId:originalSourceRegionProjectionId(target,regionId)}
  expression=`(()=>{const visible=e=>!!e&&!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length>0,byId=(attribute,id)=>Array.from(document.querySelectorAll('['+attribute+']')).find(element=>element.getAttribute(attribute)===id),region=byId('data-workbench-region-id',${JSON.stringify(expectedProjection.regionId)}),composer=region?.querySelector('[data-agent-composer="true"]'),editor=composer?.querySelector('[aria-label="Message Agent"]'),tool=composer?.querySelector('[aria-label="Reference files for the Agent to read"]');return{
    mountedDestinations:document.querySelectorAll('[data-mounted-space-nav],[data-mounted-space]').length,
    originalRegion:visible(region),
    originalProjectActive:visible(byId('data-active-workspace-id',${JSON.stringify(expectedProjection.workspaceId)})),
    originalProjectActiveRaw:visible(byId('data-active-workspace-id','private-original-workspace')),
    sharedComposer:visible(composer),sharedDraft:editor?.textContent??null,
    sharedTools:visible(tool)&&!tool.disabled,
    pendingQueue:Array.from(region?.querySelectorAll('[data-operation-id] .composer-mailbox__row')??[]).some(element=>element.closest('[data-operation-id]')?.getAttribute('data-operation-id')==='private-shared-queue-OP'&&visible(element)&&element.textContent?.includes(${JSON.stringify(queuedText)})),
    mountedComposer:Boolean(region?.querySelector('.mounted-space-agent__composer')),
    tools:visible(document.querySelector('[aria-label="Space tools"]'))}})()`
  const initialComposition=createWorkspaceLayout('private-source-view-group',[tabId])
  const view={composition:{...initialComposition,root:{type:'split',direction:'horizontal',ratio:0.32,first:initialComposition.root,second:{type:'leaf',groupId:'private-source-view-split'}},
    groups:[...initialComposition.groups,{id:'private-source-view-split',tabOrder:[],activeTabId:null,recentTabIds:[]}]},tabLayouts:{[tabId]:createWorkbenchViewLayout(regionId)},selection:{groupId:'private-source-view-group',tabId,regionId}}
  expectedSourceKey=key;expectedDraftKey=mountedRegionKey(reference,tabId,regionId)
  const pending={kind:'agent-open',operationId:'private-unresolved-OP',opaque:{keep:[1,2,3]}}
  const member={hostId:'local',target:{reference,regionId,runtimeId:'private-source-runtime',agentSessionId:'private-original-agent',expectedRun:{runId:'private-original-run'},expectedAdmission:{kind:'creation' as const,operationId:'private-original-open'}}}
  const legacyInput={target:member,request:{operationId:'private-member-input-OP',prompt:'Private member bytes',binding:{expectedRun:member.target.expectedRun,admissionIntent:{kind:'manual-actor' as const}}},submitted:true,
    response:promptCarrierWaiting(member.target.agentSessionId,member.target.expectedRun.runId,'private-member-input-OP')}
  const bucket=JSON.stringify([member.hostId,reference.runtimeId,reference.spaceId,regionId,member.target.runtimeId,member.target.agentSessionId])
  expectedInputs={[key]:{target,view,drafts:{[expectedDraftKey]:legacyDraft},memberInputs:{[bucket]:{[legacyInput.request.operationId]:legacyInput}},launchers:{private:{keep:true}}},'private-unresolved':pending}
  expectedRestoredInputs=structuredClone(expectedInputs);delete (expectedRestoredInputs[key] as {view?:unknown}).view;delete (expectedRestoredInputs[key] as {memberInputs?:unknown}).memberInputs
  const queue=[{operationId:'private-shared-queue-OP',promptCondition:null,enqueuedAt:1,runId:'private-original-run',text:queuedText,status:'deferred',awaitingExplicitSend:true,origin:'manual',freshComposerIntent:true}]
  expectedQueue=[...queue,{operationId:legacyInput.request.operationId,text:legacyInput.request.prompt,promptCondition:null,runId:member.target.expectedRun.runId,directInputBinding:legacyInput.request.binding,originalMember:member,
    status:'deferred',awaitingExplicitSend:true,inputIntakeStarted:true,inputReceipt:legacyInput.response,recoveredSourceInput:legacyInput}]
  seed=JSON.stringify({version:1,state:{activeWorkspaceId:saved.workspaceId,mainSurface:'workbench',selectedSpaceMount:key,workbenchSpaceSelection:null,mountedSpaceInputs:expectedInputs,
    agentComposerDrafts:{[expectedInputOwnerKey]:sharedDraft},agentSteerQueues:{[expectedInputOwnerKey]:queue}}})
},60_000)
afterAll(async()=>{for(const child of children)if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}children.clear();if(temporary){await stopProbeProcesses(undefined,temporary);await rm(temporary,{recursive:true,force:true,maxRetries:8,retryDelay:100})}},60_000)

test('two real Electron processes restore only the original project workface and exact private Source data without reseeding',async()=>{
  const originalConfig=await readFile(configuration,'utf8'),observed:Array<{pid:number|undefined;seed:boolean;value:any}>=[]
  let expectedSharedDraft=sharedDraft
  for(const label of ['first','second']){
    const process=await launch(label,label==='first')
    try{
      await waitFor(`${label} navigation settled`,async()=>{const value=await process.cdp.evaluate(expression);return value.originalRegion||value.originalProjectActiveRaw||value.mountedDestinations>0?value:null}).catch(async error=>{const state=await readNativeState(process),dom=await process.cdp.evaluate(`document.body?.innerText.slice(0,3000)`);throw Error(`${error.message}: ${JSON.stringify({state,dom})}`)})
      const native=await waitFor(`${label} native navigation`,async()=>{const state=await readNativeState(process);return state.selectedSpaceMount===null&&(state.activeWorkspaceId===expectedProjection.workspaceId||state.activeWorkspaceId==='private-original-workspace')&&state.agentSteerQueues[expectedInputOwnerKey]?.length===2&&!(state.mountedSpaceInputs?.[expectedSourceKey] as any)?.memberInputs?state:null})
      const value={...await process.cdp.evaluate(expression),...native};observed.push({pid:process.child.pid,seed:label==='first',value});console.error(`SOURCE_NAV_${label}`,JSON.stringify(value))
      assert.equal(value.selectedSpaceMount,null,`${label}: old Mounted selection must not survive`)
      assert.equal(value.activeWorkspaceId,expectedProjection.workspaceId)
      assert.equal(value.selection?.spaceId,expectedTarget.reference.spaceId)
      assert.equal(value.selection?.zoneId,expectedTarget.zoneId)
      assert.equal(value.selection?.tabId,expectedProjection.tabId);assert.equal(value.selection?.regionId,expectedProjection.regionId)
      assert.equal(value.mountedDestinations,0,`${label}: no Mounted destination or fallback`)
      assert.equal(value.originalRegion,true,`${label}: ordinary WorkspaceWorkbench Region must be visible`)
      const mailboxOpened=await process.cdp.evaluate(`(()=>{const region=Array.from(document.querySelectorAll('[data-workbench-region-id]')).find(element=>element.getAttribute('data-workbench-region-id')===${JSON.stringify(expectedProjection.regionId)}),button=Array.from(region?.querySelectorAll('button')??[]).find(element=>element.getAttribute('aria-label')?.startsWith('Mailbox:'));if(!button)return false;button.click();return true})()`)
      assert.equal(mailboxOpened,true,`${label}: open the real shared Message Tool mailbox`)
      const inputsOpened=await process.cdp.evaluate(`(()=>{const region=Array.from(document.querySelectorAll('[data-workbench-region-id]')).find(element=>element.getAttribute('data-workbench-region-id')===${JSON.stringify(expectedProjection.regionId)}),button=Array.from(region?.querySelectorAll('button')??[]).find(element=>element.getAttribute('aria-label')==='Inputs: 2 pending');if(!button)return false;button.click();return true})()`)
      assert.equal(inputsOpened,true,`${label}: open the original pending Inputs page`)
      await process.cdp.evaluate(`(()=>{const region=Array.from(document.querySelectorAll('[data-workbench-region-id]')).find(element=>element.getAttribute('data-workbench-region-id')===${JSON.stringify(expectedProjection.regionId)}),button=Array.from(region?.querySelectorAll('button')??[]).find(element=>element.getAttribute('aria-label')==='Show the message tool row');if(!button)return true;button.click();return true})()`)
      const composerValue=await waitFor(`${label} real shared AgentSessionComposer`,async()=>{const current=await process.cdp.evaluate(expression);return current.sharedComposer&&current.sharedDraft===expectedSharedDraft&&current.sharedTools&&current.pendingQueue&&!current.mountedComposer?current:null},15_000)
        .catch(async error=>{throw Error(`${error.message}: ${await process.cdp.evaluate(`document.querySelector('[data-agent-composer="true"]')?.outerHTML ?? document.body?.innerText.slice(0,5000)`)}`)})
      assert.equal(composerValue.sharedComposer,true,`${label}: the real shared AgentSessionComposer must be visible in the restored original Region`)
      assert.equal(composerValue.sharedDraft,expectedSharedDraft,`${label}: the shared Message Tool must show its canonical input-owner draft, never the legacy Mounted bytes`)
      assert.equal(composerValue.sharedTools,true,`${label}: the shared reference tool must remain available`)
      assert.equal(composerValue.pendingQueue,true,`${label}: the original pending queue must be visible in the shared Message Tool`)
      assert.equal(composerValue.mountedComposer,false,`${label}: no MountedSpaceComposer or second input chain is allowed`)
      const captureDirectory=globalThis.process.env.AGENTMUX_SOURCE_NAV_CAPTURE_DIRECTORY
      if(captureDirectory&&label==='second'){
        await mkdir(captureDirectory,{recursive:true})
        for(const [name,width,height] of [['wide',1600,1000],['narrow',1000,760]] as const){
          await process.cdp.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
          await process.cdp.evaluate(`(()=>{document.querySelector('[aria-label="Close mailbox"]')?.click();const recovery=document.querySelector('.mounted-space-agent__inputs');if(recovery)recovery.open=false;return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
          for(const state of ['composer','recovery','mailbox']){
            await process.cdp.evaluate(`(()=>{const recovery=document.querySelector('.mounted-space-agent__inputs');if(recovery)recovery.open=${state==='recovery'};${state==='mailbox'?"document.querySelector('.composer__mailbox')?.click();":''}return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
            await process.cdp.evaluate(`Promise.all(Array.from(document.querySelector('.composer-mailbox')?.getAnimations({subtree:true})??[]).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))`)
            const screenshot=await process.cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
            await writeFile(join(captureDirectory,`source-${state}-${name}.png`),Buffer.from(screenshot.data,'base64'))
          }
        }
        await process.cdp.call('Emulation.clearDeviceMetricsOverride')
      }
      assert.equal(value.agentComposerDrafts[expectedInputOwnerKey],expectedSharedDraft)
      assert.deepEqual(value.agentSteerQueues[expectedInputOwnerKey],expectedQueue)
      assert.equal(value.originalProjectActive,true,`${label}: original project row must be active`)
      assert.equal(value.tools,true,`${label}: ordinary Space tools must remain reachable`)
      assert.deepEqual(value.mountedSpaceInputs,expectedRestoredInputs,`${label}: locator/drafts/member inputs/unresolved operation without a second private view`)
      assert.equal(value.layouts?.[expectedProjection.workspaceId]?.root?.ratio,expectedRatio,`${label}: ordinary Source Group ratio`)
      if(label==='first'){
        const point=await process.cdp.evaluate(`(()=>{const handle=document.querySelector('[aria-label="Resize split"]');if(!handle)return null;const rect=handle.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`)
        assert.ok(point,'the ordinary Source split handle is visible')
        await process.cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:2});await process.cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:2})
        await waitFor('Source-only Group ratio persisted',async()=>{const state=await readNativeState(process);return state.layouts?.[expectedProjection.workspaceId]?.root?.ratio===.5?state:null})
        expectedRatio=.5
        const focused=await process.cdp.evaluate(`(()=>{const region=Array.from(document.querySelectorAll('[data-workbench-region-id]')).find(element=>element.getAttribute('data-workbench-region-id')===${JSON.stringify(expectedProjection.regionId)}),editor=region?.querySelector('[data-agent-composer="true"] [aria-label="Message Agent"]');if(!editor)return false;editor.focus();const selection=window.getSelection();selection.selectAllChildren(editor);selection.collapseToEnd();return true})()`)
        assert.equal(focused,true,'the restored shared AgentSessionComposer must accept focus')
        await process.cdp.call('Input.insertText',{text:' · edited after restore'})
        expectedSharedDraft+=' · edited after restore'
        await waitFor('canonical input-owner draft persisted after a real Message Tool edit',async()=>{const state=await readNativeState(process);return state.agentComposerDrafts[expectedInputOwnerKey]===expectedSharedDraft?state:null})
        assert.equal((await process.cdp.evaluate(expression)).sharedDraft,expectedSharedDraft)
        const afterEdit=await readNativeState(process)
        assert.deepEqual(afterEdit.mountedSpaceInputs,expectedRestoredInputs,'the shared Message Tool edit must leave every legacy Mounted byte unchanged')
        assert.deepEqual(afterEdit.agentSteerQueues[expectedInputOwnerKey],expectedQueue,'editing a draft must not rewrite or send the original pending queue')
      }
      // The native user document was read back before stopping; the next real process must restore those exact bytes.
      // An additional optional UI flush is not used as a substitute for this direct durability proof.
    }finally{await stop(process)}
  }
  assert.notEqual(observed[0]!.pid,observed[1]!.pid);assert.equal(observed[0]!.seed,true);assert.equal(observed[1]!.seed,false)
  const beforeConfig=JSON.parse(originalConfig),afterConfig=JSON.parse(await readFile(configuration,'utf8'))
  assert.deepEqual(afterConfig.workspaces.filter((workspace:any)=>workspace.id==='private-original-workspace'),beforeConfig.workspaces,'original project entry must not be rewritten')
  assert.equal(afterConfig.workspaces.filter((workspace:any)=>workspace.path===beforeConfig.workspaces[0].path).length,1,'navigation must not add a Source project copy')
}, 90_000)
