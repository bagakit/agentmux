import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import * as allocator from '../src/renderer/src/lib/focus-lane-layout'
import type { FocusLaneCounts } from '../src/renderer/src/lib/focus-lane-layout'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { App } from '../src/renderer/src/App'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
// Unused launcher/editor tooling paint is outside the measured Focus owner.
// App, SettingsPanel, GlobalFocusSurface, FocusProjectLanes, Row and Store stay real.
vi.mock('../src/renderer/src/components/NewTabSurface', () => ({ NewTabSurface: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
vi.mock('../src/renderer/src/components/ProjectRail', () => ({ ProjectRail: () => null }))
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, stylesheet: HTMLStyleElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
let measuredWidth = 1336, observers: Array<{ callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>
const metrics = (counts: FocusLaneCounts, slots: number) => {
  const m = counts.filter(count => count > 0).length
  return { width: slots * 182 + 4 + 24 * (4 - m) + 32 + 8 - m * 2, padding: 4, gap: 2, cardGap: 2 }
}
function oracle(counts: FocusLaneCounts, slots: number) {
  let best = Infinity
  function enumerate(index: number, used: number, rows: number) {
    if (index === 4) { best = Math.min(best, rows); return }
    const count = counts[index]!
    if (!count) { enumerate(index + 1, used, rows); return }
    for (let columns = 1; columns <= Math.min(count, slots - used); columns++) enumerate(index + 1, used + columns, Math.max(rows, Math.ceil(count / columns)))
  }
  enumerate(0, 0, 0)
  return best
}
const actualRows = (counts: FocusLaneCounts, columns: readonly number[]) => Math.max(0, ...counts.map((count, index) => count ? Math.ceil(count / columns[index]!) : 0))
function agent(id: string, state: SessionSnapshot['status']['state']) {
  return { ...base, id, workspacePath: _hygiene_fixturePath("repo"), processState: state === 'disconnected' ? 'interrupted' as const : 'running' as const, status: { ...base.status, state }, control: { ...base.control, agentSessionId: id, run: { runId: 'original-' + id } } }
}
async function seed(working = 12, results = 5, idle = 1) {
  const sessions = [...Array.from({ length: working }, (_, i) => agent('work-' + i, 'working')), ...Array.from({ length: results }, (_, i) => agent('result-' + i, 'done')), ...Array.from({ length: idle }, (_, i) => agent('idle-' + i, 'running'))]
  const now = Date.now()
  const timelines = Object.fromEntries(sessions.filter(session => session.status.state === 'done').map(session => [session.id, { agentSessionId: session.id, revision: 1, items: [{ id: 'answer-' + session.id, agentSessionId: session.id, kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Answer', content: '已确认的具体结果，保留完整按需信息。', createdAt: now, updatedAt: now }] }]))
  await act(async () => useAppStore.setState({ sessions, timelines, agentNames: Object.fromEntries(sessions.map(session => [session.id, '任务 ' + session.id])) }))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  measuredWidth = 1336; observers = []
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, observe: vi.fn(), disconnect: vi.fn() }; observers.push(this.entry) }
    observe = (element: Element) => this.entry.observe(element)
    disconnect = () => this.entry.disconnect()
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('focus-project-lanes__rows') ? measuredWidth : 0 })
  stylesheet = document.createElement('style'); stylesheet.textContent = '.focus-project-lanes__groups { padding: 2px; column-gap: 2px } .focus-context-group__cards { column-gap: 2px }'; document.head.append(stylesheet)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find((session): session is typeof base => session.kind === 'agent'); expect(found).toBeDefined(); base = found!
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  useAppStore.setState({ config: { ...config, workspaces: [{ id: 'repo', name: 'Product', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }] }, sessions: [], timelines: {}, tabs: {}, providerCatalog: [], agentNames: {}, mainSurface: 'agents', spaceObjectIcons: {}, workspaceFileRevisions: {}, scratchTopicSnapshots: {}, agentComposerDrafts: { 'work-0': 'keep my draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); stylesheet.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mount = () => act(async () => root.render(createElement(GlobalFocusSurface)))
const groups = () => container.querySelector<HTMLElement>('.focus-project-board__live > .focus-project-lanes .focus-project-lanes__groups')!
const section = (bucket: string) => groups().querySelector<HTMLElement>(`[data-bucket="${bucket}"]`)!
const columns = () => ['attention', 'working', 'results', 'idle'].map(bucket => Number(section(bucket).style.getPropertyValue('--focus-card-columns')))
const card = (id: string) => container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)!
const listObservers = () => observers.filter(observer => observer.observe.mock.calls.some(([element]) => (element as HTMLElement).classList.contains('focus-project-lanes__rows')))

it('matches an independently enumerated optimum across nonempty integer budgets', () => {
  let checked = 0
  for (const a of [0, 1, 3]) for (const b of [0, 2, 5]) for (const c of [0, 1, 4]) for (const d of [0, 1, 3]) {
    const counts = [a, b, c, d] as const, m = counts.filter(Boolean).length
    for (let slots = Math.max(1, m); slots <= 10; slots++) {
      const layout = allocator.allocateFocusLaneColumns(counts, metrics(counts, slots))
      expect(layout.slots).toBe(slots); expect(actualRows(counts, layout.columns)).toBe(oracle(counts, slots))
      layout.columns.forEach((column, i) => expect(column).toBeLessThanOrEqual(counts[i]!)); checked++
    }
  }
  expect(checked).toBeGreaterThan(500)
})
it('actual Global projects 12/5/1 into optimal five, six and seven readable slots in fixed order', async () => {
  await seed(); await mount()
  expect([...groups().children].map(node => (node as HTMLElement).dataset.bucket)).toEqual(['attention', 'working', 'results', 'idle', 'disconnected'])
  const counts = [0, 12, 5, 1] as const
  for (const slots of [5, 6, 7]) {
    measuredWidth = metrics(counts, slots).width
    await act(async () => observers[0]!.callback([], {} as ResizeObserver))
    expect(Number(groups().dataset.focusCardSlots)).toBe(slots)
    expect(actualRows(counts, columns())).toBe(oracle(counts, slots))
    expect(groups().querySelectorAll('.focus-context')).toHaveLength(18)
    expect(section('attention').style.getPropertyValue('--focus-group-width')).toBe('24px')
    expect(section('disconnected').querySelectorAll('.focus-context')).toHaveLength(0)
  }
  expect(listObservers()).toHaveLength(1)
})
it('bounds a single card group and preserves real adjacent gaps instead of stretching empty tracks', async () => {
  measuredWidth = 2000; await seed(1, 0, 0); await mount()
  expect(section('working').style.getPropertyValue('--focus-group-width')).toBe('320px')
  expect(columns()).toEqual([0, 1, 0, 0])
  await seed(0, 2, 0)
  expect(section('results').style.getPropertyValue('--focus-group-width')).toBe('642px')
  expect(columns()).toEqual([0, 0, 2, 0])
})
it('keeps a still optimal previous allocation across a real count change and equivalent content updates', async () => {
  measuredWidth = metrics([0, 17, 5, 1], 8).width; await seed(17); await mount()
  expect(columns()).toEqual([0, 5, 2, 1])
  const original = card('work-0'), draft = useAppStore.getState().agentComposerDrafts
  await seed(16)
  expect(columns()).toEqual([0, 5, 2, 1]); expect(card('work-0')).toBe(original)
  await act(async () => original.focus())
  const observerCount = observers.length
  const compute = vi.spyOn(allocator, 'allocateFocusLaneColumns'), page = vi.spyOn(api.sessions, 'historyPage'), timeline = vi.spyOn(api.sessions, 'timeline'), catalog = vi.spyOn(api.sessions, 'historySources'), icon = vi.spyOn(api.workspaces, 'appearance')
  for (let i = 0; i < 200; i++) await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, unrelated: 'other-' + i } })))
  expect(compute).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled(); expect(timeline).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); expect(icon).not.toHaveBeenCalled()
  expect(listObservers()).toHaveLength(1); expect(observers).toHaveLength(observerCount); expect(card('work-0')).toBe(original); expect(document.activeElement).toBe(original); expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  const list = listObservers()[0]!
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' })); expect(list.disconnect).toHaveBeenCalledOnce()
})
it('a pointer gesture whose original card disappears cannot click the new neighbouring Session', async () => {
  await seed(2, 0, 0); await mount()
  const original = card('work-0')
  await act(async () => original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== 'work-0') })))
  expect(original.isConnected).toBe(false)
  const neighbour = card('work-1')
  await act(async () => neighbour.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  await act(async () => { neighbour.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); neighbour.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('work-1')
})
it('necessary wrapping retains one readable subcolumn and authoritative observation-loss qualification', async () => {
  measuredWidth = 320; await seed(1, 1, 1)
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, agent('offline', 'disconnected'), { ...agent('healthy-lost', 'disconnected'), processState: 'running' }] })))
  await mount()
  expect(columns()).toEqual([0, 1, 1, 1])
  expect(card('healthy-lost').closest('[data-bucket="idle"]')).not.toBeNull()
  expect(section('disconnected').querySelectorAll('.focus-context')).toHaveLength(0)
  expect(section('disconnected').querySelector('button')?.textContent).toBe('1')
})
// Counter transferred from the independent reviewer. Its private .tmp location
// could not resolve React (0 tests); this package-local test runs the original
// App Settings route, its original mounted Global and original Store instead.
it('actual App Settings pauses the retained Focus lane width observer without replacing its work surface', async () => {
  await act(async () => useAppStore.setState({ loading: false, initialize: async () => () => {}, activeWorkspaceId: 'repo', layouts: {} }))
  await seed(2, 1, 1)
  await act(async () => root.render(createElement(App)))
  const list = container.querySelector<HTMLElement>('.focus-project-board__live > .focus-project-lanes .focus-project-lanes__rows')!
  const originalCard = card('work-0'), originalSessions = useAppStore.getState().sessions, originalDrafts = useAppStore.getState().agentComposerDrafts
  expect(list).not.toBeNull(); expect(originalCard).not.toBeNull()
  expect(groups().querySelectorAll('.focus-context')).toHaveLength(4)
  const active = listObservers().filter(observer => observer.observe.mock.calls.some(([element]) => element === list))
  expect(active).toHaveLength(1); expect(active[0]!.disconnect).not.toHaveBeenCalled()
  const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
  expect(settings).not.toBeNull()
  await act(async () => settings.click())
  expect(container.querySelector('.settings-page')).not.toBeNull()
  const workspace = container.querySelector('.app-shell__workspace')!
  expect(workspace.getAttribute('aria-hidden')).toBe('true'); expect(workspace.hasAttribute('inert')).toBe(true)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(list.isConnected).toBe(true); expect(card('work-0')).toBe(originalCard)
  expect(useAppStore.getState().sessions).toBe(originalSessions); expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
  expect(active[0]!.disconnect).toHaveBeenCalledOnce()
  // A disconnected observer cannot deliver new widths while Settings owns the
  // screen. The existing allocator remains dormant through unrelated updates.
  const compute = vi.spyOn(allocator, 'allocateFocusLaneColumns')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, unrelated: 'Settings open' } })))
  expect(compute).not.toHaveBeenCalled(); expect(listObservers()).toHaveLength(1)
})
