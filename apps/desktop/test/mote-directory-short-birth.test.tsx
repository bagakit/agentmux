import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { createHash, webcrypto } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { workbenchObjectLayout } from '../src/renderer/src/lib/desktop-focus-navigation'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import { projectWorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'

const initial = useAppStore.getState()
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("private/short-birth/topics"), name: 'Topics', kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Fixture' }], executors: {}, workspaces: [scratch],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function receipt(id: string): ScratchTopicSnapshot { const physical=_hygiene_fixturePath("private/short-birth/motes/")+createHash('sha256').update(id).digest('hex').slice(0,16);return { id, title: 'Original new Mote', summary: '', collaborators: [],
  directoryPath: scratchTopicDirectoryName(id), topicPath: scratchTopicDirectoryName(id) + '/topic.md',
  identityDirectoryPath: physical, physicalDirectoryPath: physical,
  confirmedDirectoryPaths: [physical],
  soul: { path: scratchTopicDirectoryName(id) + '/SOUL.md', content: '# Original', version: 'v1' } } }
function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:Error)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); useAppStore.setState(initial, true); useAppStore.setState({config, activeWorkspaceId: scratch.id,
  mainSurface: 'workbench', layouts: {[scratch.id]: createWorkspaceLayout('original-group')}, tabs: {}, sessions: [], topicCategories: [], spaceZoneBindings: {},
  workbenchSpaceSelection: null, scratchTopicSnapshots: {}, agentComposerDrafts: {}, error: null });
  vi.spyOn(api.sessions,'stop').mockResolvedValue(undefined)
})
afterEach(()=>{useAppStore.setState(initial,true); vi.restoreAllMocks(); vi.unstubAllGlobals()})
function surfaces() { const state = useAppStore.getState(), choice=state.workbenchSpaceSelection!, tab=state.tabs[choice.tabId!]!, catalog=spatialCatalog(state,[])
  const reference={displayWorkspaceId:scratch.id,groupId:choice.groupId!,tabId:tab.id,regionId:choice.regionId!}
  const float=moteWorkbenchProjection(catalog,tab,{open:true,preview:false,targetTabId:tab.id,targetTopicId:tab.topicId!,reference},vi.fn(),state.layouts)
  return {state,choice,tab,catalog,reference,float,space:workbenchObjectLayout(state,scratch.id)} }
it('birth allocates one original Tab/Region/draft before await and both exact shared presentations remain operable through failed ACK', async()=>{
  const pending=deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch,'ensureMote').mockReturnValue(pending.promise)
  const job=useAppStore.getState().createScratchTopic('mote',{prompt:'Original unsent request'}); const before=surfaces()
  expect(before.tab.space).toBeUndefined(); expect(before.choice).toMatchObject({spaceId:null,zoneId:null})
  expect(before.catalog.tabs[0]?.zoneId).toBeNull(); expect(before.space.confirmed).toBe(true)
  expect(before.space.layout?.groups[0]?.activeTabId).toBe(before.tab.id)
  expect(before.float.projection?.entity).toEqual({kind:'tab',tabId:before.tab.id})
  const projected=projectWorkbenchProjection(before.state.layouts[scratch.id],before.state.tabs,before.float.projection!)
  expect(projected.selection).toEqual([before.reference]); expect(projected.layout?.groups[0]?.activeTabId).toBe(before.tab.id)
  useAppStore.getState().setAgentComposerDraft(before.choice.regionId!,'Edited same original draft')
  pending.reject(new Error('Private receipt lost')); await expect(job).rejects.toThrow('receipt lost')
  const after=surfaces(); expect(after.tab).toBe(before.tab); expect(after.choice).toBe(before.choice)
  expect(after.space.confirmed).toBe(true); expect(after.float.projection?.entity).toEqual({kind:'tab',tabId:before.tab.id})
  expect(after.state.agentComposerDrafts[before.choice.regionId!]).toBe('Edited same original draft')
  expect(after.state.errorNoticeContext?.summary).toMatch(/preparation is unconfirmed/); expect(api.sessions.stop).not.toHaveBeenCalled()
  // Persist/restore through the real public graph adapters rather than reconstructing a new Tab.
  const restored=desktopWorkbenchFromSpatial(JSON.parse(JSON.stringify(desktopSpatialGraph(after.state,[]))))
  expect(restored.tabs[before.tab.id]?.layout).toEqual(before.tab.layout); expect(restored.tabs[before.tab.id]?.space).toBeUndefined()
  expect(restored.layouts[scratch.id]?.groups[0]?.tabOrder).toContain(before.tab.id)
})
it('a strict receipt binds the same Tab and Region without replacing edited draft or later navigation',async()=>{
  const pending=deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch,'ensureMote').mockReturnValue(pending.promise)
  const job=useAppStore.getState().createScratchTopic('mote',{prompt:'First'}); const born=surfaces()
  useAppStore.getState().setAgentComposerDraft(born.choice.regionId!,'Later edit')
  useAppStore.setState({mainSurface:'board',workbenchSpaceSelection:null})
  pending.resolve(receipt(born.tab.topicId!)); await job
  const state=useAppStore.getState(), tab=state.tabs[born.tab.id]!
  expect(tab.id).toBe(born.tab.id); expect(tab.regions[born.choice.regionId!]).toBe(born.tab.regions[born.choice.regionId!])
  expect(tab.space?.spaceId).toBeTruthy(); expect(tab.topicPreparation).toBeUndefined()
  expect(state.agentComposerDrafts[born.choice.regionId!]).toBe('Later edit'); expect(state.mainSurface).toBe('board'); expect(state.workbenchSpaceSelection).toBeNull()
})
it('late/foreign full ID and unknown receipts cannot bind the original unbound owner',async()=>{
  vi.spyOn(api.scratch,'ensureMote')
  for(const variant of ['foreign','unknown']) {
    useAppStore.setState({tabs:{},layouts:{[scratch.id]:createWorkspaceLayout('original-group')},workbenchSpaceSelection:null})
    const pending=deferred<ScratchTopicSnapshot>(); vi.mocked(api.scratch.ensureMote).mockReturnValue(pending.promise)
    const job=useAppStore.getState().createScratchTopic('mote',{prompt:'Keep me'}); const born=surfaces()
    pending.resolve({...receipt(variant==='foreign'?'launcher:foreign':born.tab.topicId!),...(variant==='unknown'?{readError:'Durability unconfirmed'}:{})})
    await expect(job).rejects.toThrow(/identity is unconfirmed/)
    expect(useAppStore.getState().tabs[born.tab.id]?.space).toBeUndefined(); expect(useAppStore.getState().agentComposerDrafts[born.choice.regionId!]).toBe('Keep me')
  }
})
it('pending metadata facts do not implicitly bind an unbound Tab before confirmed ensure ACK',async()=>{
  const pending=deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch,'ensureMote').mockReturnValue(pending.promise)
  const job=useAppStore.getState().createScratchTopic('mote',{prompt:'Keep me'}),born=surfaces()
  const topic={...receipt(born.tab.topicId!),readError:'Directory identity upgrade is pending'}
  useAppStore.setState({scratchTopicSnapshots:{[scratch.id]:{scope:scratchTopicsScope(scratch),topics:[topic],error:topic.readError,reading:false,revision:0}}})
  expect(spatialCatalog(useAppStore.getState(),[topic]).tabs[0]?.zoneId).toBeNull()
  expect(surfaces().space.confirmed).toBe(true)
  pending.reject(new Error('Unconfirmed'));await expect(job).rejects.toThrow('Unconfirmed')
})
it('invalid Group stays unknown while a retired Region and consistent duplicate facts retain the original parent',async()=>{
  const pending=deferred<ScratchTopicSnapshot>();vi.spyOn(api.scratch,'ensureMote').mockReturnValue(pending.promise)
  const job=useAppStore.getState().createScratchTopic('mote',{prompt:'Keep'}),born=surfaces()
  for(const reference of [{...born.reference,groupId:'missing'}]) {
    const raw={open:true,preview:false,targetTabId:born.tab.id,targetTopicId:born.tab.topicId!,reference}
    expect(moteWorkbenchProjection(born.catalog,born.tab,raw,vi.fn(),born.state.layouts).projection).toBeNull()
    expect(raw.reference).toBe(reference)
  }
  const lateReference={...born.reference,regionId:'retired'}
  const late=moteWorkbenchProjection(born.catalog,born.tab,{open:true,preview:false,targetTabId:born.tab.id,reference:lateReference},vi.fn(),born.state.layouts)
  expect(late.projection?.selection).toEqual([lateReference]);expect(late.issueKind).toBe('parent-available');expect(lateReference.regionId).toBe('retired')
  expect(projectWorkbenchProjection(born.state.layouts[scratch.id],born.state.tabs,late.projection!).selection).toEqual([lateReference])
  const duplicate={...born.catalog,locations:[...born.catalog.locations,{...born.catalog.locations[0]!}]}
  const repeated=moteWorkbenchProjection(duplicate,born.tab,{open:true,preview:false,targetTabId:born.tab.id,reference:born.reference},vi.fn(),born.state.layouts)
  expect(repeated.projection?.selection).toEqual([born.reference]);expect(repeated.issue).toBeNull();expect(repeated.catalog).toBe(duplicate)
  pending.reject(new Error('Keep')); await expect(job).rejects.toThrow('Keep')
})
it('an ID-less discovery issue keeps previously confirmed Mote facts and healthy fresh objects independently',async()=>{
  const previous=receipt('launcher:previous'),fresh=receipt('launcher:fresh')
  useAppStore.setState({scratchTopicSnapshots:{[scratch.id]:{scope:scratchTopicsScope(scratch),topics:[previous],revision:0,error:null,reading:false}}})
  const list=Object.assign([fresh],{issues:['Unclaimed private hash metadata unavailable']})
  vi.spyOn(api.scratch,'listTopics').mockResolvedValue(list)
  await useAppStore.getState().refreshScratchTopics(scratch.id,true)
  const result=useAppStore.getState().scratchTopicSnapshots[scratch.id]!
  expect(result.topics).toEqual([fresh,previous]);expect(result.topics?.every(topic=>!topic.readError)).toBe(true)
  expect(result.error).toContain(list.issues[0])
})

it('successful current continuity applies the healthy session before persistent Wiki service explanation',async()=>{
  const control={kind:'agent' as const,hostId:'local',agentSessionId:'agent-1',run:{runId:'run-1'}}
  const session:import('../src/shared/contracts').SessionSnapshot={id:'agent-1',kind:'agent',hostId:'local',executorId:'codex',providerId:'codex',workspacePath:_hygiene_fixturePath("private/short-birth/motes/0123456789abcdef"),label:'Healthy',createdAt:_reshape_fixtureEpoch(0, 0, 1),updatedAt:_reshape_fixtureEpoch(0, 0, 1),agentSessionUpdatedAt:_reshape_fixtureEpoch(0, 0, 1),processState:'running',latestOutputBytes:0,status:{state:'running',source:'run-process',observedAt:_reshape_fixtureEpoch(0, 0, 1)},capabilities:{terminal:true,timeline:'streaming',permission:'observe',providerResume:true,replyCorrelation:'none'},control}
  const tab=createWorkbenchTab('original-agent',{kind:'agent',phase:'attached',workspaceId:scratch.id,regionId:'original-agent-region',sessionId:session.id})
  useAppStore.setState({sessions:[session],tabs:{[tab.id]:tab},layouts:{[scratch.id]:createWorkspaceLayout('original-group',[tab.id])}})
  vi.spyOn(api.sessions,'recover').mockResolvedValue({kind:'reattachable',session,advisory:'Wiki directory association is unconfirmed: Private stalled read. Agent input remains available.'})
  expect(await useAppStore.getState().recoverSession(session.id)).toBe(session)
  expect(useAppStore.getState().sessions[0]?.processState).toBe('running');expect(useAppStore.getState().sessions[0]?.status.state).toBe('running')
  expect(useAppStore.getState().error).toMatch(/Wiki directory association/);expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
})

it('explicit confirmed retry attaches the same unbound birth Tab and preserves its edited original Region draft',async()=>{
  vi.spyOn(api.scratch,'ensureMote').mockRejectedValue(new Error('First reply lost'))
  const job=useAppStore.getState().createScratchTopic('mote',{prompt:'Preserve original input'}),born=surfaces()
  await expect(job).rejects.toThrow('First reply lost')
  useAppStore.getState().setAgentComposerDraft(born.choice.regionId!,'Edited before retry')
  const snapshot=receipt(born.tab.topicId!);vi.spyOn(api.scratch,'readTopic').mockResolvedValue(snapshot)
  await useAppStore.getState().openScratchTopic(snapshot.id)
  const after=surfaces();expect(after.tab.id).toBe(born.tab.id);expect(after.tab.regions[born.choice.regionId!]).toBe(born.tab.regions[born.choice.regionId!])
  expect(after.tab.space?.spaceId).toBeTruthy();expect(after.tab.topicPreparation).toBeUndefined()
  expect(after.state.agentComposerDrafts[born.choice.regionId!]).toBe('Edited before retry');expect(api.sessions.stop).not.toHaveBeenCalled()
})
