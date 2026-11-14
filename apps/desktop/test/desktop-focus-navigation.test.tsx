const { fixturePath: _reshape_fixturePath, fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { fixturePath as _hygiene_fixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { webcrypto } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '@agentmux/core'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxDesktopFocusResult, AgentMuxDesktopFocusTarget } from '@agentmux/core/control'
import type { AppConfig, SessionSnapshot, AgentMuxPreloadApi, DesktopControlRequest, DesktopControlCancellation, DesktopControlResponse } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { callPublicGoalControl } from '@agentmux/core'
import { publicGoalRecord } from '@agentmux/host/goal-projection'
import { goalLinkBuildPlugin, goalLinkOwnerFixture } from './helpers/goal-link-owner'
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, focusWorkbenchTabRegion, removeWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import { restoreWorkbenchSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { installNativePopover } from './fixtures/mote-workface'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback } from './helpers/collaboration-layout-loopback'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { workbenchDisplayReferenceMatches } from '../src/renderer/src/lib/workbench-resource-display'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import type { SettingsNavigationRequest } from '../src/renderer/src/components/SettingsNavigation'

const incomingAppFixture = vi.hoisted(() => ({
  open: undefined as undefined | ((section: 'hosts' | 'network-node', executorId?: string, field?: string, hostId?: string) => void),
  request: undefined as SettingsNavigationRequest | undefined
}))

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
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {} setVisible() {} observeViewport() {}
  async startLiveSynchronization() {} dispose() {}
} }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))
// Observe the real App provider and route props without replacing either owner or the rendered Panel.
vi.mock('../src/renderer/src/components/ProjectRail', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/ProjectRail')>()
  const { createElement, useContext } = await import('react')
  const { SettingsNavigation } = await import('../src/renderer/src/components/SettingsNavigation')
  return { ProjectRail: (props: Parameters<typeof actual.ProjectRail>[0]) => {
    incomingAppFixture.open = useContext(SettingsNavigation)?.open
    return createElement(actual.ProjectRail, props)
  } }
})
vi.mock('../src/renderer/src/components/SettingsPanel', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/SettingsPanel')>()
  const { createElement } = await import('react')
  return { ...actual, SettingsPanel: (props: Parameters<typeof actual.SettingsPanel>[0]) => {
    incomingAppFixture.request = props.navigationRequest
    return createElement(actual.SettingsPanel, props)
  } }
})

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
  executors: { fixture: { label: 'Fixture', providerId: 'codex', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'source', name: 'Source', hostId: 'local', path: _hygiene_fixturePath("source"), kind: 'folder' },
    { id: 'target', name: 'Target', hostId: 'local', path: _hygiene_fixturePath("target"), kind: 'folder' },
    { id: 'empty', name: 'Empty directory', hostId: 'local', path: _hygiene_fixturePath("empty"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const space = directoryIdentity('local', _hygiene_fixturePath("target")), zone = workspaceZoneId(space, 'target')
function agent(id: string, workspace: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex', workspacePath: _reshape_fixturePath(workspace), label: id,
    createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) },
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run:${id}` } } }
}
const source = agent('source-agent', 'source'), target = agent('target-agent', 'target')
const sourceTab = createWorkbenchTab('source-tab', { kind: 'agent', phase: 'attached', workspaceId: 'source', regionId: 'source-region', sessionId: source.id })
const targetTab = createWorkbenchTab('target-tab', { kind: 'agent', phase: 'attached', workspaceId: 'target', regionId: 'target-region', sessionId: target.id })
const goal = (id: string, sessionIds: string[] = []) => ({ id, title: id, description: '', status: 'in_progress' as const,
  priority: 'normal' as const, projectId: null, projectName: null, sessionIds, source: 'default-topic' as const, createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1) })
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
  it.each([false, true])('keeps the original focus receipt through its exact checkpoint ACK (held past the observer budget: %s)', async held => {
    const before = useAppStore.getState()
    const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'stop')]
    let deliverRequest!: (request: DesktopControlRequest) => void
    let deliverCancellation!: (cancellation: DesktopControlCancellation) => void
    const cancellations: DesktopControlCancellation[] = [], responses: DesktopControlResponse[] = [], ownerResults: AgentMuxControlResult[] = []
    let release!: () => void, entered!: () => void
    const checkpoint = new Promise<void>(resolve => { release = resolve })
    const checkpointEntered = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => { entered(); if (held) await checkpoint })
    const bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
      sendRequest: request => deliverRequest(request),
      sendCancellation: cancellation => { cancellations.push(cancellation); deliverCancellation(cancellation) } })
    const preload: AgentMuxPreloadApi['control'] = {
      onRequest: listener => { deliverRequest = listener; return () => {} },
      onCancellation: listener => { deliverCancellation = listener; return () => {} },
      respond: response => { responses.push(response); bridge.accept(response) }
    }
    let ownerFinished!: () => void
    const finished = new Promise<void>(resolve => { ownerFinished = resolve })
    const stop = createRendererControlApi(preload).onRequest(async (request, signal) => {
      try {
        const result = await useAppStore.getState().executeControl(request as AgentMuxControlRequest, signal)
        ownerResults.push(result); return result
      } finally { ownerFinished() }
    })
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: held ? 'held-original-focus' : 'normal-original-focus',
      operation: 'focus', target: { kind: 'space', regionId: 'target-region' }, inputPolicy: 'preserve' })
    let pending!: Promise<AgentMuxControlResult>
    let outcome: { value?: AgentMuxControlResult; error?: unknown }
    let readerSettled = false
    try {
      await act(async () => { pending = bridge.execute(request); await Promise.resolve() })
      const observed = pending.then(value => { readerSettled = true; return { value } }, error => { readerSettled = true; return { error } })
      await checkpointEntered
      expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: 'target-tab', regionId: 'target-region' })
      if (held) {
        // Release independently of the defect: a corrected reader must not need
        // its own timeout in order for this test to let the original ACK return.
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 2_100))
          expect(readerSettled).toBe(false); expect(cancellations).toEqual([])
          expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: 'target-tab', regionId: 'target-region' })
          expect(document.activeElement).toBe(outside); expect(useAppStore.getState().sessions).toBe(before.sessions)
          release(); await finished; await Promise.resolve()
        })
      }
      outcome = await observed
      expect(ownerResults).toHaveLength(1)
      expect(ownerResults[0]).toMatchObject({ operation: 'focus', navigation: { state: 'applied', selection: { space: { regionId: 'target-region' } } },
        input: { policy: 'preserve', outcome: 'preserved' }, save: { clientStateWritten: true, storageFlushRequested: true } })
      expect(useAppStore.getState().sessions).toBe(before.sessions)
      expect(useAppStore.getState().sessions.map(session => session.control.run)).toEqual(before.sessions.map(session => session.control.run))
      expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
      expect(document.activeElement).toBe(outside)
      expect([outside.value, outside.selectionStart, outside.selectionEnd]).toEqual(['Keep user input', 2, 5])
      for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
      console.info('FOCUS_ACK_SOURCE', JSON.stringify({ held, requestId: request.requestId,
        selection: useAppStore.getState().workbenchSpaceSelection, cancellations, responses,
        ownerResults, reader: outcome.error instanceof Error ? { name: outcome.error.name, message: outcome.error.message,
          code: (outcome.error as Error & { code?: string }).code } : outcome.value }))
      // The admitted navigation and exact save have finished at the original owner.
      // An observation deadline must not make this original reply disappear.
      expect({ cancellations, responses, outcome }).toMatchObject({ cancellations: [],
        responses: [{ requestId: request.requestId, ok: true }], outcome: { value: ownerResults[0] } })
    } finally { await act(async () => { release(); if (pending) await finished; await Promise.resolve() }); bridge.dispose(); stop() }
  })
  it('retains Focus List and Map owners, exact original workface and input across actual App navigation', async () => {
    installCollaborationCanvasGeometry(); installCollaborationLayoutLoopback()
    vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
    await control({ kind: 'space', regionId: 'source-region' })
    const original = useAppStore.getState(), originalLayouts = structuredClone(original.layouts)
    const originalChoice = structuredClone(original.workbenchSpaceSelection)
    const toolsPreference = original.toolsOpen
    await act(async () => useAppStore.getState().focusExecutionSession(null, undefined, { navigate: false }))
    const first = await control({ kind: 'surface', surface: 'focus', view: 'list' })
    expect(first.navigation.selection).toMatchObject({ surface: 'focus', focusView: 'list' })
    const list = container.querySelector<HTMLElement>('[data-desktop-focus-view="list"]')!
    expect(list.hidden).toBe(false)
    expect(list.querySelector('[data-surface-tools-toggle]')).toBeNull()
    expect(useAppStore.getState().toolsOpen).toBe(toolsPreference)
    const switcher = list.querySelector<HTMLElement>('[aria-label="Focus view"]')!
    expect([...switcher.querySelectorAll('button')].map(button => button.textContent)).toEqual(['List', 'Map'])
    expect(switcher.querySelector('[aria-label="List"]')?.getAttribute('aria-pressed')).toBe('true')
    const entered = await control({ kind: 'surface', surface: 'focus', view: 'map' })
    expect(entered.presentation).toMatchObject({ state: 'main-visible', tabId: null, regionId: null })
    const map = container.querySelector<HTMLElement>('[data-desktop-focus-view="map"]')!
    expect(map.hidden).toBe(false); expect(list.hidden).toBe(true)
    expect(map.querySelector('[data-surface-tools-toggle]')).toBeNull()
    expect(useAppStore.getState().toolsOpen).toBe(toolsPreference)
    const target = useAppStore.getState().collaborationMapTarget
    expect(target).not.toBeNull()
    await control({ kind: 'surface', surface: 'focus', view: 'list' })
    expect(map.hidden).toBe(true); expect(list.hidden).toBe(false)
    await control({ kind: 'surface', surface: 'focus', view: 'map' })
    expect(container.querySelector('[data-desktop-focus-view="map"]')).toBe(map)
    expect(useAppStore.getState().collaborationMapTarget).toBe(target)
    const spaceNavigation = container.querySelector<HTMLButtonElement>('footer [aria-label="Space: show terminal and file workbench"]')
    expect(spaceNavigation).not.toBeNull()
    expect(spaceNavigation!.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
    await act(async () => spaceNavigation!.click()); await settle()
    expect(map.hidden).toBe(true); expect(useAppStore.getState().focusView).toBe('map')
    expect(useAppStore.getState().mainSurface).toBe('workbench')
    expect(spaceNavigation!.getAttribute('aria-current')).toBe('page')
    expect(container.querySelector('[data-workspace-id="source"][data-visible="true"]')).not.toBeNull()
    const focusNavigation = container.querySelector<HTMLButtonElement>('footer [aria-label^="Focus: show execution contexts."]')
    expect(focusNavigation).not.toBeNull()
    await act(async () => focusNavigation!.click()); await settle()
    expect(map.hidden).toBe(false); expect(list.hidden).toBe(true)
    const current = useAppStore.getState()
    expect(current.tabs).toBe(original.tabs)
    expect(current.layouts).toEqual(originalLayouts)
    expect(current.workbenchSpaceSelection).toEqual(originalChoice)
    expect(current.agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(document.activeElement).toBe(outside)
    expect([outside.value, outside.selectionStart, outside.selectionEnd]).toEqual(['Keep user input', 2, 5])
    expect(container.querySelectorAll('[data-agent-reading-host]').length).toBeLessThanOrEqual(1)
    // A secondary Space action must replace a previous Focus intent with the current exact area.
    const unrelated = { kind: 'focus' as const, subject: { hostId: 'unrelated-host', agentSessionId: 'unrelated-agent' }, name: 'Other work' }
    await act(async () => useAppStore.getState().openCollaborationMap(unrelated))
    await control({ kind: 'surface', surface: 'space' })
    await act(async () => { useAppStore.getState().setWorkspaceTool('agents'); useAppStore.setState({ toolsOpen: true }) })
    await settle()
    const locate = container.querySelector<HTMLButtonElement>('.surface-tool-dock:not([hidden]) [aria-label="Locate Space in Focus map"]')
    expect(locate).not.toBeNull()
    await act(async () => locate!.click()); await settle()
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().focusView).toBe('map')
    expect(container.querySelector('[data-desktop-focus-view="map"]')).toBe(map)
    const located = useAppStore.getState().collaborationMapTarget
    expect(located).not.toBe(unrelated)
    expect(located).toMatchObject({ kind: 'focus', subject: { hostId: source.control.hostId, agentSessionId: source.control.agentSessionId } })
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(originalChoice)
    expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
    await control({ kind: 'space', zoneId: workspaceZoneId(directoryIdentity('local', _hygiene_fixturePath("empty")), 'empty') })
    const areaChoice = structuredClone(useAppStore.getState().workbenchSpaceSelection)
    expect(areaChoice).toMatchObject({ workspaceId: 'empty', tabId: null, regionId: null })
    const locateArea = container.querySelector<HTMLButtonElement>('.surface-tool-dock:not([hidden]) [aria-label="Locate Space in Focus map"]')
    expect(locateArea).not.toBeNull()
    await act(async () => locateArea!.click()); await settle()
    expect(useAppStore.getState().collaborationMapTarget).toMatchObject({ kind: 'space', workspaceId: 'empty', choice: areaChoice })
    expect(container.querySelector('[data-desktop-focus-view="map"]')).toBe(map)
  })

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
  it('opens an exact Goal and retains its independent selection on Goals reentry without PMO launch', async () => {
    const launch = vi.spyOn(api.sessions, 'launchAgent'), send = vi.spyOn(api.sessions, 'submitPrompt')
    const result = await control({ kind: 'goal', goalId: 'exact' })
    expect(result.navigation.selection).toMatchObject({ surface: 'goals', mainSurface: 'board', goalId: 'exact' })
    expect(container.querySelector('[data-goal-detail-id="exact"]')).not.toBeNull()
    expect(result.presentation.state).toBe('main-visible')
    for (const surface of ['space', 'focus', 'survey', 'goals'] as const) await control({ kind: 'surface', surface })
    expect(useAppStore.getState().selectedDemandId).toBe('exact')
    expect(launch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(document.activeElement).toBe(outside)
  })
  it('keeps original Work and execution history when the actual Goal row selects a uniquely linked other Agent', async () => {
    await control({ kind: 'space', regionId: 'source-region' })
    await act(async () => useAppStore.setState(state => ({ demands: { ...state.demands, exact: goal('exact', [target.id]) } })))
    await control({ kind: 'surface', surface: 'goals' })
    const original = useAppStore.getState(), select = vi.spyOn(original, 'selectMainRegion')
    const row = [...container.querySelectorAll<HTMLButtonElement>('.goals-row')]
      .find(button => button.querySelector('strong')?.textContent === 'exact')
    expect(row).toBeDefined()
    await act(async () => row!.click())
    expect(container.querySelector('[data-goal-detail-id="exact"]')).not.toBeNull()
    const after = useAppStore.getState()
    expect(after.selectedDemandId).toBe('exact')
    expect(after.workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
    expect(after.activeWorkspaceId).toBe(original.activeWorkspaceId)
    expect(after.agentFocus).toBe(original.agentFocus)
    expect(after.agentComposerDrafts).toBe(original.agentComposerDrafts)
    expect(select).not.toHaveBeenCalled()
  })
  it('executes public Goal focus through typed RPC and compiled CLI into the original App without selecting its linked Agent', async () => {
    await control({ kind: 'space', regionId: 'source-region' })
    await act(async () => useAppStore.setState(state => ({ demands: { ...state.demands, exact: goal('exact', [target.id]) } })))
    const original = useAppStore.getState(), select = vi.spyOn(original, 'selectMainRegion')
    const controls = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'stop')]
    const directory = await mkdtemp(join(tmpdir(), 'goal-focus-consumer-'))
    const cli = join(directory, 'amux.mjs')
    const require = createRequire(import.meta.url), core = dirname(require.resolve('../../../packages/core/package.json'))
    await symlink(join(core, 'node_modules'), join(directory, 'node_modules'), 'dir')
    await require(join(core, 'node_modules/esbuild')).build({ entryPoints: [join(core, 'src/agentmux.ts')],
      outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    const requests: string[] = []
    const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], async execute(request) {
      requests.push(request.operation)
      let pending!: Promise<AgentMuxControlResult>
      await act(async () => { pending = useAppStore.getState().executeControl(request); await Promise.resolve() })
      return await pending
    } })
    await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      const receipt = await client.call('goal.focus', { goalId: 'exact' })
      expect(receipt.navigation.selection).toMatchObject({ surface: 'goals', goalId: 'exact' })
      expect(receipt.presentation.state).toBe('main-visible')
      expect(container.querySelector('[data-goal-detail-id="exact"]')).not.toBeNull()
      await act(async () => useAppStore.getState().setSelectedDemand('first'))
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'goal', 'focus', '--goal', 'exact'], { env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('Original CLI request exceeded its bounded deadline.')) }, 10_000)
        child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
      })
      const output = JSON.parse(result.stdout)
      expect(result.stderr).toBe('')
      expect(output).toMatchObject({ ok: true, operation: 'goal.focus', result: { navigation: { selection: { surface: 'goals', goalId: 'exact' } } } })
      expect(result.code).toBe(output.result.partial ? 1 : 0)
      expect(useAppStore.getState().selectedDemandId).toBe('exact')
      expect(container.querySelector('[data-goal-detail-id="exact"]')).not.toBeNull()
      const absent = await client.call('goal.focus', { goalId: 'unavailable-goal' })
      expect(absent).toMatchObject({ partial: true, navigation: { state: 'rejected', selection: { goalId: 'exact' } }, issues: expect.arrayContaining([expect.objectContaining({ code: 'GOAL_UNKNOWN' })]) })
      const after = useAppStore.getState()
      expect(after.workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
      expect(after.activeWorkspaceId).toBe(original.activeWorkspaceId)
      expect(after.agentFocus).toBe(original.agentFocus)
      expect(after.agentComposerDrafts).toBe(original.agentComposerDrafts)
      expect(document.activeElement).toBe(outside)
      expect([outside.selectionStart, outside.selectionEnd]).toEqual([2, 5])
      expect(requests).toEqual(['focus', 'focus', 'focus'])
      expect(select).not.toHaveBeenCalled()
      for (const operation of controls) expect(operation).not.toHaveBeenCalled()
    } finally { await client.dispose(); await server.stop(); await rm(directory, { recursive: true }) }
  })
  it('rejects a late Goal navigation after the user has selected a later surface', async () => {
    let release!: (topics: []) => void
    vi.spyOn(api.scratch, 'listTopics').mockImplementationOnce(() => new Promise<[]>(resolve => { release = resolve })).mockResolvedValue([])
    let pending!: Promise<AgentMuxControlResult>
    await act(async () => {
      useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
        { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: _hygiene_fixturePath('scratch'), kind: 'folder' }] } })
      pending = useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'original-goal-navigation', operation: 'focus', target: { kind: 'goal', goalId: 'exact' }, inputPolicy: 'preserve' })
    })
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    const original = useAppStore.getState()
    release([])
    const result = await pending
    expect(result).toMatchObject({ operation: 'focus', partial: true, navigation: { state: 'rejected', selection: { surface: 'survey', goalId: 'first' } },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'NAVIGATION_CHANGED' })]) })
    expect(useAppStore.getState().agentFocus).toBe(original.agentFocus)
    expect(useAppStore.getState().selectedDemandId).toBe('first')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
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
      // Explicit input reaches the exact Space occurrence while both original
      // content presentations retain their hosts and drafts.
      focus.mockRestore(); blur.mockRestore()
      const transferred = await physicalControl('target')
      process.stdout.write('explicit-primary-transfer-facts ' + JSON.stringify({ input: transferred.input, primaryInMote: floating.contains(primary), actualSameSpaceInput: document.activeElement === homeInput, actualSameMoteInput: document.activeElement === input, primaryReference: primary.dataset.workbenchPrimaryReference }) + '\n')
      expect(transferred.input).toMatchObject({ policy: 'target', outcome: 'transferred',
        after: { scope: 'main', ownerKind: 'composer', tabId: tab.id, regionId: 'primary-input-region', sessionId: mote.id } })
      expect(transferred.presentation.state).toBe('main-visible'); expect(transferred.partial).toBe(false)
      expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true)
      expect(floating.contains(primary)).toBe(false)
      expect([...document.querySelectorAll<HTMLElement>('[data-workbench-primary-tab-id]')]
        .filter(node => node.dataset.workbenchPrimaryTabId === tab.id)).toEqual([primary])
      const spaceParent = primary.parentElement
      const currentSelection = document.getSelection()!, currentRange = document.createRange()
      currentRange.setStart(input.firstChild!.firstChild!, 4); currentRange.collapse(true)
      currentSelection.removeAllRanges(); currentSelection.addRange(currentRange)
      const currentCaret = { node: currentSelection.anchorNode, offset: currentSelection.anchorOffset }
      const currentFocus = vi.spyOn(input, 'focus'), currentBlur = vi.spyOn(input, 'blur')
      const preserved = await physicalControl()
      expect(preserved.input).toMatchObject({ policy: 'preserve', outcome: 'preserved',
        after: { scope: 'main', tabId: tab.id, regionId: 'primary-input-region', sessionId: mote.id } })
      expect(document.activeElement).toBe(input); expect(primary.parentElement).toBe(spaceParent)
      expect(currentSelection.anchorNode).toBe(currentCaret.node); expect(currentSelection.anchorOffset).toBe(currentCaret.offset)
      expect(input.textContent).toBe('Primary unsent draft')
      expect(currentFocus).not.toHaveBeenCalled(); expect(currentBlur).not.toHaveBeenCalled()
      // Closing Mote keeps the exact primary already handed to Space.
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
      const projected = moteWorkbenchProjection(catalog, state.tabs, held, () => {}, state.layouts)
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
    expect(current.tabs[tab.id]?.layout.activeRegionId).toBe(leftRegionId)
    expect(readPmoTeamsTopicFloatingState()?.reference?.regionId).toBe('mote-right-region')
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
  it.each(['bad-parent', 'conflicting-location', 'existing-region-unobserved'] as const)('does not replace a retained Region with the current Tab selection when %s', async kind => {
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
    const observed = kind === 'conflicting-location' ? { ...catalog, locations: [...catalog.locations, { ...exact[0]!, zoneId: 'unconfirmed-other-zone' }] }
      : kind === 'existing-region-unobserved' ? { ...catalog, locations: catalog.locations.filter(location => location.regionId !== original.regionId) } : catalog
    const reference = kind === 'bad-parent' ? { ...original, groupId: 'unconfirmed-parent' } : original
    const result = moteWorkbenchProjection(observed, { ...before.tabs, [currentTab.id]: currentTab }, { ...floating, reference }, () => {}, before.layouts)
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
      expect(afterReturn.currentSearchCount).toBe(1);expect(afterReturn.capturedIsCurrentSearch).toBe(true)
      expect(afterReturn.capturedConnected).toBe(true);expect(afterReturn.capturedParentSame).toBe(true)
      expect(afterReturn.capturedHidden).toBe(true);expect(afterReturn.capturedInert).toBe(true)
      if (afterReturn.activeEditable) expect(afterReturn.activeSameCaptured).toBe(true)
      expect(afterReturn.nonce).toBeNull()
      expect(returned.navigation.state).toBe('applied');expect(returned.presentation.state).toBe('main-visible')
      expect(returned.input.policy).toBe('preserve');expect(returned.input.outcome).toBe('unavailable');expect(returned.partial).toBe(true)
      expect(returned.input.before).toEqual({provenance:'observed',scope:'main',ownerKind:'other',tabId:null,regionId:null,
        sessionId:null,connected:true,visible:true,inert:false})
      expect(returned.input.after).toEqual({provenance:'observed',scope:'main',ownerKind:'other',tabId:null,regionId:null,
        sessionId:null,connected:true,visible:false,inert:true})
      expect(returnFocusEvents).toEqual([])
      expect(useAppStore.getState().agentComposerDrafts).toEqual(beforeDrafts)
      for(const call of lifecycle)expect(call).not.toHaveBeenCalled()
    } finally { document.removeEventListener('focusin',observeEditableFocus) }
  } finally { if(pending)await act(async()=>{await pending});targetRegion.removeAttribute('inert') }
})

describe('Settings semantic navigation', () => {
  it('normalizes canonical and legacy incoming through the real App provider without replacing invalid targets', async () => {
    const before = useAppStore.getState()
    await act(async () => useAppStore.setState({ config: { ...before.config!, hosts: [
      { id: 'remote-first', kind: 'ssh', label: 'Remote first', hostname: 'remote.invalid', runtimeId: 'remote-runtime' },
      { id: 'local', kind: 'local', label: 'This device' }
    ] } }))
    expect(incomingAppFixture.open).toBeTypeOf('function')
    for (const [section, hostId] of [['network-node', 'local'], ['hosts', undefined]] as const) {
      await act(async () => incomingAppFixture.open!(section, undefined, 'incoming', hostId))
      await settle()
      expect(incomingAppFixture.request).toMatchObject({ section: 'hosts', hostId: 'local', field: 'incoming' })
      expect((await readSettings()).overlays.settingsPage).toMatchObject({ sectionId: 'hosts', hostId: 'local', visible: true })
      const connections = container.querySelector<HTMLElement>('[data-settings-pane="hosts"] [data-mesh-view="connections"]')!
      expect(connections.hidden).toBe(false)
      const visible = [...connections.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')]
        .filter(target => target.isConnected && !target.closest('[hidden], [inert]'))
      expect(visible).toHaveLength(1)
      expect(document.activeElement).toBe(visible[0])
      expect(container.querySelector('[data-settings-target-issue]')).toBeNull()
    }
    await act(async () => incomingAppFixture.open!('network-node', undefined, 'incoming', 'remote-first'))
    await settle()
    expect(incomingAppFixture.request).toMatchObject({ section: 'network-node', hostId: 'remote-first', field: 'incoming' })
    expect((await readSettings()).overlays.settingsPage).toMatchObject({ sectionId: 'network-node', hostId: 'remote-first', visible: true })
    expect(container.querySelector('[data-settings-pane="network-node"] [data-settings-field="incoming"]')).toBeNull()
    expect(container.querySelector('[data-settings-pane="network-node"] [data-settings-target-issue]')).not.toBeNull()
    await act(async () => incomingAppFixture.open!('hosts', undefined, 'incoming', 'missing-host'))
    await settle()
    expect(incomingAppFixture.request).toMatchObject({ section: 'hosts', hostId: 'missing-host', field: 'incoming' })
    expect(container.querySelector('[data-settings-pane="hosts"] [data-settings-host="local"]')).toBeNull()
    expect(container.querySelector('[data-settings-pane="hosts"] [data-settings-target-issue]')).not.toBeNull()
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
    await control({ kind: 'settings', sectionId: null })
  })
  it('Host-qualified links select the actual Host resources and retain original work and drafts', async () => {
    await control({ kind: 'space', regionId: 'source-region' })
    const before = useAppStore.getState(), originalTabs = before.tabs
    await act(async () => useAppStore.setState({ config: { ...before.config!, hosts: [...before.config!.hosts,
      { id: 'second-host', kind: 'ssh', label: 'Other original Host', hostname: 'unprepared.invalid', user: 'fixture' }] } }))
    const result = await control({ kind: 'settings', sectionId: 'hosts', hostId: 'local' })
    expect(result.navigation.state).toBe('applied')
    expect(result.overlays.settingsPage).toMatchObject({ sectionId: 'hosts', visible: true, hostId: 'local' })
    const host = container.querySelector('[data-settings-host="local"]')!
    expect(host.querySelector('[data-host-view]')?.getAttribute('data-host-view')).toBe('overview')
    expect(host.querySelector<HTMLDetailsElement>('.remote-host-section')?.open).toBe(true)
    expect(useAppStore.getState().tabs).toBe(originalTabs)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
    const second = container.querySelector<HTMLButtonElement>('[data-host-disclosure="second-host"] [data-host-panel="overview"]')!
    expect(second).not.toBeNull()
    await act(async () => second.click())
    expect((await readSettings()).overlays.settingsPage).toMatchObject({ hostId: 'second-host' })
    await control({ kind: 'settings', sectionId: null })
  })
  it('CLI-qualified Node navigation selects the actual saved owner, and the local publishing link retains Node publication', async () => {
    const { parseAgentMuxCliInvocation } = await import('../../../packages/core/src/agentmux-cli-commands')
    const { rpcControlRequest } = await import('../../../packages/core/src/rpc-business-codec')
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts,
      { id: 'remote-node', kind: 'ssh', label: 'Remote Node', hostname: 'private.invalid', runtimeId: 'remote-node-runtime' }] } })))
    const node = (hostId: string) => ({ runtimeId: hostId === 'remote-node' ? 'remote-node-runtime' : 'local-node-runtime', ownerInstanceId: hostId + '-instance', alias: hostId === 'remote-node' ? 'remote-node' : 'local-node' })
    vi.spyOn(api.nodePublishing, 'call').mockImplementation(async (method, params) => method === 'node.inspect'
      ? { node: node(params.hostId), policyRevision: 'node-revision', resourcesShared: false, roots: [], landing: null } as never
      : { node: node(params.hostId), policyRevision: 'node-revision', status: 'withheld' } as never)
    vi.spyOn(api.nodePublishing, 'owner').mockImplementation(async (target, method) => method === 'settings.node.resources'
      ? { node: node(target.hostId), policyRevision: 'node-revision', status: 'unavailable', code: 'FIXTURE_NO_SAMPLE', message: 'Private fixture does not sample resources.' } as never
      : { node: node(target.hostId), policyRevision: 'node-revision', operation: null, policy: { alias: node(target.hostId).alias, shareResources: false, allowedPaths: [], deniedPaths: [], defaultPath: null } } as never)
    const invocation = await parseAgentMuxCliInvocation(['app', 'focus', '--settings-section', 'network-node', '--host', 'remote-node'])
    const request = rpcControlRequest('app.focus', invocation.params)
    if (request.operation !== 'focus') throw new Error('The original CLI did not produce a focus request')
    const result = await control(request.target)
    expect(result.navigation.state).toBe('applied'); expect(result.overlays.settingsPage).toMatchObject({ sectionId: 'network-node', hostId: 'remote-node', visible: true })
    expect(container.querySelector('[data-settings-pane="network-node"] [data-settings-field="incoming"]')).toBeNull()
    await control({ kind: 'settings', sectionId: 'hosts', hostId: 'local' })
    await act(async () => container.querySelector<HTMLButtonElement>('[data-resource-editor="local"] [data-host-panel="connection"]')!.click())
    const open = [...container.querySelectorAll<HTMLButtonElement>('[data-resource-editor="local"] button')].find(button => button.textContent === 'Open Node publishing')!
    expect(open).not.toBeNull(); await act(async () => open.click()); await settle()
    expect((await readSettings()).overlays.settingsPage).toMatchObject({ sectionId: 'network-node', hostId: 'local', visible: true })
    expect(container.querySelector('[data-settings-pane="network-node"] [data-settings-field="incoming"]')).toBeNull()
    expect(container.querySelector('[data-settings-pane="network-node"] [data-settings-field="publishing"]')).not.toBeNull()
    await control({ kind: 'settings', sectionId: null })
  })
  it('Host-qualified Agent focus checks the original Host before navigation and keeps a healthy same-SID workface', async () => {
    await control({ kind: 'space', regionId: 'source-region' })
    const before = useAppStore.getState(), drafts = before.agentComposerDrafts
    const request = { schemaVersion: 5 as const, requestId: crypto.randomUUID(), operation: 'focus' as const,
      target: { kind: 'space' as const, regionId: 'target-region' }, inputPolicy: 'preserve' as const,
      expectedAgentSessionId: target.control.agentSessionId, expectedAgentHostId: 'another-host' }
    let response!: AgentMuxDesktopFocusResult
    await act(async () => { response = await useAppStore.getState().executeControl(parseAgentMuxControlRequest(request)) as AgentMuxDesktopFocusResult })
    expect(response.navigation.state).toBe('rejected')
    expect(response.navigation.expectedAgentHostId).toBe('another-host')
    expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(useAppStore.getState().sessions).toEqual(before.sessions)
  })
  async function readSettings() {
    const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'inspect.client' })
    if (result.operation !== 'inspect.client') throw new Error('Expected original client inspection')
    return desktopWorkbenchObservationSchema.parse(result.observation).desktop
  }
  it('consumes the actual public CLI and Settings owner, observes manual selection and keeps original drafts', async () => {
    await control({ kind: 'space', regionId: 'source-region' })
    const original = useAppStore.getState()
    const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'stop')]
    const first = await readSettings()
    expect(first.overlays.settingsPage).toMatchObject({ sectionId: null, visible: false })
    expect(first.overlays.settingsPage!.sectionIds.length).toBeGreaterThan(10)
    expect(first.overlays.settingsPage!.sectionIds).toEqual(expect.arrayContaining(['overview', 'appearance', 'profile']))
    const directory = await mkdtemp(join(tmpdir(), 'settings-navigation-consumer-'))
    const cli = join(directory, 'amux.mjs')
    const require = createRequire(import.meta.url), core = dirname(require.resolve('../../../packages/core/package.json'))
    await symlink(join(core, 'node_modules'), join(directory, 'node_modules'), 'dir')
    await require(join(core, 'node_modules/esbuild')).build({ entryPoints: [join(core, 'src/agentmux.ts')],
      outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    const requests: string[] = []
    const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], async execute(request) {
      requests.push(request.operation)
      let pending!: Promise<AgentMuxControlResult>
      await act(async () => { pending = useAppStore.getState().executeControl(request); await Promise.resolve() })
      return await pending
    } })
    await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const invoke = async (...args: string[]) => await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const deadline = setTimeout(() => { child.kill(); reject(new Error('Original Settings CLI request exceeded its deadline.')) }, 10000)
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(deadline); reject(error) })
      child.once('close', code => { clearTimeout(deadline); try { resolve({ code, stderr, body: JSON.parse(stdout || stderr) }) } catch (error) { reject(error) } })
    })
    try {
      const response = await invoke('app', 'focus', '--settings-section', 'appearance')
      expect(response.stderr).toBe('')
      expect(response.body).toMatchObject({ ok: true, operation: 'app.focus', result: {
        navigation: { state: 'applied', requested: { kind: 'settings', sectionId: 'appearance' } },
        presentation: { state: 'covered', blockers: ['settings'] },
        overlays: { settingsPage: { sectionId: 'appearance', visible: true } }, input: { outcome: 'preserved' } } })
      expect(response.code).toBe(0)
      expect(container.querySelector('[data-settings-pane="appearance"]')!.hasAttribute('hidden')).toBe(false)
      const inspect = await invoke('app', 'inspect')
      expect(inspect.code).toBe(0)
      expect(inspect.body.result.observation.desktop.overlays.settingsPage.sectionIds).toEqual(first.overlays.settingsPage!.sectionIds)
      const profile = container.querySelector<HTMLButtonElement>('[data-settings-target="profile"]')!
      expect(profile).not.toBeNull()
      await act(async () => profile.click()); await settle()
      expect((await readSettings()).overlays.settingsPage).toMatchObject({ sectionId: 'profile', visible: true })
      const field = container.querySelector<HTMLInputElement>('#profile-display-name')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Original unsaved profile')
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const unknown = await client.call('app.focus', { target: { kind: 'settings', sectionId: 'not-registered' }, inputPolicy: 'preserve' })
      expect(unknown).toMatchObject({ navigation: { state: 'rejected' }, overlays: { settingsPage: { sectionId: 'profile', visible: true } },
        issues: expect.arrayContaining([expect.objectContaining({ code: 'SETTINGS_SECTION_UNKNOWN' })]) })
      expect(container.querySelector('#profile-display-name')).toBe(field)
      expect(field.value).toBe('Original unsaved profile')
      await control({ kind: 'settings', sectionId: 'appearance' })
      await control({ kind: 'settings', sectionId: 'profile' })
      expect(container.querySelector('#profile-display-name')).toBe(field)
      expect(field.value).toBe('Original unsaved profile')
      const current = useAppStore.getState()
      expect(current.mainSurface).toBe(original.mainSurface)
      expect(current.tabs).toBe(original.tabs); expect(current.layouts).toBe(original.layouts)
      expect(current.agentComposerDrafts).toBe(original.agentComposerDrafts)
      expect(current.workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
      expect(document.activeElement).toBe(outside)
      expect([outside.selectionStart, outside.selectionEnd]).toEqual([2, 5])
      const closed = await invoke('app', 'focus', '--close-settings')
      expect(closed.body.result.overlays.settings).toBe(false)
      expect(closed.body.result.overlays.settingsPage.visible).toBe(false)
      expect(field.value).toBe('Original unsaved profile')
      expect(document.activeElement).toBe(outside)
      const mixed = await invoke('app', 'focus', '--settings-section', 'profile', '--surface', 'space')
      expect(mixed.body).toMatchObject({ ok: false, error: { code: 'INVALID_CLI_ARGUMENT' } })
      expect(requests).toEqual(['focus', 'inspect.client', 'focus', 'focus'])
      for (const operation of lifecycle) expect(operation).not.toHaveBeenCalled()
    } finally { await client.dispose(); await server.stop(); await rm(directory, { recursive: true }) }
  })
  it('preserves the real Mote caret and composition while hidden main input is reported unavailable', async () => {
    // A human opening first exercises transition from the Panel's normal focus policy.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click()); await settle()
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Search settings"]'))
    const { input } = await arrangePrimaryInputMote()
    expect(input).not.toBeNull()
    input.focus()
    const selection = document.getSelection()!, text = input.firstChild!.firstChild
    expect(text).not.toBeNull()
    const range = document.createRange(); range.setStart(text!, 2); range.setEnd(text!, 5)
    selection.removeAllRanges(); selection.addRange(range)
    const focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
    const composition = vi.fn(); input.addEventListener('compositionend', composition)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    const first = await control({ kind: 'settings', sectionId: 'overview' })
    expect(first.input).toMatchObject({ outcome: 'preserved', after: { scope: 'floating', ownerKind: 'composer' } })
    expect(document.activeElement).toBe(input)
    expect(selection.getRangeAt(0).startContainer).toBe(text); expect(selection.getRangeAt(0).startOffset).toBe(2)
    expect(selection.getRangeAt(0).endOffset).toBe(5)
    expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled(); expect(composition).not.toHaveBeenCalled()
    await control({ kind: 'settings', sectionId: 'appearance' })
    expect(document.activeElement).toBe(input)
    expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled(); expect(composition).not.toHaveBeenCalled()
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组' }))
    const closed = await control({ kind: 'settings', sectionId: null })
    expect(closed.overlays.settings).toBe(false)
    expect(document.activeElement).toBe(input); expect(focus).not.toHaveBeenCalled()
    await control({ kind: 'space', regionId: 'source-region' }, 'target')
    const mainInput = container.querySelector<HTMLElement>('[data-workbench-region-id="source-region"] .xterm-helper-textarea')!
    expect(document.activeElement).toBe(mainInput)
    const hidden = await control({ kind: 'settings', sectionId: 'overview' })
    expect(hidden.input.outcome).toBe('unavailable')
    expect(hidden.input.after.inert).toBe(true)
    expect(useAppStore.getState().agentComposerDrafts[source.id]).toBe('Unsent original draft')
  })
})


it('source-qualified Goal links distinguish stores on one real semantic Runtime and survive its original process restart', async () => {
  const fixture = await goalLinkOwnerFixture()
  try {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
    const first = await fixture.open('original')
    vi.spyOn(api.goals, 'execute').mockImplementation(request => callPublicGoalControl(request, (method, input) => first.client.call(method, input as never)))
    const a = await first.client.call('goal.create', { goalId: 'exact', title: 'Original source Goal', risk: 'low', confirmation: 'user' })
    await act(async () => useAppStore.setState({ demands: { exact: { ...publicGoalRecord(a.goal), source: 'default-topic' } } }))
    const second = await fixture.open('other')
    const listProof = JSON.parse(await readFile(join(fixture.native.env.AGENTMUX_STATE_DIRECTORY!, 'goal-list-proof.json'), 'utf8'))
    expect(listProof).toMatchObject({ scope: 'original', items: [{ id: 'exact', title: 'Original source Goal' }] })
    expect(listProof.items[0].address).toBeDefined()
    const b = await second.client.call('goal.create', { goalId: 'exact', title: 'Other source Goal', risk: 'low', confirmation: 'user' })
    expect(a.goal.address).toBeDefined(); expect(b.goal.address).toBeDefined()
    const address = a.goal.address!, other = b.goal.address!
    expect(address.runtimeId).toBe(fixture.native.owner.runtimeId)
    expect(address.runtimeId).not.toBe(fixture.native.owner.ownerInstanceId)
    expect(address.namespace).not.toBe(other.namespace)
    expect(other.runtimeId).toBe(address.runtimeId)
    expect(JSON.stringify(address)).not.toContain(first.root)
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'original-reading', operation: 'focus',
      target: { kind: 'goal', goalId: 'exact', runtimeId: address.runtimeId, namespace: address.namespace, section: 'plan' }, inputPolicy: 'preserve' })
    const before = useAppStore.getState()
    const outcome = await control(request.target as AgentMuxDesktopFocusTarget).then(result => ({ result }), error => ({ error: String(error) }))
    expect(outcome).not.toHaveProperty('error')
    const rejected = 'result' in outcome ? outcome.result! : undefined
    expect(rejected!.navigation.state).toBe('rejected')
    expect(rejected!.issues.some(issue => issue.code === 'GOAL_SOURCE_UNCONFIRMED')).toBe(true)
    expect(useAppStore.getState().selectedDemandId).toBe(before.selectedDemandId)
    expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    const oldOwner = fixture.native.owner
    await fixture.open('original')
    const read = await first.client.call('goal.inspect', { goalId: 'exact' })
    expect(fixture.native.owner.runtimeId).toBe(oldOwner.runtimeId)
    expect(fixture.native.owner.ownerInstanceId).not.toBe(oldOwner.ownerInstanceId)
    expect(read.goal!.address).toEqual(address)
    expect((await control(request.target as AgentMuxDesktopFocusTarget)).navigation.state).not.toBe('rejected')
    await act(async () => useAppStore.setState({ demands: { exact: { ...publicGoalRecord(b.goal), source: 'default-topic' } } }))
    const bare = await control({ kind: 'goal', goalId: 'exact' })
    expect(bare.navigation.state).toMatch(/applied|unchanged/u)
    expect(container.querySelector('[data-goal-detail-id="exact"]')?.textContent).toContain('Other source Goal')
  } finally { await fixture.close() }
}, 60_000)

it('copied Goal plan links and the real CLI reveal the original graph without creating work or stealing the retained draft', async () => {
  const fixture = await goalLinkOwnerFixture(), owner = await fixture.open('original')
  let server: AgentMuxControlServer | undefined, client: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'stop')]
  try {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function(this: HTMLElement) {
      const reading = this.closest<HTMLElement>('[data-goal-reading-section]')
      const base = reading?.dataset.goalReadingSection === 'plan' ? 900 : reading?.dataset.goalReadingSection === 'activity' ? 1800 : 100
      const top = reading ? base - (this.closest<HTMLElement>('.goals-detail')?.scrollTop ?? 0) : 0
      return { x: 0, y: top, top, left: 0, right: 600, bottom: top + 400, width: 600, height: 400, toJSON: () => ({}) }
    })
    vi.spyOn(api.goals, 'execute').mockImplementation(request => callPublicGoalControl(request, (method, input) => owner.client.call(method, input as never)))
    const created = await owner.client.call('goal.create', { goalId: 'exact', title: 'An addressable Goal', risk: 'low', confirmation: 'user' })
    const address = created.goal.address!
    if (process.env.GOAL_LINK_EVIDENCE) await appendFile(process.env.GOAL_LINK_EVIDENCE, JSON.stringify({ phase: 'empty-original-goal', goal: created.goal, config, owner: fixture.native.owner }) + '\n')
    await act(async () => useAppStore.setState({ demands: { exact: { ...publicGoalRecord(created.goal), source: 'default-topic' } }, selectedDemandId: null }))
    const writes = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    const requests: AgentMuxControlRequest[] = []
    const execute = async (request: AgentMuxControlRequest, signal?: AbortSignal) => {
      requests.push(request)
      let pending!: Promise<AgentMuxControlResult>
      await act(async () => { pending = useAppStore.getState().executeControl(request, signal); await Promise.resolve() })
      return pending
    }
    const ingress = new SpatialLinkIngress(), issues = vi.fn()
    ingress.ready(execute, issues)
    await ingress.receive(address.goalUrl)
    expect(issues).not.toHaveBeenCalled()
    const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy plan link')
    expect(copy).toBeDefined(); await act(async () => copy!.click())
    expect(writes).toHaveBeenCalledWith(address.planUrl)
    await act(async () => useAppStore.getState().setMainSurface('survey'))
    await settle()
    outside.focus(); outside.value = 'Original unsent draft'; outside.setSelectionRange(2, 7)
    const original = useAppStore.getState()
    await ingress.receive(writes.mock.calls[0]![0])
    expect(issues).not.toHaveBeenCalled()
    expect(container.querySelector('[data-goal-plan-empty]')).not.toBeNull()
    expect(container.querySelector<HTMLElement>('.goals-detail')!.scrollTop).toBeGreaterThan(0)
    expect(document.activeElement).toBe(outside); expect(outside.value).toBe('Original unsent draft')
    expect([outside.selectionStart, outside.selectionEnd]).toEqual([2, 7])
    expect(useAppStore.getState().agentFocus).toBe(original.agentFocus)
    const proposal = { summary: 'Read the original plan', criteria: [{ id: 'read', text: 'The original graph is visible' }], openQuestions: [] }
    await owner.client.call('goal.update', { goalId: 'exact', patch: { alignment: proposal } })
    await owner.client.call('goal.plan.revise', { goalId: 'exact', revision: { operationId: 'original-plan', expectedRevision: 0, alignmentRevision: 1,
      nodes: [{ id: 'read', title: 'Read original graph', outcome: 'The original graph is visible', criterionIds: ['read'], dependsOn: [], check: 'Inspect the original graph', executor: null }] } })
    const saved = await owner.client.call('goal.inspect', { goalId: 'exact' })
    if (process.env.GOAL_LINK_EVIDENCE) await appendFile(process.env.GOAL_LINK_EVIDENCE, JSON.stringify({ phase: 'saved-original-goal', goal: saved.goal, config, owner: fixture.native.owner }) + '\n')
    await act(async () => useAppStore.setState({ demands: { exact: { ...publicGoalRecord(saved.goal!), source: 'default-topic' } } }))
    const cliDirectory = join(fixture.directory, 'cli'); await mkdir(cliDirectory)
    const cli = join(cliDirectory, 'amux.mjs'), require = createRequire(import.meta.url), core = dirname(require.resolve('../../../packages/core/package.json'))
    await symlink(join(core, 'node_modules'), join(cliDirectory, 'node_modules'), 'dir')
    await require(join(core, 'node_modules/esbuild')).build({ entryPoints: [join(core, 'src/agentmux.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: [goalLinkBuildPlugin('actual-public-CLI')] })
    server = new AgentMuxControlServer({ socketPath: join(fixture.directory, 'desktop.sock'), coreClients: () => [], execute: (request, _name, context) => execute(request, context?.signal) })
    await server.start()
    client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const receipt = await client.call('goal.focus', { goalId: 'exact', runtimeId: address.runtimeId, namespace: address.namespace, section: 'plan' })
    expect(receipt.presentation.goal).toEqual({ goalId: 'exact', runtimeId: address.runtimeId, namespace: address.namespace, section: 'plan' })
    const cliCall = async (args: string[]) => {
      const child = spawn(process.execPath, [cli, '--endpoint', 'unix:' + server!.path, ...args], { env: objectCliEnvironment(fixture.directory), stdio: ['ignore', 'pipe', 'pipe'] })
      return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = '', stderr = ''; const deadline = setTimeout(() => { child.kill(); reject(Error('The exact Goal CLI request exceeded its deadline.')) }, 10_000)
        child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value }); child.once('error', error => { clearTimeout(deadline); reject(error) })
        child.once('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
      })
    }
    const requestsBeforeDiscovery = requests.length
    const help = await cliCall(['goal', 'focus', '--help']), skill = await cliCall(['goal', '--skill']), spaceSkill = await cliCall(['space', '--skill'])
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--namespace ID'); expect(help.stdout).toContain('--section plan')
    expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('goal.address'); expect(skill.stdout).toContain('presentation.goal')
    expect(spaceSkill.code, spaceSkill.stderr).toBe(0); expect(spaceSkill.stdout).toContain('capsule, mote, host and goal'); expect(spaceSkill.stdout).toContain('goal focus --goal ID --runtime ID --namespace ID --section plan')
    expect(requests).toHaveLength(requestsBeforeDiscovery)
    const result = await cliCall(['goal', 'focus', '--goal', 'exact', '--runtime', address.runtimeId, '--namespace', address.namespace, '--section', 'plan'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result.presentation.goal).toEqual(receipt.presentation.goal)
    expect(container.querySelector('[data-goal-plan-node="read"]')).not.toBeNull()
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Goal title"]')!
    const { editGoalDraft } = await import('../src/renderer/src/lib/goal-edit-drafts')
    await act(async () => editGoalDraft('exact', 'title', 'A retained local edit'))
    await ingress.receive(address.planUrl)
    expect(container.querySelector('[aria-label="Goal title"]')).toBe(editor)
    expect(editor.value).toBe('A retained local edit')
    const invoke = vi.mocked(api.goals.execute).getMockImplementation()!
    const anchorButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!
    for (const choice of ['Activity', 'Overview']) {
      await act(async () => anchorButton('Overview').click())
      const detail = container.querySelector<HTMLElement>('.goals-detail')!, originalScroll = detail.scrollTop
      let release!: () => void, reached!: () => void
      const held = new Promise<void>(resolve => { release = resolve }), reachedSource = new Promise<void>(resolve => { reached = resolve })
      vi.mocked(api.goals.execute).mockImplementationOnce(async request => { const read = await invoke(request); reached(); await held; return read })
      const pending = ingress.receive(address.planUrl)
      await reachedSource; await settle()
      expect(useAppStore.getState().goalReadingEntry?.phase).toBe('pending')
      expect(detail.scrollTop, 'A pending source read cannot reveal the plan before confirmation').toBe(originalScroll)
      await act(async () => anchorButton(choice).click())
      expect(useAppStore.getState().goalReadingEntry).toBeNull()
      const selectedScroll = detail.scrollTop, draft = useAppStore.getState().goalEditDrafts.exact
      try { release(); expect(await pending).toContain('NAVIGATION_CHANGED') } finally { release() }
      expect(detail.scrollTop).toBe(selectedScroll)
      expect(useAppStore.getState().goalEditDrafts.exact).toBe(draft)
      expect(container.querySelector('[aria-label="Goal title"]')).toBe(editor)
    }
    let release!: () => void, reached!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), sourceReached = new Promise<void>(resolve => { reached = resolve })
    vi.mocked(api.goals.execute).mockImplementationOnce(async request => { const read = await invoke(request); reached(); await held; return read })
    const delayed = ingress.receive(address.planUrl)
    await sourceReached
    await act(async () => useAppStore.getState().setMainSurface('recall'))
    const later = useAppStore.getState()
    try { release(); expect(await delayed).toContain('NAVIGATION_CHANGED') } finally { release() }
    expect(useAppStore.getState().mainSurface).toBe('recall')
    expect(useAppStore.getState().agentFocus).toBe(later.agentFocus)
    expect(useAppStore.getState().goalEditDrafts.exact).toEqual(later.goalEditDrafts.exact)

    expect(requests.every(request => request.operation === 'focus')).toBe(true)
    expect((await owner.client.call('goal.inspect', { goalId: 'exact' })).goal!.plan!.revision).toBe(1)
    for (const action of lifecycle) expect(action).not.toHaveBeenCalled()
  } finally { await client?.dispose(); await server?.stop(); await fixture.close() }
}, 60_000)


it('malformed optional diagnostics never hide a real owner Goal or its valid original address', async () => {
  const fixture = await goalLinkOwnerFixture()
  try {
    const owner = await fixture.open('original')
    await owner.client.call('goal.create', { goalId: 'original', title: 'A real original Goal', risk: 'low', confirmation: 'user' })
    const read = await callPublicGoalControl({ schemaVersion: 5, requestId: 'metadata-original', operation: 'demand.show', demandId: 'original' },
      (method, input) => owner.client.call(method, input as never))
    if (read.operation !== 'demand.show' || !read.demand) throw Error('The real original Goal read is required')
    expect(read.demand.address).toBeDefined()
    for (const issue of [7, { message: 'A malformed optional diagnostic' }]) for (const includeAddress of [true, false]) {
      const { address: originalAddress, ...body } = read.demand
      let parsed: ReturnType<typeof parseAgentMuxControlReceipt> | undefined, failure: unknown
      try { parsed = parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'metadata-reading', operation: 'demand.show', ok: true,
        result: { demand: { ...body, ...(includeAddress ? { address: originalAddress } : {}), addressIssue: issue }, goalContinuations: [] } }) } catch (error) { failure = error }
      expect(failure, 'An optional address diagnostic cannot hide the original Goal').toBeUndefined()
      expect(parsed?.ok).toBe(true)
      if (parsed?.ok && parsed.operation === 'demand.show') {
        expect(parsed.result.demand).toMatchObject({ id: read.demand.id, title: read.demand.title })
        if (includeAddress) expect(parsed.result.demand?.address).toEqual(originalAddress)
        else { expect(parsed.result.demand?.address).toBeUndefined(); expect(parsed.result.demand?.addressIssue).toContain('unconfirmed') }
      }
    }
  } finally { await fixture.close() }
}, 60_000)

it('an actual Goal focus receipt rejects another presented Goal while preserving the legacy bare receipt', async () => {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
  const { operation, ...body } = await control({ kind: 'goal', goalId: 'exact' })
  expect(body.navigation.state).toMatch(/applied|unchanged/u)
  expect(body.presentation.goal?.goalId).toBe('exact')
  const frame = { schemaVersion: 5, requestId: 'original-goal-reading', operation, ok: true, result: body }
  expect(() => parseAgentMuxControlReceipt(frame)).not.toThrow()
  const other = { ...body, presentation: { ...body.presentation, goal: { ...body.presentation.goal, goalId: 'another-goal' } } }
  expect(() => parseAgentMuxControlReceipt({ ...frame, result: other })).toThrow('Goal receipt target is mismatched')
  const { goal: _reading, ...legacy } = body.presentation
  expect(() => parseAgentMuxControlReceipt({ ...frame, result: { ...body, presentation: legacy } })).not.toThrow()
})

it('a literal self Goal keeps its original identity through copied links and the real focus CLI', async () => {
  const { parseAmuxObjectLink } = await import('@agentmux/core/sharing')
  const fixture = await goalLinkOwnerFixture(), owner = await fixture.open('original')
  let server: AgentMuxControlServer | undefined
  const lifecycle = [vi.spyOn(api.sessions, 'launchAgent'), vi.spyOn(api.sessions, 'submitPrompt'), vi.spyOn(api.sessions, 'resume'), vi.spyOn(api.sessions, 'stop')]
  try {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function(this: HTMLElement) {
      const reading = this.closest<HTMLElement>('[data-goal-reading-section]')
      const top = reading?.dataset.goalReadingSection === 'plan' ? 900 - (this.closest<HTMLElement>('.goals-detail')?.scrollTop ?? 0) : 0
      return { x: 0, y: top, top, left: 0, right: 600, bottom: top + 400, width: 600, height: 400, toJSON: () => ({}) }
    })
    vi.spyOn(api.goals, 'execute').mockImplementation(request => callPublicGoalControl(request, (method, input) => owner.client.call(method, input as never)))
    const created = await owner.client.call('goal.create', { goalId: 'self', title: 'A literal record identity', risk: 'low', confirmation: 'user' })
    expect(created.goal.id).toBe('self')
    const address = created.goal.address!
    expect(parseAmuxObjectLink(address.planUrl)).toMatchObject({ kind: 'goal', goalId: 'self' })
    await act(async () => useAppStore.setState({ demands: { self: { ...publicGoalRecord(created.goal), source: 'default-topic' } } }))
    const requests: AgentMuxControlRequest[] = []
    const execute = async (request: AgentMuxControlRequest, signal?: AbortSignal) => {
      requests.push(request)
      let pending!: Promise<AgentMuxControlResult>
      await act(async () => { pending = useAppStore.getState().executeControl(request, signal); await Promise.resolve() })
      return pending
    }
    const ingress = new SpatialLinkIngress(), issues = vi.fn(), writes = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
    ingress.ready(execute, issues)
    await ingress.receive(address.goalUrl)
    expect(issues, 'A literal Goal ID cannot be rejected as a spatial self selector').not.toHaveBeenCalled()
    const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy plan link')
    expect(copy).toBeDefined(); await act(async () => copy!.click())
    expect(writes).toHaveBeenCalledWith(address.planUrl)
    await ingress.receive(writes.mock.calls[0]![0])
    expect(issues).not.toHaveBeenCalled()
    expect(container.querySelector('[data-goal-detail-id="self"]')).not.toBeNull()
    expect(container.querySelector('[data-goal-plan-origin]')).not.toBeNull()
    server = new AgentMuxControlServer({ socketPath: join(fixture.directory, 'desktop.sock'), coreClients: () => [], execute: (request, _name, context) => execute(request, context?.signal) })
    await server.start()
    const cliDirectory = join(fixture.directory, 'cli'); await mkdir(cliDirectory)
    const cli = join(cliDirectory, 'amux.mjs'), require = createRequire(import.meta.url), core = dirname(require.resolve('../../../packages/core/package.json'))
    await symlink(join(core, 'node_modules'), join(cliDirectory, 'node_modules'), 'dir')
    await require(join(core, 'node_modules/esbuild')).build({ entryPoints: [join(core, 'src/agentmux.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: [goalLinkBuildPlugin('actual-public-CLI')] })
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--endpoint', 'unix:' + server!.path, 'goal', 'focus', '--goal', 'self', '--runtime', address.runtimeId, '--namespace', address.namespace, '--section', 'plan'], { env: objectCliEnvironment(fixture.directory), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; const deadline = setTimeout(() => { child.kill(); reject(Error('The literal Goal CLI request exceeded its deadline.')) }, 10_000)
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value }); child.once('error', error => { clearTimeout(deadline); reject(error) })
      child.once('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
    })
    expect(result.code, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt).toMatchObject({ ok: true, operation: 'goal.focus', result: { navigation: { requested: { goalId: 'self' }, selection: { goalId: 'self' } } } })
    expect(receipt.result.presentation.goal).toEqual({ goalId: 'self', runtimeId: address.runtimeId, namespace: address.namespace, section: 'plan' })
    expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'spatial-reading', operation: 'focus', target: { kind: 'space', regionId: 'self' } })).toThrow('requires an exact ID')
    expect((await owner.client.call('goal.inspect', { goalId: 'self' })).goal!.plan).toBeUndefined()
    expect(requests.every(request => request.operation === 'focus')).toBe(true)
    for (const action of lifecycle) expect(action).not.toHaveBeenCalled()
  } finally { await server?.stop(); await fixture.close() }
}, 60_000)
