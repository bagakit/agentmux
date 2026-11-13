import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, Fragment, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { useAppStore } from '../src/renderer/src/store'
import { useAgentCurrentForkControls } from '../src/renderer/src/components/AgentCurrentForkControls'
import { OpenDestinationBar } from '../src/renderer/src/components/OpenDestinationBar'
import { AgentOperationFeedback } from '../src/renderer/src/components/AgentOperationFeedback'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { executionHostProjection } from '../src/renderer/src/lib/region-execution-host'
import { WorkbenchMenuSubmit } from '../src/renderer/src/components/WorkbenchMenuScope'
import * as DropdownMenu from '../src/renderer/src/components/HoverDropdownMenu'
import { currentForkRequest, currentForkUnavailableReason, reviewCurrentFork, type CurrentForkSession } from '../src/renderer/src/lib/agent-current-fork'
import { parseSpaceControlRequest } from '../../../packages/core/src/space-control-parser'
vi.mock('../src/renderer/src/store', async importOriginal => { const original = await importOriginal<typeof import('../src/renderer/src/store')>(); return { ...original, useAppStore: (await import('zustand')).create(() => original.useAppStore.getState()) } })
const initialState=useAppStore.getState()
const origin = { workspaceId: 'display-workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region', sessionId: 'original-session' }
const handle = { kind: 'provider' as const, providerId: 'protocol-provider', sessionId: 'original-native', transcriptPath: _hygiene_fixturePath("private/current.jsonl") }
function session(extra = {}): CurrentForkSession { return { id:'original-session',kind:'agent',hostId:'local',providerId:'protocol-provider',executorId:'private',workspacePath:_hygiene_fixturePath("private"),control:{kind:'agent',hostId:'local',agentSessionId:'original-session',run:{runId:'original-run'}},nativeHandle:handle,capabilities:{providerFork:{current:true}},...extra } as any }
const location = { spaceId: null, zoneId:'original-zone', workspaceId:'resource-workspace', displayWorkspaceId:origin.workspaceId, groupId:origin.tabGroupId, tabId:origin.tabId, regionId:origin.regionId }
function catalog(extra = {}): AgentMuxSpaceCatalog { return { spaces:[],zones:[],bindings:[],tabs:[],regions:[{regionId:origin.regionId,tabId:origin.tabId,kind:'agent',agentSessionId:origin.sessionId,runId:'original-run',execution:{hostId:'local',cwd:_hygiene_fixturePath("private")}}],locations:[location],...extra } }
const opened = { operation:'agent.open',requestId:'original-operation',outcome:'opened',from:null,to:{...location,tabId:'new-tab',regionId:'new-region'},agent:{agentSessionId:'new-session',runId:'new-run'},resource:null,save:{layoutApplied:true,clientStateWritten:true,storageFlushRequested:true,diskDurability:'confirmed',reason:null},issues:[] }
let root:Root, host:HTMLDivElement, execute:ReturnType<typeof vi.fn>, setMenuOpen:(open:boolean)=>void
beforeEach(()=>{ (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);execute=vi.fn(async(request:any)=>request.operation==='space.inspect'?{operation:'space.inspect',catalog:catalog()}:{...opened,requestId:request.requestId});useAppStore.setState({...initialState,agentOperations:{},spatialRequests:{},sessions:[session()],tabs:{[origin.tabId]:{regions:{[origin.regionId]:{kind:'agent',sessionId:origin.sessionId}},layout:{activeRegionId:origin.regionId}}},layouts:{[origin.workspaceId]:{activeGroupId:origin.tabGroupId,groups:[{id:origin.tabGroupId,activeTabId:origin.tabId}]}},activeWorkspaceId:origin.workspaceId,mainSurface:'workbench',executeControl:execute},true) })
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
function Surface({ value=session(),readOnly=false,derived }: {value?:CurrentForkSession;readOnly?:boolean;derived?:{id:string;label:string;instruction:string}}) {
  const actions=useAgentCurrentForkControls({session:value,linkOrigin:origin,readOnly})
  const [open,setOpen]=useState(true)
  setMenuOpen=setOpen
  return createElement(Fragment,null,createElement(DropdownMenu.Root,{open,onOpenChange:setOpen},createElement(DropdownMenu.Trigger,null,'Information'),createElement(DropdownMenu.Content,null,createElement(WorkbenchMenuSubmit.Provider,{value:()=>setOpen(false)},actions(),derived?actions(undefined,derived):null))),createElement(AgentOperationFeedback,{subject:{hostId:value.control.hostId,agentSessionId:value.control.agentSessionId,regionId:origin.regionId}}))
}
async function render(value=session(),readOnly=false){await act(async()=>root.render(createElement(Surface,{value,readOnly})));await reopenMenu() }
async function click(text:string){const button=[...document.querySelectorAll<HTMLElement>('[role=menuitem],button')].find(one=>one.textContent?.trim()===text);expect(button,'Missing '+text).toBeTruthy();await act(async()=>button!.click()) }
async function choose(destination:string){const button=document.querySelector<HTMLButtonElement>(`button[data-destination="${destination}"]`);expect(button,'Missing '+destination).toBeTruthy();await act(async()=>button!.click()) }
async function reopenMenu(){await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));await act(async()=>setMenuOpen(true));await act(async()=>new Promise(resolve=>setTimeout(resolve,25)))}
const forkOperation=()=>Object.values(useAppStore.getState().agentOperations).find(operation=>operation.kind==='fork')
const currentReport=(patch={})=>({...opened,requestId:execute.mock.calls.findLast(([request])=>request.operation==='agent.open')?.[0].requestId??'unobserved-operation',...patch})
it('reuses five destination buttons, browser defaults remain six, and cancel/Escape creates nothing',async()=>{
  await act(async()=>root.render(<OpenDestinationBar canSplit onSelect={()=>{}}/>));expect(host.querySelectorAll('[data-destination]')).toHaveLength(6)
  await render();await click('Fork current conversation…');expect(document.querySelectorAll('[data-destination]')).toHaveLength(5);expect(document.querySelector('[data-destination=system]')).toBeNull();expect(document.querySelector('[role=toolbar]')?.getAttribute('aria-label')).toContain('fork');await click('Cancel fork');expect(execute).not.toHaveBeenCalled();await click('Fork current conversation…');await act(async()=>document.querySelector('[data-current-fork-review]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(document.querySelector('[data-current-fork-review]')).toBeNull();expect(execute).not.toHaveBeenCalled()
})
it('exact source review fences changed native identity, Run and Region before any launch',async()=>{
  for(const patch of [{nativeHandle:{...handle,sessionId:'new-native'}},{control:{...session().control,run:{runId:'new-run'}}},{nativeSourceObservation:{state:'unknown'}}]){
    await render();await click('Fork current conversation…');useAppStore.setState({sessions:[session(patch)]});await choose('right');expect(execute).not.toHaveBeenCalled();expect(document.body.textContent).toContain('changed');useAppStore.setState({sessions:[session()]});await reopenMenu()
  }
  await render();await click('Fork current conversation…');useAppStore.setState({tabs:{[origin.tabId]:{regions:{[origin.regionId]:{kind:'agent',sessionId:'another-session'}}}}});await choose('right');expect(execute).not.toHaveBeenCalled();expect(document.body.textContent).toContain('no longer contains')
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
  await render(); const fork = [...document.querySelectorAll('[role=menuitem]')].find(one => one.textContent?.trim() === 'Fork current conversation…')!; expect(fork.querySelector('[data-semantic-icon="action.fork-conversation"]')).not.toBeNull(); expect(fork.querySelector('[data-semantic-icon="git.fork"]')).toBeNull(); await click('Fork current conversation…');await choose('tab');expect(document.querySelector('[role=menu]')).toBeNull();await reopenMenu();expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls[0]?.[0]).toMatchObject({operation:'space.inspect',target:{tabId:origin.tabId,regionId:origin.regionId,displayWorkspaceId:origin.workspaceId,groupId:origin.tabGroupId}});expect(execute.mock.calls[1]?.[0]).toMatchObject({operation:'agent.open',content:{kind:'fork-agent',source:{agentSessionId:origin.sessionId,expectedRun:session().control.run,expectedNativeHandle:handle}},destination:{zoneId:location.zoneId,displayWorkspaceId:origin.workspaceId,groupId:origin.tabGroupId,newTab:true},focus:true});expect(execute.mock.calls[1]?.[0].destination).not.toHaveProperty('tabId');expect(document.body.textContent).toContain('new-session')
})
it('four splits use exact original Tab/Region and reject an unrelated location',()=>{
  const review=reviewCurrentFork(session(),origin,'review')
  for(const destination of ['left','right','up','down'] as const) expect(currentForkRequest(review,session(),catalog(),destination,true).destination).toEqual({zoneId:location.zoneId,displayWorkspaceId:origin.workspaceId,groupId:origin.tabGroupId,tabId:origin.tabId,regionId:origin.regionId,split:destination})
  expect(()=>currentForkRequest(review,session(),catalog({locations:[{...location,groupId:'another-group'}]}),'tab',true)).toThrow('unknown')
  expect(()=>currentForkRequest(review,session({nativeHandle:{...handle,sessionId:'changed-native'}}),catalog(),'tab',true)).toThrow('changed')
  expect(()=>currentForkRequest(review,session(),catalog({locations:[location,{...location,spaceId:'another-space'}]}),'tab',true)).toThrow('unknown')
  expect(currentForkRequest(review,session(),catalog({locations:[{...location,spaceId:'exact-space'}]}),'tab',true).destination.spaceId).toBe('exact-space')
})
it('rechecks after location await and does not dispatch stale source or take moved focus',async()=>{
  let resolve!:(value:any)=>void;execute.mockImplementationOnce(()=>new Promise(done=>resolve=done));await render();await click('Fork current conversation…');await act(async()=>document.querySelector<HTMLButtonElement>('[data-destination=right]')!.click());useAppStore.setState({sessions:[session({nativeHandle:{...handle,sessionId:'new-native'}})]});await act(async()=>resolve({operation:'space.inspect',catalog:catalog()}));expect(execute).toHaveBeenCalledOnce();expect(document.body.textContent).toContain('not dispatched');useAppStore.setState({sessions:[session()],activeWorkspaceId:'another-workspace'});await reopenMenu();await click('Fork current conversation…');await choose('right');expect(execute.mock.calls[2]?.[0]).toMatchObject({operation:'agent.open',focus:false})
})
it('unknown receipt survives menu dismissal, inspect is read only and never repeats launch',async()=>{
  execute.mockImplementation(async request=>{if(request.operation==='agent.open')throw new Error('Response lost');if('requestId' in request.target)return{operation:'space.inspect',catalog:catalog(),request:{requestId:request.target.requestId,known:true,report:{...opened,requestId:request.target.requestId,outcome:'partial',issues:[{step:'identity-reminder',code:'UNKNOWN',message:'Reminder unconfirmed',recovery:'Inspect operation.'}]}}};return{operation:'space.inspect',catalog:catalog()}})
  await render();await click('Fork current conversation…');await choose('right');await reopenMenu();const operationId=document.querySelector('[data-current-fork-operation]')!.getAttribute('data-current-fork-operation');expect(document.body.textContent).toContain('Response lost');await act(async()=>setMenuOpen(false));await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));await act(async()=>setMenuOpen(true));await act(async()=>new Promise(resolve=>setTimeout(resolve,25)));expect(document.querySelector('[data-current-fork-operation]')?.getAttribute('data-current-fork-operation')).toBe(operationId);await click('Check fork operation');expect(execute.mock.calls.filter(([request])=>request.operation==='agent.open')).toHaveLength(1);expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({operation:'space.inspect',target:{requestId:operationId}});expect(document.body.textContent).toContain('new-session');expect(document.body.textContent).toContain('Reminder unconfirmed')
})
it('unsupported, unknown and read-only explain the exact restriction without side effects',async()=>{
  for(const [value,readonly,message] of [[session({capabilities:{}}),false,'does not support'],[session({nativeHandle:undefined}),false,'has not been observed'],[session({nativeSourceObservation:{state:'unknown'}}),false,'unconfirmed'],[session(),true,'read-only']] as const){await render(value,readonly);expect(document.body.textContent).toContain(message);await click('Fork current conversation…');expect(document.querySelector('[data-current-fork-review]')).toBeNull();expect(execute).not.toHaveBeenCalled()}
  expect(currentForkUnavailableReason(session(),{...origin,regionId:undefined},false)).toContain('exact original')
})
it('retains exact admitted operation before child creation and across controller remount',async()=>{
  const review=reviewCurrentFork(session(),origin,'retained-operation')
  useAppStore.setState({sessions:[session()],spatialRequests:{[review.operationId]:{requestId:review.operationId,operation:'agent.open',createAgent:true,agentSessionId:'child-session',executionHostId:'local',forkSource:review.source}}})
  await render();expect(document.querySelector('[data-current-fork-operation]')?.getAttribute('data-current-fork-operation')).toBe(review.operationId);expect(execute).not.toHaveBeenCalled();execute.mockResolvedValue({operation:'space.inspect',catalog:catalog(),request:{requestId:review.operationId,known:true,report:{...opened,requestId:review.operationId}}});await click('Check fork operation');expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({operation:'space.inspect',target:{requestId:review.operationId}}));expect(document.body.textContent).toContain('new-session')
  // An unrelated exact source cannot donate an operation, even before child projection.
  await act(async()=>root.unmount());root=createRoot(host);useAppStore.setState({spatialRequests:{[review.operationId]:{requestId:review.operationId,operation:'agent.open',createAgent:true,agentSessionId:'child-session',executionHostId:'local',forkSource:{...review.source,expectedRun:{runId:'unrelated-run'}}}}});await render();expect(document.querySelector('[data-current-fork-operation]')).toBeNull()
})

it('allows inspection during pending creation and fences a late unknown read behind the creation receipt', async () => {
  let finishCreation!: (value: any) => void, finishInspection!: (value: any) => void
  execute.mockImplementation(request => {
    if (request.operation === 'agent.open') return new Promise(resolve => { finishCreation = resolve })
    if (request.target.requestId) return new Promise(resolve => { finishInspection = resolve })
    return Promise.resolve({ operation: 'space.inspect', catalog: catalog() })
  })
  await render(); await click('Fork current conversation…'); await choose('right')
  expect(document.querySelector('[role=menu]')).toBeNull()
  expect(document.body.textContent).toContain('Fork中')
  await reopenMenu()
  expect(document.body.textContent).toContain('Fork request pending')
  await click('Fork current conversation…')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
  await click('Check fork operation')
  const operationId = document.querySelector('[data-current-fork-operation]')!.getAttribute('data-current-fork-operation')
  expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'space.inspect', target: { requestId: operationId } })
  await act(async () => finishCreation(currentReport()))
  expect(document.body.textContent).toContain('new-session')
  const check = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(item => item.textContent === 'Check fork operation')!
  expect(check.getAttribute('aria-disabled')).toBe('true')
  await act(async () => finishInspection({ operation: 'space.inspect', request: { known: true, report: null } }))
  expect(document.body.textContent).toContain('Fork opened')
  expect(document.body.textContent).toContain('new-session')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it('keeps an inspected opened receipt when the pending creation response is later lost', async () => {
  let loseCreation!: (cause: Error) => void
  execute.mockImplementation(request => {
    if (request.operation === 'agent.open') return new Promise((_resolve, reject) => { loseCreation = reject })
    return Promise.resolve(request.target.requestId
      ? { operation: 'space.inspect', request: { known: true, report: currentReport() } }
      : { operation: 'space.inspect', catalog: catalog() })
  })
  await render(); await click('Fork current conversation…'); await choose('right'); await reopenMenu(); await click('Check fork operation')
  expect(document.body.textContent).toContain('Fork opened')
  await act(async () => loseCreation(new Error('Late response lost')))
  expect(document.body.textContent).toContain('Fork opened')
  expect(document.body.textContent).toContain('new-session')
  expect(document.body.textContent).toContain('Late response lost')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it('keeps an inspected opened receipt when the older creation reply later reports unknown', async () => {
  let finishCreation!: (value: any) => void
  execute.mockImplementation(request => {
    if (request.operation === 'agent.open') return new Promise(resolve => { finishCreation = resolve })
    return Promise.resolve(request.target.requestId
      ? { operation: 'space.inspect', request: { known: true, report: currentReport() } }
      : { operation: 'space.inspect', catalog: catalog() })
  })
  await render(); await click('Fork current conversation…'); await choose('right'); await reopenMenu(); await click('Check fork operation')
  expect(document.body.textContent).toContain('Fork opened')
  await act(async () => finishCreation(currentReport({ outcome: 'unknown', agent: null })))
  expect(document.body.textContent).toContain('Fork opened')
  expect(document.body.textContent).toContain('new-session')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it('the actual fork controls keep the renderer alias in its Region and send the canonical original Core source', async () => {
  const canonical = session({ control: { ...session().control, agentSessionId: 'canonical-original-session' } })
  useAppStore.setState({ sessions: [canonical] })
  execute.mockImplementation(async request => request.operation === 'space.inspect'
    ? { operation: 'space.inspect', catalog: catalog({ regions: [{ ...catalog().regions[0], agentSessionId: canonical.control.agentSessionId }] }) }
    : { ...opened, ...parseSpaceControlRequest(request) })
  await render(canonical); await click('Fork current conversation…'); await choose('right')
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls[1]?.[0]).toMatchObject({ operation: 'agent.open', content: { kind: 'fork-agent', source: {
    agentSessionId: canonical.control.agentSessionId, expectedRun: canonical.control.run, expectedNativeHandle: handle
  } }, destination: { tabId: origin.tabId, regionId: origin.regionId, split: 'right' } })
  expect(useAppStore.getState().tabs[origin.tabId]!.regions[origin.regionId]).toMatchObject({ sessionId: origin.sessionId })
})

it('only inspects the exact retained alias-source fork operation without rewriting or replaying its original input', async () => {
  const canonical = session({ control: { ...session().control, agentSessionId: 'canonical-original-session' } })
  const source = { agentSessionId: canonical.id, expectedRun: canonical.control.run, expectedNativeHandle: handle }
  const admitted = { requestId: 'original-alias-fork', operation: 'agent.open', createAgent: true, agentSessionId: 'child-original', executionHostId: 'local', forkSource: source }
  useAppStore.setState({ sessions: [canonical], spatialRequests: { [admitted.requestId]: admitted } })
  const original = structuredClone(useAppStore.getState().spatialRequests)
  execute.mockResolvedValue({ operation: 'space.inspect', catalog: catalog(), request: { requestId: admitted.requestId, known: true, report: null } })
  await render(canonical)
  await click('Check fork operation')
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'space.inspect', target: { requestId: admitted.requestId } }))
  expect(useAppStore.getState().spatialRequests).toEqual(original)
})
it('a fork-based derived action sends its instruction as the forked conversation\'s first message, and the official Fork sends none', () => {
  const derived = { id: 'retry', label: 'Try another approach', instruction: 'Try a different design.' }
  const review = reviewCurrentFork(session(), origin, 'derived-operation', false, derived)
  expect(currentForkRequest(review, session(), catalog(), 'tab', true).content).toEqual({ kind: 'fork-agent', source: review.source, prompt: derived.instruction })
  const official = reviewCurrentFork(session(), origin, 'official-operation')
  expect(currentForkRequest(official, session(), catalog(), 'tab', true).content).not.toHaveProperty('prompt')
})


it('the real Region header dismisses its invoking menu before preparation and keeps later input and navigation through the original dispatch', async () => {
  let finishLocation!: (value: unknown) => void, finishCreation!: (value: unknown) => void
  const source = session(), originalSessions = useAppStore.getState().sessions
  execute.mockImplementation(request => request.operation === 'space.inspect'
    ? new Promise(resolve => { finishLocation = resolve })
    : new Promise(resolve => { finishCreation = resolve }))
  function HeaderSurface() {
    const actions = useAgentCurrentForkControls({ session: source, linkOrigin: origin, readOnly: false })
    return <AgentRegionHeader name="Source Agent" executorLabel="Fixture" sessionId={source.id} sessionKind="agent"
      executionHost={executionHostProjection(source.control.hostId, source.workspacePath)} regionId={origin.regionId}
      readOnly={false} onHistory={undefined} nativeSession={source} currentConversationActions={actions()} />
  }
  const later = document.createElement('input'); later.value = 'Later original draft'; document.body.append(later)
  try {
    await act(async () => root.render(<HeaderSurface />))
    const more = document.querySelector<HTMLButtonElement>('[aria-label^="More actions for Source Agent"]')!
    expect(more).not.toBeNull()
    await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true })) })
    await click('Fork current conversation…'); await choose('right')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('.agent-region-header')?.textContent).toContain('Fork中')
    expect(execute).toHaveBeenCalledTimes(1)
    await act(async () => { later.focus(); useAppStore.setState({ activeWorkspaceId:'later-workspace' }) })
    await act(async () => finishLocation({ operation:'space.inspect', catalog:catalog() }))
    expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({ operation:'agent.open', focus:false,
      content:{ kind:'fork-agent', source:{ agentSessionId:source.control.agentSessionId, expectedRun:source.control.run, expectedNativeHandle:handle } } })
    await act(async () => finishCreation(currentReport()))
    expect(document.activeElement).toBe(later)
    expect(later.value).toBe('Later original draft')
    expect(useAppStore.getState().activeWorkspaceId).toBe('later-workspace')
    expect(useAppStore.getState().sessions).toBe(originalSessions)
    expect(document.querySelector('.agent-region-header__name')?.textContent).toBe('Source Agent')
    expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
  } finally { later.remove() }
})

it('an inspected partial receipt preserves the created child when the older dispatch later becomes unknown', async () => {
  let finishCreation!: (value: unknown) => void
  execute.mockImplementation(request => request.operation === 'agent.open'
    ? new Promise(resolve => { finishCreation = resolve })
    : Promise.resolve(request.target.requestId ? { operation:'space.inspect', request:{ known:true,
      report:currentReport({ outcome:'partial', issues:[{ step:'save', code:'SAVE_UNCONFIRMED', message:'Placement save unconfirmed.', recovery:'Check original operation.' }] }) } }
      : { operation:'space.inspect', catalog:catalog() }))
  await render(); await click('Fork current conversation…'); await choose('right')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await reopenMenu(); await click('Check fork operation')
  expect(forkOperation()?.phase).toBe('partial')
  expect(forkOperation()?.report?.agent).toMatchObject({ agentSessionId:'new-session', runId:'new-run' })
  await act(async () => finishCreation(currentReport({ outcome:'unknown', agent:null, to:null })))
  expect(forkOperation()?.phase).toBe('partial')
  expect(forkOperation()?.report?.agent?.agentSessionId).toBe('new-session')
  expect(document.body.textContent).toContain('Fork部分完成')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it('an unmounted Fork presentation retains its pending reference and later result without repeating creation', async () => {
  let finishCreation!: (value: unknown) => void
  execute.mockImplementation(request => request.operation === 'agent.open'
    ? new Promise(resolve => { finishCreation = resolve }) : Promise.resolve({ operation:'space.inspect', catalog:catalog() }))
  await render(); await click('Fork current conversation…'); await choose('right')
  const operation = forkOperation()!
  expect(operation).toMatchObject({ kind:'fork', phase:'pending', subject:{ hostId:'local', agentSessionId:session().control.agentSessionId, regionId:origin.regionId } })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => root.render(null))
  await act(async () => finishCreation(currentReport()))
  expect(forkOperation()).toMatchObject({ operationId:operation.operationId, phase:'succeeded', report:{ agent:{ agentSessionId:'new-session', runId:'new-run' }, to:{ regionId:'new-region' } } })
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it.each(['opened', 'retired'] as const)('the real Region header consumes a card-inspected %s receipt before reopening without a second menu check', async outcome => {
  const source = session()
  execute.mockImplementation(async request => request.operation === 'agent.open'
    ? { ...opened, requestId:request.requestId, outcome:'unknown', agent:null, to:null }
    : request.target.requestId ? { operation:'space.inspect', request:{ known:true, report:currentReport({ outcome, ...(outcome === 'retired' ? { to:null } : {}) }) } }
      : { operation:'space.inspect', catalog:catalog() })
  function HeaderSurface() {
    const actions = useAgentCurrentForkControls({ session:source, linkOrigin:origin, readOnly:false })
    return <AgentRegionHeader name="Source Agent" executorLabel="Fixture" sessionId={source.id} sessionKind="agent"
      executionHost={executionHostProjection(source.control.hostId, source.workspacePath)} regionId={origin.regionId}
      readOnly={false} onHistory={undefined} nativeSession={source} currentConversationActions={actions()} />
  }
  async function openMore() {
    const more = document.querySelector<HTMLButtonElement>('[aria-label^="More actions for Source Agent"]')!
    await act(async () => { more.focus(); more.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true })) })
  }
  await act(async () => root.render(<HeaderSurface />))
  await openMore(); await click('Fork current conversation…'); await choose('right')
  const operationId = forkOperation()!.operationId
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.body.textContent).toContain('Fork未确认')
  await act(async () => document.querySelector<HTMLElement>('.agent-operation-feedback summary')!.click())
  await click('核对原操作')
  expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({ operation:'space.inspect', target:{ requestId:operationId } })
  await openMore()
  expect(document.body.textContent).toContain(outcome === 'opened' ? 'Fork opened' : 'Fork target closed')
  expect(document.body.textContent).toContain('new-session')
  await click('Fork current conversation…')
  expect(document.querySelector('[data-current-fork-review]')).not.toBeNull()
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
  expect(execute.mock.calls.filter(([request]) => request.operation === 'space.inspect' && request.target.requestId)).toHaveLength(1)
})

it('a newer inspection retires an opened Fork receipt while keeping the original child identity', async () => {
  await render(); await click('Fork current conversation…'); await choose('right'); await reopenMenu()
  expect(document.body.textContent).toContain('Fork opened')
  const originalId = execute.mock.calls.find(([request]) => request.operation === 'agent.open')![0].requestId
  execute.mockResolvedValueOnce({ operation:'space.inspect', request:{ known:true, report:currentReport({ outcome:'retired', to:null }) } })
  await click('Check fork operation')
  expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({ operation:'space.inspect', target:{ requestId:originalId } })
  expect(forkOperation()).toMatchObject({ phase:'retired', operationId:originalId, report:{ outcome:'retired', agent:{ agentSessionId:'new-session', runId:'new-run' }, to:null } })
  expect(document.body.textContent).toContain('Fork target closed')
  expect(document.body.textContent).toContain('Fork目标已关闭')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it('all Fork-based menu actions expose the same unsettled operation and unlock after a confirmed receipt even while its older response waits', async () => {
  const derived = { id:'retry', label:'Try another approach', instruction:'Try another design.' }
  let finishCreation!: (value:unknown) => void
  execute.mockImplementation(request => request.operation === 'agent.open' ? new Promise(resolve => { finishCreation = resolve })
    : Promise.resolve(request.target.requestId ? { operation:'space.inspect', request:{ known:true, report:currentReport() } }
      : { operation:'space.inspect', catalog:catalog() }))
  await act(async () => root.render(<Surface derived={derived} />)); await reopenMenu()
  await click('Fork current conversation…'); await choose('right'); await reopenMenu()
  const official = document.querySelector('[data-current-fork-action]')!, sibling = document.querySelector('[data-derived-action="retry"]')!
  expect(official.getAttribute('aria-disabled')).toBe('true')
  expect(sibling.getAttribute('aria-disabled')).toBe('true')
  await click('Try another approach…')
  expect(document.querySelector('[data-current-fork-review]')).toBeNull()
  await click('Check fork operation')
  expect(document.querySelector('[data-current-fork-action]')!.getAttribute('aria-disabled')).not.toBe('true')
  expect(document.querySelector('[data-derived-action="retry"]')!.getAttribute('aria-disabled')).not.toBe('true')
  await click('Try another approach…')
  expect(document.querySelector('[data-current-fork-review]')?.textContent).toContain(derived.instruction)
  await act(async () => finishCreation(currentReport({ outcome:'unknown', agent:null, to:null })))
  expect(document.querySelector('[data-current-fork-review]')?.textContent).toContain(derived.instruction)
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
  expect(useAppStore.getState().sessions[0]?.control).toEqual(session().control)
})


it('retired Fork results stay static and preserve the source when an older opened reply arrives', async () => {
  let finishCreation!: (value: unknown) => void
  execute.mockImplementation(request => request.operation === 'agent.open' ? new Promise(resolve => { finishCreation = resolve })
    : Promise.resolve(request.target.requestId ? { operation:'space.inspect', request:{ known:true,
      report:currentReport({ outcome:'retired', to:null }) } } : { operation:'space.inspect', catalog:catalog() }))
  await render(); await click('Fork current conversation…'); await choose('right')
  const originalOperation = forkOperation()!
  await reopenMenu(); await click('Check fork operation')
  expect(forkOperation()?.phase).toBe('retired')
  expect(document.body.textContent).toContain('Fork目标已关闭')
  await act(async () => finishCreation({ ...opened, requestId:originalOperation.operationId }))
  expect(forkOperation()?.phase).toBe('retired')
  expect(useAppStore.getState().sessions[0]?.control).toEqual(session().control)
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
  await click('Fork current conversation…')
  expect(document.querySelector('[data-current-fork-review]')).not.toBeNull()
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
})

it('an older operation cannot overwrite a later explicitly confirmed Fork intent or its new child', async () => {
  let finishOlder!: (value: unknown) => void
  execute.mockImplementation(request => {
    if (request.operation !== 'agent.open') return Promise.resolve(request.target.requestId
      ? { operation:'space.inspect', request:{ known:true, report:{ ...opened, requestId:request.target.requestId } } }
      : { operation:'space.inspect', catalog:catalog() })
    if (execute.mock.calls.filter(([value]) => value.operation === 'agent.open').length === 1) return new Promise(resolve => { finishOlder = resolve })
    return Promise.resolve({ ...opened, requestId:request.requestId, agent:{ agentSessionId:'second-child', runId:'second-run' } })
  })
  await render(); await click('Fork current conversation…'); await choose('right')
  const olderId = forkOperation()!.operationId
  await reopenMenu(); await click('Check fork operation')
  await click('Fork current conversation…'); await choose('right')
  const creations = execute.mock.calls.filter(([request]) => request.operation === 'agent.open')
  expect(creations).toHaveLength(2)
  expect(creations[1]![0].requestId).not.toBe(olderId)
  await reopenMenu()
  expect(document.body.textContent).toContain('second-child')
  await act(async () => finishOlder({ ...opened, requestId:olderId, outcome:'unknown', agent:null, to:null }))
  expect(document.body.textContent).toContain('second-child')
  expect(document.body.textContent).toContain('Fork opened')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(2)
})
