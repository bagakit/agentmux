// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AgentFocusContext } from '../src/renderer/src/lib/agent-focus'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { defaultAgent, executionAgent, moteAgent, moteConfig } from './fixtures/mote-workface'

const initial = useAppStore.getState(), options = useAppStore.persist.getOptions()
type Saved = ReturnType<NonNullable<typeof options.partialize>>
const originalFocus: AgentFocusContext = {
  execution: { sessionId: 'original-focus-without-tab',
    reference: { displayWorkspaceId: 'workspace', groupId: 'previous-group', tabId: 'previous-tab', regionId: 'previous-region' },
    history: [{ sessionId: 'original-focus-without-tab', focusedAt: 123 }] },
  pmo: { sessionId: 'original-pmo-without-tab' }
}
const empty: RuntimeSnapshot = { sessions: [], timelines: {}, recoveryCandidates: [] }
let directory: string, dispose: (() => void) | undefined, saved: Saved | undefined
let initializing: ReturnType<ReturnType<typeof useAppStore.getState>['initialize']> | undefined
let release: (() => void) | undefined
let effects: { mock: { calls: unknown[][] } }[]
async function ticks() { for (let count = 0; count < 24; count++) await Promise.resolve() }

beforeEach(async () => {
  useAppStore.setState(initial, true)
  saved = undefined; dispose = undefined; initializing = undefined; release = undefined
  directory = await mkdtemp(join(tmpdir(), 'amx-original-focus-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(callback => spatial.subscribe(callback))
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(empty)
  effects = ['launchAgent', 'launchTerminal', 'recover', 'resume', 'stop', 'submitPrompt', 'write', 'interrupt', 'attach']
    .map(name => vi.spyOn(api.sessions, name as keyof typeof api.sessions))
})
afterEach(async () => {
  release?.()
  dispose?.()
  if (initializing && !dispose) (await initializing)()
  await ticks()
  useAppStore.persist.setOptions({ storage: options.storage })
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
  await rm(directory, { recursive: true, force: true })
})

async function arrange(focus = originalFocus, config: AppConfig = composerConfig, sessions: SessionSnapshot[] = []) {
  const workspace = config.workspaces.find(value => value.id !== '__scratch__')!
  const tab = createWorkbenchTab('retained-unrelated-tab', { kind: 'launcher', workspaceId: workspace.id, regionId: 'retained-region' })
  const spaceId = directoryIdentity(workspace.hostId, workspace.path)
  tab.space = { spaceId, zoneId: workspaceZoneId(spaceId, workspace.id) }
  const tabs = { [tab.id]: tab }, layouts = { [workspace.id]: createWorkspaceLayout('retained-group', [tab.id]) }
  const durable = { ...options.partialize!(initial), agentFocus: structuredClone(focus), activeWorkspaceId: workspace.id,
    mainSurface: 'agents' as const, agentComposerDrafts: { [originalFocus.execution.sessionId!]: 'Original unsent input' } }
  // Real Zustand hydration/merge and partialization, with only the browser storage IO adapted.
  useAppStore.persist.setOptions({ storage: {
    getItem: () => ({ state: durable, version: 1 }),
    setItem: (_key, value) => { saved = value.state }, removeItem: () => {}
  } })
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().agentFocus).toEqual(focus)
  useAppStore.setState({ sessions, loading: true })
  await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...useAppStore.getState(), config, tabs, layouts }, []) })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  return { tabs, layouts, workspaceId: workspace.id }
}
function noExecution() { for (const effect of effects) expect(effect.mock.calls).toHaveLength(0) }

it('actual initialize retains the hydrated no-Tab execution/PMO choices, reference and history with an empty first Session cut', async () => {
  const original = await arrange()
  dispose = await useAppStore.getState().initialize()
  await ticks()
  const state = useAppStore.getState()
  expect(state.loading).toBe(false)
  expect(state.sessions).toEqual([])
  expect(state.agentFocus).toEqual(originalFocus)
  expect(saved?.agentFocus).toEqual(originalFocus)
  expect(state.tabs).toEqual(original.tabs); expect(state.layouts).toEqual(original.layouts)
  expect(state.activeWorkspaceId).toBe(original.workspaceId); expect(state.mainSurface).toBe('agents')
  expect(state.agentComposerDrafts[originalFocus.execution.sessionId!]).toBe('Original unsent input')
  expect(api.sessions.snapshot).toHaveBeenCalled()
  noExecution()
})

it('actual initialize still rejects observed incompatible lanes without discarding earlier execution history', async () => {
  const focus = { ...originalFocus, execution: { ...originalFocus.execution, sessionId: defaultAgent.id }, pmo: { sessionId: executionAgent.id } }
  await arrange(focus, moteConfig, [defaultAgent, executionAgent])
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().agentFocus).toEqual({ execution: { sessionId: null, history: originalFocus.execution.history }, pmo: { sessionId: null } })
  noExecution()
})

it('actual initialize keeps original choices when observed Sessions have unobserved Topic lane facts', async () => {
  const execution = moteAgent(originalFocus.execution.sessionId!, 'launcher:unobserved-execution')
  const pmo = moteAgent(originalFocus.pmo.sessionId!, 'launcher:unobserved-pmo')
  await arrange(originalFocus, moteConfig, [execution, pmo])
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().agentFocus).toEqual(originalFocus)
  noExecution()
})

it.each(['select', 'clear'] as const)('a later explicit %s while boot config is awaited wins over retained focus and late membership', async action => {
  await arrange()
  let configReady!: (value: AppConfig) => void, membershipReady!: (value: RuntimeSnapshot) => void
  const config = new Promise<AppConfig>(resolve => { configReady = resolve })
  const membership = new Promise<RuntimeSnapshot>(resolve => { membershipReady = resolve })
  release = () => { configReady(composerConfig); membershipReady(empty) }
  vi.mocked(api.config.get).mockReturnValue(config)
  vi.mocked(api.sessions.snapshot).mockReturnValue(membership)
  initializing = useAppStore.getState().initialize()
  await vi.waitFor(() => expect(api.config.get).toHaveBeenCalled())
  expect(useAppStore.getState().focusExecutionSession(action === 'select' ? 'later-user-choice' : null, undefined, { navigate: false })).toBe(true)
  const selected = useAppStore.getState().agentFocus
  configReady(composerConfig)
  dispose = await initializing
  expect(useAppStore.getState().agentFocus).toEqual(selected)
  membershipReady({ ...empty, sessions: [composerSession(originalFocus.execution.sessionId!)] })
  await ticks()
  expect(useAppStore.getState().agentFocus).toEqual(selected)
  expect(saved?.agentFocus).toEqual(selected)
  noExecution()
})
