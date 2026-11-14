// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { act, type ReactNode } from 'react'
import { useMoteMainEntry } from '../src/renderer/src/lib/mote-main-entry'
import { MoteDialogueViewProvider } from '../src/renderer/src/lib/mote-dialogue-view'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace, seedMoteWorkface, installNativePopover } from './fixtures/mote-workface'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string } }) => <div data-terminal-session={session.id} /> }))
const baseline = useAppStore.getState(), launcher = useLauncherState.getState(), closes: Array<() => void | Promise<void>> = []
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(baseline, true); useLauncherState.setState(launcher, true); localStorage.clear() })
function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IntersectionObserver', class { constructor(private notify: IntersectionObserverCallback) {} observe(target: Element) { queueMicrotask(() => this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) } unobserve() {} disconnect() {} })
  localStorage.clear(); seedMoteWorkface(); closes.push(installNativePopover())
  const continuity = { operationId: 'original-recovery', agentSessionId: defaultAgent.id, trigger: 'manual' as const,
    previousRun: defaultAgent.control.run, policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, admittedAt: 1, observedAt: 1, rechecks: 0,
    kind: 'unavailable' as const, reason: 'native-handle-unavailable' as const, evidence: { kind: 'run-ended' as const, state: 'exited' as const, observedAt: 1 } }
  useAppStore.setState(current => ({ loading: false, initialize: async () => () => {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn(async () => {}),
    activeWorkspaceId: scratchWorkspace.id, mainSurface: 'workbench', sessions: current.sessions.map(item => item.id === defaultAgent.id ? {
      ...defaultAgent, processState: 'exited' as const, continuity, status: { state: 'error' as const, source: 'run-process' as const, observedAt: 1, continuity: 'unavailable' as const, continuityReason: 'native-handle-unavailable' as const }
    } : item), viewModes: { [defaultAgent.id]: 'activity' } }))
  useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', defaultTab.id)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(moteTopics); vi.spyOn(api.scratch, 'readTopic').mockImplementation(async (_workspace, id) => moteTopics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  const read = vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }): Promise<MoteDialoguePage> => ({ main: { target, identity: { hostId: 'local', moteId: moteTopics[0]!.id }, status: 'ready', resource: null, documentRevision: 'original-file', roleRevision: 'original-role', current: reference, issue: null }, links: [], incarnation: 'original-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }))
  vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(new Error('Original conversation source unavailable'))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation(async input => { const closed = new AbortController(); return { ...input, sourceHostId: input.hostId, scope: { sources: [] }, coverage: [], closed: closed.signal, dispose() { closed.abort() } } })
  return { read, ensure: vi.spyOn(api.moteDialogue, 'ensureRecovery'), inspect: vi.spyOn(api.moteDialogue, 'inspectRecovery'), open: vi.spyOn(api.spatial, 'openAgent'), send: vi.spyOn(useAppStore.getState(), 'send') }
}
async function mounted(node:ReactNode = <App />) { const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container); closes.push(async () => { await act(async () => root.unmount()); container.remove() }); await act(async () => root.render(node)); return container }
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)

it('actual App exposes the current unavailable Main and original actions without entry admission or opening reading details', async () => {
  const calls = setup(), container = await mounted()
  await vi.waitFor(() => expect(container.querySelector('.activity-feed[data-mote-conversation="true"]')).not.toBeNull())
  const reader = container.querySelector('.activity-feed[data-mote-conversation="true"]')!, workface = reader.closest('[data-mote-workface]')!
  await vi.waitFor(() => expect(workface.querySelector('[data-mote-main-recovery]')?.textContent).toContain('无法原样恢复'))
  for (const label of ['开始新一轮', '更换主 Agent…']) expect(button(workface, label)?.closest('[hidden],[inert],details')).toBeNull()
  const originalActions = reader.querySelector('[data-original-session-actions]')!
  expect(originalActions).not.toBeNull();expect(originalActions.closest('[hidden],[inert],details')).toBeNull()
  const output = button(originalActions, 'Read original output')!
  expect(output).toBeDefined(); expect(output.closest('details')).toBeNull()
  expect(workface.querySelector<HTMLDetailsElement>('.mote-conversation__reading-tools')?.open).toBe(false)
  const editor = workface.querySelector('[aria-label="Message Agent"]')
  expect(editor).not.toBeNull(); expect(editor?.closest('[hidden],[inert]')).toBeNull()
  expect(calls.ensure).not.toHaveBeenCalled(); expect(calls.inspect).not.toHaveBeenCalled(); expect(calls.open).not.toHaveBeenCalled(); expect(calls.send).not.toHaveBeenCalled()
})

it.each(['running', 'newer-run'] as const)('actual App does not present an old unavailable operation as a fault on %s', async kind => {
  const calls = setup()
  useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === defaultAgent.id && item.kind === 'agent' ? { ...item,
    ...(kind === 'running' ? { processState:'running' as const } : { control:{ ...item.control, run:{runId:'newer-original-run'} } }) } : item) }))
  const container = await mounted()
  await vi.waitFor(() => expect(container.querySelector('.activity-feed[data-mote-conversation="true"]')).not.toBeNull())
  expect(container.querySelector('[data-mote-main-recovery]')).toBeNull()
  expect(container.querySelector('[aria-label="Message Agent"]')?.closest('[hidden],[inert]')).toBeNull()
  expect(calls.open).not.toHaveBeenCalled(); expect(calls.send).not.toHaveBeenCalled(); expect(calls.ensure).not.toHaveBeenCalled()
})

it('actual floating App shows canonical unavailable without admitting another recovery and navigation keeps the draft and old input', async () => {
  const calls = setup()
  calls.inspect.mockResolvedValue({operation:null})
  calls.ensure.mockImplementation(async request => ({operation:{ ...useAppStore.getState().sessions.find(item=>item.id===defaultAgent.id)!.continuity!,
    operationId:request.operationId,previousRun:request.expectedRun,moteMainEntry:{target:request.target,reference:request.reference,expectedRoleRevision:request.expectedRoleRevision} }}))
  const key = moteEntryDraftKey({ workspace:scratchWorkspace, topic:moteTopics[0]!, rootPath:moteTopics[0]!.directoryPath })
  useLauncherState.getState().setDraft(key,'prompt','Original draft with an attachment reference')
  const pending = { operationId:'old-unknown-query',text:'Old question waiting for the original Agent',status:'deferred' as const,runId:defaultAgent.control.run.runId,promptCondition:null,error:'Original reply unknown',inputIntakeStarted:true }
  useAppStore.setState({ agentSteerQueues:{[defaultAgent.id]:[pending as any]} })
  const container = await mounted()
  await act(async () => requestPmoTeamsTopicFloatingOpen({targetTopicId:moteTopics[0]!.id}))
  const visible = () => [...container.querySelectorAll<HTMLElement>('[data-mote-workface]')].find(e => e.closest('.pmo-teams-topic-floating__body') && !e.closest('[hidden],[inert]')) ?? [...container.querySelectorAll<HTMLElement>('[data-mote-main-recovery]')].at(-1)?.closest<HTMLElement>('[data-mote-workface]')
  await vi.waitFor(() => expect(visible()?.querySelector('[data-mote-main-recovery]')?.textContent).toContain('无法原样恢复'))
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true})))
  expect(visible()?.querySelector('[data-mote-main-recovery]')).not.toBeNull()
  await act(async () => button(visible()!,'开始新一轮')!.click())
  await vi.waitFor(() => expect(visible()?.textContent).toContain('旧对话和未确认的消息留在原处'))
  expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Original draft with an attachment reference')
  expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]).toEqual([pending])
  expect(calls.open).not.toHaveBeenCalled(); expect(calls.ensure).toHaveBeenCalledTimes(1); expect(calls.send).not.toHaveBeenCalled()
})

it('actual App exposes independent Main choices for unknown recovery and opens the original settings without a new request', async () => {
  const calls = setup()
  useAppStore.setState(state => ({ sessions:state.sessions.map(item => item.id===defaultAgent.id && item.kind==='agent' ? {...item,
    continuity:{...item.continuity!,kind:'pending' as const,reason:'operation-unconfirmed' as const,evidence:{kind:'run-unknown' as const,observedAt:1,message:'Original recovery ACK unknown'}},
    status:{...item.status,continuity:undefined,continuityReason:undefined} } : item) }))
  const container=await mounted()
  await vi.waitFor(() => expect(container.querySelector('[data-mote-main-recovery]')?.textContent).toContain('未确认'))
  const row=container.querySelector('[data-mote-main-recovery]')!
  expect(button(row,'开始新一轮')).toBeDefined()
  await act(async()=>button(row,'更换主 Agent…')!.click())
  await vi.waitFor(()=>expect(document.querySelector('.mote-quick-mode-dialog')).not.toBeNull())
  expect(calls.open).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})


const scope = { workspace:scratchWorkspace, topic:moteTopics[0]!, rootPath:moteTopics[0]!.directoryPath }
function Entry({token}:{token:string}) { return <MoteDialogueViewProvider scope={scope} active><Probe token={token}/></MoteDialogueViewProvider> }
function Probe({token}:{token:string}) { const value=useMoteMainEntry({scope,entryToken:token,active:true});return <output data-entry-status={value.status}>{value.issue}</output> }
function setOriginal(value:(item:any)=>any) { useAppStore.setState(state=>({sessions:state.sessions.map(item=>item.id===defaultAgent.id?value(item):item)})) }

it('early edit cancellation survives same-Run continuity observation updates while canonical unavailable stays visible',async()=>{
  const calls=setup();setOriginal(item=>({...item,continuity:undefined,status:{...item.status,continuity:undefined,continuityReason:undefined}}))
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});closes.push(()=>release())
  const read=calls.read.getMockImplementation()!;calls.read.mockImplementation(async input=>{await held;return read(input)})
  const container=await mounted(<Entry token="original-entry"/>)
  await act(async()=>document.dispatchEvent(new InputEvent('input',{bubbles:true})))
  await act(async()=>{setOriginal(item=>({...item,continuity:{operationId:'observed-original',agentSessionId:item.id,trigger:'manual',previousRun:item.control.run,policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},admittedAt:1,observedAt:2,rechecks:1,kind:'unavailable',reason:'native-handle-unavailable',evidence:{kind:'run-ended',state:'exited',observedAt:2}}}));release()})
  await vi.waitFor(()=>expect(container.querySelector('output')?.textContent).toContain('尚未确认可接续原会话的 ID'))
  expect(calls.inspect).not.toHaveBeenCalled();expect(calls.ensure).not.toHaveBeenCalled();expect(calls.open).not.toHaveBeenCalled()
})

it('a new explicit entry can recheck a previously unavailable Provider without another creation or replay',async()=>{
  const calls=setup();setOriginal(item=>({...item,continuity:{...item.continuity,reason:'provider-unavailable'}}))
  calls.inspect.mockResolvedValue({operation:null})
  calls.ensure.mockImplementation(async request=>({operation:{...useAppStore.getState().sessions.find(item=>item.id===defaultAgent.id)!.continuity!,operationId:request.operationId,previousRun:request.expectedRun,kind:'unavailable',reason:'provider-unavailable',moteMainEntry:{target:request.target,reference:request.reference,expectedRoleRevision:request.expectedRoleRevision}}}))
  const container=document.createElement('div');document.body.append(container);const root=createClientUiRoot(container);closes.push(async()=>{await act(async()=>root.unmount());container.remove()})
  await act(async()=>root.render(<Entry token="first-open"/>));await vi.waitFor(()=>expect(calls.ensure).toHaveBeenCalledTimes(1))
  calls.ensure.mockImplementation(async request=>({operation:{...useAppStore.getState().sessions.find(item=>item.id===defaultAgent.id)!.continuity!,operationId:request.operationId,previousRun:request.expectedRun,kind:'reattachable',reason:'already-running',evidence:{kind:'run-running',observedAt:3},moteMainEntry:{target:request.target,reference:request.reference,expectedRoleRevision:request.expectedRoleRevision}}} as any))
  vi.spyOn(useAppStore.getState(),'refreshSession').mockResolvedValue()
  await act(async()=>root.render(<Entry token="second-open"/>));await vi.waitFor(()=>expect(calls.ensure).toHaveBeenCalledTimes(2))
  expect(calls.ensure.mock.calls[0]![0].operationId).not.toBe(calls.ensure.mock.calls[1]![0].operationId)
  expect(calls.open).not.toHaveBeenCalled();expect(calls.send).not.toHaveBeenCalled()
})

it.each(['new-run','same-run'] as const)('a late unavailable reply never faults a healthy %s or admits another Run under the same entry',async kind=>{
  const calls=setup();setOriginal(item=>({...item,continuity:undefined}))
  calls.inspect.mockResolvedValue({operation:null})
  let release!:(value:any)=>void;calls.ensure.mockImplementation(()=>new Promise(resolve=>{release=resolve}));closes.push(()=>release?.({operation:null}))
  const container=await mounted(<Entry token="one-explicit-open"/>);await vi.waitFor(()=>expect(calls.ensure).toHaveBeenCalledTimes(1))
  const request=calls.ensure.mock.calls[0]![0]
  await act(async()=>setOriginal(item=>({...item,processState:'running',control:{...item.control,run:kind==='new-run'?{runId:'new-healthy-run'}:item.control.run}})))
  await act(async()=>release({operation:{operationId:request.operationId,agentSessionId:reference.sessionId,trigger:'manual',previousRun:request.expectedRun,policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},admittedAt:1,observedAt:2,rechecks:0,kind:'unavailable',reason:'native-handle-unavailable',evidence:{kind:'run-ended',state:'exited',observedAt:2},moteMainEntry:{target:request.target,reference:request.reference,expectedRoleRevision:request.expectedRoleRevision}}}))
  expect(container.textContent).not.toContain('尚未确认可接续原会话的 ID');expect(calls.ensure).toHaveBeenCalledTimes(1)
})

it('actual App opens the retained original start position while its public handover source is still waiting',async()=>{
  setup()
  const {createMoteConversationStartFixture}=await import('../../host/test/helpers/mote-conversation-start-fixture')
  const {ScratchTopics}=await import('@agentmux/host/mote-resources')
  const {dirname}=await import('node:path')
  const {desktopWorkbenchFromSpatial}=await import('../src/renderer/src/lib/desktop-spatial-state')
  const {scratchTopicsScope}=await import('../src/renderer/src/lib/scratch-topic-snapshots')
  const {spatialAgentOpenRecord,moteMainCreatedReference}=await import('@agentmux/core/spatial-graph')
  const {moteAgent}=await import('./fixtures/mote-workface')
  const f=await createMoteConversationStartFixture({providerId:'claude'});closes.push(f.close)
  await f.start('old-main');await f.settledSetup('old-main');await f.start('held-start','Original pending first message is not a replacement prompt',true)
  const graph=(await f.spatial.read())!.graph,record=spatialAgentOpenRecord(graph,'held-start')!,created=moteMainCreatedReference(record)!
  const main=(await f.main.readCurrentMoteMain(f.target)).current!
  let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve});closes.push(()=>release())
  const sources=f.dialogue.read.bind(f.dialogue);let sourceWaits=0
  vi.spyOn(f.dialogue,'read').mockImplementation(async(input,context)=>{if(input.operationId==='held-start:source'){sourceWaits++;await barrier}return sources(input,context)})
  const workspace={id:f.target.expectedResource.workspaceId,hostId:'local',path:f.target.expectedResource.workspacePath,name:'Original private Mote',kind:'folder' as const}
  const topics=new ScratchTopics(),identity=await topics.readForDirectory(workspace,dirname(f.path)),topic=await topics.read(workspace,identity!.id)
  if(!topic)throw Error('Original public Mote topic missing')
  const projected=desktopWorkbenchFromSpatial(graph),prior=useAppStore.getState()
  const raw=f.h.client.agentSessions()
  useAppStore.setState({config:{...prior.config!,workspaces:[workspace],executors:{saved:{label:'Saved',providerId:'claude',command:'claude',args:[],env:{},injectAgentMuxGuide:false}}},
    tabs:projected.tabs,layouts:projected.layouts,spaceZoneBindings:{[f.target.zoneId]:{spaceId:f.target.spaceId,workspaceId:workspace.id,topicId:topic.id,contentKind:'mote'}},activeWorkspaceId:workspace.id,mainSurface:'workbench',
    sessions:raw.map(value=>({...moteAgent(value.agentSessionId,null,'waiting'),workspacePath:value.workspacePath,providerId:value.providerId,control:{kind:'agent' as const,hostId:'local',agentSessionId:value.agentSessionId,run:value.run}})),
    scratchTopicSnapshots:{[workspace.id]:{scope:scratchTopicsScope(workspace),topics:[topic],revision:1,error:null,reading:false}},
    moteMainCreationReferences:{[JSON.stringify(f.target)]:{target:f.target,operationId:'held-start',deferredInput:{operationId:'held-start_query',prompt:'Original pending first message is not a replacement prompt'}}},refreshScratchTopics:vi.fn(async()=>{})})
  useAppStore.getState().activateTab(workspace.id,main.groupId,main.tabId)
  vi.mocked(api.scratch.listTopics).mockResolvedValue([topic]);vi.mocked(api.scratch.readTopic).mockResolvedValue(topic)
  vi.mocked(api.moteDialogue.read).mockImplementation(input=>f.rpc.call('space.mote.dialogue.read',input))
  vi.spyOn(api.motePreferences,'read').mockImplementation(input=>f.rpc.call('space.mote.preferences.read',input))
  vi.spyOn(api.moteDialogue,'inspectSetup').mockImplementation(input=>f.rpc.call('space.mote.dialogue.setup.inspect',input))
  vi.spyOn(api.moteDialogue,'advanceSetup').mockImplementation(input=>f.rpc.call('space.mote.dialogue.setup.advance',input))
  vi.spyOn(api.spatial,'read').mockImplementation(()=>f.spatial.read())
  const open=vi.mocked(api.spatial.openAgent),originalRun=raw.find(value=>value.agentSessionId===main.sessionId)!.run.runId,inputCount=f.h.inner.kernel.input.mock.calls.filter(([id])=>id===originalRun).length,runCount=f.h.started.length
  const container=await mounted()
  await vi.waitFor(()=>expect(button(container,'主 Agent')).toBeDefined())
  await act(async()=>button(container,'主 Agent')!.click())
  await vi.waitFor(()=>expect(button(document,'开始新一轮对话')).toBeDefined())
  await act(async()=>button(document,'开始新一轮对话')!.click())
  await vi.waitFor(()=>expect(container.querySelector('[data-main-original-request]')).not.toBeNull())
  const request=container.querySelector('[data-main-original-request]')!
  await act(async()=>button(request,'核对原开始请求')!.click())
  await vi.waitFor(()=>expect(button(request,'查看原开始位置')).toBeDefined())
  expect(sourceWaits).toBeGreaterThan(0)
  await act(async()=>button(request,'查看原开始位置')!.click())
  await vi.waitFor(()=>expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({tabId:created.tabId,regionId:created.regionId,groupId:created.groupId}))
  expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(main)
  expect(open).not.toHaveBeenCalled();expect(f.h.started).toHaveLength(runCount);expect(f.h.inner.kernel.input.mock.calls.filter(([id])=>id===originalRun)).toHaveLength(inputCount);expect(JSON.stringify(f.h.inner.kernel.input.mock.calls)).not.toContain('Original pending first message is not a replacement prompt');expect(api.moteDialogue.advanceSetup).not.toHaveBeenCalled()
  expect(useAppStore.getState().moteMainCreationReferences[JSON.stringify(f.target)]?.operationId).toBe('held-start')
  await act(async()=>release())
},60000)
