// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, BrowserSnapshot, SessionSnapshot } from '../../../src/shared/contracts'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { SurfaceMemoryBudgetProvider, useBrowserSurfaceReleased, useMonacoSurfaceReleased } from '../../../src/renderer/src/lib/surface-memory-budget-coordinator'

const baseline = useAppStore.getState()
const paths = ['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/browser-state.ts', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx',
  'apps/desktop/src/renderer/src/lib/surface-memory-budget-coordinator.tsx',
  'apps/desktop/src/renderer/src/lib/surface-memory-budget-candidates.ts',
  'apps/desktop/scripts/fixtures/browser-app-workspace-cost/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/browser-app-workspace-cost/app-workspace-cost.fixture.tsx']
const identity = () => Object.fromEntries(paths.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')]))
const browser = (id: string): BrowserSnapshot => ({ id, navigationId: `navigation-${id}`, profileId: 'profile',
  url: `https://example.test/${id}`, title: id, loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
const agent = (id: string): SessionSnapshot => ({ id, kind: 'agent', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: '/fixture', label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0,
  processState: 'running', status: { state: 'running', source: 'run-process', observedAt: Date.now() },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } })
function fixture() {
  const related = browser('related-browser'), unrelated = browser('unrelated-browser')
  const relatedTab = createWorkbenchTab('related-tab', { ...related, kind: 'browser', browserId: related.id,
    regionId: 'related-region', workspaceId: 'related-workspace' })
  const unrelatedTab = createWorkbenchTab('unrelated-tab', { ...unrelated, kind: 'browser', browserId: unrelated.id,
    regionId: 'unrelated-region', workspaceId: 'unrelated-workspace' })
  const sessions = [agent('agent-one'), agent('agent-two')]
  const agents = sessions.map((session, index) => createWorkbenchTab(`agent-tab-${index + 1}`, {
    kind: 'agent', phase: 'attached', sessionId: session.id, regionId: `agent-region-${index + 1}`, workspaceId: 'unrelated-workspace' }))
  const tabs = Object.fromEntries([relatedTab, unrelatedTab, ...agents].map(tab => [tab.id, tab]))
  const layouts = { 'related-workspace': createWorkspaceLayout('related-group', [relatedTab.id]),
    'unrelated-workspace': createWorkspaceLayout('unrelated-group', [unrelatedTab.id, ...agents.map(tab => tab.id)]) }
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local fixture' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: ['related', 'unrelated'].map(name => ({ id: `${name}-workspace`, name, hostId: 'local', path: `/fixture/${name}`, kind: 'folder' })),
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true,
      devTools: true, viewport: true, saveBookmark: true, more: true } } }
  return { tabs, sessions, layouts, config, related }
}
type Props = { visible: boolean; focusTabId: string | null; focusPortalTargetId: string | null;
  interactiveResize: boolean; viewTargets?: Readonly<Record<string, string>> }
type RawEvent = { sequence: number; window: string; kind: string; consumerId: string; phase?: string; props?: Props;
  stateIdentity?: number; monacoRegionIds?: string[]; browserRegionIds?: string[] }
let root: Root, container: HTMLDivElement, events: RawEvent[], observationWindow: string, dispose: () => void
let resizeListener: ((value: { active: boolean }) => void) | undefined
let report: Record<string, unknown>
const reports: unknown[] = []
function record(kind: string, consumerId: string, phase?: string, props?: Props) {
  events.push({ sequence: events.length + 1, window: observationWindow, kind, consumerId, ...(phase ? { phase } : {}), ...(props ? { props } : {}) })
}
const commits = (id: string, window = observationWindow) => events.filter(event => event.window === window && event.kind === 'workspace-commit' && event.consumerId === id)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  events = []; observationWindow = 'mount'; resizeListener = undefined
  vi.stubGlobal('__agentmuxSourceWorkspaceCommit', (id: string, phase: string, props: Props) => record('workspace-commit', id, phase, props))
  vi.stubGlobal('__agentmuxSourceWorkspaceRender', (id: string) => record('workspace-render', id))
  const stateIds = new WeakMap<object, number>(); let nextStateId = 0
  vi.stubGlobal('__agentmuxSourceSurfaceBudget', (state: { monacoRegionIds: ReadonlySet<string>; browserRegionIds: ReadonlySet<string> }) => {
    if (!stateIds.has(state)) stateIds.set(state, ++nextStateId)
    events.push({ sequence: events.length + 1, window: observationWindow, kind: 'surface-memory-context-value',
      consumerId: 'SurfaceMemoryBudgetProvider', stateIdentity: stateIds.get(state)!,
      monacoRegionIds: [...state.monacoRegionIds], browserRegionIds: [...state.browserRegionIds] })
  })
  // External startup and OS input fixtures only. The actual App/Workspace/SessionPane,
  // Zustand Store subscription and production Browser reducer remain loaded and mounted.
  vi.spyOn(api.ui, 'onWindowResize').mockImplementation(listener => { resizeListener = listener; return () => {} })
  const f = fixture()
  useAppStore.setState({ ...baseline, initialize: async () => () => {}, loading: false, config: f.config,
    tabs: f.tabs, layouts: f.layouts, sessions: f.sessions, mainSurface: 'workbench', activeWorkspaceId: 'related-workspace',
    toolsOpen: false, projectRailOpen: false, error: null, agentNames: {}, timelines: {},
    viewModes: { 'agent-one': 'activity', 'agent-two': 'activity' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  dispose = useAppStore.subscribe(() => record('global-store-notify', 'global-store'))
  report = { schema: 'agentmux.browser-capability-source-app-consumers.v1', passed: false,
    candidateCommit: process.env.AGENTMUX_SOURCE_CANDIDATE_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceIdentity: identity(), producer: { kind: 'source-actual-App-real-useAppStore', nativeAppLaunched: false, browserProducerInvoked: false },
    conditions: { observation: 'Actual App mount; Profiler injected inside actual Workspace returned tree by owning config; no StrictMode.',
      externalFixtures: ['initialize startup returns disposer', 'OS onWindowResize callback capture', 'web preview API selected by repository test config'],
      agentViewMode: 'activity; actual SessionPane and ActivityView; Canvas and terminal costs excluded',
      browserUpdateId: f.related.id, fixtureTabs: f.tabs, fixtureLayouts: f.layouts, fixtureSessions: f.sessions,
      sourceConsumerIds: ['related-workspace', 'unrelated-workspace'] } }
})
afterEach(async () => {
  report.sourceAfter = identity(); report.rawEvents = [...events]
  reports.push(report)
  observationWindow = 'cleanup'; dispose()
  await act(async () => root.unmount()); container.remove(); window.localStorage.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(baseline, true)
  if (process.env.AGENTMUX_APP_SOURCE_CONSUMER_REPORT) writeFileSync(process.env.AGENTMUX_APP_SOURCE_CONSUMER_REPORT,
    JSON.stringify({ schema: 'agentmux.browser-capability-source-app-consumer-reports.v1', reports }, null, 2) + '\n')
})
async function mountApp() {
  await act(async () => root.render(<App />))
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  expect(container.querySelectorAll('.workspace-workbench-registry > [data-workspace-id]')).toHaveLength(2)
  expect(container.querySelectorAll('.retained-workbench-view')).toHaveLength(4)
  expect(container.querySelectorAll('.agent-surface[data-agent-surface-mode="activity"]')).toHaveLength(2)
  for (const id of ['related-workspace', 'unrelated-workspace']) expect(commits(id, 'mount').length, `Actual ${id} Profiler observed`).toBeGreaterThan(0)
  report.mountEndSequence = events.length
}

it('actual App Browser updated caller retains unrelated Workspace commit boundary', async () => {
  report.case = 'actual-app-registry-browser-updated'
  await mountApp()
  const before = useAppStore.getState()
  observationWindow = 'browser-update'
  await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser('related-browser'), title: 'Updated once', loading: true } }))
  report.updateEndSequence = events.length
  report.samples = ['related-workspace', 'unrelated-workspace'].map(id => ({ id, related: id === 'related-workspace', commits: commits(id).length }))
  report.globalStoreNotifications = events.filter(event => event.window === observationWindow && event.kind === 'global-store-notify').length
  report.workspaceRenderSamples = ['related-workspace', 'unrelated-workspace'].map(id => ({ id,
    renders: events.filter(event => event.window === observationWindow && event.kind === 'workspace-render' && event.consumerId === id).length }))
  expect(report.globalStoreNotifications).toBeGreaterThan(0)
  expect(useAppStore.getState().tabs).not.toBe(before.tabs)
  expect(useAppStore.getState().tabs['unrelated-tab']).toBe(before.tabs['unrelated-tab'])
  expect(commits('related-workspace').length).toBeGreaterThan(0)
  expect(commits('unrelated-workspace').length, 'Actual App parent refreshed an unrelated Workspace').toBe(0)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().tabs['related-tab']!.regions['related-region']).toMatchObject({ title: 'Updated once', loading: true })
  report.passed = true
})

it('actual App passes changed resize and Focus projection props through the default memo boundary', async () => {
  report.case = 'actual-app-resize-focus-props'
  await mountApp()
  expect(resizeListener).toBeTypeOf('function')
  observationWindow = 'resize-active'
  await act(async () => resizeListener!({ active: true }))
  for (const id of ['related-workspace', 'unrelated-workspace']) {
    expect(commits(id).length).toBeGreaterThan(0)
    expect(commits(id).at(-1)?.props?.interactiveResize).toBe(true)
  }
  observationWindow = 'resize-end'
  await act(async () => resizeListener!({ active: false }))
  for (const id of ['related-workspace', 'unrelated-workspace']) expect(commits(id).at(-1)?.props?.interactiveResize).toBe(false)
  observationWindow = 'focus'
  await act(async () => useAppStore.setState({ mainSurface: 'agents',
    agentFocus: { execution: { sessionId: 'agent-one', history: [] }, pmo: { sessionId: null } } }))
  expect(commits('unrelated-workspace').length).toBeGreaterThan(0)
  expect(commits('unrelated-workspace').at(-1)?.props).toMatchObject({ visible: true, focusTabId: 'agent-tab-1', focusPortalTargetId: 'focus-workspace-slot' })
  expect(container.querySelector('[data-workspace-id="unrelated-workspace"]')?.getAttribute('data-visible')).toBe('true')
  expect(container.querySelector('#focus-workspace-slot .agent-surface')).not.toBeNull()
  expect(useAppStore.getState().sessions.map(session => session.control.run.runId)).toEqual(['run-agent-one', 'run-agent-two'])
  report.passed = true
})

it('actual Avatar Settings click opens the current executor route after App updates', async () => {
  report.case = 'actual-app-settings-navigation-click'
  await mountApp()
  observationWindow = 'config-update'
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, executors: {
    ...config.executors, codex: { ...config.executors.codex!, label: 'Current executor' }
  } }, mainSurface: 'agents',
  agentFocus: { execution: { sessionId: 'agent-one', history: [] }, pmo: { sessionId: null } } }))
  const avatar = container.querySelector<HTMLElement>('#focus-workspace-slot .agent-avatar[data-executor-id="codex"]')
  expect(avatar).not.toBeNull()
  await act(async () => avatar!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  const settings = document.querySelector<HTMLButtonElement>('.agent-identity-popover button[aria-label="Edit Current executor executor"]')
  expect(settings).not.toBeNull()
  observationWindow = 'settings-click'
  await act(async () => settings!.click())
  expect(container.querySelector('[data-settings-page="agents"]')).not.toBeNull()
  expect(useAppStore.getState().config!.executors.codex!.label).toBe('Current executor')
  report.passed = true
})

it('actual Memory Provider publishes added removed and replaced nonempty set membership', async () => {
  report.case = 'actual-memory-context-membership-changes'
  function ReleasedRegion({ id }: { id: string }) {
    const browser = useBrowserSurfaceReleased(id), monaco = useMonacoSurfaceReleased(id)
    return <output data-released-region={id}>{`${browser}:${monaco}`}</output>
  }
  async function publish(browserIds: string[], monacoIds: string[]) {
    await act(async () => root.render(<SurfaceMemoryBudgetProvider state={{ browserRegionIds: new Set(browserIds), monacoRegionIds: new Set(monacoIds) }}>
      {['one', 'two'].map(id => <ReleasedRegion key={id} id={id} />)}
    </SurfaceMemoryBudgetProvider>))
    expect(container.querySelectorAll('[data-released-region]')).toHaveLength(2)
    return [...container.querySelectorAll('[data-released-region]')].map(element => element.textContent)
  }
  observationWindow = 'member-add'
  expect(await publish(['one'], ['two'])).toEqual(['true:false', 'false:true'])
  observationWindow = 'member-replace'
  expect(await publish(['two'], ['one'])).toEqual(['false:true', 'true:false'])
  observationWindow = 'member-add-both'
  expect(await publish(['one', 'two'], ['one', 'two'])).toEqual(['true:true', 'true:true'])
  observationWindow = 'member-delete'
  expect(await publish([], [])).toEqual(['false:false', 'false:false'])
  report.passed = true
})
