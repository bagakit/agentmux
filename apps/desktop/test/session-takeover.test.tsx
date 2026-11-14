import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { AgentCatalogEntry } from '@agentmux/core'
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, executorDetectionKey, prepareRendererUpdate } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { takeOverSession, takeoverPrompt, takeoverRequestId, type TakeoverSource } from '../src/renderer/src/lib/session-takeover'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionTakeoverSurface } from '../src/renderer/src/components/SessionTakeoverSurface'
import { AgentOperationFeedback } from '../src/renderer/src/components/AgentOperationFeedback'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { createClientUiRoot } from './helpers/client-ui-render'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import type { AgentLaunchResult, AppConfig, SessionSnapshot, ProviderCatalogObservation } from '../src/shared/contracts'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, dispose: (() => void) | undefined
let config: AppConfig, original: Extract<SessionSnapshot, { kind: 'agent' }>, source: TakeoverSource
let nameOwner: AgentMuxSpatialStateStore, ownerDirectory: string
const creations = new Map<string, Awaited<ReturnType<typeof api.sessions.creation>>>()
const diagnostic = 'Original diagnostic ' + 'all retained details; '.repeat(100)
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
function emptyProviderCatalog(options: { observation: true }): Promise<ProviderCatalogObservation>
function emptyProviderCatalog(): Promise<AgentCatalogEntry[]>
async function emptyProviderCatalog(options?: { observation: true }): Promise<ProviderCatalogObservation | AgentCatalogEntry[]> {
  return options?.observation ? { catalog: [], warnings: [] } : []
}
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
  vi.spyOn(api.providers, 'list').mockImplementation(emptyProviderCatalog)
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
  await act(async () => { root.unmount(); await prepareRendererUpdate() })
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
  function Host() {
    const [open, setOpen] = useState(true)
    return <>
      {source.hostId ? <AgentOperationFeedback subject={{ hostId: source.hostId, agentSessionId: source.agentSessionId, regionId: source.origin.regionId }} /> : null}
      {open ? <SessionTakeoverSurface source={source} active onClose={() => { setOpen(false); onClose() }} /> : null}
    </>
  }
  await act(async () => root.render(<Host />))
  return onClose
}

// Built-in Takeover creation is owned by takeover-flow and takeover-flow-main.
// This suite owns original menu/Stage cancellation, experience review and custom derived actions.

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

it('the original Agent Region opens experience review without extracting, delivering or stopping work', async () => {
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  const read = vi.spyOn(api.agentLearning, 'call').mockRejectedValue(new Error('Original learning owner is temporarily unavailable'))
  await act(async () => root.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible parked interactiveResize={false} linkOrigin={source.origin} />))
  const trigger = document.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => { await vi.waitFor(() => expect(document.querySelector('.agent-region-menu')).not.toBeNull()) })
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Pass on experience')
  expect(entry).toBeDefined(); await act(async () => entry!.click())
  expect(document.querySelector('.session-learning')).not.toBeNull()
  expect(read.mock.calls.map(([method]) => method)).toEqual(['agent.learning.ls'])
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
})

it('a Focus card hands Take over and Pass on experience to its exact Region, which opens them in place', async () => {
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  vi.spyOn(api.agentLearning, 'call').mockRejectedValue(new Error('Original learning owner is temporarily unavailable'))
  await act(async () => root.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible parked interactiveResize={false} linkOrigin={source.origin} />))
  const exact = { tabId: 'source-tab', regionId: 'source-region', sessionId: original.id, runId: original.control.run.runId }
  await act(async () => useAppStore.getState().requestRegionDerivedAction({ ...exact, actionId: 'take-over' }))
  expect(document.querySelector('.session-takeover:not(.session-learning)')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useAppStore.getState().regionDerivedActionRequest).toBeNull()
  await act(async () => document.querySelector('.session-takeover')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.session-takeover')).toBeNull() })
  await act(async () => useAppStore.getState().requestRegionDerivedAction({ ...exact, actionId: 'pass-on-experience' }))
  expect(document.querySelector('.session-learning')).not.toBeNull()
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
})

it('a custom new-agent action creates its own Agent from the same source with its own identity, instruction and name', async () => {
  const launch = launchBoundary(), stop = vi.spyOn(api.sessions, 'stop')
  const derived = { id: 'review', label: 'Review this work', instruction: 'Review the changes and list concrete bugs.' }
  expect(await takeoverRequestId(source)).toMatch(/^takeover:/)
  const derivedId = await takeoverRequestId({ ...source, derived })
  expect(derivedId).toMatch(/^derived:/); expect(derivedId).not.toBe(await takeoverRequestId(source))
  expect(await takeoverRequestId({ ...source, derived: { ...derived, instruction: 'Another instruction.' } })).not.toBe(derivedId)
  const report = await takeOverSession({ ...source, derived }, 'fixture', () => true)
  expect(report.outcome, JSON.stringify(report.issues)).toBe('opened'); expect(report.requestId).toBe(derivedId)
  const prompt = launch.mock.calls[0]![0].prompt!
  expect(prompt).toContain('Your task (Review this work):\nReview the changes and list concrete bugs.')
  expect(prompt).toContain("agent context --host 'local' --session 'original'")
  expect(prompt).not.toContain('Take over the unfinished work')
  await vi.waitFor(() => expect(useAppStore.getState().agentNames[report.agent!.agentSessionId]).toBe('Original Agent - Review this work'))
  expect(launch).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions.find(session => session.id === original.id)).toEqual(original)
  expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Unsent draft stays with the original.')
})

it('the Region opens a custom action from its menu in place and preselects its default Agent', async () => {
  const launch = launchBoundary()
  // Two Agents on the same Host; the action's default must lead, not the configuration order.
  useAppStore.setState(state => ({ config: { ...state.config!, executors: { first: { ...state.config!.executors.fixture!, label: 'First' }, ...state.config!.executors },
    agentDerivedActions: { actions: [{ id: 'review', label: 'Review this work', base: 'new-agent', instruction: 'Review the changes.', executorId: 'fixture' }] } } }))
  await act(async () => root.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible parked interactiveResize={false} linkOrigin={source.origin} />))
  const trigger = document.querySelector<HTMLButtonElement>('.agent-region-header__more')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  await act(async () => { await vi.waitFor(() => expect(document.querySelector('.agent-region-menu [data-derived-action="review"]')).not.toBeNull()) })
  await act(async () => document.querySelector<HTMLElement>('.agent-region-menu [data-derived-action="review"]')!.click())
  const surface = document.querySelector<HTMLElement>('.session-takeover[data-derived-action="review"]')!
  expect(surface).not.toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(surface.querySelector('h2')!.textContent).toBe('Review this work')
  expect(surface.querySelector('.session-takeover__instruction > p')!.textContent).toBe('Review the changes.')
  expect(surface.querySelector('.agent-pick[data-executor-id="fixture"] .agent-pick__default')?.getAttribute('aria-label')).toBe('Default Agent for this action')
  expect([...surface.querySelectorAll<HTMLButtonElement>('.agent-pick')].map(pick => pick.dataset.executorId)).toEqual(['fixture', 'first'])
  expect(launch).not.toHaveBeenCalled()
})

it('a request that arrives while the Region is still hidden opens once it is shown', async () => {
  const render = (visible: boolean) => root.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible={visible} parked interactiveResize={false} linkOrigin={source.origin} />)
  await act(async () => render(false))
  await act(async () => useAppStore.getState().requestRegionDerivedAction({ tabId: 'source-tab', regionId: 'source-region', sessionId: original.id, runId: original.control.run.runId, actionId: 'take-over' }))
  expect(useAppStore.getState().regionDerivedActionRequest).not.toBeNull()
  await act(async () => render(true))
  expect(document.querySelector('.session-takeover:not([hidden])')).not.toBeNull()
  expect(useAppStore.getState().regionDerivedActionRequest).toBeNull()
})

it('a derived action request for another Region is left alone, and a changed Run opens nothing', async () => {
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  await act(async () => root.render(<SessionPane sessionId={original.id} surfaceKind="agent" visible parked interactiveResize={false} linkOrigin={source.origin} />))
  await act(async () => useAppStore.getState().requestRegionDerivedAction({ tabId: 'source-tab', regionId: 'another-region', sessionId: original.id, runId: original.control.run.runId, actionId: 'take-over' }))
  expect(document.querySelector('.session-takeover')).toBeNull()
  expect(useAppStore.getState().regionDerivedActionRequest?.regionId).toBe('another-region')
  await act(async () => useAppStore.getState().requestRegionDerivedAction({ tabId: 'source-tab', regionId: 'source-region', sessionId: original.id, runId: 'replaced-run', actionId: 'take-over' }))
  expect(document.querySelector('.session-takeover')).toBeNull()
  expect(useAppStore.getState().regionDerivedActionRequest).toBeNull()
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Agent or Run in this Region changed') }), expect.anything())
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

it('custom derived instructions and original diagnostic remain complete at the prompt boundary', () => {
  const instruction = 'Review each independent finding and preserve its source. '.repeat(50) + 'End of authored instruction.'
  const prompt = takeoverPrompt({ ...source, derived: { id: 'full-review', label: 'Review all findings', instruction } })
  expect(prompt).toContain(instruction)
  expect(prompt).toContain(diagnostic)
  expect(prompt).toContain("agent context --host 'local' --session 'original'")
})

async function mountTakeoverExitFocus() {
  const triggerPanel = document.createElement('div'), trigger = document.createElement('button'), later = document.createElement('input')
  trigger.textContent = 'Invoking Agent More'; later.setAttribute('aria-label', 'Neighbor draft')
  triggerPanel.append(trigger); document.body.append(triggerPanel, later)
  const onClose = vi.fn()
  await act(async () => root.render(<SessionTakeoverSurface source={source} active onClose={onClose} returnTrigger={trigger} />))
  return { triggerPanel, trigger, later, onClose }
}
async function cancelTakeoverExitFocus() {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]')!.click())
}
it('later deliberate focus survives takeover cancellation exit', async () => {
  const { later, onClose } = await mountTakeoverExitFocus()
  await cancelTakeoverExitFocus()
  await act(async () => later.focus())
  expect(document.activeElement).toBe(later)
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(document.activeElement, 'Later explicit neighbor input must retain focus after exit').toBe(later)
})

it('normal cancellation still returns to the invoking More', async () => {
  const { trigger, onClose } = await mountTakeoverExitFocus()
  await cancelTakeoverExitFocus()
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(trigger)
})

it.each(['hidden', 'inert', 'aria-hidden'] as const)('cancellation rejects a now %s invoking trigger in both return paths', async attribute => {
  const { triggerPanel, trigger, onClose } = await mountTakeoverExitFocus()
  triggerPanel.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : '')
  const attemptedFocus = vi.spyOn(trigger, 'focus')
  await cancelTakeoverExitFocus()
  const cleanupAttempts = attemptedFocus.mock.calls.length
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect({ cleanupAttempts, allAttempts: attemptedFocus.mock.calls.length }, 'Neither cleanup nor exit timer may focus a hidden/inert origin').toEqual({ cleanupAttempts: 0, allAttempts: 0 })
})

it.each(['disabled', 'aria-disabled'] as const)('cancellation rejects a now %s invoking button in both return paths', async attribute => {
  const { trigger, onClose } = await mountTakeoverExitFocus()
  trigger.setAttribute(attribute, attribute === 'aria-disabled' ? 'true' : '')
  const attemptedFocus = vi.spyOn(trigger, 'focus')
  await cancelTakeoverExitFocus()
  const cleanupAttempts = attemptedFocus.mock.calls.length
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect({ cleanupAttempts, allAttempts: attemptedFocus.mock.calls.length }).toEqual({ cleanupAttempts: 0, allAttempts: 0 })
})
