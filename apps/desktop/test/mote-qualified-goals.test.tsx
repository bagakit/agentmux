// @vitest-environment happy-dom
import {act,Profiler} from 'react'
import {chooseField} from './helpers/selection-field'
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import type {AgentMuxSpatialGraph} from '@agentmux/core/spatial-graph'
import {admitSpatialAgentOpen,admitSpatialAgentAssociation} from '../../../packages/core/src/spatial-agent-open'
import type {DemandAgentReference,DemandSpaceMemberReference} from '@agentmux/demand'
import {demandAgentReferenceKey} from '@agentmux/demand'
import {PMO_TEAMS_TOPIC_ID,scratchTopicDirectoryName} from '@agentmux/host/mote-model'
import {seedMoteWorkface,moteTopics,scratchWorkspace,defaultAgent} from './fixtures/mote-workface'
import {createClientUiRoot} from './helpers/client-ui-render'
import {restorePersistedWorkbench} from '../src/renderer/src/lib/workbench-persistence'
import {desktopSpatialGraph,desktopWorkbenchFromSpatial} from '../src/renderer/src/lib/desktop-spatial-state'
import * as appStore from '../src/renderer/src/store'
import {api} from '../src/renderer/src/lib/api'
import * as moteGoals from '../src/renderer/src/lib/mote-goals'
import {goalsForMote,moteGoalContext} from '../src/renderer/src/lib/mote-goals'
import {MoteCurrentWork} from '../src/renderer/src/components/MoteCurrentWork'
import {spaceMountKey} from '../src/shared/space-mount'
import {spaceSessionMemberKey} from '@agentmux/core/space-sessions'
import {hostedAgentSessionSummary} from '../../../packages/core/src/hosted-session-summary'
import {moteAgent} from './fixtures/mote-workface'
import type {SpaceSnapshot} from '@agentmux/core'
import type {MountedSessionObservation} from '../src/renderer/src/lib/space-mount-sessions'
import type {DemandRecord} from '../src/renderer/src/lib/global-demand-board'
vi.mock('../src/renderer/src/components/GoalDelegationWork',()=>({GoalDelegationWork:()=>null}))
vi.mock('../src/renderer/src/components/GoalContinuationControl',()=>({GoalContinuationControl:()=>null}))
const scope={workspace:scratchWorkspace,topic:moteTopics.find(t=>t.id===PMO_TEAMS_TOPIC_ID)!,rootPath:scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}
const before=appStore.useAppStore.getState()
let graph:AgentMuxSpatialGraph|null,container:HTMLDivElement,root:ReturnType<typeof createClientUiRoot>,ref:DemandSpaceMemberReference
function goal(id:string,refs:DemandAgentReference[]):DemandRecord{return {id,title:id,description:'',status:'in_progress',priority:'normal',projectId:null,projectName:null,sessionIds:refs,createdAt:1,updatedAt:2,source:'session'}}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);seedMoteWorkface();const original=desktopSpatialGraph(appStore.useAppStore.getState(),moteTopics)
const context=moteGoalContext(appStore.useAppStore.getState(),scope),zone=original.zones.find(z=>z.zoneId===context.contentRef!.zoneId)!,spaceId=original.bindings.find(b=>b.zoneId===zone.zoneId)!.spaceId
const opened=admitSpatialAgentOpen(original,{agentSessionId:defaultAgent.id,request:{schemaVersion:5,requestId:'original-C',operation:'agent.open',content:{kind:'new-agent',executorId:'fixture'},destination:{spaceId,zoneId:zone.zoneId,newTab:true},focus:false},execution:{hostId:'D-in-source',runtimeId:'D-runtime',executorRevision:'selected-revision',workspaceId:null,workspacePath:zone.directoryPath!},placement:{runtimeId:'source-runtime',hostId:zone.hostId!,workspaceId:zone.workspaceId,workspacePath:zone.directoryPath!},regionResource:{workspaceId:zone.workspaceId}})
graph=opened.graph;const projected=restorePersistedWorkbench({config:appStore.useAppStore.getState().config!,sessions:[],persisted:desktopWorkbenchFromSpatial(graph),createTabGroupId:()=> 'unused',preserveEntityIds:new Set(graph.tabs.map(t=>t.tabId))});appStore.useAppStore.setState({tabs:projected.tabs,layouts:projected.layouts,mountedSpaceInputs:{},mountedSpaceObservations:{},mountedSpaceSessions:{}})
ref={kind:'space-member',source:{runtimeId:'source-runtime',spaceId,regionId:opened.record.address.regionId,admission:{kind:'creation',operationId:'original-C'}},execution:{runtimeId:'D-runtime',agentSessionId:defaultAgent.id}}
vi.spyOn(appStore,'currentCoreSpatialGraph').mockImplementation(()=>graph);vi.spyOn(api.goals,'execute').mockResolvedValue({operation:'demand.list',demands:[]});container=document.createElement('div');document.body.append(container);root=createClientUiRoot(container)})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();appStore.useAppStore.setState(before,true);vi.restoreAllMocks()})
const context=()=>moteGoalContext(appStore.useAppStore.getState(),scope,null,graph)
const render=async(records:DemandRecord[])=>{appStore.useAppStore.setState({demands:Object.fromEntries(records.map(r=>[r.id,r]))});await act(async()=>root.render(<MoteCurrentWork scope={scope} reference={null}/>))}
it('matches a qualified original admission and excludes same SID in another Runtime, Source, Region or C',()=>{const records=[goal('exact',[ref]),...(['runtime','source','space','region','C'] as const).map(kind=>{const wrong=structuredClone(ref);if(kind==='runtime')wrong.execution.runtimeId='other-runtime';if(kind==='source')wrong.source.runtimeId='other-source';if(kind==='space')wrong.source.spaceId='other-space';if(kind==='region')wrong.source.regionId='other-region';if(kind==='C')wrong.source.admission.operationId='other-C';return goal(kind,[wrong])})];const value=context();expect(goalsForMote(Object.fromEntries(records.map(r=>[r.id,r])),value.sessionIds,value.contentRef,value.agentReferences).map(r=>r.id)).toEqual(['exact'])})
it('actual Mote keeps the unloaded qualified Goal without borrowing the receiving same-SID label',async()=>{await render([goal('Qualified original',[ref])]);expect(container.querySelector('[data-mote-goal="Qualified original"]')).not.toBeNull();expect(container.textContent).toContain('1 linked discussion not loaded. Original references retained.');expect(appStore.useAppStore.getState().demands['Qualified original']!.sessionIds[0]).toBe(ref)})
it('separates raw IDs from qualified view keys while retaining original raw Goal membership',()=>{const key=demandAgentReferenceKey(ref),value=context();const records={raw:goal('raw',[defaultAgent.id]),qualified:goal('qualified',[ref]),collision:goal('collision',[key])};expect(goalsForMote(records,value.sessionIds,value.contentRef,value.agentReferences).map(r=>r.id).sort()).toEqual(['qualified','raw'])})

it('shows confirmed empty work until an original Goal uses the unresolved discussion', async () => {
  delete graph!.resources['core:agent-open']
  await render([])
  expect(context().unconfirmedMembers).toContainEqual({ regionId: ref.source.regionId, operationId: 'original-C' })
  expect(container.textContent).toContain('No linked work yet')
  expect(container.textContent).not.toContain('Some Mote discussions could not be checked.')

  await act(async () => appStore.useAppStore.setState({ demands: { original: goal('Referenced work', [ref]) } }))
  expect(container.textContent).toContain('Some Mote discussions could not be checked.')
  expect(container.textContent).not.toContain('No linked work yet')

  await act(async () => appStore.useAppStore.setState({ demands: {} }))
  expect(container.textContent).toContain('No linked work yet')
  expect(container.textContent).not.toContain('Some Mote discussions could not be checked.')
})

it('retains the exact unresolved C as last-known alongside a healthy raw neighbor, then stops matching a changed C', async () => {
  const original = goal('Qualified retained', [ref]), neighbor = goal('Healthy neighbor', ['neighbor-agent'])
  await render([original, neighbor])
  const drafts = appStore.useAppStore.getState().agentComposerDrafts
  const saved = structuredClone(graph!), configuration = appStore.useAppStore.getState().config!
  await act(async () => appStore.useAppStore.setState({ config: { ...configuration, workspaces: [] } }))
  expect(container.querySelector('[data-mote-goal="Qualified retained"]')).not.toBeNull()
  expect(container.querySelector('[data-mote-goal="Healthy neighbor"]')).not.toBeNull()
  await act(async () => appStore.useAppStore.setState({ config: configuration }))
  delete graph!.resources['core:agent-open']
  await act(async () => appStore.useAppStore.setState(state => ({ tabs: { ...state.tabs } })))
  expect(container.querySelector('[data-mote-goal="Qualified retained"]')).not.toBeNull()
  expect(container.querySelector('[data-mote-goal="Healthy neighbor"]')).not.toBeNull()
  expect(container.textContent).toContain('Some Mote discussions could not be checked.')
  expect(appStore.useAppStore.getState().demands['Qualified retained']!.sessionIds).toEqual([ref])
  expect(appStore.useAppStore.getState().agentComposerDrafts).toBe(drafts)
  graph = saved
  const region = graph.regions.find(r => r.regionId === ref.source.regionId)!
  region.creationOperationId = 'different-C'
  await act(async () => appStore.useAppStore.setState(state => ({ tabs: { ...state.tabs } })))
  expect(container.querySelector('[data-mote-goal="Qualified retained"]')).toBeNull()
  expect(container.querySelector('[data-mote-goal="Healthy neighbor"]')).not.toBeNull()
})
it('matches association L through its original record without converting it to the A creation C or a local namesake', () => {
  const zone = graph!.zones.find(z => z.zoneId === context().contentRef!.zoneId)!
  const opened = admitSpatialAgentAssociation(graph!, { schemaVersion: 5, requestId: 'original-L', operation: 'agent.open',
    content: { kind: 'agent-session', reference: { kind: 'coordinator-agent', runtimeId: 'A-runtime',
      binding: { bindingId: 'original-binding', agentSessionId: defaultAgent.id, createOperationId: 'A-original-C' } },
      expectedResource: { runtimeId: 'source-runtime', workspaceId: zone.workspaceId, workspacePath: zone.directoryPath! } },
    destination: { spaceId: ref.source.spaceId, zoneId: zone.zoneId, newTab: true }, focus: false }, 'source-runtime')
  graph = opened.graph
  const associated: DemandSpaceMemberReference = { kind: 'space-member', source: { ...ref.source, regionId: opened.record.address.regionId,
    admission: { kind: 'association', operationId: 'original-L' } }, execution: { runtimeId: 'A-runtime', agentSessionId: defaultAgent.id } }
  const wrong = { ...associated, source: { ...associated.source, admission: { kind: 'creation' as const, operationId: 'A-original-C' } } }
  const value = context()
  expect(goalsForMote({ exact: goal('exact L', [associated]), wrong: goal('wrong C', [wrong]) }, value.sessionIds, value.contentRef, value.agentReferences).map(g => g.id)).toEqual(['exact L'])
  expect(graph.regions.find(r => r.regionId === associated.source.regionId)).toMatchObject({ agentSessionId: null, execution: null })
})
it('qualifies a remote Mote only from its existing exact Source cut, never from the observer Core graph', () => {
  const remoteScope = { ...scope, workspace: { ...scope.workspace, hostId: 'B' } }
  const state = appStore.useAppStore.getState()
  appStore.useAppStore.setState({ config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'B', kind: 'ssh', label: 'B', hostname: 'fixture.invalid', runtimeId: 'B-runtime' }], workspaces: state.config!.workspaces.map(w => w.id === scope.workspace.id ? remoteScope.workspace : w) } })
  const unconfirmed = moteGoalContext(appStore.useAppStore.getState(), remoteScope, null, graph)
  expect(unconfirmed.agentReferences).toEqual([])
  const spaceId = unconfirmed.contentRef?.zoneId ? graph!.bindings.find(b => b.zoneId === unconfirmed.contentRef!.zoneId)?.spaceId : undefined
  // IDs are Source-owned opaque values. The existing scoped API, not this observer graph, supplies this actual B Space identity.
  const remoteSpaceId = spaceId ?? JSON.stringify(['B', scope.topic.directoryPath])
  const localSpace = graph!.spaces.find(s => s.spaceId === ref.source.spaceId)!, localZone = graph!.zones.find(z => z.zoneId === context().contentRef?.zoneId) ?? graph!.zones.find(z => graph!.bindings.some(b => b.spaceId === ref.source.spaceId && b.zoneId === z.zoneId))!
  const reference = { runtimeId: 'B-runtime', spaceId: remoteSpaceId }, source = { runtimeId: 'B-runtime', ownerInstanceId: 'B-instance' }
  const region = graph!.regions.find(r => r.regionId === ref.source.regionId)!, tab = graph!.tabs.find(t => t.tabId === region.tabId)!
  const snapshot: SpaceSnapshot = { reference, source, revision: 9, scope: { space: { ...localSpace, spaceId: remoteSpaceId },
    zones: [localZone], tabs: [tab], regions: [region], bindings: [{ spaceId: remoteSpaceId, zoneId: localZone.zoneId }] } }
  const member = { hostId: 'D-in-source', runtimeId: 'D-runtime', agentSessionId: defaultAgent.id }
  const original: Parameters<typeof hostedAgentSessionSummary>[0] = { kind: 'agent', agentSessionId: defaultAgent.id, providerId: 'fixture', executorId: 'fixture', hostId: 'D-in-source', workspacePath: scope.topic.directoryPath, run: { runId: 'D-original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 2 }
  const metadata: MountedSessionObservation = { reading: false, opening: { reference, source, revision: 9 }, members: { [spaceSessionMemberKey(member)]: {
    member, state: { status: 'observed', authority: { runtimeId: 'D-runtime', ownerInstanceId: 'D-instance' }, session: hostedAgentSessionSummary(original) },
    cut: { reference, source, revision: 9 }, occurrences: [{ regionId: region.regionId, creationOperationId: 'original-C', projectRuntimeId: 'B-runtime', agentRuntimeId: 'D-runtime', executionRoute: { kind: 'unconfirmed' } }] } }, lastConfirmed: {} }
  const key = spaceMountKey(reference)
  appStore.useAppStore.setState({ mountedSpaceInputs: { [key]: { kind: 'space-member-input', target: { hostId: 'B', reference, workspaceId: scope.workspace.id, zoneId: localZone.zoneId }, drafts: {} } },
    mountedSpaceObservations: { [key]: { snapshot, reading: false } }, mountedSpaceSessions: { [key]: metadata } })
  const qualified = moteGoalContext(appStore.useAppStore.getState(), remoteScope, null, graph)
  const expected = { ...ref, source: { ...ref.source, runtimeId: 'B-runtime', spaceId: remoteSpaceId } }
  expect(qualified.agentReferences).toEqual([expected])
  expect(qualified.loadedReferenceKeys).toEqual([demandAgentReferenceKey(expected)])
  metadata.members[spaceSessionMemberKey(member)]!.cut!.revision = 8
  expect(moteGoalContext(appStore.useAppStore.getState(), remoteScope, null, graph).agentReferences).toEqual([])
})

it('links an original raw discussion while preserving the complete qualified reference bytes and order', async () => {
  const original = goal('Original mixed work', [ref, defaultAgent.id]), calls: unknown[] = []
  vi.mocked(api.goals.execute).mockImplementation(async request => {
    if (request.operation === 'demand.list') return { operation: 'demand.list', demands: [] }
    if (request.operation !== 'demand.update') throw Error('Only original Goal list/update expected')
    calls.push(request.patch.sessionIds)
    return { operation: 'demand.update', demand: { assigneeSessionIds: [], supervisorSessionId: null, participations: [], ...original, sessionIds: request.patch.sessionIds ?? original.sessionIds }, receipt: { demandId: original.id, updatedAt: original.updatedAt } }
  })
  await render([original])
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Choose or create a goal"]')!.click())
  await chooseField(container.querySelector<HTMLElement>('[aria-label="Goal to associate with this Mote"]')!, original.id)
  await chooseField(container.querySelector<HTMLElement>('[aria-label="Mote discussion for the goal"]')!, 'neighbor-agent')
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Link this discussion')!.click())
  expect(calls).toEqual([[ref, defaultAgent.id, 'neighbor-agent']])
  expect(JSON.stringify((calls[0] as DemandAgentReference[])[0])).toBe(JSON.stringify(ref))
})
it('does not recompute membership or repaint for unrelated Sessions and keeps hidden Source observations passive', async () => {
  appStore.useAppStore.setState({ demands: { exact: goal('Exact member', [ref]) } })
  let renders = 0
  await act(async () => root.render(<Profiler id="mote" onRender={() => { renders++ }}><MoteCurrentWork scope={scope} reference={null}/></Profiler>))
  expect(container.querySelector('[data-mote-goal="Exact member"]')).not.toBeNull()
  const contextRead = vi.spyOn(moteGoals, 'moteGoalContext')
  renders = 0
  for (let i = 0; i < 30; i++) await act(async () => appStore.useAppStore.setState(state => ({ sessions: [...state.sessions, moteAgent('unrelated-' + i, null)] })))
  expect(contextRead).not.toHaveBeenCalled(); expect(renders).toBe(0)
  await act(async () => root.render(<Profiler id="mote" onRender={() => { renders++ }}><MoteCurrentWork scope={scope} reference={null} active={false}/></Profiler>))
  contextRead.mockClear(); renders = 0
  await act(async () => appStore.useAppStore.setState({ mountedSpaceObservations: {}, mountedSpaceSessions: {} }))
  expect(contextRead).not.toHaveBeenCalled(); expect(renders).toBe(0)
  expect(container.querySelector('[data-mote-goal="Exact member"]')).not.toBeNull()
})

it('does not qualify a remote Mote from an observer graph even when opaque Space, Region, SID and C collide', () => {
  const remoteScope = { ...scope, workspace: { ...scope.workspace, hostId: 'B' }, topic: { ...scope.topic, readError: 'B Source metadata unavailable' } }
  const zone = graph!.tabs.find(t => t.regionIds.includes(ref.source.regionId))!.zoneId!
  appStore.useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'B', kind: 'ssh', label: 'B', hostname: 'fixture.invalid', runtimeId: 'source-runtime' }], workspaces: state.config!.workspaces.map(w => w.id === scope.workspace.id ? remoteScope.workspace : w) },
    spaceZoneBindings: { [zone]: { workspaceId: scope.workspace.id, spaceId: ref.source.spaceId, topicId: scope.topic.id, contentKind: 'mote', directoryPath: scope.topic.directoryPath } } }))
  expect(moteGoalContext(appStore.useAppStore.getState(), remoteScope, null, graph).agentReferences).toEqual([])
})

it('keeps a cold unconfirmed qualified reference in the original Goal and reports observation unknown instead of an empty confirmed Mote', async () => {
  const original = goal('Unconfirmed original relation', [ref])
  graph = null
  await render([original, goal('Healthy raw neighbor', ['neighbor-agent'])])
  expect(container.textContent).toContain('Some Mote discussions could not be checked.')
  expect(container.textContent).not.toContain('No linked work yet')
  expect(container.querySelector('[data-mote-goal="Healthy raw neighbor"]')).not.toBeNull()
  expect(appStore.useAppStore.getState().demands[original.id]!.sessionIds[0]).toBe(ref)
})

it('reads only the exact Mote Source slot rather than enumerating unrelated mounted observations on Store updates', async () => {
  let enumerations = 0, unrelatedReads = 0
  const foreign = Object.fromEntries(Array.from({ length: 120 }, (_, i) => ['unrelated-source-' + i, { reading: false }]))
  const observed = new Proxy(foreign, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target) },
    get(target, key, receiver) { if (typeof key === 'string' && key.startsWith('unrelated-source-')) unrelatedReads++; return Reflect.get(target, key, receiver) } })
  appStore.useAppStore.setState({ mountedSpaceObservations: observed })
  enumerations = 0; unrelatedReads = 0
  await render([goal('Original Source work', [ref])])
  for (let i = 0; i < 20; i++) await act(async () => appStore.useAppStore.setState(state => ({ sessions: [...state.sessions, moteAgent('unrelated-cost-' + i, null)] })))
  expect(container.querySelector('[data-mote-goal="Original Source work"]')).not.toBeNull()
  expect(enumerations).toBe(0); expect(unrelatedReads).toBe(0)
})
it('does not carry an old Source Runtime Goal into a new confirmed Source with the same resource, Space, Region and C', async () => {
  await render([goal('Old Source work', [ref])])
  const previous = JSON.stringify(appStore.useAppStore.getState().demands['Old Source work']!.sessionIds)
  const next = structuredClone(ref); next.source.runtimeId = 'new-source-runtime'
  // This is the original Source record's new confirmed tuple, with all aliases, Region and C deliberately unchanged.
  const changed = structuredClone(graph!), requests = changed.resources['core:agent-open'] as { requests: Record<string, { placement: { runtimeId: string } }> }
  requests.requests['original-C']!.placement.runtimeId = next.source.runtimeId
  graph = changed
  await act(async () => appStore.useAppStore.setState(state => ({ demands: { ...state.demands, next: goal('New Source work', [next]) }, tabs: { ...state.tabs } })))
  expect(container.querySelector('[data-mote-goal="New Source work"]')).not.toBeNull()
  // Make the new Source's original C temporarily unreadable after it has been confirmed.
  delete graph!.resources['core:agent-open']
  await act(async () => appStore.useAppStore.setState(state => ({ tabs: { ...state.tabs } })))
  expect(container.querySelector('[data-mote-goal="Old Source work"]')).toBeNull()
  expect(container.querySelector('[data-mote-goal="New Source work"]')).not.toBeNull()
  expect(JSON.stringify(appStore.useAppStore.getState().demands['Old Source work']!.sessionIds)).toBe(previous)
})
it('selects one pinned Source and clears old last-known when another confirmed Runtime reuses the same Host, Space, Region and OP', async () => {
  const remoteScope = { ...scope, workspace: { ...scope.workspace, hostId: 'B' } }
  const sourceSpaceId = JSON.stringify(['B', scope.topic.directoryPath])
  const region = graph!.regions.find(r => r.regionId === ref.source.regionId)!, tab = graph!.tabs.find(t => t.tabId === region.tabId)!, zone = graph!.zones.find(z => z.zoneId === tab.zoneId)!
  const space = graph!.spaces.find(s => s.spaceId === ref.source.spaceId)!
  const at = (runtimeId: string, confirmedMember: boolean) => {
    const reference = { runtimeId, spaceId: sourceSpaceId }, source = { runtimeId, ownerInstanceId: 'instance-' + runtimeId }
    const key = spaceMountKey(reference), member = { hostId: 'D-in-source', runtimeId: 'D-runtime', agentSessionId: defaultAgent.id }
    const snapshot: SpaceSnapshot = { reference, source, revision: 5, scope: { space: { ...space, spaceId: sourceSpaceId }, zones: [zone], tabs: [tab], regions: [region], bindings: [{ spaceId: sourceSpaceId, zoneId: zone.zoneId }] } }
    const metadata: MountedSessionObservation = { reading: false, opening: { reference, source, revision: 5 }, lastConfirmed: {}, members: confirmedMember ? { [spaceSessionMemberKey(member)]: {
      member, cut: { reference, source, revision: 5 }, state: { status: 'unavailable', issue: { code: 'READ_UNAVAILABLE', message: 'The exact D reader is unavailable; B membership remains confirmed.' } },
      occurrences: [{ regionId: region.regionId, creationOperationId: 'original-C', projectRuntimeId: runtimeId, agentRuntimeId: 'D-runtime', executionRoute: { kind: 'unconfirmed' } }] } } : {} }
    return { key, snapshot, metadata, target: { hostId: 'B', reference, workspaceId: scope.workspace.id, zoneId: zone.zoneId } }
  }
  const old = at('B-original-runtime', true), next = at('B-new-runtime', false)
  const config = appStore.useAppStore.getState().config!
  const sourceHost = { id: 'B', kind: 'ssh' as const, label: 'B', hostname: 'fixture.invalid', runtimeId: old.snapshot.source.runtimeId }
  appStore.useAppStore.setState({ config: { ...config, hosts: [...config.hosts, sourceHost], workspaces: config.workspaces.map(w => w.id === scope.workspace.id ? remoteScope.workspace : w) },
    mountedSpaceInputs: { [old.key]: { kind: 'space-member-input', target: old.target, drafts: {} }, [next.key]: { kind: 'space-member-input', target: next.target, drafts: {} } },
    mountedSpaceObservations: { [old.key]: { snapshot: old.snapshot, reading: false }, [next.key]: { snapshot: next.snapshot, reading: false } }, mountedSpaceSessions: { [old.key]: old.metadata, [next.key]: next.metadata },
    demands: { original: goal('Old pinned Source work', [{ ...ref, source: { ...ref.source, runtimeId: old.snapshot.source.runtimeId, spaceId: sourceSpaceId } }]) } })
  await act(async () => root.render(<MoteCurrentWork scope={remoteScope} reference={null}/>))
  expect(container.querySelector('[data-mote-goal="Old pinned Source work"]')).not.toBeNull()
  await act(async () => appStore.useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...config.hosts, { ...sourceHost, runtimeId: next.snapshot.source.runtimeId }] } })))
  expect(container.querySelector('[data-mote-goal="Old pinned Source work"]')).toBeNull()
  expect(container.textContent).toContain('Some Mote discussions could not be checked.')
  expect(appStore.useAppStore.getState().demands.original!.sessionIds).toEqual([{ ...ref, source: { ...ref.source, runtimeId: old.snapshot.source.runtimeId, spaceId: sourceSpaceId } }])
})
