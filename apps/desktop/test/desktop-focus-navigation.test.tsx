import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxControlResult, AgentMuxDesktopFocusResult, AgentMuxDesktopFocusTarget } from '@agentmux/core/control'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, focusWorkbenchTabRegion, removeWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import { restoreWorkbenchSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { installNativePopover } from './fixtures/mote-workface'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { workbenchDisplayReferenceMatches } from '../src/renderer/src/lib/workbench-resource-display'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'

// Actual App/Store/Workbench/SessionPane/TerminalView focus owners run. The Run API,
// terminal DOM paint/addons and geometry are isolated leaves; native proof covers real I/O.
vi.mock('react-resizable-panels', async () => {
  // The browser build registers real Panels in happy-dom; the Node build registers none.
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    fixtureInput: HTMLTextAreaElement | null = null
    open(host: HTMLElement) { this.element = document.createElement('div'); this.element.className = 'xterm'
      this.fixtureInput = document.createElement('textarea'); this.fixtureInput.className = 'xterm-helper-textarea'; this.element.append(this.fixtureInput); host.append(this.element) }
    refresh() {}
    focus() { this.fixtureInput?.focus() }
    onRender = () => ({ dispose() {} })
    onSelectionChange = () => ({ dispose() {} })
    getSelection() { return '' }
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {} setVisible() {} observeViewport() {}
  async startLiveSynchronization() {} dispose() {}
} }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
  executors: { fixture: { label: 'Fixture', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'source', name: 'Source', hostId: 'local', path: _hygiene_fixturePath("source"), kind: 'folder' },
    { id: 'target', name: 'Target', hostId: 'local', path: _hygiene_fixturePath("target"), kind: 'folder' },
    { id: 'empty', name: 'Empty directory', hostId: 'local', path: _hygiene_fixturePath("empty"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const space = directoryIdentity('local', _hygiene_fixturePath("target")), zone = workspaceZoneId(space, 'target')
function agent(id: string, workspace: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex', workspacePath: `/${workspace}`, label: id,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run:${id}` } } }
}
const source = agent('source-agent', 'source'), target = agent('target-agent', 'target')
const sourceTab = createWorkbenchTab('source-tab', { kind: 'agent', phase: 'attached', workspaceId: 'source', regionId: 'source-region', sessionId: source.id })
const targetTab = createWorkbenchTab('target-tab', { kind: 'agent', phase: 'attached', workspaceId: 'target', regionId: 'target-region', sessionId: target.id })
const goal = (id: string, sessionIds: string[] = []) => ({ id, title: id, description: '', status: 'in_progress' as const,
  priority: 'normal' as const, projectId: null, projectName: null, sessionIds, source: 'default-topic' as const, createdAt: 1, updatedAt: 1 })
let root: Root, container: HTMLDivElement, outside: HTMLTextAreaElement, dispose: (() => void) | undefined, restorePopover: (() => void) | undefined
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) }) }
async function control(target: AgentMuxDesktopFocusTarget, inputPolicy: 'preserve' | 'target' = 'preserve') {
  let pending!: Promise<unknown>
  await act(async () => {
    pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: crypto.randomUUID(),
      operation: 'focus', target, inputPolicy }))
    await Promise.resolve()
  })
  const result = await pending as AgentMuxDesktopFocusResult
  const { operation, ...body } = result
  expect(parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'private', operation, ok: true, result: body })).toMatchObject({ result: body })
  await settle()
  return result
}
async function arrangePrimaryInputMote(twoRegions = false) {
  const mote = { ...agent('primary-input-agent', 'scratch'), workspacePath: _hygiene_fixturePath("scratch/topic--launcher--leader") }
  const first = createWorkbenchTab('primary-input-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
    regionId: 'primary-input-region', sessionId: mote.id })
  const regions = twoRegions ? addWorkbenchRegion(first, 'primary-input-region', 'right', { kind: 'agent', phase: 'attached',
    workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'primary-input-right', sessionId: mote.id }) : first
  const tab = { ...regions, layout: { ...regions.layout, activeRegionId: 'primary-input-region' }, topicId: PMO_TEAMS_TOPIC_ID }
  const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Private primary input', summary: '', collaborators: [],
    directoryPath: mote.workspacePath, topicPath: `${mote.workspacePath}/topic.md`,
    soul: { path: `${mote.workspacePath}/SOUL.md`, content: '# Private identity', version: 'v1' } }
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic]); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
  await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
    { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' }] },
    sessions: [...state.sessions, mote], tabs: { ...state.tabs, [tab.id]: tab },
    layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('primary-input-group', [tab.id]) },
    viewModes: { ...state.viewModes, [mote.id]: 'activity' }, agentComposerDrafts: { ...state.agentComposerDrafts, [mote.id]: 'Primary unsent draft' } })))
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: tab.id })); await settle()
  const floating = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')!
  const input = floating.querySelector<HTMLElement>('[data-workbench-region-id="primary-input-region"] [role="textbox"]')!
  return { mote, tab, floating, input }
}
// A real second external Activity presentation keeps the original Mote body secondary
// under the current default projection rule. This changes setup, never the input oracle.
async function showSecondActivityPresentation(tabId: string, groupId = 'primary-input-group', regionId = 'primary-input-region') {
  const state = useAppStore.getState()
  const catalog = spatialCatalog(state, await api.scratch.listTopics(SCRATCH_WORKSPACE_ID))
  const entities = catalog.tabs.filter(entity => entity.tabId === tabId)
  expect(entities).toHaveLength(1)
  expect(typeof entities[0]!.zoneId).toBe('string')
  const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId, tabId, regionId }
  expect(catalog.locations.some(location => location.displayWorkspaceId === reference.displayWorkspaceId &&
    location.groupId === groupId && location.tabId === tabId && location.regionId === regionId)).toBe(true)
  await act(async () => {
    state.setSurveyZoneSelection({ zoneId: entities[0]!.zoneId!, selection: [reference], active: reference })
    state.setMainSurface('survey')
  })
  await settle()
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  restorePopover = installNativePopover()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) })
  window.localStorage.clear()
  useAppStore.setState({ ...initial, restoredWorkbench: null, config: null }, true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'attach').mockImplementation(async control => ({ attachmentId: `attachment:${control.run.runId}`,
    session: control.run.runId === source.control.run.runId ? source : target, currentSize: { cols: 80, rows: 24 }, gap: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [] }))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  dispose = await useAppStore.getState().initialize()
  useAppStore.setState({ initialize: vi.fn(async () => () => {}), loading: false, config, sessions: [source, target],
    tabs: { [sourceTab.id]: sourceTab, [targetTab.id]: targetTab },
    layouts: { source: createWorkspaceLayout('source-group', [sourceTab.id]), target: createWorkspaceLayout('target-group', [targetTab.id]), empty: createWorkspaceLayout('empty-group') },
    activeWorkspaceId: 'source', mainSurface: 'workbench', workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    demands: { first: goal('first', [source.id]), exact: goal('exact') }, selectedDemandId: 'first',
    agentFocus: { execution: { sessionId: source.id, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [source.id]: 'Unsent original draft' } })
  container = document.createElement('div'); outside = document.createElement('textarea'); outside.value = 'Keep user input'
  document.body.append(container, outside); root = createRoot(container)
  await act(async () => root.render(createElement(App))); await settle(); outside.focus(); outside.setSelectionRange(2, 5)
})
afterEach(async () => {
  await act(async () => root.unmount()); dispose?.(); dispose = undefined
  restorePopover?.(); restorePopover = undefined
  container.remove(); outside.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear()
})

describe('actual Desktop navigation and content-free observation owners', () => {
  it('reads presentation for cold requests and adds no readers, observers or Runtime subscriptions for unrelated output facts', async () => {
    const presentation = await import('../src/renderer/src/lib/desktop-presentation')
    const read = vi.spyOn(presentation, 'readDesktopPresentation')
    const query = vi.spyOn(document, 'querySelector')
    const observe = vi.spyOn(window.MutationObserver.prototype, 'observe')
    const subscriptions = vi.spyOn(api.sessions, 'onEvent')
    const expressions = vi.spyOn(await import('../src/renderer/src/lib/region-focus'), 'regionFocusExpression')
    const targetExpressions = () => expressions.mock.calls.filter(([, regionId]) => regionId === 'target-region').length
    const sourceExpressions = () => expressions.mock.calls.filter(([, regionId]) => regionId === 'source-region').length
    const desktopQueries = () => query.mock.calls.filter(([selector]) => selector.startsWith('[data-desktop-surface=')).length
    const result = await control({ kind: 'space', regionId: 'target-region' })
    expect(result.presentation.state).toBe('main-visible')
    expect(read.mock.calls.length).toBeGreaterThan(0)
    expect(desktopQueries()).toBeGreaterThan(0)
    expect(container.querySelectorAll('.xterm-helper-textarea').length).toBeGreaterThan(0)
    const original = useAppStore.getState(), reads = read.mock.calls.length, queries = desktopQueries()
    const targetRenders = targetExpressions(), sourceRenders = sourceExpressions()
    expect(targetRenders).toBeGreaterThan(0)
    observe.mockClear()
    for (let revision = 1; revision <= 35; revision++) await act(async () => useAppStore.setState({
      sessions: useAppStore.getState().sessions.map(session => session.id === source.id ? { ...session, latestOutputBytes: revision * 4096 } : session),
      timelines: { [source.id]: { agentSessionId: source.id, revision, items: [] } }
    }))
    await settle()
    expect(useAppStore.getState().sessions).toHaveLength(2)
    expect(useAppStore.getState().sessions.find(session => session.id === source.id)?.latestOutputBytes).toBe(35 * 4096)
    expect(useAppStore.getState().tabs).toBe(original.tabs)
    expect(useAppStore.getState().layouts).toBe(original.layouts)
    expect(read.mock.calls.length).toBe(reads)
    expect(desktopQueries()).toBe(queries)
    expect(sourceExpressions()).toBeGreaterThan(sourceRenders)
    expect(targetExpressions()).toBe(targetRenders)
    expect(observe).not.toHaveBeenCalled()
    expect(subscriptions).not.toHaveBeenCalled()
    const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'cost-read-only-inspect', operation: 'inspect.client' })
    if (inspected.operation !== 'inspect.client') throw new Error('Wrong operation')
    expect(desktopWorkbenchObservationSchema.parse(inspected.observation).desktop.selection.space?.regionId).toBe('target-region')
    expect(read.mock.calls.length).toBe(reads + 1)
    expect(desktopQueries()).toBeGreaterThan(queries)
    expect(observe).not.toHaveBeenCalled()
    expect(subscriptions).not.toHaveBeenCalled()
  })
  it('selects a child-derived Space and preserves the actual external input while new target terminals mount', async () => {
    const healthySessions = useAppStore.getState().sessions
    // The original target View exists before navigation, but its terminal is not mounted
    // until Core facts arrive. This exercises the real first-mount focus owner rather
    // than relying on an already hydrated terminal's visibility change.
    await act(async () => useAppStore.setState({ sessions: [source] })); await settle()
    const before = useAppStore.getState(), launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    const result = await control({ kind: 'space', regionId: 'target-region' })
    expect(result.navigation).toMatchObject({ state: 'applied', selection: { surface: 'space', space: {
      spaceId: space, zoneId: zone, workspaceId: 'target', tabId: 'target-tab', groupId: 'target-group', regionId: 'target-region' } } })
    expect(result.presentation).toMatchObject({ provenance: 'observed', state: 'main-visible' })
    expect(result.input).toMatchObject({ policy: 'preserve', outcome: 'preserved', before: { scope: 'main' }, after: { scope: 'main' } })
    expect(document.activeElement).toBe(outside); expect([outside.value, outside.selectionStart, outside.selectionEnd]).toEqual(['Keep user input', 2, 5])
    expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    await act(async () => useAppStore.setState({ sessions: healthySessions })); await settle()
    expect(container.querySelector('[data-workbench-region-id="target-region"] .xterm-helper-textarea')).not.toBeNull()
    expect(document.activeElement).toBe(outside)
    expect([outside.value, outside.selectionStart, outside.selectionEnd]).toEqual(['Keep user input', 2, 5])
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })
  it('does not grant default input to a newly mounted target when the current DOM has no input owner', async () => {
    const healthySessions = useAppStore.getState().sessions
    await act(async () => useAppStore.setState({ sessions: [source] })); await settle()
    outside.blur()
    expect(document.activeElement).toBe(document.body)
    const result = await control({ kind: 'space', regionId: 'target-region' })
    expect(result.input.policy).toBe('preserve')
    expect(result.input.outcome).not.toBe('transferred')
    expect(document.activeElement).toBe(document.body)
    await act(async () => useAppStore.setState({ sessions: healthySessions })); await settle()
    expect(container.querySelector('[data-workbench-region-id="target-region"] .xterm-helper-textarea')).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
  })
  it('opens an exact Goal from the full projection and preserves it through pure Surface selection without PMO launch', async () => {
    const launch = vi.spyOn(api.sessions, 'launchAgent'), send = vi.spyOn(api.sessions, 'submitPrompt')
    const result = await control({ kind: 'goal', goalId: 'exact' })
    expect(result.navigation.selection).toMatchObject({ surface: 'goals', mainSurface: 'board', goalId: 'exact' })
    expect(container.querySelector('[data-goal-detail-id="exact"]')).not.toBeNull()
    expect(result.presentation.state).toBe('main-visible')
    for (const surface of ['space', 'focus', 'survey', 'goals'] as const) await control({ kind: 'surface', surface })
    expect(useAppStore.getState().selectedDemandId).toBe('exact')
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(document.activeElement).toBe(outside)
  })
  it('transfers input only through the exact mounted Terminal owner and cancels an old intent on later explicit navigation', async () => {
    const result = await control({ kind: 'space', tabId: 'target-tab' }, 'target')
    expect(result.input).toMatchObject({ outcome: 'transferred', after: { ownerKind: 'terminal', tabId: 'target-tab', regionId: 'target-region', sessionId: target.id } })
    expect(document.activeElement?.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id')).toBe('target-region')
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
    await act(async () => useAppStore.getState().focusRegion('target', 'target-tab', 'target-region', 'keyboard'))
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
    await settle(); expect(useAppStore.getState().mainSurface).toBe('survey')
  })
  it('does not replay a pending exact input handoff after later user navigation and delayed Session facts', async () => {
    await act(async () => useAppStore.setState({ sessions: [source] }))
    let pending!: Promise<unknown>
    await act(async () => {
      pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'late-native',
        operation: 'focus', target: { kind: 'space', regionId: 'target-region' }, inputPolicy: 'target' }))
      await Promise.resolve()
    })
    expect(useAppStore.getState().regionCaretFocus?.regionId).toBe('target-region')
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
    await act(async () => useAppStore.setState({ sessions: [source, target] }))
    const result = await pending as AgentMuxDesktopFocusResult
    expect(result.navigation.state).toBe('unconfirmed'); expect(result.input.outcome).not.toBe('transferred')
    expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().regionCaretFocus).toBeNull()
    await settle()
    expect(document.activeElement?.closest('[data-workbench-region-id]')).toBeNull()
  })
  it('hands a pending exact input request to the original Terminal when its Session facts permit the first mount', async () => {
    const healthySessions = useAppStore.getState().sessions
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    await act(async () => useAppStore.setState({ sessions: [source] })); await settle()
    expect(container.querySelector('[data-workbench-region-id="target-region"] .xterm-helper-textarea')).toBeNull()
    outside.focus()
    const beforeTabs = useAppStore.getState().tabs
    let pending!: Promise<unknown>
    await act(async () => {
      pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'first-mount-target',
        operation: 'focus', target: { kind: 'space', regionId: 'target-region' }, inputPolicy: 'target' }))
      await Promise.resolve()
    })
    expect(useAppStore.getState().regionCaretFocus?.regionId).toBe('target-region')
    expect(document.activeElement).toBe(outside)
    await act(async () => useAppStore.setState({ sessions: healthySessions })); await settle()
    const targetInput = container.querySelector('[data-workbench-region-id="target-region"] .xterm-helper-textarea')
    expect(targetInput).not.toBeNull()
    const result = await pending as AgentMuxDesktopFocusResult
    expect(result.navigation.state).toBe('applied')
    expect(result.input).toMatchObject({ policy: 'target', outcome: 'transferred',
      after: { ownerKind: 'terminal', regionId: 'target-region', sessionId: target.id, connected: true, visible: true, inert: false } })
    expect(document.activeElement).toBe(targetInput)
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
    expect(useAppStore.getState().tabs).toEqual(beforeTabs)
    expect(useAppStore.getState().sessions).toBe(healthySessions)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })
  it('selects a zero-Tab Zone without automatic prewarm, detection or a new Session/Tab', async () => {
    const warm = vi.spyOn(useAppStore.getState(), 'prewarmTerminal'), terminal = vi.spyOn(api.sessions, 'launchTerminal')
    const detect = vi.spyOn(api.executors, 'detect')
    const before = useAppStore.getState().tabs
    const emptySpace = directoryIdentity('local', _hygiene_fixturePath("empty"))
    const result = await control({ kind: 'space', zoneId: workspaceZoneId(emptySpace, 'empty') })
    expect(result.navigation.selection.space).toMatchObject({ spaceId: emptySpace, workspaceId: 'empty', tabId: null, regionId: null })
    expect(useAppStore.getState().tabs).toBe(before)
    expect(result.presentation.state).toBe('main-visible'); expect(document.activeElement).toBe(outside)
    expect(warm).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-workspace-id="empty"][data-visible="true"]')).toHaveLength(1)
    // The durable exact choice is restored without transient input intent. Visibility still
    // does not authorize prewarm; ordinary process restart is separately covered by Native.
    await act(async () => useAppStore.setState({ workbenchNavigationInputPolicy: null })); await settle()
    expect(warm).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled()
  })
  it('lets the actual human new-tab action authorize its normal launcher after display-only Control navigation', async () => {
    await control({ kind: 'space', regionId: 'target-region' })
    const prewarm = vi.spyOn(useAppStore.getState(), 'prewarmTerminal')
    await act(async () => useAppStore.getState().openLauncher({ workspaceId: 'target', tabGroupId: 'target-group', reveal: true })); await settle()
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: space, zoneId: zone, workspaceId: 'target', groupId: 'target-group' })
    expect(useAppStore.getState().layouts.target!.groups[0]!.tabOrder).toHaveLength(2)
    expect(prewarm).toHaveBeenCalledWith('target', expect.any(String))
    expect(container.querySelector('.launch-surface')).not.toBeNull()
  })
  it('returns typed multi-Zone candidates and rejects mismatched parents without changing the durable workface', async () => {
    useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
      { id: 'worktree', name: 'Worktree', hostId: 'local', path: _hygiene_fixturePath("target-worktree"), repoPath: _hygiene_fixturePath("target"), kind: 'worktree', branch: 'task' }] } })
    const before = useAppStore.getState()
    const ambiguous = await control({ kind: 'space', spaceId: space })
    expect(ambiguous.navigation.state).toBe('rejected')
    expect(ambiguous.issues.find(issue => issue.code === 'SPACE_ZONE_REQUIRED')?.candidates).toEqual([
      { zoneId: zone }, { zoneId: workspaceZoneId(space, 'worktree') } ])
    const mismatch = await control({ kind: 'space', spaceId: directoryIdentity('local', _hygiene_fixturePath("source")), regionId: 'target-region' })
    expect(mismatch.navigation.state).toBe('rejected')
    expect(useAppStore.getState().tabs).toStrictEqual(before.tabs); expect(useAppStore.getState().layouts).toStrictEqual(before.layouts)
    expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
  })
  it('reads actual App overlay/input facts through strict inspect without changing state or invoking input/lifecycle', async () => {
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')
    expect(button).toBeTruthy()
    await act(async () => button!.click()); await settle()
    const field = document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')
    expect(field).toBeTruthy(); field!.focus(); const beforeElement = document.activeElement
    const result = await control({ kind: 'goal', goalId: 'exact' })
    expect(result.presentation).toMatchObject({ state: 'covered', blockers: ['settings'] }); expect(result.partial).toBe(true)
    expect(document.activeElement).toBe(beforeElement)
    const before = useAppStore.getState(), change = vi.fn(), release = useAppStore.subscribe(change)
    const snapshot = vi.spyOn(api.sessions, 'snapshot'), write = vi.spyOn(api.sessions, 'write'), launch = vi.spyOn(api.sessions, 'launchAgent'), resize = vi.spyOn(api.sessions, 'resize')
    const inspect = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'inspect-only', operation: 'inspect.client' })
    if (inspect.operation !== 'inspect.client') throw new Error('Wrong operation')
    const observed = desktopWorkbenchObservationSchema.parse(inspect.observation)
    expect(observed.desktop.presentation.state).toBe('covered'); expect(observed.desktop.overlays.settings).toBe(true)
    expect(JSON.stringify(observed)).not.toContain('Unsent original draft')
    expect(useAppStore.getState()).toBe(before); expect(change).not.toHaveBeenCalled(); expect(document.activeElement).toBe(beforeElement)
    expect(snapshot).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(resize).not.toHaveBeenCalled(); release()
  })
  it('reads current selection/input after a delayed read-only directory lookup while the user navigates', async () => {
    let release!: (topics: []) => void
    const topics = new Promise<[]>(resolve => { release = resolve })
    vi.spyOn(api.scratch, 'listTopics').mockImplementationOnce(() => topics).mockResolvedValue([])
    let pending!: Promise<unknown>
    await act(async () => {
      useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
        { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' }] } })
      pending = useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'delayed-inspect', operation: 'inspect.client' })
    })
    await act(async () => useAppStore.getState().setMainSurface('survey')); await settle()
    const actualInput = document.activeElement, current = useAppStore.getState()
    release([])
    const result = await pending as AgentMuxControlResult
    if (result.operation !== 'inspect.client') throw new Error('Wrong observation operation')
    const observed = desktopWorkbenchObservationSchema.parse(result.observation)
    expect(observed.mainSurface).toBe('survey'); expect(observed.desktop.selection.surface).toBe('survey')
    expect(observed.desktop.presentation.state).toBe('main-visible')
    expect(document.activeElement).toBe(actualInput); expect(useAppStore.getState()).toBe(current)
  })
  it.each(['unavailable', 'transferred'] as const)('keeps the existing Mote composer after the original mode switch while a different target is pending and %s', async outcome => {
    const { mote, tab, floating, input: firstInput } = await arrangePrimaryInputMote()
    firstInput.focus()
    await control({ kind: 'space', regionId: 'primary-input-region' })
    await act(async () => useAppStore.getState().setViewMode(mote.id, 'terminal')); await settle()
    await control({ kind: 'space', regionId: 'primary-input-region' }, 'target')
    await act(async () => useAppStore.getState().setViewMode(mote.id, 'activity')); await settle()
    await showSecondActivityPresentation(tab.id)
    const input = floating.querySelector<HTMLElement>('[data-workbench-region-id="primary-input-region"] [role="textbox"]')!
    expect(input.textContent).toBe('Primary unsent draft')
    input.focus()
    expect(input.closest('[data-workbench-primary-tab-id]')).toBeNull()
    const primary = document.querySelector<HTMLElement>('[data-workbench-primary-tab-id="primary-input-tab"]')!
    const secondary = input.closest<HTMLElement>('.retained-workbench-view')!
    expect(primary.dataset.workbenchPrimaryTabId).toBe(tab.id)
    expect(floating.contains(primary)).toBe(false); expect(floating.contains(secondary)).toBe(true)
    const parent = secondary.parentElement, occurrence = primary.dataset.workbenchPrimaryReference
    const primaryParent = primary.parentElement
    expect(parent?.id).toBeTruthy(); expect(occurrence).toBeTruthy()
    expect(secondary.dataset.workbenchViewReference).toBe(workbenchRegionProjectionSlotId('view', {
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'primary-input-group', tabId: tab.id, regionId: 'primary-input-region' }))
    const facts = (phase: string) => process.stdout.write('mode-switch-pending-facts ' + JSON.stringify({ phase, outcome,
      inputConnected: input.isConnected, activeSameInput: document.activeElement === input,
      activeRegionId: document.activeElement?.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') ?? null,
      secondaryConnected: secondary.isConnected, secondaryParentId: secondary.parentElement?.id, secondaryParentUnchanged: secondary.parentElement === parent,
      secondaryIsPrimary: Boolean(secondary.dataset.workbenchPrimaryTabId),
      primaryParentId: primary.parentElement?.id, primaryParentUnchanged: primary.parentElement === primaryParent,
      primaryReference: primary.dataset.workbenchPrimaryReference, primaryInMote: floating.contains(primary),
      policy: useAppStore.getState().workbenchNavigationInputPolicy, selection: useAppStore.getState().workbenchSpaceSelection,
      nonce: useAppStore.getState().regionCaretFocus }) + '\n')
    facts('before')
    const selection = document.getSelection()!, range = document.createRange()
    range.setStart(input.firstChild!.firstChild!, 3); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
    const caret = { node: selection.anchorNode, offset: selection.anchorOffset }
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    const targetInput = document.querySelector<HTMLTextAreaElement>('[data-workbench-region-id="target-region"] .xterm-helper-textarea')!
    const targetRegion = targetInput.closest<HTMLElement>('[data-workbench-region-id]')!
    expect(targetInput).toBeTruthy(); expect(targetRegion.dataset.workbenchRegionId).toBe('target-region')
    const wasInert = targetRegion.hasAttribute('inert'); targetRegion.setAttribute('inert', '')
    const events: string[] = []
    const onFocus = (event: Event) => { if (event.target === input) events.push(event.type) }
    document.addEventListener('focusin', onFocus); document.addEventListener('focusout', onFocus)
    const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
    const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'submitPrompt')]
    let pending: Promise<AgentMuxControlResult> | undefined
    const originalInputIsKept = () => {
      expect(document.activeElement).toBe(input); expect(secondary.parentElement).toBe(parent)
      expect(primary.dataset.workbenchPrimaryReference).toBe(occurrence); expect(floating.contains(secondary)).toBe(true)
      expect(selection.anchorNode).toBe(caret.node); expect(selection.anchorOffset).toBe(caret.offset)
      expect(input.textContent).toBe('Primary unsent draft'); expect(useAppStore.getState().agentComposerDrafts[mote.id]).toBe('Primary unsent draft')
      expect(events).toEqual([]); expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
    }
    try {
      await act(async () => {
        pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5,
          requestId: crypto.randomUUID(), operation: 'focus', target: { kind: 'space', regionId: 'target-region' }, inputPolicy: 'target' }))
        await Promise.resolve()
      })
      await settle()
      expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('target')
      expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe('target-region')
      expect(useAppStore.getState().regionCaretFocus?.regionId).toBe('target-region')
      facts('pending')
      originalInputIsKept()
      if (outcome === 'transferred') { targetRegion.removeAttribute('inert'); await settle() }
      let result!: AgentMuxControlResult
      await act(async () => { result = await pending! })
      await settle()
      expect(useAppStore.getState().regionCaretFocus).toBeNull()
      if (result.operation !== 'focus') throw new Error('Wrong exact input operation')
      expect(result.input.outcome).toBe(outcome)
      if (outcome === 'unavailable') {
        expect(result.partial).toBe(true); originalInputIsKept()
        // Clearing a failed nonce leaves the explicit typed selection intact.
        // Later original facts must not move the healthy input host either.
        await act(async () => useAppStore.setState({ sessions: [...useAppStore.getState().sessions] })); await settle()
        originalInputIsKept()
        const preserved = await control({ kind: 'goal', goalId: 'exact' })
        expect(preserved.input).toMatchObject({ policy: 'preserve', outcome: 'preserved', after: { sessionId: mote.id, regionId: 'primary-input-region' } })
        originalInputIsKept()
      } else {
        expect(document.activeElement).toBe(targetInput)
        expect(result.input.after).toMatchObject({ ownerKind: 'terminal', tabId: 'target-tab', regionId: 'target-region', sessionId: target.id })
        expect(events).toEqual(['focusout']); expect(focus).not.toHaveBeenCalled()
        expect(input.textContent).toBe('Primary unsent draft'); expect(useAppStore.getState().agentComposerDrafts[mote.id]).toBe('Primary unsent draft')
      }
      for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
    } finally {
      if (pending) await act(async () => { await pending })
      facts('after-cleanup')
      if (!wasInert) targetRegion.removeAttribute('inert')
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组' }))
      document.removeEventListener('focusin', onFocus); document.removeEventListener('focusout', onFocus)
    }
  })
  it('retains the exact primary Activity input host while Space receives a secondary presentation, without compensating focus', async () => {
    const { mote, tab, floating, input } = await arrangePrimaryInputMote()
    // Exercise the physical owner directly. The public receipt parser and the
    // projection reader have separate owning coverage and the original Native gate.
    const physicalControl = async (inputPolicy: 'preserve' | 'target' = 'preserve') => {
      let pending!: Promise<AgentMuxControlResult>
      await act(async () => { pending = useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5,
        requestId: crypto.randomUUID(), operation: 'focus', target: { kind: 'space', regionId: 'primary-input-region' }, inputPolicy })); await Promise.resolve() })
      const result = await pending; await settle()
      if (result.operation !== 'focus') throw new Error('Unexpected physical owner operation')
      return result
    }
    expect(input).not.toBeNull(); expect(input.textContent).toBe('Primary unsent draft')
    input.focus()
    const primary = input.closest<HTMLElement>('[data-workbench-primary-tab-id]')!
    expect(primary?.dataset.workbenchPrimaryTabId).toBe(tab.id)
    const parent = primary.parentElement, occurrence = primary.dataset.workbenchPrimaryReference
    const selection = document.getSelection()!, range = document.createRange()
    range.setStart(input.firstChild!.firstChild!, 3); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
    const caret = { node: selection.anchorNode, offset: selection.anchorOffset }
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    const events: string[] = []
    const onFocus = (event: Event) => { if (event.target === input) events.push(event.type) }
    document.addEventListener('focusin', onFocus); document.addEventListener('focusout', onFocus)
    const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
    const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop'), vi.spyOn(api.sessions, 'submitPrompt')]
    try {
      const result = await physicalControl()
      expect(result.input, JSON.stringify(result.input)).toMatchObject({ policy: 'preserve', outcome: 'preserved', after: { scope: 'floating', ownerKind: 'composer', sessionId: mote.id } })
      expect(document.activeElement).toBe(input); expect(primary.parentElement).toBe(parent)
      expect(primary.dataset.workbenchPrimaryReference).toBe(occurrence)
      expect(floating.contains(primary)).toBe(true)
      expect(selection.anchorNode).toBe(caret.node); expect(selection.anchorOffset).toBe(caret.offset)
      expect(events).toEqual([]); expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
      expect(input.textContent).toBe('Primary unsent draft')
      const homeInput = [...document.querySelectorAll<HTMLElement>('[data-workbench-region-id="primary-input-region"] [role="textbox"]')]
        .find(editor => !floating.contains(editor))!
      expect(homeInput).toBeTruthy(); expect(homeInput.textContent).toBe('Primary unsent draft')
      expect(homeInput.closest('[data-agent-surface-mode="activity"]')).toBeTruthy()
      expect(homeInput.closest('[data-workbench-primary-tab-id]')).toBeNull()
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组' }))
      // Explicit input reaches the exact Space occurrence. The current unique external
      // Activity policy can keep the primary in Mote while Space consumes a secondary.
      focus.mockRestore(); blur.mockRestore()
      const transferred = await physicalControl('target')
      process.stdout.write('explicit-primary-transfer-facts ' + JSON.stringify({ input: transferred.input, primaryInMote: floating.contains(primary), actualSameSpaceInput: document.activeElement === homeInput, actualSameMoteInput: document.activeElement === input, primaryReference: primary.dataset.workbenchPrimaryReference }) + '\n')
      expect(transferred.input).toMatchObject({ policy: 'target', outcome: 'transferred',
        after: { scope: 'floating', ownerKind: 'composer', tabId: tab.id, regionId: 'primary-input-region', sessionId: mote.id } })
      expect(transferred.presentation.state).toBe('floating'); expect(transferred.partial).toBe(true)
      expect(document.activeElement).toBe(input); expect(homeInput.isConnected).toBe(true)
      expect(homeInput.textContent).toBe('Primary unsent draft')
      expect(floating.contains(primary)).toBe(true)
      expect([...document.querySelectorAll<HTMLElement>('[data-workbench-primary-tab-id]')]
        .filter(node => node.dataset.workbenchPrimaryTabId === tab.id)).toEqual([primary])
      expect(homeInput.closest('[data-workbench-primary-tab-id]')).toBeNull()
      const secondary = homeInput.closest<HTMLElement>('[data-workbench-view-reference]')!
      const spaceParent = secondary.parentElement
      homeInput.focus()
      const secondarySelection = document.getSelection()!, secondaryRange = document.createRange()
      secondaryRange.setStart(homeInput.firstChild!.firstChild!, 4); secondaryRange.collapse(true)
      secondarySelection.removeAllRanges(); secondarySelection.addRange(secondaryRange)
      const secondaryCaret = { node: secondarySelection.anchorNode, offset: secondarySelection.anchorOffset }
      const secondaryFocus = vi.spyOn(homeInput, 'focus'), secondaryBlur = vi.spyOn(homeInput, 'blur')
      const preservedSecondary = await physicalControl()
      expect(preservedSecondary.input).toMatchObject({ policy: 'preserve', outcome: 'preserved',
        after: { scope: 'main', tabId: tab.id, regionId: 'primary-input-region', sessionId: mote.id } })
      expect(document.activeElement).toBe(homeInput); expect(secondary.parentElement).toBe(spaceParent)
      expect(secondarySelection.anchorNode).toBe(secondaryCaret.node); expect(secondarySelection.anchorOffset).toBe(secondaryCaret.offset)
      expect(homeInput.textContent).toBe('Primary unsent draft')
      expect(secondaryFocus).not.toHaveBeenCalled(); expect(secondaryBlur).not.toHaveBeenCalled()
      expect(homeInput.closest('[data-workbench-primary-tab-id]')).toBeNull()
      expect(floating.contains(primary)).toBe(true)
      // Closing the original presentation returns its unique primary normally;
      // durable draft/Session identity never depends on the secondary DOM.
      const close = floating.querySelector<HTMLButtonElement>('[aria-label="Close Mote"]')!
      await act(async () => close.click()); await settle()
      expect(primary.isConnected).toBe(true); expect(primary.parentElement).toBe(spaceParent)
      expect(useAppStore.getState().agentComposerDrafts[mote.id]).toBe('Primary unsent draft')
      for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('focusin', onFocus); document.removeEventListener('focusout', onFocus)
    }
  })
  it('keeps the original borrowed Mote Composer, draft and composition through Space/Goal/Surface navigation', async () => {
    const mote = { ...agent('mote-agent', 'scratch'), workspacePath: _hygiene_fixturePath("scratch/topic--launcher--leader") }
    const tab = { ...createWorkbenchTab('mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: 'mote-region', sessionId: mote.id }), topicId: PMO_TEAMS_TOPIC_ID }
    const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Private Mote', summary: '', collaborators: [],
      directoryPath: mote.workspacePath, topicPath: `${mote.workspacePath}/topic.md`,
      soul: { path: `${mote.workspacePath}/SOUL.md`, content: '# Private identity', version: 'v1' } }
    const emptyTopic = { id: 'view:empty-topic', title: 'Private empty Topic', summary: '', collaborators: [],
      directoryPath: _hygiene_fixturePath("scratch/topic--view--empty-topic"), topicPath: _hygiene_fixturePath("scratch/topic--view--empty-topic/topic.md") }
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, emptyTopic]); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
    await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' }] },
      sessions: [...state.sessions, mote], tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [tab.id]) },
      viewModes: { ...state.viewModes, [mote.id]: 'activity' }, agentComposerDrafts: { ...state.agentComposerDrafts, [mote.id]: 'Original Mote draft' } })))
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: tab.id })); await settle()
    const editor = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-region-id="mote-region"] [role="textbox"]')
    expect(editor).toBeTruthy(); expect(editor!.textContent).toBe('Original Mote draft')
    editor!.focus(); editor!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    const originalNode = editor, draft = useAppStore.getState().agentComposerDrafts[mote.id]
    const originalPrimary = originalNode!.closest<HTMLElement>('[data-workbench-primary-tab-id]')!
    const originalHost = originalPrimary.parentElement, originalReference = originalPrimary.dataset.workbenchPrimaryReference
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop'), send = vi.spyOn(api.sessions, 'submitPrompt')
    for (const target of [{ kind: 'space', regionId: 'target-region' }, { kind: 'goal', goalId: 'exact' },
      { kind: 'surface', surface: 'survey' }, { kind: 'surface', surface: 'focus' }] as const) {
      const result = await control(target)
      expect(result.input).toMatchObject({ outcome: 'preserved', after: { scope: 'floating', ownerKind: 'composer', sessionId: mote.id } })
      expect(result.floating).toMatchObject({ state: 'pinned', tabId: tab.id, regionId: 'mote-region', sessionId: mote.id, presentation: 'visible' })
      expect(document.activeElement).toBe(originalNode); expect(editor!.textContent).toBe('Original Mote draft')
    }
    const borrowed = await control({ kind: 'space', regionId: 'mote-region' })
    expect(borrowed.presentation.state).toBe('floating'); expect(borrowed.partial).toBe(true)
    expect(originalPrimary.querySelectorAll('[data-workbench-region-id="mote-region"]')).toHaveLength(1)
    expect(originalPrimary.parentElement).toBe(originalHost)
    expect(originalPrimary.dataset.workbenchPrimaryReference).toBe(originalReference)
    expect(originalPrimary.closest('[data-pmo-teams-topic-floating]')).toBeTruthy()
    expect(useAppStore.getState().agentComposerDrafts[mote.id]).toBe(draft)
    const home = document.getElementById(workbenchProjectionSlotId('workbench-tab-slot', { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: tab.id }))
    expect(home).toBeTruthy()
    const notice = home!.querySelector('[data-workbench-borrowed-view-notice] .service-window')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('Selected View is in Mote')
    expect(notice!.textContent).toContain('This Tab is selected here. Its original View remains in the floating window.')
    expect(notice!.textContent).toContain('Close Mote to return this View to Space.')
    expect(notice!.querySelector('button, input, textarea, [contenteditable]')).toBeNull()
    const secondary = home!.querySelector<HTMLElement>('[data-workbench-region-id="mote-region"] [role="textbox"]')
    expect(secondary).toBeTruthy()
    expect(secondary!.closest('[data-workbench-primary-tab-id]')).toBeNull()
    expect(secondary!.textContent).toBe('Original Mote draft')
    expect(home!.closest('[inert]')).toBeNull()
    expect(document.activeElement).toBe(originalNode)
    await control({ kind: 'space', regionId: 'mote-region' })
    expect(home!.querySelector('[data-workbench-borrowed-view-notice] .service-window')).toBe(notice)
    expect(document.activeElement).toBe(originalNode)
    const empty = await control({ kind: 'space', spaceId: directoryIdentity('local', emptyTopic.directoryPath) })
    const address = empty.navigation.selection.space, state = useAppStore.getState()
    expect(address).toMatchObject({ workspaceId: SCRATCH_WORKSPACE_ID, topicId: emptyTopic.id, tabId: null, regionId: null })
    const prewarm = vi.spyOn(useAppStore.getState(), 'prewarmTerminal'), detect = vi.spyOn(api.executors, 'detect')
    await act(async () => editor!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))); await settle()
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(address)
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBe('preserve')
    expect(useAppStore.getState().tabs).toBe(state.tabs); expect(useAppStore.getState().layouts).toBe(state.layouts)
    expect(useAppStore.getState().agentFocus.pmo.sessionId).toBe(mote.id)
    expect(document.activeElement).toBe(originalNode); expect(editor!.textContent).toBe('Original Mote draft')
    const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'mote-pointer-observe', operation: 'inspect.client' })
    if (inspected.operation !== 'inspect.client') throw new Error('Wrong operation')
    expect(desktopWorkbenchObservationSchema.parse(inspected.observation).desktop.selection.space).toEqual(address)
    expect(prewarm).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled()
    editor!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组' }))
    await control({ kind: 'space', regionId: 'mote-region' })
    const close = document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-floating] [aria-label="Close Mote"]')
    expect(close).toBeTruthy()
    await act(async () => close!.click()); await settle()
    expect(home!.querySelector('[data-workbench-borrowed-view-notice]')).toBeNull()
    expect(home!.querySelector('[data-workbench-region-id="mote-region"] [role="textbox"]')).toBe(originalNode)
    expect(document.querySelectorAll('[data-workbench-region-id="mote-region"]')).toHaveLength(1)
    expect(originalNode!.textContent).toBe('Original Mote draft')
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })
  it.each(['none', 'other-tab', 'same-tab'] as const)('selects the exact Region inside a borrowed split Mote without changing the main address or native input (retained=%s)', async (heldSource) => {
    const left = { ...agent('mote-left-agent', 'scratch'), workspacePath: _hygiene_fixturePath("scratch/topic--launcher--leader") }
    const right = { ...agent('mote-right-agent', 'scratch'), workspacePath: left.workspacePath }
    let split = addWorkbenchRegion(createWorkbenchTab('mote-split-tab', { kind: 'agent', phase: 'attached',
      workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'mote-left-region', sessionId: left.id }), 'mote-left-region', 'right',
      { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'mote-right-region', sessionId: right.id })
    if (heldSource === 'same-tab') split = addWorkbenchRegion(split, 'mote-right-region', 'left',
      { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'mote-peer-region', sessionId: left.id })
    const tab = { ...split, layout: { ...split.layout, activeRegionId: 'mote-left-region' }, topicId: PMO_TEAMS_TOPIC_ID }
    const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Private split Mote', summary: '', collaborators: [], directoryPath: left.workspacePath,
      topicPath: `${left.workspacePath}/topic.md`, soul: { path: `${left.workspacePath}/SOUL.md`, content: '# Private identity', version: 'v1' } }
    const empty = { id: 'view:empty-topic', title: 'Private empty Topic', summary: '', collaborators: [],
      directoryPath: _hygiene_fixturePath("scratch/topic--view--empty-topic"), topicPath: _hygiene_fixturePath("scratch/topic--view--empty-topic/topic.md") }
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, empty]); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
    await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' }] },
      sessions: [...state.sessions, left, right], tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-split-group', [tab.id]) },
      viewModes: { ...state.viewModes, [left.id]: 'activity', [right.id]: 'activity' },
      agentComposerDrafts: { ...state.agentComposerDrafts, [left.id]: 'Left original draft', [right.id]: 'Right original draft' } })))
    await act(async () => useAppStore.getState().selectWorkspace(SCRATCH_WORKSPACE_ID)); await settle()
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: tab.id })); await settle()
    await showSecondActivityPresentation(tab.id, 'mote-split-group', 'mote-left-region')
    process.stdout.write('split-second-external-setup ' + JSON.stringify({ heldSource, mainSurface: useAppStore.getState().mainSurface, survey: useAppStore.getState().surveyZoneSelection, modes: useAppStore.getState().viewModes, surveyText: document.querySelector('.global-survey-surface')?.textContent, surveySlots: [...document.querySelectorAll<HTMLElement>('.global-survey-surface [data-workbench-tab-id]')].map(slot => ({tabId: slot.dataset.workbenchTabId, id: slot.id, group: slot.dataset.workbenchGroupId, regions: [...slot.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].map(region => region.dataset.workbenchRegionId)})), primaries: [...document.querySelectorAll<HTMLElement>('[data-workbench-primary-tab-id]')].filter(one => one.dataset.workbenchPrimaryTabId === tab.id).map(one => ({parent:one.parentElement?.id,reference:one.dataset.workbenchPrimaryReference})) }) + '\n')
    const originalEditors = [...document.querySelectorAll<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-region-id] [role="textbox"]')]
    expect(originalEditors).toHaveLength(heldSource === 'same-tab' ? 3 : 2)
    const originalRight = originalEditors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === 'mote-right-region')!
    const originalView = originalRight.closest<HTMLElement>('.retained-workbench-view')!, originalParent = originalView.parentElement
    const placementFacts = (phase: string) => {
      const state = useAppStore.getState(), currentTab = state.tabs[tab.id]!, held = readPmoTeamsTopicFloatingState()!
      const catalog = spatialCatalog(state, [topic, empty]), activeReference = held.reference && { ...held.reference, regionId: currentTab.layout.activeRegionId }
      const projected = moteWorkbenchProjection(catalog, currentTab, held, () => {}, state.layouts)
      process.stdout.write('split-mote-placement-facts ' + JSON.stringify({ phase, heldSource,
      targetTabId: held.targetTabId, targetTopicId: held.targetTopicId, actualTabTopicId: currentTab.topicId,
      currentActiveRegionId: currentTab.layout.activeRegionId, tabEntities: catalog.tabs.filter(entity => entity.tabId === tab.id),
      activeReference, activeParentMatches: Boolean(activeReference && workbenchDisplayReferenceMatches(state.layouts[activeReference.displayWorkspaceId], activeReference)),
      exactActiveLocations: catalog.locations.filter(location => activeReference && location.displayWorkspaceId === activeReference.displayWorkspaceId &&
        location.groupId === activeReference.groupId && location.tabId === activeReference.tabId && location.regionId === activeReference.regionId),
      projectionEntity: projected.projection?.entity ?? null, projectionIssue: projected.issue,
      held: readPmoTeamsTopicFloatingState()?.reference, regions: Object.keys(useAppStore.getState().tabs[tab.id]!.regions),
      originalRightConnected: originalRight.isConnected, originalViewConnected: originalView.isConnected,
      originalViewParent: originalView.parentElement?.id, originalParentUnchanged: originalView.parentElement === originalParent,
      viewReference: originalView.dataset.workbenchViewReference, primaryReference: originalView.dataset.workbenchPrimaryReference,
      actualRightCount: document.querySelectorAll('[data-pmo-teams-topic-floating] [data-workbench-region-id="mote-right-region"] [role="textbox"]').length,
      floatingSlots: [...document.querySelectorAll<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-tab-id]')].map(slot => ({ id: slot.id,
        tabId: slot.dataset.workbenchTabId, regions: [...slot.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].map(region => region.dataset.workbenchRegionId) })),
      primaries: [...document.querySelectorAll<HTMLElement>('[data-workbench-primary-tab-id]')].filter(host => host.dataset.workbenchPrimaryTabId === tab.id)
        .map(host => ({ parent: host.parentElement?.id, reference: host.dataset.workbenchPrimaryReference,
          regions: [...host.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].map(region => region.dataset.workbenchRegionId) }))
    }) + '\n')
    }
    placementFacts('before-control')
    originalEditors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === 'mote-left-region')!.focus()
    const heldRegionId = heldSource === 'same-tab' ? 'mote-left-region' : 'target-region'
    await control(heldSource === 'none' ? { kind: 'space', spaceId: directoryIdentity('local', empty.directoryPath) }
      : { kind: 'space', regionId: heldRegionId })
    placementFacts('after-control')
    if (heldSource === 'same-tab') {
      // The real second presentation stays visible through the original public Surface owner.
      // This preserves the already-selected Space address while the unrelated Region moves.
      await control({ kind: 'surface', surface: 'survey' })
    }
    if (heldSource !== 'none') {
      let moved!: AgentMuxControlResult
      await act(async () => { moved = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({
        schemaVersion: 5, requestId: 'mote-retained-public-move', operation: 'space.mv',
        fromRegionId: heldRegionId, expectedAgentSessionId: heldSource === 'same-tab' ? left.id : target.id,
        destination: { zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("empty")), 'empty') }, focus: false })) })
      await settle(); expect(moved.operation).toBe('space.mv')
      if (moved.operation !== 'space.mv') throw new Error('Wrong operation')
      expect(moved.outcome).toBe('moved')
      placementFacts('after-move')
    }
    const leftRegionId = heldSource === 'same-tab' ? 'mote-peer-region' : 'mote-left-region'
    const editors = [...document.querySelectorAll<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-region-id] [role="textbox"]')]
    expect(editors).toHaveLength(2)
    const leftEditor = editors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === leftRegionId)!
    const rightEditor = editors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === 'mote-right-region')!
    expect(leftEditor).toBeTruthy(); expect(rightEditor).toBeTruthy(); leftEditor.focus()
    const rightView = rightEditor.closest<HTMLElement>('.retained-workbench-view')!, rightParent = rightView.parentElement
    expect(rightView.dataset.workbenchPrimaryTabId).toBeUndefined()
    expect(rightParent?.id).toBe(workbenchProjectionSlotId('mote-floating-tab-slot', {
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-split-group', tabId: tab.id }))
    const before = useAppStore.getState(), address = before.workbenchSpaceSelection
    expect(address).toMatchObject(heldSource === 'same-tab' ? { workspaceId: SCRATCH_WORKSPACE_ID, tabId: tab.id, regionId: null }
      : heldSource === 'other-tab' ? { workspaceId: 'target', tabId: null, regionId: null }
      : { topicId: empty.id, tabId: null, regionId: null })
    if (heldSource !== 'none') expect(before.retainedSpatialFocus).toMatchObject({
      tabId: heldSource === 'same-tab' ? tab.id : 'target-tab', regionId: heldRegionId })
    else expect(before.retainedSpatialFocus).toBeNull()
    expect(before.tabs[tab.id]?.layout.activeRegionId).toBe(leftRegionId)
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    const prewarm = vi.spyOn(before, 'prewarmTerminal'), detect = vi.spyOn(api.executors, 'detect')
    const localFocus = vi.spyOn(before, 'focusRegion')
    const pointerFacts = (phase: string) => {
      const current = useAppStore.getState()
      const host = rightEditor.closest<HTMLElement>('.retained-workbench-view')
      process.stdout.write('split-mote-pointer-facts ' + JSON.stringify({ phase, heldSource,
        floating: readPmoTeamsTopicFloatingState(), activeRegionId: current.tabs[tab.id]?.layout.activeRegionId,
        pmo: current.agentFocus.pmo, sourceSelection: current.workbenchSpaceSelection, retained: current.retainedSpatialFocus,
        localFocusCalls: localFocus.mock.calls, exactRightInputConnected: rightEditor.isConnected,
        exactRightActive: document.activeElement === rightEditor, hostParentId: host?.parentElement?.id,
        exactViewUnchanged: host === rightView, exactParentUnchanged: host?.parentElement === rightParent,
        nativeReference: rightEditor.closest('[data-workbench-region-reference]')?.getAttribute('data-workbench-region-reference'),
        viewReference: rightEditor.closest('[data-workbench-view-reference]')?.getAttribute('data-workbench-view-reference'),
        primaryReference: rightEditor.closest('[data-workbench-primary-reference]')?.getAttribute('data-workbench-primary-reference'),
        rawReferences: spatialCatalog(current, [topic, empty]).locations.filter(location => location.tabId === tab.id)
      }) + '\n')
    }
    pointerFacts('before')
    await act(async () => {
      rightEditor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      rightEditor.focus() // Only the native pointer default action is a happy-dom leaf.
    }); await settle()
    const current = useAppStore.getState()
    pointerFacts('after')
    placementFacts('after-pointer')
    expect(current.workbenchSpaceSelection).toEqual(address); expect(current.workbenchNavigationInputPolicy).toBe('preserve')
    expect(current.activeWorkspaceId).toBe(before.activeWorkspaceId); expect(current.mainSurface).toBe(before.mainSurface)
    // Core spatial ACK may hydrate equal objects; all Group/Tab IDs, selection and geometry stay exact.
    expect(current.layouts).toStrictEqual(before.layouts); expect(current.retainedSpatialFocus).toBe(before.retainedSpatialFocus)
    expect(current.tabs[tab.id]?.layout.activeRegionId).toBe('mote-right-region')
    expect(current.agentFocus.pmo.sessionId).toBe(right.id); expect(current.regionCaretFocus).toBeNull()
    const inspected = await current.executeControl({ schemaVersion: 5, requestId: 'mote-split-observe', operation: 'inspect.client' })
    if (inspected.operation !== 'inspect.client') throw new Error('Wrong operation')
    expect(desktopWorkbenchObservationSchema.parse(inspected.observation).desktop).toMatchObject({ selection: { space: address },
      floating: { tabId: tab.id, regionId: 'mote-right-region', sessionId: right.id }, input: { regionId: 'mote-right-region', sessionId: right.id } })
    expect(rightEditor.closest('[data-workbench-region-id]')?.classList.contains('workbench-region--active')).toBe(true)
    expect(leftEditor.closest('[data-workbench-region-id]')?.classList.contains('workbench-region--active')).toBe(false)
    expect(document.activeElement).toBe(rightEditor); expect(leftEditor.isConnected).toBe(true); expect(rightEditor.isConnected).toBe(true)
    expect(rightEditor.closest('.retained-workbench-view')).toBe(rightView); expect(rightView.parentElement).toBe(rightParent)
    expect(rightView.dataset.workbenchPrimaryTabId).toBeUndefined()
    expect(rightView.dataset.workbenchViewReference).toBe(workbenchRegionProjectionSlotId('view', {
      displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-split-group', tabId: tab.id, regionId: 'mote-right-region' }))
    expect([leftEditor.textContent, rightEditor.textContent]).toEqual(['Left original draft', 'Right original draft'])
    expect(current.sessions).toBe(before.sessions); expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(prewarm).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled()
  })
  it.each(['bad-parent', 'ambiguous-location', 'existing-region-unobserved'] as const)('does not replace a retained Region with the current Tab selection when %s', async kind => {
    const { tab, input } = await arrangePrimaryInputMote(true)
    input.focus(); await control({ kind: 'space', regionId: 'primary-input-region' })
    const before = useAppStore.getState(), floating = readPmoTeamsTopicFloatingState()!
    const original = floating.reference!
    expect(original).toEqual({ displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'primary-input-group', tabId: tab.id, regionId: 'primary-input-region' })
    const currentTab = kind === 'existing-region-unobserved' ? focusWorkbenchTabRegion(tab, 'primary-input-right')
      : removeWorkbenchRegion(tab, 'primary-input-region')!
    const catalog = spatialCatalog({ ...before, tabs: { ...before.tabs, [tab.id]: currentTab } }, await api.scratch.listTopics(SCRATCH_WORKSPACE_ID))
    const current = { ...original, regionId: currentTab.layout.activeRegionId }
    const exact = catalog.locations.filter(location => location.displayWorkspaceId === current.displayWorkspaceId &&
      location.groupId === current.groupId && location.tabId === current.tabId && location.regionId === current.regionId)
    expect(exact).toHaveLength(1)
    const observed = kind === 'ambiguous-location' ? { ...catalog, locations: [...catalog.locations, exact[0]!] }
      : kind === 'existing-region-unobserved' ? { ...catalog, locations: catalog.locations.filter(location => location.regionId !== original.regionId) } : catalog
    const reference = kind === 'bad-parent' ? { ...original, groupId: 'unconfirmed-parent' } : original
    const result = moteWorkbenchProjection(observed, currentTab, { ...floating, reference }, () => {}, before.layouts)
    expect(result.projection).toBeNull(); expect(result.retainedTabId).toBe(tab.id); expect(result.issue).toBeTruthy()
    expect(readPmoTeamsTopicFloatingState()).toBe(floating); expect(floating.reference).toBe(original)
    expect(useAppStore.getState()).toBe(before)
  })
  it.each(['unknown-parent', 'bad-parent'] as const)('keeps original Mote input but does not route a local click through an %s', async kind => {
    const { mote, tab, floating } = await arrangePrimaryInputMote(true)
    const originalReference = readPmoTeamsTopicFloatingState()!.reference!
    const reference = kind === 'unknown-parent' ? null : { ...originalReference, groupId: 'missing-parent-group' }
    const stateHost = document.createElement('div'), stateRoot = createRoot(stateHost)
    let update!: ReturnType<typeof usePmoTeamsTopicFloatingState>[1]
    function OriginalFloatingStateOwner() { [, update] = usePmoTeamsTopicFloatingState(); return null }
    document.body.append(stateHost)
    await act(async () => stateRoot.render(createElement(OriginalFloatingStateOwner)))
    await act(async () => update({ reference }))
    await act(async () => stateRoot.unmount()); stateHost.remove(); await settle()
    const right = floating.querySelector<HTMLElement>('[data-workbench-region-id="primary-input-right"] [role="textbox"]')!
    expect(right).toBeTruthy(); expect(right.isConnected).toBe(true)
    const before = useAppStore.getState(), held = readPmoTeamsTopicFloatingState()
    const localFocus = vi.spyOn(before, 'focusRegion')
    const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'stop')]
    await act(async () => {
      right.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      right.focus() // Controlled native pointer default only.
    }); await settle()
    expect(localFocus).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[tab.id]?.layout.activeRegionId).toBe('primary-input-region')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(readPmoTeamsTopicFloatingState()).toBe(held); expect(held?.reference).toEqual(reference)
    expect(document.activeElement).toBe(right); expect(right.isConnected).toBe(true)
    expect(right.textContent).toBe('Primary unsent draft')
    expect(useAppStore.getState().agentComposerDrafts[mote.id]).toBe('Primary unsent draft')
    for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
  })
  it('observes the original surviving same-Zone projection after a confirmed user close while preserving the healthy Session', async () => {
    const sibling = { ...createWorkbenchTab('target-sibling-tab', { kind: 'agent', phase: 'attached', workspaceId: 'target',
      regionId: 'target-sibling-region', sessionId: target.id }), space: { spaceId: space, zoneId: zone } }
    await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [sibling.id]: sibling },
      layouts: { ...state.layouts, target: createWorkspaceLayout('target-group', [targetTab.id, sibling.id]) } })))
    await control({ kind: 'space', regionId: 'target-region' })
    const sessions = useAppStore.getState().sessions, stop = vi.spyOn(api.sessions, 'stop')
    await act(async () => { expect(await useAppStore.getState().closeTab('target', 'target-group', 'target-tab', { keepAgentSessions: true })).toBe(true) })
    await settle()
    expect(useAppStore.getState().tabs['target-tab']).toBeUndefined()
    expect(useAppStore.getState().layouts.target!.groups[0]!.activeTabId).toBe(sibling.id)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: space, zoneId: zone,
      workspaceId: 'target', tabId: sibling.id, regionId: 'target-sibling-region' })
    expect(useAppStore.getState().sessions).toBe(sessions); expect(stop).not.toHaveBeenCalled()
    const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'closed-observe', operation: 'inspect.client' })
    if (result.operation !== 'inspect.client') throw new Error('Wrong operation')
    expect(desktopWorkbenchObservationSchema.parse(result.observation).desktop.selection.space).toMatchObject({
      spaceId: space, zoneId: zone, tabId: sibling.id, regionId: 'target-sibling-region' })
  })
  it('retains the exact Topic parent and the peer workface after a confirmed close with no same-Topic successor', async () => {
    const topic = { id: 'view:chosen', title: 'Chosen', summary: '', collaborators: [],
      directoryPath: _hygiene_fixturePath("scratch/topic--view--chosen"), topicPath: _hygiene_fixturePath("scratch/topic--view--chosen/topic.md") }
    const peer = { ...topic, id: 'view:peer', title: 'Peer', directoryPath: _hygiene_fixturePath("scratch/topic--view--peer"), topicPath: _hygiene_fixturePath("scratch/topic--view--peer/topic.md") }
    const chosenTab = { ...createWorkbenchTab('chosen-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: 'chosen-region', sessionId: target.id }), topicId: topic.id }
    const peerTab = { ...createWorkbenchTab('peer-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: 'peer-region', sessionId: source.id }), topicId: peer.id }
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, peer])
    await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' }] },
      tabs: { ...state.tabs, [chosenTab.id]: chosenTab, [peerTab.id]: peerTab },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('topics-group', [chosenTab.id, peerTab.id]) } })))
    const selected = (await control({ kind: 'space', regionId: 'chosen-region' })).navigation.selection.space!
    // Core save hydration may add the exact original Zone descriptor. Closing a
    // peer must preserve that authoritative descriptor and the complete body.
    const originalPeer = useAppStore.getState().tabs[peerTab.id]!
    expect(originalPeer).toMatchObject(peerTab)
    const sessions = useAppStore.getState().sessions, stop = vi.spyOn(api.sessions, 'stop'), prewarm = vi.spyOn(useAppStore.getState(), 'prewarmTerminal')
    await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'topics-group', chosenTab.id, { keepAgentSessions: true })).toBe(true) })
    await settle()
    const parent = { ...selected, tabId: null, groupId: null, regionId: null }
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(parent)
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBeNull()
    expect(useAppStore.getState().tabs[peerTab.id]).toEqual(originalPeer)
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.tabOrder).toEqual([peerTab.id])
    const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'closed-topic-observe', operation: 'inspect.client' })
    if (result.operation !== 'inspect.client') throw new Error('Wrong operation')
    expect(desktopWorkbenchObservationSchema.parse(result.observation).desktop.selection.space).toEqual(parent)
    expect(useAppStore.getState().sessions).toBe(sessions); expect(stop).not.toHaveBeenCalled(); expect(prewarm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outside)
  })
  it('keeps exact durable projection/choice through unknown snapshots and does not replace it with another Agent', async () => {
    const selected = (await control({ kind: 'space', regionId: 'target-region' })).navigation.selection.space!
    const originalTabs = useAppStore.getState().tabs, originalLayouts = useAppStore.getState().layouts
    useAppStore.setState({ sessions: [] })
    expect(restoreWorkbenchSpaceSelection(selected)).toEqual(selected)
    const result = await control({ kind: 'space', regionId: 'target-region' })
    expect(result.navigation.state).toBe('unchanged')
    expect(result.navigation.selection.space).toEqual(selected)
    expect(useAppStore.getState().tabs).toEqual(originalTabs); expect(useAppStore.getState().layouts).toEqual(originalLayouts)
    const unknown = await control({ kind: 'space', zoneId: 'unknown-zone' })
    expect(unknown.navigation.state).toBe('rejected'); expect(useAppStore.getState().tabs).toEqual(originalTabs)
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(selected)
    // Confirm the two original durable owners; known Topic discovery may add its own Tabs.
    expect(Object.keys(useAppStore.getState().tabs[sourceTab.id]!.regions)).toEqual(['source-region'])
    expect(Object.keys(useAppStore.getState().tabs[targetTab.id]!.regions)).toEqual(['target-region'])
    expect(useAppStore.getState().tabs[targetTab.id]!.regions['target-region']).toEqual(targetTab.regions['target-region'])
    expect(useAppStore.getState().sessions).toEqual([])
  })
})

it('keeps both original Mote regions after human Focus navigation cancels a pending input', async () => {
  const { mote, tab, floating, input: initialInput } = await arrangePrimaryInputMote(true)
  initialInput.focus(); await control({ kind: 'space', regionId: 'primary-input-region' })
  await act(async () => useAppStore.getState().setViewMode(mote.id, 'terminal')); await settle()
  await control({ kind: 'space', regionId: 'primary-input-region' }, 'target')
  await act(async () => useAppStore.getState().setViewMode(mote.id, 'activity')); await settle()
  await showSecondActivityPresentation(tab.id)
  const read = (id: string) => {
    const region = floating.querySelector<HTMLElement>(`[data-workbench-region-id="${id}"]`)!
    const input = region.querySelector<HTMLElement>('[role="textbox"]')!
    return { id, region, input, host: input.closest<HTMLElement>('[data-workbench-view-reference]')!, value: input.textContent }
  }
  const left = read('primary-input-region'), right = read('primary-input-right')
  expect(left.host).toBe(right.host); expect(left.host.dataset.workbenchPrimaryTabId).toBeUndefined()
  left.input.focus()
  const primaries = [...document.querySelectorAll<HTMLElement>('[data-workbench-primary-tab-id]')].filter(node => node.dataset.workbenchPrimaryTabId === tab.id)
  expect(primaries).toHaveLength(1)
  const primary = primaries[0]!, primaryParent = primary.parentElement, secondaryParent = left.host.parentElement
  const beforeDrafts = useAppStore.getState().agentComposerDrafts
  const facts = (phase: string) => process.stdout.write('manual-mote-facts ' + JSON.stringify({ phase,
    policy: useAppStore.getState().workbenchNavigationInputPolicy, mainSurface: useAppStore.getState().mainSurface,
    nonce: useAppStore.getState().regionCaretFocus, draftSame: useAppStore.getState().agentComposerDrafts[mote.id] === beforeDrafts[mote.id],
    originalPrimary: { connected: primary.isConnected, parentId: primary.parentElement?.id, parentSame: primary.parentElement === primaryParent,
      marker: primary.dataset.workbenchPrimaryReference, inMote: floating.contains(primary) },
    regions: [left, right].map(one => { const current = read(one.id); return { id: one.id, sameRegion: current.region === one.region,
      sameInput: current.input === one.input, oldRegionConnected: one.region.isConnected, oldInputConnected: one.input.isConnected,
      oldValue: one.input.textContent, originalValue: one.value, currentValue: current.input.textContent,
      oldHostConnected: one.host.isConnected, oldHostParentId: one.host.parentElement?.id, oldHostParentSame: one.host.parentElement === secondaryParent,
      oldCommittedOccurrence: one.host.dataset.workbenchViewReference, currentCommittedOccurrence: current.host.dataset.workbenchViewReference,
      currentIsPrimary: current.host.dataset.workbenchPrimaryTabId === tab.id } }),
    actualInputTag: document.activeElement?.tagName, actualInputAria: document.activeElement?.getAttribute('aria-label') }) + '\n')
  const targetInput = document.querySelector<HTMLTextAreaElement>('[data-workbench-region-id="target-region"] .xterm-helper-textarea')!
  const targetRegion = targetInput.closest<HTMLElement>('[data-workbench-region-id]')!; targetRegion.setAttribute('inert','')
  const lifecycle=[vi.spyOn(api.sessions,'launchAgent'),vi.spyOn(api.sessions,'stop'),vi.spyOn(api.sessions,'submitPrompt')]
  let pending: Promise<AgentMuxControlResult> | undefined
  try {
    facts('before')
    await act(async () => { pending=useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion:5,requestId:crypto.randomUUID(),
      operation:'focus',target:{kind:'space',regionId:'target-region'},inputPolicy:'target' })); await Promise.resolve() }); await settle()
    expect(useAppStore.getState().regionCaretFocus?.regionId).toBe('target-region');facts('pending')
    const buttons=document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Primary surfaces"] button.surface-navigation__focus')
    expect(buttons).toHaveLength(1);expect(buttons[0]!.disabled).toBe(false)
    await act(async () => buttons[0]!.click());await settle()
    const search=document.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!;expect(search).toBeTruthy();search.focus()
    let result!:AgentMuxControlResult;await act(async()=>{result=await pending!});expect(result.operation).toBe('focus')
    if(result.operation!=='focus')throw Error('Wrong operation')
    expect(result.navigation.state).toBe('unconfirmed');expect(result.navigation.selection.surface).toBe('focus');expect(result.input.outcome).not.toBe('transferred')
    targetRegion.removeAttribute('inert');await settle()
    expect(document.activeElement).toBe(search);expect(search.isConnected).toBe(true);expect(useAppStore.getState().regionCaretFocus).toBeNull()
    expect(useAppStore.getState().workbenchNavigationInputPolicy).toBeNull();facts('after-human')
    for(const one of [left,right]) { const current=read(one.id);expect(current.region).toBe(one.region);expect(current.input).toBe(one.input)
      expect(one.region.isConnected).toBe(true);expect(one.input.isConnected).toBe(true);expect(current.input.textContent).toBe(one.value) }
    expect(useAppStore.getState().agentComposerDrafts).toEqual(beforeDrafts)
    for(const call of lifecycle)expect(call).not.toHaveBeenCalled()
    const beforeReturnParent = search.parentElement
    const observeFocusReturn = (phase: string) => ({ phase,
      capturedExists: Boolean(search), capturedWasFocusInput: search.matches('[aria-label="Search contexts"]'),
      currentSearchCount: document.querySelectorAll('[aria-label="Search contexts"]').length,
      capturedIsCurrentSearch: document.querySelector('[aria-label="Search contexts"]') === search,
      capturedConnected: search.isConnected, capturedParentSame: search.parentElement === beforeReturnParent,
      capturedParentClass: search.parentElement?.className,
      capturedHidden: Boolean(search.closest('[hidden], [aria-hidden="true"]')), capturedInert: Boolean(search.closest('[inert]')),
      activeSameCaptured: document.activeElement === search, activeTag: document.activeElement?.tagName,
      activeRegionId: document.activeElement?.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id'),
      activeEditable: document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable || document.activeElement.matches('input,textarea')),
      policy: useAppStore.getState().workbenchNavigationInputPolicy, mainSurface: useAppStore.getState().mainSurface,
      nonce: useAppStore.getState().regionCaretFocus })
    process.stdout.write('focus-return-facts ' + JSON.stringify(observeFocusReturn('before-return')) + '\n')
    const returnFocusEvents: string[] = []
    const observeEditableFocus = (event: Event) => { const element = event.target; if(element instanceof HTMLElement &&
      (element.isContentEditable || element.matches('input,textarea'))) returnFocusEvents.push(element.tagName) }
    document.addEventListener('focusin',observeEditableFocus)
    try {
      const returned = await control({ kind:'space', regionId:'target-region' })
      const afterReturn = observeFocusReturn('after-return')
      process.stdout.write('focus-return-facts ' + JSON.stringify({ ...afterReturn, returned, editableFocusIn:returnFocusEvents }) + '\n')
      expect(afterReturn.capturedExists).toBe(true);expect(afterReturn.capturedWasFocusInput).toBe(true)
      expect(afterReturn.currentSearchCount).toBe(0);expect(afterReturn.capturedIsCurrentSearch).toBe(false)
      expect(afterReturn.capturedConnected).toBe(false);expect(afterReturn.activeSameCaptured).toBe(false)
      expect(afterReturn.activeEditable).toBe(false);expect(afterReturn.nonce).toBeNull()
      expect(returned.navigation.state).toBe('applied');expect(returned.presentation.state).toBe('main-visible')
      expect(returned.input.policy).toBe('preserve');expect(returned.input.outcome).toBe('unavailable');expect(returned.partial).toBe(true)
      expect(returned.input.before).toEqual({provenance:'observed',scope:'main',ownerKind:'other',tabId:null,regionId:null,
        sessionId:null,connected:true,visible:true,inert:false})
      expect(returned.input.after).toEqual({provenance:'observed',scope:'none',ownerKind:null,tabId:null,regionId:null,
        sessionId:null,connected:null,visible:null,inert:null})
      expect(returnFocusEvents).toEqual([])
      expect(useAppStore.getState().agentComposerDrafts).toEqual(beforeDrafts)
      for(const call of lifecycle)expect(call).not.toHaveBeenCalled()
    } finally { document.removeEventListener('focusin',observeEditableFocus) }
  } finally { if(pending)await act(async()=>{await pending});targetRegion.removeAttribute('inert') }
})
