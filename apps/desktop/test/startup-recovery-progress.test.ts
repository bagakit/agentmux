// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch, fixturePath as _newTailFixturePath } from "../../../test/fixture-values.mjs"
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { reduceAgentMembershipSnapshot, projectRuntimeEvent, reduceRuntimeEvent } from '../src/renderer/src/lib/session-state'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { AppConfig, RuntimeSnapshot, SessionSnapshot, SessionRecoveryResult } from '../src/shared/contracts'
const initial = useAppStore.getState()
const ids = ['eligible-a', 'eligible-b']
const now = Date.now()
const config: AppConfig = { version: 9, hosts: [{id: 'local', kind: 'local', label: 'Private'}], executors: {}, workspaces: [{id: 'workspace', name: 'Private', hostId: 'local', path: _newTailFixturePath("private/startup-blocking-fixture"), kind: 'folder'}], appearance: {terminalTheme: 'graphite'}, browser: {toolbar: {selectElement: true, screenshot: true, devTools: true, saveBookmark: true, viewport: true, more: true}} }
function session(id: string): Extract<SessionSnapshot, {kind: 'agent'}> { return {id, kind:'agent', providerId:'codex', executorId:'fixture', hostId:'local', workspacePath:config.workspaces[0]!.path, label:id, createdAt:_newTailFixtureEpoch(0, 0, 1), updatedAt:now, agentSessionUpdatedAt:now, latestOutputBytes:0, promptSubmissionPredecessor:null, processState:'interrupted', status:{state:'disconnected',source:'run-process',observedAt:now}, semanticStatus:{state:'done',source:'native-hook',observedAt:now-1000,stateEnteredAt:now-1000}, capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'}, control:{kind:'agent',hostId:'local',agentSessionId:id,run:{runId:'old-'+id}}} }
let snapshot: RuntimeSnapshot
let dir: string
let spatial: AgentMuxSpatialStateStore
let dispose: (()=>void) | undefined
let releases: (()=>void)[]
function gate<T>() { let resolve!: (value: T)=>void; const promise = new Promise<T>(done=>{resolve=done}); return {promise, resolve} }
async function settle() { await new Promise(done=>setTimeout(done,40)) }
beforeEach(async ()=>{
 useAppStore.setState(initial,true)
 releases=[]
 vi.spyOn(useAppStore.persist,'hasHydrated').mockReturnValue(true)
 vi.spyOn(api.config,'get').mockResolvedValue(config)
 vi.spyOn(api.providers,'list').mockImplementation(providerCatalogReader())
 vi.spyOn(api.demands,'list').mockResolvedValue([])
 vi.spyOn(api.sessions,'historySources').mockImplementation(historySourcesReader())
 dir=await mkdtemp(join(tmpdir(),'agentmux-startup-blocking-'))
 spatial=new AgentMuxSpatialStateStore(join(dir,'spatial.json'))
 vi.spyOn(api.spatial,'read').mockImplementation(()=>spatial.read())
 vi.spyOn(api.spatial,'commit').mockImplementation(input=>spatial.commit(input))
 vi.spyOn(api.spatial,'onChange').mockImplementation(listener=>spatial.subscribe(listener))
 vi.spyOn(api.spatial,'retainLabels').mockImplementation(input=>spatial.retainDisplayLabels(input))
 const tabs=Object.fromEntries(ids.map(id=>['tab-'+id,createWorkbenchTab('tab-'+id,{regionId:'region-'+id,kind:'agent',phase:'attached',workspaceId:'workspace',sessionId:id})]))
 const layouts={workspace:createWorkspaceLayout('group',Object.keys(tabs))}
 useAppStore.setState({loading:true,restoredWorkbench:{tabs,layouts},activeWorkspaceId:'workspace'})
 const state=useAppStore.getState()
 await spatial.commit({expectedRevision:0,graph:desktopSpatialGraph({...state,config,tabs,layouts,sessions:ids.map(session)},[])})
 snapshot={sessions:ids.map(session),recoveryCandidates:[],timelines:Object.fromEntries(ids.map(id=>[id,{agentSessionId:id,revision:1,items:[]}]))}
 vi.spyOn(api.sessions,'snapshot').mockImplementation(async()=>snapshot)
 vi.spyOn(api.sessions,'recover').mockImplementation(async control=>{
  const id=control.kind==='agent'?control.agentSessionId:''
  const original=session(id)
  const restored={...original,processState:'running' as const,status:{state:'running' as const,source:'run-process' as const,observedAt:now},control:{...original.control,run:{runId:'new-'+id}}}
  snapshot={...snapshot,sessions:snapshot.sessions.map(item=>item.id===id?restored:item)}
  return {kind:'resumed',session:restored}
 })
})
afterEach(async()=>{dispose?.();dispose=undefined;for(const release of releases)release();await settle();vi.restoreAllMocks();await rm(dir,{recursive:true,force:true})})
async function initialize(){dispose=await useAppStore.getState().initialize();expect(useAppStore.getState().loading).toBe(false);await settle()}
it('baseline: exact saved executions and complete snapshots auto-resume both recent completed interrupted Sessions',async()=>{
 await initialize()
 expect(vi.mocked(api.sessions.recover).mock.calls.map(([control])=>control.kind==='agent'?control.agentSessionId:null)).toEqual(ids)
})
it('a retained-History metadata reader cannot hold already confirmed startup recovery',async()=>{
 const before=useAppStore.getState(), original=before.restoredWorkbench!
 const id='unobserved-original', tab=createWorkbenchTab('tab-'+id,{regionId:'region-'+id,kind:'agent',phase:'attached',workspaceId:'workspace',sessionId:id})
 const tabs={...Object.fromEntries(Object.values(original.tabs).map(tab=>[tab.id,hydratePersistedTab(tab)])),[tab.id]:tab}, layouts={workspace:createWorkspaceLayout('group',Object.keys(tabs))}
 const saved=await spatial.read()
 await spatial.commit({expectedRevision:saved!.revision,graph:desktopSpatialGraph({...before,config,tabs,layouts,sessions:[...ids.map(session),session(id)]},[])})
 useAppStore.setState({restoredWorkbench:{tabs,layouts}})
 const held=gate<Awaited<ReturnType<typeof api.sessions.historySources>>>()
 vi.mocked(api.sessions.historySources).mockReturnValue(held.promise as never)
 releases.push(()=>held.resolve({sources:[],warnings:[]} as never))
 await initialize()
 expect(api.sessions.historySources).toHaveBeenCalledTimes(1)
 expect(vi.mocked(api.sessions.recover).mock.calls.map(([control])=>control.kind==='agent'?control.agentSessionId:null)).toEqual(ids)
})
it('one unresolved Session recovery cannot hold another eligible original Session',async()=>{
 const original=vi.mocked(api.sessions.recover).getMockImplementation()!
 const held=gate<SessionRecoveryResult>()
 vi.mocked(api.sessions.recover).mockImplementation((...args)=>args[0].kind==='agent'&&args[0].agentSessionId===ids[0]?held.promise:original(...args))
 releases.push(()=>held.resolve({kind:'reattachable',session:{...session(ids[0]!),processState:'running'}}))
 await initialize()
 expect(vi.mocked(api.sessions.recover).mock.calls.map(([control])=>control.kind==='agent'?control.agentSessionId:null)).toEqual(ids)
})
it('an unrelated missing Timeline cannot silently cancel all original startup recovery',async()=>{
 const unrelated=session('unrelated')
 snapshot={...snapshot,sessions:[...snapshot.sessions,unrelated]}
 await initialize()
 expect(vi.mocked(api.sessions.recover).mock.calls.map(([control])=>control.kind==='agent'?control.agentSessionId:null)).toEqual(ids)
 expect(useAppStore.getState().sessions.find((item):item is Extract<SessionSnapshot,{kind:'agent'}>=>item.kind==='agent'&&item.id==='unrelated')?.timelineObservation).toEqual({
  run:unrelated.control.run,code:'TIMELINE_OBSERVATION_FAILED',message:'Runtime snapshot is missing the matching Timeline for Agent Session: unrelated'
 })
})

it('retains only the exact ended Run recovery failure through snapshot and process refreshes',async()=>{
 await initialize()
 const current=useAppStore.getState(), original=session(ids[0]!)
 const failed={...original,status:{...original.status,state:'error' as const,continuity:'unavailable' as const,
  continuityReason:'provider-unavailable' as const,detail:'Original Provider executable was unavailable.'}}
 const state={...current,sessions:[failed,session(ids[1]!)]}
 const refreshed=reduceAgentMembershipSnapshot(state,{...snapshot,sessions:ids.map(session)})
 expect(refreshed.sessions[0]?.status).toMatchObject(failed.status)
 const event={type:'core' as const,hostId:'local',event:{type:'process-state' as const,agentSessionId:original.id,
  run:original.control.run,pid:null,state:'interrupted' as const,interruptionReason:'daemon_restart',evidence:{source:'run-process' as const,observedAt:now+1}}}
 const observed=projectRuntimeEvent(refreshed,event).state
 expect(observed.sessions[0]?.status).toMatchObject({continuity:'unavailable',continuityReason:'provider-unavailable',detail:failed.status.detail})
 const running=projectRuntimeEvent(observed,{...event,event:{...event.event,state:'running',evidence:{source:'run-process',observedAt:now+2}}}).state
 expect(running.sessions[0]?.status.continuity).toBeUndefined()
 const replaced={...original,control:{...original.control,run:{runId:'different-run'}},processState:'interrupted' as const}
 expect(reduceAgentMembershipSnapshot(state,{...snapshot,sessions:[replaced]}).sessions[0]?.status.continuity).toBeUndefined()
})

it('keeps a wrong Timeline scoped to its Session and retains its original readable history',async()=>{
 const original={agentSessionId:ids[0]!,revision:1,items:[]}
 useAppStore.setState({timelines:{[ids[0]!]:original}})
 snapshot={...snapshot,timelines:{...snapshot.timelines,[ids[0]!]:{...original,agentSessionId:'another-session'}}}
 const projected=reduceAgentMembershipSnapshot(useAppStore.getState(),snapshot)
 expect(projected.sessions.find((item):item is Extract<SessionSnapshot,{kind:'agent'}>=>item.kind==='agent'&&item.id===ids[0])?.timelineObservation?.code).toBe('TIMELINE_IDENTITY_MISMATCH')
 await initialize()
 expect(vi.mocked(api.sessions.recover).mock.calls.map(([control])=>control.kind==='agent'?control.agentSessionId:null)).toEqual(ids)
 expect(useAppStore.getState().timelines[ids[0]!]).toEqual(original)
})

it('does not swallow an unexpected snapshot-processing failure during background startup',async()=>{
 const report=vi.spyOn(useAppStore.getState(),'reportError')
 const malformed={...snapshot,timelines:undefined} as unknown as RuntimeSnapshot
 vi.mocked(api.sessions.snapshot).mockResolvedValue(malformed)
 await initialize()
 expect(report).toHaveBeenCalledWith(expect.any(Error),expect.objectContaining({kind:'indeterminate',summary:expect.stringContaining('Session snapshot failed')}))
 expect(Object.keys(useAppStore.getState().tabs)).toEqual(ids.map(id=>'tab-'+id))
})

it('review: disposed startup ignores its late History success even while original notice remains',async()=>{
 snapshot={sessions:[],recoveryCandidates:[],timelines:{}}
 const held=gate<Awaited<ReturnType<typeof api.sessions.historySources>>>()
 vi.mocked(api.sessions.historySources).mockReturnValue(held.promise as never)
 releases.push(()=>held.resolve({sources:[],warnings:[]} as never))
 await initialize()
 expect(api.sessions.historySources).toHaveBeenCalled()
 const priorError=useAppStore.getState().error
 expect(priorError).toContain('saved Session reference')
 dispose?.();dispose=undefined
 held.resolve({sources:ids.map(agentSessionId=>({agentSessionId,hostId:'local',state:'retired'})),warnings:[]} as never)
 await settle()
 expect(useAppStore.getState().error).toBe(priorError)
})
it('review: a same-Run semantic event cannot settle a retained continuity refusal while process remains interrupted',()=>{
 const original=session(ids[0]!)
 const failed={...original,status:{...original.status,state:'error' as const,continuity:'unavailable' as const,continuityReason:'provider-unavailable' as const,detail:'Exact original recovery refused'}}
 useAppStore.setState({sessions:[failed]})
 const state=reduceRuntimeEvent(useAppStore.getState(),{type:'core',hostId:'local',event:{type:'agent-status',agentSessionId:original.id,state:'done',evidence:{source:'native-transcript',observedAt:now+1,run:original.control.run}}})
 expect(state.sessions[0]!.processState).toBe('interrupted')
 expect(state.sessions[0]!.status.continuity).toBe('unavailable')
 expect(state.sessions[0]!.status.detail).toBe('Exact original recovery refused')
})
