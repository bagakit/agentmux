import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixturePath as _hygiene_fixturePath, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import { displayLabel } from '@agentmux/core/spatial-graph'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, executorDetectionKey } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { inspectTakeover, takeOverSession, takeoverExecution, takeoverPrompt, type TakeoverSource } from '../src/renderer/src/lib/session-takeover'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionTakeoverSurface } from '../src/renderer/src/components/SessionTakeoverSurface'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { createClientUiRoot } from './helpers/client-ui-render'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, dispose: (() => void) | undefined
let config: AppConfig, original: Extract<SessionSnapshot, { kind: 'agent' }>, source: TakeoverSource
let nameOwner: AgentMuxSpatialStateStore, ownerDirectory: string
const creations = new Map<string, AgentLaunchResult['created']>()
const diagnostic = 'Original diagnostic ' + 'all retained details; '.repeat(100)
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
beforeEach(async () => {
  creations.clear()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear()
  config = { ...await api.config.get(), hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: { fixture: { label: 'Fixture', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: _hygiene_fixturePath("repo"), kind: 'folder' }] }
  const seed = (await api.sessions.snapshot()).sessions.find(item => item.kind === 'agent')
  if (!seed || seed.kind !== 'agent') throw new Error('A nonempty Agent fixture is required')
  original = { ...seed, id: 'original', executorId: 'fixture', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    label: 'Original Agent', control: { ...seed.control, hostId: 'local', agentSessionId: 'original' }, status: { ...seed.status, detail: diagnostic } }
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => ({sessions:useAppStore.getState().sessions.length?useAppStore.getState().sessions:[original],timelines:{},recoveryCandidates:[]}))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'creation').mockImplementation(async (_hostId, id) => {
    const created = creations.get(id)
    if (!created) throw new Error('The exact fixture creation is not observed')
    return structuredClone(created)
  })
  // Each scenario has a fresh external Core spatial store. The Desktop's real
  // persistence and spatial orchestrator consume it; prior preview cases cannot
  // reintroduce another case's durable creation intent.
  ownerDirectory = await mkdtemp(join(tmpdir(), 'amux-takeover-name-'))
  nameOwner = new AgentMuxSpatialStateStore(join(ownerDirectory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => nameOwner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => nameOwner.commit(input))
  vi.spyOn(api.spatial, 'renameLabel').mockImplementation(input => nameOwner.mutateDisplayLabel(input, {
    actor: {kind:'device',id:'private-takeover-fixture',verified:true},source:'desktop-ui',entryPoint:'spatial:renameLabel',transport:'electron-ipc',location:{windowId:'private-window'}}))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(() => () => {})
  useAppStore.setState({ ...initial, config: null, restoredWorkbench: null, tabs: {}, layouts: {}, spatialRequests: {}, spaceZoneBindings: {} }, true)
  dispose = await useAppStore.getState().initialize()
  const tab = createWorkbenchTab('source-tab', { regionId: 'source-region', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: original.id })
  useAppStore.setState({ config, sessions: [original], tabs: { [tab.id]: tab }, layouts: { repo: createWorkspaceLayout('source-group', [tab.id]) },
    activeWorkspaceId: 'repo', mainSurface: 'workbench', viewModes: { original: 'terminal' },
    agentComposerDrafts: { original: 'Unsent draft stays with the original.' },
    executorDetections: { [executorDetectionKey('local', 'fixture')]: { state: 'error', error: 'Discovery unavailable' } } })
  source = { agentSessionId: original.id, hostId: 'local', cwd: _hygiene_fixturePath("repo"), label: original.label, executorId: 'fixture', diagnostic,
    origin: { workspaceId: 'repo', tabGroupId: 'source-group', tabId: tab.id, regionId: 'source-region' } }
  await useAppStore.getState().retryWorkbenchSave()
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
  await rm(ownerDirectory, {recursive:true,force:true})
})
function launched(id: string, operationId: string): AgentLaunchResult {
  const session = { ...original, id, label: 'Successor', createdAt: Date.now(), control: { ...original.control, agentSessionId: id, run: { runId: `new:${id}` } } }
  const created = { ...agentCreationFixture(session), hostId: 'local', creation: { createOperationId: operationId, initialPrompt: 'confirmed' as const } }
  creations.set(id, created)
  return { created,
    creation: { createOperationId: operationId, initialPrompt: 'confirmed' }, session,
    timeline: { agentSessionId: id, revision: 0, items: [] }, projectionFailures: [] }
}
function launchBoundary() {
  return vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launched(input.agentSessionId!, input.createOperationId!))
}
async function mountPicker(onClose = vi.fn()) {
  await act(async () => root.render(<SessionTakeoverSurface source={source} active onClose={onClose} />))
  return onClose
}

it('the real Agent Region exposes Take over and opening/cancelling keeps its draft without launching', async () => {
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  await act(async () => root.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible parked interactiveResize={false} linkOrigin={source.origin} />))
  const trigger = document.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => { await vi.waitFor(() => expect(document.querySelector('.agent-region-menu')).not.toBeNull()) })
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Take over')
  expect(entry, 'The actual Region production entry must be reachable').toBeDefined()
  await act(async () => entry!.click())
  expect(document.querySelector('.session-takeover')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => document.querySelector('.session-takeover')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('.session-takeover')!.hasAttribute('inert')).toBe(true)
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.session-takeover')).toBeNull() })
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
})

it('the shared Launcher picker retains unknown choices and has no warm-terminal side effect in takeover', async () => {
  const prewarm = vi.spyOn(useAppStore.getState(), 'prewarmTerminal'), launch = launchBoundary()
  const tab = createWorkbenchTab('launcher-tab', { regionId: 'launcher-region', kind: 'launcher', workspaceId: 'repo' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab } }))
  await act(async () => root.render(<NewTabSurface tabGroupId="source-group" tabId={tab.id} regionId="launcher-region" visible={false} />))
  expect(document.querySelector('.agent-catalog .agent-pick[data-executor-id="fixture"]')).not.toBeNull()
  await mountPicker()
  expect(document.querySelector('.agent-catalog .agent-pick[data-executor-id="fixture"]')).not.toBeNull()
  expect(document.querySelector('.agent-pick')!.hasAttribute('disabled')).toBe(false)
  expect(document.querySelectorAll('select')).toHaveLength(0)
  expect(document.querySelector('.session-takeover')!.textContent).not.toMatch(/history source/i)
  expect(prewarm).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
})

it('one choice reaches the real spatial owner, hands over complete context and preserves the original', async () => {
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  const beforeTab = structuredClone(useAppStore.getState().tabs['source-tab']), beforeAgent = structuredClone(original)
  const onClose = await mountPicker()
  const pick = document.querySelector<HTMLButtonElement>('.agent-pick[data-executor-id="fixture"]')!
  await act(async () => { pick.click(); pick.click(); await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1)) })
  await vi.waitFor(async () => { await act(async () => {}); expect(onClose).toHaveBeenCalledTimes(1) })
  const input = launch.mock.calls[0]![0]
  expect(input.hostId).toBe('local'); expect(input.workspacePath).toBe(_hygiene_fixturePath("repo"))
  expect(input.prompt).toContain(diagnostic)
  expect(input.prompt).toContain('agent context --host local --session \'original\'')
  expect(input.prompt).toContain('saved Core work record and Provider conversation')
  expect(input.prompt).toContain('nextCursor')
  expect(useAppStore.getState().tabs['source-tab']).toEqual(beforeTab)
  expect(useAppStore.getState().sessions.find(item => item.id === 'original')).toEqual(beforeAgent)
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
  expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(2)
  expect(stop).not.toHaveBeenCalled()
  const repeated = await takeOverSession(source, 'fixture', () => true)
  expect(repeated.agent?.agentSessionId).toBe(input.agentSessionId)
  expect(launch).toHaveBeenCalledTimes(1)
})

it.each(['Investigation - build', ("Investigation - build - " + _hygiene_fixtureCivil(9, 30) + " " + _hygiene_fixtureClock(8, 15))])('inherits %s with one stable creation-time suffix through the durable name owner', async label => {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(_hygiene_fixtureYear,9,7,17,32))
  try {
    source = {...source,label}
    const launch=launchBoundary(), before=structuredClone(useAppStore.getState().sessions)
    const report=await takeOverSession(source,'fixture',()=>true),id=report.agent!.agentSessionId
    expect(report.outcome).toBe('opened')
    const expected=("Investigation - build - " + _hygiene_fixtureCivil(10, 7) + " " + _hygiene_fixtureClock(17, 32))
    expect(useAppStore.getState().agentNames[id]).toBe(expected)
    expect(displayLabel((await nameOwner.read())!.graph,{kind:'agent-session',id})?.value).toBe(expected)
    vi.setSystemTime(new Date(_hygiene_fixtureYear,9,7,19,45))
    await inspectTakeover(source);expect(useAppStore.getState().agentNames[id]).toBe(expected)
    await useAppStore.getState().renameAgent(id,'User renamed successor')
    await inspectTakeover(source);expect(useAppStore.getState().agentNames[id]).toBe('User renamed successor')
    await useAppStore.getState().renameAgent(id,null)
    await inspectTakeover(source);expect(useAppStore.getState().agentNames[id]).toBeUndefined()
    expect(launch).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().sessions.find(s=>s.id===original.id)).toEqual(before[0])
    expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
  } finally {vi.useRealTimers()}
})

it.each(['disk', 'identity'])('settles an unobserved new Agent from exact Core creation and preserves it after a %s naming failure', async failure => {
  const names=vi.mocked(api.spatial.renameLabel);names.mockRejectedValue(new Error('Private inherited-name disk failure'))
  const launch=launchBoundary(),report=await takeOverSession(source,'fixture',()=>true),id=report.agent!.agentSessionId
  const execute=useAppStore.getState().executeControl
  const confirmed=await execute({schemaVersion:5,requestId:'confirmed-name-inspection',operation:'space.inspect',target:{requestId:report.requestId}})
  vi.spyOn(useAppStore.getState(),'executeControl').mockImplementation((request,signal)=>request.operation==='space.inspect'?Promise.resolve(confirmed):execute(request,signal))
  // This fresh durable creation has no name mutation yet, as after a lost projection/ACK.
  const current=useAppStore.getState();useAppStore.setState({sessions:current.sessions.filter(s=>s.id!==id),agentNames:{},nameLabels:{}})
  const created={...agentCreationFixture({...original,id,createdAt:new Date(_hygiene_fixtureYear,9,7,18,10).getTime()}),agentSessionId:id,hostId:'local',createdAt:new Date(_hygiene_fixtureYear,9,7,18,10).getTime()}
  const creation=vi.mocked(api.sessions.creation).mockClear().mockResolvedValue(failure==='identity'?{...created,agentSessionId:'another-agent'}:created)
  const inspected=await inspectTakeover(source)
  expect(inspected?.outcome).toBe('opened');expect(creation).toHaveBeenCalledExactlyOnceWith('local',id)
  expect(useAppStore.getState().nameEditFailure?.message).toContain(failure==='identity'?'creation reply belongs to another Agent':'Private inherited-name disk failure')
  expect(useAppStore.getState().tabs[report.to!.tabId]!.regions[report.to!.regionId]).toMatchObject({sessionId:id})
  expect(launch).toHaveBeenCalledTimes(1)
})

it('a moved display uses the exact original execution Zone instead of the display Host', async () => {
  config = { ...config, hosts: [...config.hosts, { id: 'remote', kind: 'ssh', label: 'Build', hostname: 'private.invalid' }],
    workspaces: [...config.workspaces, { id: 'execution', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), name: 'Remote', kind: 'folder' }] }
  original = { ...original, workspacePath: _hygiene_fixturePath("srv/repo"), control: { ...original.control, hostId: 'remote' } }
  source = { ...source, hostId: 'remote', cwd: _hygiene_fixturePath("srv/repo") }
  useAppStore.setState({ config, sessions: [original] })
  const launch = launchBoundary()
  const report = await takeOverSession(source, 'fixture', () => true)
  expect(report.outcome).toBe('opened')
  expect(launch.mock.calls[0]![0]).toMatchObject({ hostId: 'remote', workspacePath: _hygiene_fixturePath("srv/repo") })
  expect(launch.mock.calls[0]![0].prompt).toContain('"hostId":"remote"')
  expect(launch.mock.calls[0]![0].prompt).toContain('agent context --host local')
  expect(useAppStore.getState().tabs['source-tab']!.regions['source-region']).toMatchObject({ sessionId: 'original' })
})

it('names an unobserved remote successor through the original Desktop Host while its Core receipt says local', async () => {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(_hygiene_fixtureYear,9,7,18,10))
  try {
    config={...config,hosts:[...config.hosts,{id:'remote',kind:'ssh',label:'Build',hostname:'private.invalid'}],
      workspaces:[...config.workspaces,{id:'execution',hostId:'remote',path:_hygiene_fixturePath("srv/repo"),name:'Remote',kind:'folder'}]}
    original={...original,workspacePath:_hygiene_fixturePath("srv/repo"),control:{...original.control,hostId:'remote'}}
    source={...source,hostId:'remote',cwd:_hygiene_fixturePath("srv/repo")};useAppStore.setState({config,sessions:[original]})
    await useAppStore.getState().retryWorkbenchSave()
    const names=vi.mocked(api.spatial.renameLabel),persist=names.getMockImplementation()!
    names.mockRejectedValue(new Error('First name ACK unavailable'))
    const launch=launchBoundary(),report=await takeOverSession(source,'fixture',()=>true),id=report.agent!.agentSessionId
    expect(report.outcome).toBe('opened');expect(report.agent!.hostId).toBe('remote')
    useAppStore.setState({sessions:useAppStore.getState().sessions.filter(s=>s.id!==id)})
    names.mockImplementation(persist);const creation=vi.mocked(api.sessions.creation).mockClear()
    const inspected=await inspectTakeover(source)
    expect(inspected?.outcome).toBe('opened')
    expect(creation.mock.calls.length).toBeGreaterThan(0)
    expect(creation.mock.calls.every(([host,sid])=>host==='remote'&&sid===id)).toBe(true)
    expect(useAppStore.getState().agentNames[id]).toBe(("Original Agent - " + _hygiene_fixtureCivil(10, 7) + " " + _hygiene_fixtureClock(18, 10)))
    expect(displayLabel((await nameOwner.read())!.graph,{kind:'agent-session',id})?.value).toBe(("Original Agent - " + _hygiene_fixtureCivil(10, 7) + " " + _hygiene_fixtureClock(18, 10)))
    expect(launch).toHaveBeenCalledTimes(1)
  } finally {vi.useRealTimers()}
})

it('a failed creation keeps its correlation and visible feedback; Check again never resends', async () => {
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Original Host temporarily unavailable'))
  const creation = vi.mocked(api.sessions.creation).mockRejectedValue(new Error('The original creation has no confirmed Session or prepared start.'))
  await mountPicker()
  await act(async () => document.querySelector<HTMLButtonElement>('.agent-pick')!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.session-takeover__issue')).not.toBeNull() })
  expect(document.querySelector('.session-takeover__issue')!.textContent).toContain('Original Host temporarily unavailable')
  expect(useAppStore.getState().layouts.repo!.groups[0]!.activeTabId).toBe('source-tab')
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector<HTMLButtonElement>('.session-takeover__issue button')!.disabled).toBe(false) })
  await act(async () => document.querySelector<HTMLButtonElement>('.session-takeover__issue button')!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.session-takeover__issue')!.textContent).toContain('Original operation failure: Original Host temporarily unavailable') })
  expect(document.querySelector('.session-takeover__issue')!.textContent).toContain('Current creation check: The original creation has no confirmed Session or prepared start.')
  const inspected = await inspectTakeover(source)
  expect(inspected!.issues.map(issue => issue.step)).toEqual(['original-owner', 'creation-read'])
  const binding = useAppStore.getState().spatialRequests[inspected!.requestId]!
  expect(binding.originalFailure?.message).toBe('Original Host temporarily unavailable')
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.spatialRequests[binding.requestId].originalFailure).toEqual(binding.originalFailure)
  const observed = launched(binding.agentSessionId, binding.requestId).created
  creation.mockResolvedValue({ ...observed, creation: { ...observed.creation!, createOperationId: 'another-operation' } })
  expect(await inspectTakeover(source)).toMatchObject({ outcome: 'unknown', issues: [
    { step: 'original-owner', message: 'Original operation failure: Original Host temporarily unavailable' },
    { step: 'creation-read', message: expect.stringContaining('original creation operation identity') }
  ] })
  creation.mockResolvedValue({ ...observed, creation: { ...observed.creation!, persistence: 'unconfirmed' } })
  expect(await inspectTakeover(source)).toMatchObject({ outcome: 'unknown', issues: [
    { step: 'original-owner', message: 'Original operation failure: Original Host temporarily unavailable' },
    { code: 'AGENT_CREATION_UNCONFIRMED' }
  ] })
  creation.mockResolvedValue(observed)
  const confirmed = await inspectTakeover(source)
  expect(confirmed!.outcome).toBe('opened')
  expect(confirmed!.issues).toEqual([])
  expect(useAppStore.getState().spatialRequests[binding.requestId]!.originalFailure).toEqual(binding.originalFailure)
  expect(launch).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
})

it('a changed source and a cancelled admission cannot target a replacement Agent', async () => {
  const launch = launchBoundary()
  await expect(takeOverSession(source, 'fixture', () => false)).rejects.toThrow('original Region or Session changed')
  useAppStore.setState({ tabs: { 'source-tab': createWorkbenchTab('source-tab', { regionId: 'source-region', kind: 'agent', phase: 'attached', workspaceId: 'repo', sessionId: 'replacement' }) } })
  await expect(takeOverSession(source, 'fixture', () => true)).rejects.toThrow('original Region or Session changed')
  expect(launch).not.toHaveBeenCalled()
})

it('an absent source Host is explicit and never borrows the display Host', async () => {
  const launch = launchBoundary()
  useAppStore.setState({ sessions: [] })
  vi.mocked(api.spatial.read).mockResolvedValue(null)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  await expect(takeOverSession({ ...source, hostId: undefined, cwd: undefined }, 'fixture', () => true)).rejects.toThrow()
  expect(launch).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs['source-tab']!.regions['source-region']).toMatchObject({ sessionId: 'original' })
})

it('the complete retained first task and diagnostic are provided without frontend clipping', () => {
  const prompt = 'Original task '.repeat(200) + 'TASK-END'
  useAppStore.setState({ pendingAgentLaunches: { original: { events: [], overflowed: false, request: { hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), executorId: 'fixture', prompt } } } })
  expect(takeoverPrompt(source)).toContain(prompt)
  expect(takeoverPrompt(source)).toContain(diagnostic)
})

it('a retired original source is re-read from Core metadata independently of the display Host', async () => {
  config = { ...config, hosts: [...config.hosts, { id: 'remote', kind: 'ssh', label: 'Build', hostname: 'private.invalid' }],
    workspaces: [...config.workspaces, { id: 'execution', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), name: 'Remote', kind: 'folder' }] }
  original = { ...original, workspacePath: _hygiene_fixturePath("srv/repo"), control: { ...original.control, hostId: 'remote' } }
  useAppStore.setState({ config, sessions: [] })
  const histories = [{ agentSessionId: 'original', hostId: 'remote', state: 'retired' as const, retiredAt: 10,
    history: { providerId: 'codex', executorId: 'fixture', workspacePath: _hygiene_fixturePath("srv/repo"), createdAt: 1 } }]
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue(histories)
  const read = vi.mocked(api.spatial.read).getMockImplementation()!
  vi.mocked(api.spatial.read).mockImplementation(async () => {
    const snapshot = await read()
    // The external Core has the same original remote binding; the Desktop
    // display deliberately remains on local. Preserve the actual write boundary.
    snapshot?.graph.regions.forEach(region => {
      if (region.agentSessionId === 'original') region.execution = { hostId: 'remote', cwd: _hygiene_fixturePath("srv/repo") }
    })
    return snapshot
  })
  expect(takeoverExecution('original', histories)).toEqual({ hostId: 'remote', cwd: _hygiene_fixturePath("srv/repo"), executorId: 'fixture' })
  const launch = launchBoundary()
  const report = await takeOverSession({ ...source, hostId: 'remote', cwd: _hygiene_fixturePath("srv/repo") }, 'fixture', () => true)
  expect(report.outcome).toBe('opened')
  expect(launch.mock.calls[0]![0]).toMatchObject({ hostId: 'remote', workspacePath: _hygiene_fixturePath("srv/repo") })
  expect(useAppStore.getState().tabs['source-tab']!.regions['source-region']).toMatchObject({ sessionId: 'original' })
})

it('conflicting retained source Hosts stay unknown and a stale Host cannot be substituted', async () => {
  useAppStore.setState({ sessions: [] })
  const histories = ['local', 'other'].map(hostId => ({ hostId, agentSessionId: 'original', state: 'retired' as const, retiredAt: 10,
    history: { providerId: 'codex', executorId: 'fixture', workspacePath: _hygiene_fixturePath("repo"), createdAt: 1 } }))
  expect(takeoverExecution('original', histories)).toBeNull()
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue(histories)
  vi.mocked(api.spatial.read).mockResolvedValue(null)
  const launch = launchBoundary()
  await expect(takeOverSession(source, 'fixture', () => true)).rejects.toThrow('unconfirmed or ambiguous')
  vi.mocked(api.sessions.historySources).mockResolvedValue([histories[1]!])
  await expect(takeOverSession(source, 'fixture', () => true)).rejects.toThrow('execution identity changed')
  expect(launch).not.toHaveBeenCalled()
})

it('an incomplete two-Host catalogue cannot establish a unique takeover source without Core execution', async () => {
  const goodStore = new AgentMuxMemoryAgentSessionStore(), failedStore = new AgentMuxMemoryAgentSessionStore()
  await goodStore.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original', hostId: 'local', providerId: 'codex', executorId: 'fixture',
    workspacePath: _hygiene_fixturePath("repo"), run: { runId: 'retained-original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-fixture', hookToken: 'private-fixture-token', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } })
  const failure = new Error('The other exact Host retained metadata is unavailable.')
  vi.spyOn(failedStore, 'load').mockRejectedValue(failure)
  const healthy = new AgentMuxClient({ store: goodStore }), failed = new AgentMuxClient({ store: failedStore })
  const controller = new RuntimeController(goodStore, async () => { throw new Error('No Runtime connection belongs to this metadata fixture') })
  controller.commit({ hosts: [
    { id: 'local', config: { id: 'local', kind: 'local', label: 'Private' }, client: healthy, executionHost: { kind: 'local', dispose: vi.fn() } as never },
    { id: 'other', config: { id: 'other', kind: 'ssh', label: 'Other', hostname: 'other.invalid' }, client: failed, executionHost: { kind: 'local', dispose: vi.fn() } as never }
  ], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  // This metadata-only fixture has no trusted remote Runtime. Keep that known
  // observation state without scheduling a native connection to any user owner.
  Object.assign(failed, { runtimeOwnerIdentity: () => ({ availability: 'unverified' }) })
  const connect = [vi.spyOn(healthy, 'connect'), vi.spyOn(failed, 'connect')]
  useAppStore.setState({ sessions: [] })
  vi.mocked(api.spatial.read).mockResolvedValue(null)
  const history = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => controller.sessionHistorySources())
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  try {
    const cut = await controller.sessionHistorySources({ observation: true })
    expect(cut.sources.map(item => [item.agentSessionId, item.hostId])).toEqual([['original', 'local']])
    expect(cut.warnings).toEqual([expect.objectContaining({ hostId: 'other', scope: 'observation', code: 'RUNTIME_UNAVAILABLE' })])
    await expect(takeOverSession({ ...source, hostId: undefined, cwd: undefined }, 'fixture', () => true)).rejects.toBe(failure)
    expect(history).toHaveBeenCalledExactlyOnceWith()
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    for (const probe of connect) expect(probe).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
    expect(useAppStore.getState().tabs['source-tab']!.regions['source-region']).toMatchObject({ sessionId: 'original' })
  } finally { await controller.dispose() }
})

it('a fresh Core Region replacement refuses the stale Desktop source without touching either Session', async () => {
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  graph.regions.find(region => region.regionId === 'source-region')!.agentSessionId = 'replacement'
  useAppStore.setState({ sessions: [] })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([{ hostId: 'local', agentSessionId: 'original', state: 'retired', retiredAt: 10,
    history: { providerId: 'codex', executorId: 'fixture', workspacePath: _hygiene_fixturePath("repo"), createdAt: 1 } }])
  vi.mocked(api.spatial.read).mockResolvedValue({ schemaVersion: 1, revision: 2, graph })
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  await expect(takeOverSession(source, 'fixture', () => true)).rejects.toThrow('Core confirms the original Region')
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
})

it('a confirmed Core execution binding keeps takeover usable when history observation fails', async () => {
  config = { ...config, hosts: [...config.hosts, { id: 'remote', kind: 'ssh', label: 'Build', hostname: 'private.invalid' }],
    workspaces: [...config.workspaces, { id: 'execution', hostId: 'remote', path: _hygiene_fixturePath("srv/repo"), name: 'Remote', kind: 'folder' }] }
  original = { ...original, hostId: 'remote', workspacePath: _hygiene_fixturePath("srv/repo"), control: { ...original.control, hostId: 'remote' } }
  useAppStore.setState({ config, sessions: [original] })
  // Let the real Desktop persistence ACK this binding before withholding the
  // next Runtime observation. An external write racing an older fixture ACK
  // would substitute a different source instead of testing an observation gap.
  await vi.waitFor(async () => {
    const spatial = await api.spatial.read()
    expect(spatial?.graph.regions.find(region => region.regionId === 'source-region')?.execution)
      .toEqual({ hostId: 'remote', cwd: _hygiene_fixturePath("srv/repo") })
  })
  vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  useAppStore.setState({ sessions: [] })
  const failure = 'History probe failed; '.repeat(100) + 'FULL-FAILURE-END'
  vi.spyOn(api.sessions, 'historySources').mockRejectedValue(new Error(failure))
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  const report = await takeOverSession({ ...source, hostId: undefined, cwd: undefined }, 'fixture', () => true)
  expect(report.outcome).toBe('opened')
  expect(launch.mock.calls[0]![0]).toMatchObject({ hostId: 'remote', workspacePath: _hygiene_fixturePath("srv/repo") })
  expect(launch.mock.calls[0]![0].prompt).toContain(failure)
  expect(launch.mock.calls[0]![0].prompt).toContain('agent context --host local')
  expect(useAppStore.getState().tabs['source-tab']!.regions['source-region']).toMatchObject({ sessionId: 'original' })
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
  expect(stop).not.toHaveBeenCalled()
})
