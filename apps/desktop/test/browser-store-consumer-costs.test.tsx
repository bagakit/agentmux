// @vitest-environment happy-dom
import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { act, createElement, Fragment, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const baseline = useAppStore.getState()
const sourcePaths = ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/browser-state.ts',
  'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/lib/workbench-session-subscriptions.ts', 'apps/desktop/test/browser-store-consumer-costs.test.tsx']
const sourceIdentity = () => Object.fromEntries(sourcePaths.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')]))
const snapshot = (id: string): BrowserSnapshot => ({ id, navigationId: `navigation-${id}`, profileId: 'profile',
  url: `https://example.test/${id}`, title: id, loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
const session = (id: string): SessionSnapshot => ({ id, kind: 'agent', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: '/fixture', label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } })
const fixture = () => {
  const related = snapshot('related-browser'), unrelated = snapshot('unrelated-browser')
  const relatedTab = createWorkbenchTab('related-tab', { ...related, kind: 'browser', regionId: 'related-region', browserId: related.id, workspaceId: 'related-workspace' })
  const unrelatedTab = createWorkbenchTab('unrelated-tab', { ...unrelated, kind: 'browser', regionId: 'unrelated-region', browserId: unrelated.id, workspaceId: 'unrelated-workspace' })
  const sessions = [session('agent-one'), session('agent-two')]
  const agentOne = createWorkbenchTab('agent-tab-one', { kind: 'agent', regionId: 'agent-region-one', sessionId: sessions[0]!.id, workspaceId: 'unrelated-workspace', phase: 'attached' })
  const agentTwo = createWorkbenchTab('agent-tab-two', { kind: 'agent', regionId: 'agent-region-two', sessionId: sessions[1]!.id, workspaceId: 'unrelated-workspace', phase: 'attached' })
  const tabs = { [relatedTab.id]: relatedTab, [unrelatedTab.id]: unrelatedTab, [agentOne.id]: agentOne, [agentTwo.id]: agentTwo }
  const layouts = { 'related-workspace': createWorkspaceLayout('related-group', [relatedTab.id]),
    'unrelated-workspace': createWorkspaceLayout('unrelated-group', [unrelatedTab.id, agentOne.id, agentTwo.id]) }
  return { tabs, sessions, layouts, related }
}
type RawEvent = { sequence: number; window: 'mount' | 'update' | 'cleanup'; kind: 'global-store-notify' | 'selector-call' | 'observer-render' | 'workspace-commit'; consumerId: string; selectedIdentity?: number; phase?: string }
type Consumer = { id: string; related: boolean; kind: 'tab' | 'session'; subjectId: string }
const consumers: Consumer[] = [
  { id: 'related-browser-tab', related: true, kind: 'tab', subjectId: 'related-tab' },
  { id: 'unrelated-browser-tab', related: false, kind: 'tab', subjectId: 'unrelated-tab' },
  { id: 'agent-tab-one', related: false, kind: 'tab', subjectId: 'agent-tab-one' },
  { id: 'agent-tab-two', related: false, kind: 'tab', subjectId: 'agent-tab-two' },
  { id: 'agent-session-one', related: false, kind: 'session', subjectId: 'agent-one' },
  { id: 'agent-session-two', related: false, kind: 'session', subjectId: 'agent-two' }
]
let root: Root, container: HTMLDivElement, dispose: () => void, report: Record<string, unknown>
let events: RawEvent[], windowName: RawEvent['window'], ids: WeakMap<object, number>, identityCounter: number
const reports: unknown[] = []
function record(kind: RawEvent['kind'], consumerId: string, selected?: object, phase?: string) {
  if (selected && !ids.has(selected)) ids.set(selected, ++identityCounter)
  events.push({ sequence: events.length + 1, window: windowName, kind, consumerId,
    ...(selected ? { selectedIdentity: ids.get(selected)! } : {}), ...(phase ? { phase } : {}) })
}
function Observer({ consumer }: { consumer: Consumer }) {
  const selected = useAppStore(state => {
    const value = consumer.kind === 'tab' ? state.tabs[consumer.subjectId] : state.sessions.find(item => item.id === consumer.subjectId)
    record('selector-call', consumer.id, value)
    return value
  })
  record('observer-render', consumer.id, selected)
  return createElement('output', { 'data-consumer': consumer.id }, selected?.id ?? 'missing')
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  const f = fixture()
  useAppStore.setState({ tabs: f.tabs, sessions: f.sessions, layouts: f.layouts,
    config: null, agentNames: {}, timelines: {}, mainSurface: 'workbench', projectRailOpen: false, toolsOpen: false })
  events = []; windowName = 'mount'; ids = new WeakMap(); identityCounter = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  dispose = useAppStore.subscribe(state => record('global-store-notify', 'global-store', state))
  report = { schema: 'agentmux.browser-capability-source-consumers.v1', passed: false,
    candidateCommit: process.env.AGENTMUX_SOURCE_CANDIDATE_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceIdentity: sourceIdentity(), producer: { kind: 'source-real-useAppStore', browserProducerInvoked: false, nativeAppLaunched: false },
    conditions: { observation: 'Mount via React act, capture boundary, one production applyBrowserEvent(updated), flush with act; no StrictMode.',
      browserUpdateId: f.related.id, consumers, fixtureTabs: f.tabs, fixtureSessions: f.sessions, fixtureLayouts: f.layouts }, rawEvents: events }
})
afterEach(async () => {
  report.sourceAfter = sourceIdentity()
  report.updateEndSequence = events.length
  report.rawEvents = [...events]
  if (report.case) reports.push(report)
  windowName = 'cleanup'; dispose()
  await act(async () => root.unmount()); container.remove(); window.localStorage.clear()
  vi.restoreAllMocks(); useAppStore.setState(baseline, true)
  if (process.env.AGENTMUX_BROWSER_SOURCE_CONSUMER_REPORT) writeFileSync(process.env.AGENTMUX_BROWSER_SOURCE_CONSUMER_REPORT,
    JSON.stringify({ schema: 'agentmux.browser-capability-source-consumer-reports.v1', reports }, null, 2) + '\n')
})
function updateWindow() {
  report.mountEndSequence = events.length
  windowName = 'update'
  const current = snapshot('related-browser')
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: { ...current, title: 'Updated once', loading: true } })
}
const count = (kind: RawEvent['kind'], id: string) => events.filter(event => event.window === 'update' && event.kind === kind && event.consumerId === id).length

it('measures actual selector observer renders through real production Store applyBrowserEvent', async () => {
  report.case = 'selected-tab-session-observers'
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['related-tab', 'unrelated-tab', 'agent-tab-one', 'agent-tab-two'])
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual(['agent-one', 'agent-two'])
  await act(async () => root.render(createElement(Fragment, null, ...consumers.map(consumer => createElement(Observer, { key: consumer.id, consumer })))))
  expect(container.querySelectorAll('[data-consumer]')).toHaveLength(6)
  expect(events.filter(event => event.window === 'mount' && event.kind === 'observer-render').map(event => event.consumerId)).toEqual(consumers.map(item => item.id))
  await act(async () => updateWindow())
  report.globalStoreNotifications = count('global-store-notify', 'global-store')
  report.samples = consumers.map(consumer => ({ ...consumer, selectorCalls: count('selector-call', consumer.id), renders: count('observer-render', consumer.id) }))
  expect(count('global-store-notify', 'global-store')).toBeGreaterThan(0)
  expect(count('selector-call', 'related-browser-tab')).toBeGreaterThan(0)
  expect(count('observer-render', 'related-browser-tab')).toBeGreaterThan(0)
  for (const consumer of consumers.slice(1)) {
    // Global Store updates evaluate selectors even when the selected value does not change.
    expect(count('selector-call', consumer.id)).toBeGreaterThan(0)
    expect(count('observer-render', consumer.id), `Unrelated selected consumer rerendered: ${consumer.id}`).toBe(0)
  }
  expect(container.querySelector('[data-consumer="related-browser-tab"]')?.textContent).toBe('related-tab')
  expect(useAppStore.getState().tabs['related-tab']!.regions['related-region']).toMatchObject({ title: 'Updated once', loading: true })
  report.passed = true
})

it('measures the actual existing Workspace consumers without unrelated workspace commits', async () => {
  report.case = 'actual-workspace-projections'
  await act(async () => root.render(createElement(Fragment, null,
    ...['related', 'unrelated'].map(name => createElement(Profiler, { key: name, id: `${name}-workspace`,
      onRender: (id, phase) => record('workspace-commit', id, undefined, phase) },
    createElement(WorkspaceWorkbench, { workspaceId: `${name}-workspace`, viewOwnership: 'projection',
      projectionTabId: `${name}-tab`, viewHostPrefix: `${name}-projection` })))
  )))
  expect(container.querySelectorAll('.workspace-workbench')).toHaveLength(2)
  expect(container.querySelectorAll('[data-workbench-tab-id]')).not.toHaveLength(0)
  await act(async () => updateWindow())
  report.globalStoreNotifications = count('global-store-notify', 'global-store')
  report.samples = ['related', 'unrelated'].map(name => ({ id: `${name}-workspace`, related: name === 'related', commits: count('workspace-commit', `${name}-workspace`) }))
  expect(count('global-store-notify', 'global-store')).toBeGreaterThan(0)
  expect(count('workspace-commit', 'related-workspace')).toBeGreaterThan(0)
  expect(count('workspace-commit', 'unrelated-workspace'), 'An unrelated existing Workspace rerendered for another Browser update').toBe(0)
  report.passed = true
})

it('retains this workspace durable orphan Tab outside the current layout membership', async () => {
  const active = createWorkbenchTab('active-launcher', { kind: 'launcher', regionId: 'active-region', workspaceId: 'related-workspace' })
  const orphan = createWorkbenchTab('durable-orphan', { kind: 'launcher', regionId: 'orphan-region', workspaceId: 'related-workspace' })
  const foreign = createWorkbenchTab('foreign-orphan', { kind: 'launcher', regionId: 'foreign-region', workspaceId: 'foreign-workspace' })
  useAppStore.setState({ tabs: { [active.id]: active, [orphan.id]: orphan, [foreign.id]: foreign },
    layouts: { 'related-workspace': createWorkspaceLayout('group', [active.id]) } })
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'related-workspace', viewHostPrefix: 'orphan-source' })))
  expect(container.querySelectorAll('.retained-workbench-view')).toHaveLength(2)
  expect(container.textContent).toContain('Restoring Tab layout')
  expect(useAppStore.getState().tabs).toEqual({ [active.id]: active, [orphan.id]: orphan, [foreign.id]: foreign })
})

it('reads the latest global Tab facts at Close and preserves a same Session view added in another workspace', async () => {
  await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'unrelated-workspace',
    viewOwnership: 'projection', projectionTabId: 'agent-tab-one', viewHostPrefix: 'close-source' })))
  const close = container.querySelector<HTMLButtonElement>('[data-workbench-tab-id="agent-tab-one"] .workbench-tab__close')
  expect(close).not.toBeNull()
  const duplicate = createWorkbenchTab('foreign-session-view', { kind: 'agent', regionId: 'foreign-session-region',
    sessionId: 'agent-one', workspaceId: 'foreign-workspace', phase: 'attached' })
  const stop = vi.spyOn(api.sessions, 'stop')
  const original = useAppStore.getState()
  await act(async () => {
    // The action follows the authoritative update before React can refresh any old render closure.
    useAppStore.setState({ tabs: { ...original.tabs, [duplicate.id]: duplicate },
      layouts: { ...original.layouts, 'foreign-workspace': createWorkspaceLayout('foreign-group', [duplicate.id]) } })
    close!.click()
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useAppStore.getState().tabs['agent-tab-one']).toBeUndefined()
  expect(useAppStore.getState().tabs[duplicate.id]).toBe(duplicate)
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual(['agent-one', 'agent-two'])
  expect(stop).not.toHaveBeenCalled()
})
