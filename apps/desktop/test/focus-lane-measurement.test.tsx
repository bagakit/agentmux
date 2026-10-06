// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { allocateFocusLaneColumns } from '../src/renderer/src/lib/focus-lane-layout'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, width: number
const observers: Array<{ notify: () => void; target?: Element; disconnected: boolean }> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  width = 1000; observers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    record: typeof observers[number]
    constructor(notify: () => void) { this.record = { notify, disconnected: false }; observers.push(this.record) }
    observe(target: Element) { this.record.target = target }
    disconnect() { this.record.disconnected = true }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () { return width })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 500))
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const base = snapshot.sessions.find(session => session.kind === 'agent')!
  const workspace = { id: 'project', name: 'Original project', hostId: 'local', path: fixturePath('project'), kind: 'folder' as const }
  const session = { ...base, id: 'original', workspacePath: workspace.path, hostId: 'local',
    control: { ...base.control, agentSessionId: 'original' } }
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
  useAppStore.setState({ config: { ...config, workspaces: [workspace] }, sessions: [session], timelines: {}, tabs: {}, layouts: {}, agentNames: {}, scratchTopicSnapshots: {},
    mainSurface: 'agents', agentComposerDrafts: { original: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [{ sessionId: 'original', focusedAt: Date.now(), identity: { kind: 'agent', name: 'Original investigation', providerId: 'codex', hostId: 'local', workspacePath: workspace.path, project: { id: workspace.id, name: workspace.name } } }] }, pmo: { sessionId: null } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const groups = () => container.querySelector<HTMLElement>('.focus-project-lanes__groups')!
const render = () => act(async () => root.render(createElement(GlobalFocusSurface)))

it('keeps provisional cards readable until a real positive width exists', () => {
  const counts = [0, 1, 8, 2] as const, metrics = { width: 0, padding: 4, gap: 2, cardGap: 2 }
  expect(allocateFocusLaneColumns(counts, metrics).widths).toEqual([0, 180, 180, 180])
  expect(allocateFocusLaneColumns(counts, { ...metrics, width: 176 }).widths).toEqual([0, 172, 172, 172])
  expect(allocateFocusLaneColumns(counts, { ...metrics, width: 500 }).widths).toEqual([0, 247, 247, 320])
})

it('measures late cards after retained-only headings without needing a resize callback', async () => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: [] })
  await render()
  expect(container.querySelector('.focus-project-lanes__rows')).not.toBeNull()
  expect(groups()).toBeNull()
  await act(async () => useAppStore.setState({ sessions }))
  expect(Number(groups().dataset.focusCardSlots)).toBeGreaterThan(1)
  const card = container.querySelector('[data-session-id="original"]')
  const active = observers.filter(observer => !observer.disconnected && observer.target?.matches('.focus-project-lanes__rows'))
  expect(active).toHaveLength(1)
  width = 500
  await act(async () => active[0]!.notify())
  expect(groups().dataset.focusCardSlots).toBe('2')
  expect(container.querySelector('[data-session-id="original"]')).toBe(card)
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Original unsent draft')
})

it('starts observation when an empty scan gains cards and resumes it when shown again', async () => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: [], agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  await render()
  expect(groups()).toBeNull()
  await act(async () => useAppStore.setState({ sessions }))
  expect(Number(groups().dataset.focusCardSlots)).toBeGreaterThan(1)
  const card = container.querySelector('[data-session-id="original"]')
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  expect(observers.filter(observer => !observer.disconnected && observer.target?.matches('.focus-project-lanes__rows'))).toHaveLength(0)
  width = 500
  await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
  expect(groups().dataset.focusCardSlots).toBe('2')
  expect(container.querySelector('[data-session-id="original"]')).toBe(card)
})
