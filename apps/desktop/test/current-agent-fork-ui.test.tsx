import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { useAppStore } from '../src/renderer/src/store'
import { useAgentCurrentForkControls } from '../src/renderer/src/components/AgentCurrentForkControls'
import { OpenDestinationBar } from '../src/renderer/src/components/OpenDestinationBar'
import * as DropdownMenu from '../src/renderer/src/components/HoverDropdownMenu'
import { currentForkRequest, currentForkUnavailableReason, reviewCurrentFork, type CurrentForkSession } from '../src/renderer/src/lib/agent-current-fork'
vi.mock('../src/renderer/src/store', async () => ({ useAppStore: (await import('zustand')).create(() => ({})) }))
const origin = { workspaceId: 'display-workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region', sessionId: 'original-session' }
const handle = { kind: 'provider' as const, providerId: 'protocol-provider', sessionId: 'original-native', transcriptPath: _hygiene_fixturePath("private/current.jsonl") }
function session(extra = {}): CurrentForkSession { return { id:'original-session',kind:'agent',hostId:'local',providerId:'protocol-provider',executorId:'private',workspacePath:_hygiene_fixturePath("private"),control:{kind:'agent',hostId:'local',agentSessionId:'original-session',run:{runId:'original-run'}},nativeHandle:handle,capabilities:{providerFork:{current:true}},...extra } as any }
const location = { spaceId: null, zoneId:'original-zone', workspaceId:'resource-workspace', displayWorkspaceId:origin.workspaceId, groupId:origin.tabGroupId, tabId:origin.tabId, regionId:origin.regionId }
function catalog(extra = {}): AgentMuxSpaceCatalog { return { spaces:[],zones:[],bindings:[],tabs:[],regions:[{regionId:origin.regionId,tabId:origin.tabId,kind:'agent',agentSessionId:origin.sessionId,runId:'original-run',execution:{hostId:'local',cwd:_hygiene_fixturePath("private")}}],locations:[location],...extra } }
const opened = { operation:'agent.open',requestId:'original-operation',outcome:'opened',from:null,to:{...location,tabId:'new-tab',regionId:'new-region'},agent:{agentSessionId:'new-session',runId:'new-run'},resource:null,save:{layoutApplied:true,localStorageWritten:true,storageFlushRequested:true,diskDurability:'confirmed',reason:null},issues:[] }
let root:Root, host:HTMLDivElement, execute:ReturnType<typeof vi.fn>, setMenuOpen:(open:boolean)=>void
beforeEach(()=>{ (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);execute=vi.fn(async(request:any)=>request.operation==='space.inspect'?{operation:'space.inspect',catalog:catalog()}:opened);useAppStore.setState({sessions:[session()],tabs:{[origin.tabId]:{regions:{[origin.regionId]:{kind:'agent',sessionId:origin.sessionId}},layout:{activeRegionId:origin.regionId}}},layouts:{[origin.workspaceId]:{activeGroupId:origin.tabGroupId,groups:[{id:origin.tabGroupId,activeTabId:origin.tabId}]}},activeWorkspaceId:origin.workspaceId,mainSurface:'workbench',executeControl:execute},true) })
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
function Surface({ value=session(),readOnly=false }: {value?:CurrentForkSession;readOnly?:boolean}) {
  const actions=useAgentCurrentForkControls({session:value,linkOrigin:origin,readOnly})
  const [open,setOpen]=useState(true)
  setMenuOpen=setOpen
  return createElement(DropdownMenu.Root,{open,onOpenChange:setOpen},createElement(DropdownMenu.Trigger,null,'Information'),createElement(DropdownMenu.Content,null,actions))
}
async function render(value=session(),readOnly=false){await act(async()=>root.render(createElement(Surface,{value,readOnly}))) }
async function click(text:string){const button=[...document.querySelectorAll<HTMLElement>('[role=menuitem],button')].find(one=>one.textContent?.trim()===text);expect(button,'Missing '+text).toBeTruthy();await act(async()=>button!.click()) }
async function choose(destination:string){const button=document.querySelector<HTMLButtonElement>(`button[data-destination="${destination}"]`);expect(button,'Missing '+destination).toBeTruthy();await act(async()=>button!.click()) }
it('reuses five destination buttons, browser defaults remain six, and cancel/Escape creates nothing',async()=>{
  const baseline=OpenDestinationBar({canSplit:true,onSelect:()=>{}});expect((baseline.props.children as any[]).length).toBe(6)
  await render();await click('Fork current conversation…');expect(document.querySelectorAll('[data-destination]')).toHaveLength(5);expect(document.querySelector('[data-destination=system]')).toBeNull();expect(document.querySelector('[role=toolbar]')?.getAttribute('aria-label')).toContain('fork');await click('Cancel fork');expect(execute).not.toHaveBeenCalled();await click('Fork current conversation…');await act(async()=>document.querySelector('[data-current-fork-review]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(document.querySelector('[data-current-fork-review]')).toBeNull();expect(execute).not.toHaveBeenCalled()
})
it('exact source review fences changed native identity, Run and Region before any launch',async()=>{
  for(const patch of [{nativeHandle:{...handle,sessionId:'new-native'}},{control:{...session().control,run:{runId:'new-run'}}},{nativeSourceObservation:{state:'unknown'}}]){
    await render();await click('Fork current conversation…');useAppStore.setState({sessions:[session(patch)]});await choose('right');expect(execute).not.toHaveBeenCalled();expect(document.body.textContent).toContain('changed');useAppStore.setState({sessions:[session()]})
  }
  await click('Fork current conversation…');useAppStore.setState({tabs:{[origin.tabId]:{regions:{[origin.regionId]:{kind:'agent',sessionId:'another-session'}}}}});await choose('right');expect(execute).not.toHaveBeenCalled();expect(document.body.textContent).toContain('no longer contains')
})
it('cancels the reviewed intent before the native document Escape dismissal, and reopens with no side effects',async()=>{
  await render();await click('Fork current conversation…')
  expect(document.activeElement?.getAttribute('data-destination')).toBe('tab')
  // Native event order: window capture precedes the menu owner's document dismissal.
  document.addEventListener('keydown',()=>flushSync(()=>setMenuOpen(false)),{capture:true,once:true})
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
  await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));await act(async()=>setMenuOpen(true));await act(async()=>new Promise(resolve=>setTimeout(resolve,25)))
  expect(document.querySelector('[data-current-fork-review]')).toBeNull();expect(execute).not.toHaveBeenCalled()
  await click('Fork current conversation…');expect(document.querySelector('[data-current-fork-review]')).not.toBeNull();expect(execute).not.toHaveBeenCalled()
})
it('inspects exact original location and wires new Tab to resource Zone and original display Group',async()=>{
  await render();await click('Fork current conversation…');await choose('tab');expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls[0]?.[0]).toMatchObject({operation:'space.inspect',target:{tabId:origin.tabId,regionId:origin.regionId,displayWorkspaceId:origin.workspaceId,groupId:origin.tabGroupId}});expect(execute.mock.calls[1]?.[0]).toMatchObject({operation:'agent.open',content:{kind:'fork-agent',source:{agentSessionId:origin.sessionId,expectedRun:session().control.run,expectedNativeHandle:handle}},destination:{zoneId:location.zoneId,displayWorkspaceId:origin.workspaceId,groupId:origin.tabGroupId,newTab:true},focus:true});expect(execute.mock.calls[1]?.[0].destination).not.toHaveProperty('tabId');expect(document.body.textContent).toContain('new-session')
})
it('four splits use exact original Tab/Region and reject an unrelated location',()=>{
  const review=reviewCurrentFork(session(),origin,'review')
  for(const [destination,split] of [['left','left'],['right','right'],['up','above'],['down','below']] as const) expect(currentForkRequest(review,session(),catalog(),destination,true).destination).toEqual({zoneId:location.zoneId,displayWorkspaceId:origin.workspaceId,groupId:origin.tabGroupId,tabId:origin.tabId,regionId:origin.regionId,split})
  expect(()=>currentForkRequest(review,session(),catalog({locations:[{...location,groupId:'another-group'}]}),'tab',true)).toThrow('unknown')
  expect(()=>currentForkRequest(review,session({nativeHandle:{...handle,sessionId:'changed-native'}}),catalog(),'tab',true)).toThrow('changed')
  expect(()=>currentForkRequest(review,session(),catalog({locations:[location,{...location,spaceId:'another-space'}]}),'tab',true)).toThrow('unknown')
  expect(currentForkRequest(review,session(),catalog({locations:[{...location,spaceId:'exact-space'}]}),'tab',true).destination.spaceId).toBe('exact-space')
})
it('rechecks after location await and does not dispatch stale source or take moved focus',async()=>{
  let resolve!:(value:any)=>void;execute.mockImplementationOnce(()=>new Promise(done=>resolve=done));await render();await click('Fork current conversation…');await act(async()=>document.querySelector<HTMLButtonElement>('[data-destination=right]')!.click());useAppStore.setState({sessions:[session({nativeHandle:{...handle,sessionId:'new-native'}})]});await act(async()=>resolve({operation:'space.inspect',catalog:catalog()}));expect(execute).toHaveBeenCalledOnce();expect(document.body.textContent).toContain('not dispatched');useAppStore.setState({sessions:[session()],activeWorkspaceId:'another-workspace'});await click('Fork current conversation…');await choose('right');expect(execute.mock.calls[2]?.[0]).toMatchObject({operation:'agent.open',focus:false})
})
it('unknown receipt survives menu dismissal, inspect is read only and never repeats launch',async()=>{
  execute.mockImplementation(async request=>{if(request.operation==='agent.open')throw new Error('Response lost');if('requestId' in request.target)return{operation:'space.inspect',catalog:catalog(),request:{requestId:request.target.requestId,known:true,report:{...opened,outcome:'partial',issues:[{step:'identity-reminder',code:'UNKNOWN',message:'Reminder unconfirmed',recovery:'Inspect operation.'}]}}};return{operation:'space.inspect',catalog:catalog()}})
  await render();await click('Fork current conversation…');await choose('right');const operationId=document.querySelector('[data-current-fork-operation]')!.getAttribute('data-current-fork-operation');expect(document.body.textContent).toContain('Response lost');await act(async()=>setMenuOpen(false));await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));await act(async()=>setMenuOpen(true));await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));expect(document.querySelector('[data-current-fork-operation]')?.getAttribute('data-current-fork-operation')).toBe(operationId);await click('Check fork operation');expect(execute.mock.calls.filter(([request])=>request.operation==='agent.open')).toHaveLength(1);expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({operation:'space.inspect',target:{requestId:operationId}});expect(document.body.textContent).toContain('new-session');expect(document.body.textContent).toContain('Reminder unconfirmed')
})
it('unsupported, unknown and read-only explain the exact restriction without side effects',async()=>{
  for(const [value,readonly,message] of [[session({capabilities:{}}),false,'does not support'],[session({nativeHandle:undefined}),false,'has not been observed'],[session({nativeSourceObservation:{state:'unknown'}}),false,'unconfirmed'],[session(),true,'read-only']] as const){await render(value,readonly);expect(document.body.textContent).toContain(message);await click('Fork current conversation…');expect(document.querySelector('[data-current-fork-review]')).toBeNull();expect(execute).not.toHaveBeenCalled()}
  expect(currentForkUnavailableReason(session(),{...origin,regionId:undefined},false)).toContain('exact original')
})
it('retains exact admitted operation before child creation and across controller remount',async()=>{
  const review=reviewCurrentFork(session(),origin,'retained-operation')
  useAppStore.setState({sessions:[session()],spatialRequests:{[review.operationId]:{requestId:review.operationId,operation:'agent.open',createAgent:true,agentSessionId:'child-session',executionHostId:'local',forkSource:review.source}}})
  await render();expect(document.querySelector('[data-current-fork-operation]')?.getAttribute('data-current-fork-operation')).toBe(review.operationId);expect(execute).not.toHaveBeenCalled();execute.mockResolvedValue({operation:'space.inspect',catalog:catalog(),request:{requestId:review.operationId,known:true,report:opened}});await click('Check fork operation');expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({operation:'space.inspect',target:{requestId:review.operationId}}));expect(document.body.textContent).toContain('new-session')
  // An unrelated exact source cannot donate an operation, even before child projection.
  await act(async()=>root.unmount());root=createRoot(host);useAppStore.setState({spatialRequests:{[review.operationId]:{requestId:review.operationId,operation:'agent.open',createAgent:true,agentSessionId:'child-session',executionHostId:'local',forkSource:{...review.source,expectedRun:{runId:'unrelated-run'}}}}});await render();expect(document.querySelector('[data-current-fork-operation]')).toBeNull()
})
