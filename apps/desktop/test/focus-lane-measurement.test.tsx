// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import * as allocator from '../src/renderer/src/lib/focus-lane-layout'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
// This suite isolates the original column measurement owner. The viewport
// consumer and its own real geometry observers have a separate mounted suite.
vi.mock('../src/renderer/src/components/FocusContextCards', async () => {
  const { FocusContextRow } = await import('../src/renderer/src/components/FocusContextRow')
  return { FocusContextCards: ({ contexts, selectedId, onSelect }: Parameters<typeof import('../src/renderer/src/components/FocusContextCards').FocusContextCards>[0]) =>
    <div className="focus-context-group__cards">{contexts.map(context => <FocusContextRow key={context.id} context={context} selected={selectedId === context.id} onSelect={onSelect} />)}</div> }
})
const initial = useAppStore.getState()
type Observer = { callback: ResizeObserverCallback; target?: Element; disconnected: boolean }
let root: Root, container: HTMLDivElement, style: HTMLStyleElement, documentVisible: boolean, physicalWidth: number
const observers: Observer[] = [], geometryReads: Element[] = [], styleReads: Element[] = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  observers.length = 0; geometryReads.length = 0; styleReads.length = 0; documentVisible = true; physicalWidth = 1000.5
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => documentVisible ? 'visible' : 'hidden')
  vi.stubGlobal('ResizeObserver', class {
    record: Observer
    constructor(callback: ResizeObserverCallback) { this.record = { callback, disconnected: false }; observers.push(this.record) }
    observe(target: Element) { this.record.target = target }
    disconnect() { this.record.disconnected = true }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.focus-project-lanes__rows, .focus-project-lanes__groups')) geometryReads.push(this)
    return physicalWidth
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.focus-project-lanes__rows, .focus-project-lanes__groups')) geometryReads.push(this)
    return new DOMRect(0, 0, 17, 500)
  })
  const computedStyle = globalThis.getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    if (node.matches('.focus-project-lanes__groups, .focus-context-group__cards')) styleReads.push(node)
    return computedStyle(node, pseudo)
  })
  style = document.createElement('style')
  style.textContent = '.focus-project-lanes__groups { padding-left: 3.5px; padding-right: 4.5px; column-gap: 3px } .focus-context-group__cards { column-gap: 5px }'
  document.head.append(style)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const base = snapshot.sessions.find(session => session.kind === 'agent')!
  const workspace = { id: 'project', name: 'Original project', hostId: 'local', path: fixturePath('project'), kind: 'folder' as const }
  const session = { ...base, id: 'original', workspacePath: workspace.path, hostId: 'local', control: { ...base.control, agentSessionId: 'original' } }
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
  useAppStore.setState({ config: { ...config, workspaces: [workspace] }, sessions: [session], timelines: {}, tabs: {}, layouts: {}, agentNames: {}, scratchTopicSnapshots: {},
    mainSurface: 'agents', agentComposerDrafts: { original: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [{ sessionId: 'original', focusedAt: Date.now(), identity: { kind: 'agent', name: 'Original investigation', providerId: 'codex', hostId: 'local', workspacePath: workspace.path, project: { id: workspace.id, name: workspace.name } } }] }, pmo: { sessionId: null } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); style.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const groups = () => container.querySelector<HTMLElement>('.focus-project-lanes__groups')!
const activeObservers = () => observers.filter(observer => !observer.disconnected && observer.target?.matches('.focus-project-lanes__rows'))
const render = (visible = true) => act(async () => root.render(<GlobalFocusSurface visible={visible} />))
const deliver = (observer: Observer, width: number) => observer.callback([{ target: observer.target!,
  contentRect: new DOMRect(0, 0, width, 500), borderBoxSize: [{ inlineSize: width + 20, blockSize: 500 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver)
const resize = (width: number) => act(async () => { if (width > 0) physicalWidth = width; for (const observer of activeObservers()) deliver(observer, width) })

it('keeps provisional cards readable until a real positive width exists', () => {
  const counts = [0, 1, 8, 2] as const, metrics = { width: 0, padding: 4, gap: 2, cardGap: 2 }
  expect(allocator.allocateFocusLaneColumns(counts, metrics).widths).toEqual([0, 180, 180, 180])
  expect(allocator.allocateFocusLaneColumns(counts, { ...metrics, width: 176 }).widths).toEqual([0, 172, 172, 172])
  expect(allocator.allocateFocusLaneColumns(counts, { ...metrics, width: 500 }).widths).toEqual([0, 247, 247, 320])
})

it('synchronously measures actual initial columns before paint, then consumes RO content sizes without another geometry read', async () => {
  const compute = vi.spyOn(allocator, 'allocateFocusLaneColumns')
  await render()
  const card = container.querySelector('[data-session-id="original"]')
  expect(card).not.toBeNull(); expect(groups().dataset.focusCardSlots).toBe('5')
  expect(geometryReads, 'One actual visible initial content width').toHaveLength(1)
  expect(styleReads, 'Visible initial actual CSS gaps').toHaveLength(2)
  expect(activeObservers()).toHaveLength(1)
  physicalWidth = 17 // Later observer contentRect, rather than another live geometry read, owns this width.
  await act(async () => { for (const observer of activeObservers()) deliver(observer, 1000.5) })
  expect(compute.mock.calls.at(-1)![1]).toEqual({ width: 1000.5, padding: 8, gap: 3, cardGap: 5 })
  expect(groups().dataset.focusCardSlots).toBe('5')
  await resize(363.5) // Content box excludes the observer's deliberately wider scroll-bar border box.
  expect(groups().dataset.focusCardSlots).toBe('1')
  expect(compute.mock.calls.at(-1)![1].width).toBe(363.5)
  style.textContent = '.focus-project-lanes__groups { padding-left: 10px; padding-right: 12px; column-gap: 7px } .focus-context-group__cards { column-gap: 9px }'
  await resize(500.25)
  expect(compute.mock.calls.at(-1)![1]).toEqual({ width: 500.25, padding: 22, gap: 7, cardGap: 9 })
  compute.mockClear(); const slots = groups().dataset.focusCardSlots, styles = styleReads.length
  await resize(0); await resize(500.25)
  expect(compute).not.toHaveBeenCalled(); expect(groups().dataset.focusCardSlots).toBe(slots)
  expect(styleReads.length).toBe(styles + 2)
  expect(geometryReads).toHaveLength(1)
  expect(container.querySelector('[data-session-id="original"]')).toBe(card)
})

it('starts first-size observation when retained-only headings or an empty scan gains real cards', async () => {
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ sessions: [] }); await render()
  expect(container.querySelector('.focus-project-lanes__rows')).not.toBeNull(); expect(groups()).toBeNull()
  expect(activeObservers()).toHaveLength(0)
  await act(async () => useAppStore.setState({ sessions }))
  expect(groups().dataset.focusCardSlots).toBe('5'); expect(activeObservers()).toHaveLength(1)
  await resize(1000.5); expect(groups().dataset.focusCardSlots).toBe('5')
  const card = container.querySelector('[data-session-id="original"]')
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  expect(activeObservers()).toHaveLength(0)
  await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
  expect(groups().dataset.focusCardSlots).toBe('5')
  await resize(500); expect(groups().dataset.focusCardSlots).toBe('2')
  expect(container.querySelector('[data-session-id="original"]')).toBe(card)
  expect(geometryReads).toHaveLength(2)
})

it('hidden surfaces and documents disconnect observers and reject queued sizes while retaining the original workface', async () => {
  await render(false); expect(activeObservers()).toHaveLength(0); expect(geometryReads).toHaveLength(0)
  await render(); await resize(1000.5)
  const card = container.querySelector<HTMLElement>('[data-session-id="original"]')!, rows = groups().closest<HTMLElement>('.focus-project-lanes__rows')!
  await act(async () => card.focus()); rows.scrollTop = 34; rows.scrollLeft = 12
  const reading = document.createRange(); reading.selectNodeContents(card); const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(reading); const selectedText = selection.toString()
  expect(selectedText.length).toBeGreaterThan(0)
  const before = useAppStore.getState(), active = activeObservers(), slots = groups().dataset.focusCardSlots
  await render(false); styleReads.length = 0
  await act(async () => { for (const observer of active) { deliver(observer, 0); deliver(observer, 363.5) } })
  expect(activeObservers()).toHaveLength(0); expect(styleReads).toHaveLength(0)
  expect(groups().dataset.focusCardSlots).toBe(slots)
  await render(); expect(groups().dataset.focusCardSlots).toBe(slots); styleReads.length = 0
  const revealed = activeObservers()
  await act(async () => { documentVisible = false; document.dispatchEvent(new Event('visibilitychange')) })
  expect(activeObservers()).toHaveLength(0)
  await act(async () => { for (const observer of revealed) deliver(observer, 363.5) })
  expect(styleReads).toHaveLength(0); expect(groups().dataset.focusCardSlots).toBe(slots)
  await act(async () => { documentVisible = true; document.dispatchEvent(new Event('visibilitychange')) })
  expect(activeObservers()).toHaveLength(1); expect(groups().dataset.focusCardSlots).toBe(slots)
  await resize(500); expect(groups().dataset.focusCardSlots).toBe('2')
  expect(container.querySelector('[data-session-id="original"]')).toBe(card)
  expect([rows.scrollTop, rows.scrollLeft]).toEqual([34, 12]); expect(selection.toString()).toBe(selectedText)
  expect(document.activeElement).toBe(card); expect(geometryReads).toHaveLength(3)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
