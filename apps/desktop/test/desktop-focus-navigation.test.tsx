// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxControlResult, AgentMuxDesktopFocusResult, AgentMuxDesktopFocusTarget } from '@agentmux/core/control'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import { restoreWorkbenchSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { installNativePopover } from './fixtures/mote-workface'

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
    input: HTMLTextAreaElement | null = null
    open(host: HTMLElement) { this.element = document.createElement('div'); this.element.className = 'xterm'
      this.input = document.createElement('textarea'); this.input.className = 'xterm-helper-textarea'; this.element.append(this.input); host.append(this.element) }
    refresh() {}
    focus() { this.input?.focus() }
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
  workspaces: [{ id: 'source', name: 'Source', hostId: 'local', path: '/source', kind: 'folder' },
    { id: 'target', name: 'Target', hostId: 'local', path: '/target', kind: 'folder' },
    { id: 'empty', name: 'Empty directory', hostId: 'local', path: '/empty', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const space = directoryIdentity('local', '/target'), zone = workspaceZoneId(space, 'target')
function agent(id: string, workspace: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex', workspacePath: `/${workspace}`, label: id,
    createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
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
    const emptySpace = directoryIdentity('local', '/empty')
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
    expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
    expect(useAppStore.getState().layouts.target!.groups[0]!.tabOrder).toHaveLength(2)
    expect(prewarm).toHaveBeenCalledWith('target', expect.any(String))
    expect(container.querySelector('.launch-surface')).not.toBeNull()
  })
  it('returns typed multi-Zone candidates and rejects mismatched parents without changing the durable workface', async () => {
    useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
      { id: 'worktree', name: 'Worktree', hostId: 'local', path: '/target-worktree', repoPath: '/target', kind: 'worktree', branch: 'task' }] } })
    const before = useAppStore.getState()
    const ambiguous = await control({ kind: 'space', spaceId: space })
    expect(ambiguous.navigation.state).toBe('rejected')
    expect(ambiguous.issues.find(issue => issue.code === 'SPACE_ZONE_REQUIRED')?.candidates).toEqual([
      { spaceId: space, zoneId: zone }, { spaceId: space, zoneId: workspaceZoneId(space, 'worktree') } ])
    const mismatch = await control({ kind: 'space', spaceId: directoryIdentity('local', '/source'), regionId: 'target-region' })
    expect(mismatch.navigation.state).toBe('rejected')
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
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
        { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/scratch', kind: 'folder' }] } })
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
  it('keeps the original borrowed Mote Composer, draft and composition through Space/Goal/Surface navigation', async () => {
    const mote = { ...agent('mote-agent', 'scratch'), workspacePath: '/scratch/topic--launcher--leader' }
    const tab = { ...createWorkbenchTab('mote-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: 'mote-region', sessionId: mote.id }), topicId: PMO_TEAMS_TOPIC_ID }
    const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Private Mote', summary: '', collaborators: [],
      directoryPath: mote.workspacePath, topicPath: `${mote.workspacePath}/topic.md`,
      soul: { path: `${mote.workspacePath}/SOUL.md`, content: '# Private identity', version: 'v1' } }
    const emptyTopic = { id: 'view:empty-topic', title: 'Private empty Topic', summary: '', collaborators: [],
      directoryPath: '/scratch/topic--view--empty-topic', topicPath: '/scratch/topic--view--empty-topic/topic.md' }
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, emptyTopic]); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
    await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/scratch', kind: 'folder' }] },
      sessions: [...state.sessions, mote], tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', [tab.id]) },
      viewModes: { ...state.viewModes, [mote.id]: 'activity' }, agentComposerDrafts: { ...state.agentComposerDrafts, [mote.id]: 'Original Mote draft' } })))
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: tab.id })); await settle()
    const editor = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-region-id="mote-region"] [role="textbox"]')
    expect(editor).toBeTruthy(); expect(editor!.textContent).toBe('Original Mote draft')
    editor!.focus(); editor!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '组' }))
    const originalNode = editor, draft = useAppStore.getState().agentComposerDrafts[mote.id]
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
    expect(document.querySelectorAll('[data-workbench-region-id="mote-region"]')).toHaveLength(1)
    expect(useAppStore.getState().agentComposerDrafts[mote.id]).toBe(draft)
    const home = document.getElementById('workbench-tab-slot:mote-tab')
    expect(home).toBeTruthy()
    const notice = home!.querySelector('[data-workbench-borrowed-view-notice] .service-window')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('Selected View is in Mote')
    expect(notice!.textContent).toContain('This Tab is selected here. Its original View remains in the floating window.')
    expect(notice!.textContent).toContain('Close Mote to return this View to Space.')
    expect(notice!.querySelector('button, input, textarea, [contenteditable]')).toBeNull()
    expect(home!.querySelector('[data-workbench-region-id="mote-region"]')).toBeNull()
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
    const left = { ...agent('mote-left-agent', 'scratch'), workspacePath: '/scratch/topic--launcher--leader' }
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
      directoryPath: '/scratch/topic--view--empty-topic', topicPath: '/scratch/topic--view--empty-topic/topic.md' }
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, empty]); vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic)
    await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/scratch', kind: 'folder' }] },
      sessions: [...state.sessions, left, right], tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-split-group', [tab.id]) },
      viewModes: { ...state.viewModes, [left.id]: 'activity', [right.id]: 'activity' },
      agentComposerDrafts: { ...state.agentComposerDrafts, [left.id]: 'Left original draft', [right.id]: 'Right original draft' } })))
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTabId: tab.id })); await settle()
    const originalEditors = [...document.querySelectorAll<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-region-id] [role="textbox"]')]
    expect(originalEditors).toHaveLength(heldSource === 'same-tab' ? 3 : 2)
    originalEditors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === 'mote-left-region')!.focus()
    const heldRegionId = heldSource === 'same-tab' ? 'mote-left-region' : 'target-region'
    await control(heldSource === 'none' ? { kind: 'space', spaceId: directoryIdentity('local', empty.directoryPath) }
      : { kind: 'space', regionId: heldRegionId })
    if (heldSource !== 'none') {
      let moved!: AgentMuxControlResult
      await act(async () => { moved = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({
        schemaVersion: 5, requestId: 'mote-retained-public-move', operation: 'space.mv',
        fromRegionId: heldRegionId, expectedAgentSessionId: heldSource === 'same-tab' ? left.id : target.id,
        destination: { zoneId: workspaceZoneId(directoryIdentity('local', '/empty'), 'empty') }, focus: false })) })
      await settle(); expect(moved.operation).toBe('space.mv')
      if (moved.operation !== 'space.mv') throw new Error('Wrong operation')
      expect(moved.outcome).toBe('moved')
    }
    const leftRegionId = heldSource === 'same-tab' ? 'mote-peer-region' : 'mote-left-region'
    const editors = [...document.querySelectorAll<HTMLElement>('[data-pmo-teams-topic-floating] [data-workbench-region-id] [role="textbox"]')]
    expect(editors).toHaveLength(2)
    const leftEditor = editors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === leftRegionId)!
    const rightEditor = editors.find(editor => editor.closest('[data-workbench-region-id]')?.getAttribute('data-workbench-region-id') === 'mote-right-region')!
    expect(leftEditor).toBeTruthy(); expect(rightEditor).toBeTruthy(); leftEditor.focus()
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
    await act(async () => {
      rightEditor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      rightEditor.focus() // Only the native pointer default action is a happy-dom leaf.
    }); await settle()
    const current = useAppStore.getState()
    expect(current.workbenchSpaceSelection).toEqual(address); expect(current.workbenchNavigationInputPolicy).toBe('preserve')
    expect(current.activeWorkspaceId).toBe(before.activeWorkspaceId); expect(current.mainSurface).toBe(before.mainSurface)
    expect(current.layouts).toBe(before.layouts); expect(current.retainedSpatialFocus).toBe(before.retainedSpatialFocus)
    expect(current.tabs[tab.id]?.layout.activeRegionId).toBe('mote-right-region')
    expect(current.agentFocus.pmo.sessionId).toBe(right.id); expect(current.regionCaretFocus).toBeNull()
    const inspected = await current.executeControl({ schemaVersion: 5, requestId: 'mote-split-observe', operation: 'inspect.client' })
    if (inspected.operation !== 'inspect.client') throw new Error('Wrong operation')
    expect(desktopWorkbenchObservationSchema.parse(inspected.observation).desktop).toMatchObject({ selection: { space: address },
      floating: { tabId: tab.id, regionId: 'mote-right-region', sessionId: right.id }, input: { regionId: 'mote-right-region', sessionId: right.id } })
    expect(rightEditor.closest('[data-workbench-region-id]')?.classList.contains('workbench-region--active')).toBe(true)
    expect(leftEditor.closest('[data-workbench-region-id]')?.classList.contains('workbench-region--active')).toBe(false)
    expect(document.activeElement).toBe(rightEditor); expect(leftEditor.isConnected).toBe(true); expect(rightEditor.isConnected).toBe(true)
    expect([leftEditor.textContent, rightEditor.textContent]).toEqual(['Left original draft', 'Right original draft'])
    expect(current.sessions).toBe(before.sessions); expect(current.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(prewarm).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled()
  })
  it('observes the original surviving same-Zone projection after a confirmed user close while preserving the healthy Session', async () => {
    const sibling = createWorkbenchTab('target-sibling-tab', { kind: 'agent', phase: 'attached', workspaceId: 'target',
      regionId: 'target-sibling-region', sessionId: target.id })
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
      directoryPath: '/scratch/topic--view--chosen', topicPath: '/scratch/topic--view--chosen/topic.md' }
    const peer = { ...topic, id: 'view:peer', title: 'Peer', directoryPath: '/scratch/topic--view--peer', topicPath: '/scratch/topic--view--peer/topic.md' }
    const chosenTab = { ...createWorkbenchTab('chosen-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: 'chosen-region', sessionId: target.id }), topicId: topic.id }
    const peerTab = { ...createWorkbenchTab('peer-tab', { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID,
      regionId: 'peer-region', sessionId: source.id }), topicId: peer.id }
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, peer])
    await act(async () => useAppStore.setState(state => ({ config: { ...config, workspaces: [...config.workspaces,
      { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: '/scratch', kind: 'folder' }] },
      tabs: { ...state.tabs, [chosenTab.id]: chosenTab, [peerTab.id]: peerTab },
      layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('topics-group', [chosenTab.id, peerTab.id]) } })))
    const selected = (await control({ kind: 'space', regionId: 'chosen-region' })).navigation.selection.space!
    const sessions = useAppStore.getState().sessions, stop = vi.spyOn(api.sessions, 'stop'), prewarm = vi.spyOn(useAppStore.getState(), 'prewarmTerminal')
    await act(async () => { expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'topics-group', chosenTab.id, { keepAgentSessions: true })).toBe(true) })
    await settle()
    const parent = { ...selected, tabId: null, groupId: null, regionId: null }
    expect(useAppStore.getState().workbenchSpaceSelection).toEqual(parent)
    expect(useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.groups[0]!.activeTabId).toBeNull()
    expect(useAppStore.getState().tabs[peerTab.id]).toEqual(peerTab)
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
    expect(Object.values(useAppStore.getState().tabs).map(tab => Object.keys(tab.regions))).toEqual([['source-region'], ['target-region']])
  })
})
