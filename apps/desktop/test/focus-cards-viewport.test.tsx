// @vitest-environment happy-dom
import { act, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createFocusProjectionSelector, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { createFocusCardViewport, FocusContextCards } from '../src/renderer/src/components/FocusContextCards'
import type { FocusAgentReveal } from '../src/renderer/src/lib/focus-agent-navigation'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

vi.mock(import('../src/renderer/src/components/AgentAvatar'), async importOriginal => ({ ...await importOriginal(), AgentAvatar: () => <span /> }))
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, contexts: readonly FocusContext[]
let columns = 3, start = 0, viewport = 240
const tall = new Set<string>()
const slotGeometryReads: HTMLElement[] = []
const groupGeometryReads: HTMLElement[] = []
const viewportGeometryReads: HTMLElement[] = []
const observed: Element[] = [], unobserved: Element[] = []
const observers: { callback: IntersectionObserverCallback; targets: Set<Element>; options: IntersectionObserverInit }[] = []
const select = vi.fn(), noLinks = new Map(), noIdentities = new Map()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); columns = 3; start = 0; viewport = 240; select.mockClear(); observers.length = 0; tall.clear(); slotGeometryReads.length = 0; groupGeometryReads.length = 0
  viewportGeometryReads.length = 0; observed.length = 0; unobserved.length = 0
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number]
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { this.record = { callback, targets: new Set(), options }; observers.push(this.record) }
    observe(element: Element) { this.record.targets.add(element); observed.push(element) }
    unobserve(element: Element) { this.record.targets.delete(element); unobserved.push(element) }
    disconnect() { this.record.targets.clear() }
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('test-scroll') ? viewport : 52 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('test-scroll') ? viewport : 52 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = start - (this.closest<HTMLElement>('.test-scroll')?.scrollTop ?? 0)
    if (this.classList.contains('focus-context-group__cards')) { groupGeometryReads.push(this); return new DOMRect(0, top, 600, Math.ceil(contexts.length / columns) * 54) }
    if (this.dataset.focusCardBody) {
      slotGeometryReads.push(this)
      const siblings = [...this.parentElement!.children] as HTMLElement[], index = siblings.indexOf(this), row = Math.floor(index / columns)
      const rowHeight = (position: number) => siblings.slice(position * columns, (position + 1) * columns).some(slot => tall.has(JSON.parse(slot.dataset.focusCardKey!)[1])) ? 180 : 52
      const offset = Array.from({ length: row }, (_, position) => rowHeight(position) + 2).reduce((sum, height) => sum + height, 0)
      return new DOMRect(index % columns * 200, top + offset, 200, rowHeight(row))
    }
    if (this.classList.contains('test-scroll') || this.classList.contains('test-outer-scroll')) viewportGeometryReads.push(this)
    return new DOMRect(0, 0, 600, viewport)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const sessions = Array.from({ length: 279 }, (_, index) => composerSession(`viewport-owner-${index}`))
  useAppStore.setState({ ...baseline, config: composerConfig, sessions, tabs: {}, layouts: {}, timelines: {}, mainSurface: 'agents',
    agentNames: Object.fromEntries(sessions.map((session, index) => [session.id, `Original Agent ${index}`])), agentComposerDrafts: { original: 'Original unsent draft' } }, true)
  contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  expect(contexts).toHaveLength(279)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function Scene({ order = contexts, visible = true, layoutReady = true, other, otherVisible = true, outerScroll = false, reveal, onRevealed }: {
  order?: readonly FocusContext[]; visible?: boolean; layoutReady?: boolean
  other?: readonly FocusContext[]; otherVisible?: boolean; outerScroll?: boolean
  reveal?: FocusAgentReveal; onRevealed?: (id: string) => void
}) {
  const inner = useRef<HTMLDivElement>(null), outer = useRef<HTMLDivElement>(null)
  const [cardViewport] = useState(createFocusCardViewport)
  const scrollRef = outerScroll ? outer : inner
  // Keep the same surface owner that original cards consume for focus/menu.
  const presentation = useMemo(() => ({ active: visible, retainedRegionId: null }), [visible])
  return <WorkbenchPresentationContext.Provider value={presentation}><div ref={outer} className="test-outer-scroll"><div ref={inner} className="test-scroll focus-project-lanes__rows">
    <FocusContextCards contexts={order} viewport={cardViewport} scrollRef={scrollRef} visible={visible} layoutReady={layoutReady}
      revealRequest={reveal} onRevealed={onRevealed} selectedId={null} goalLinks={noLinks} identities={noIdentities} onSelect={select} />
    {other ? <FocusContextCards contexts={other} viewport={cardViewport} scrollRef={scrollRef} visible={visible && otherVisible}
      layoutReady={layoutReady} selectedId={null} goalLinks={noLinks} identities={noIdentities} onSelect={select} /> : null}
  </div></div><input aria-label="Later input" /></WorkbenchPresentationContext.Provider>
}
const full = () => [...container.querySelectorAll<HTMLElement>('.focus-context-group__cards > [data-focus-card-body="mounted"]')]
const realBodies = () => container.querySelectorAll('.focus-context-group__cards .focus-context__identity')
const slots = () => [...container.querySelectorAll<HTMLElement>('.focus-context-group__cards > [data-focus-card-body]')]
const button = (id: string) => container.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`)!
const render = (props: Parameters<typeof Scene>[0] = {}) => act(async () => { root.render(<Scene {...props} />) })
const intersection = (target: Element, isIntersecting = true, time = window.performance.now()) =>
  ({ target, isIntersecting, time }) as IntersectionObserverEntry
const intersect = () => {
  for (const observer of observers) {
    const entries = [...observer.targets].map(target => {
      const rect = target.getBoundingClientRect()
      return intersection(target, rect.bottom >= -104 && rect.top <= viewport + 104)
    })
    observer.callback(entries, {} as IntersectionObserver)
  }
}
const scrollTo = (top: number) => act(async () => {
  const scroll = container.querySelector<HTMLElement>('.test-scroll')!; scroll.scrollTop = top; scroll.dispatchEvent(new Event('scroll'))
  intersect()
})
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function menu(card: HTMLElement) {
  await act(async () => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })))
  await settle()
  return document.querySelector<HTMLElement>('.focus-context-menu')!
}

it('mounts only real initial viewport bodies before paint while preserving all 279 facts and selectable slots', async () => {
  const before = useAppStore.getState()
  await act(async () => {
    flushSync(() => root.render(<Scene />))
    expect(slots()).toHaveLength(279)
    expect(full().length, 'Actual body creation follows the viewport, not 279 facts').toBeGreaterThan(9)
    expect(full().length, 'Offscreen bodies are not eagerly created').toBeLessThan(40)
    expect(realBodies().length, 'Actual AgentContextContent bodies, not gate attributes').toBe(full().length)
    expect(slotGeometryReads.length, 'Initial geometry reads stop below the actual viewport').toBeLessThan(40)
    expect(slots().slice(0, 12).every(slot => slot.dataset.focusCardBody === 'mounted')).toBe(true)
  })
  const pending = slots().find(slot => slot.dataset.focusCardBody === 'pending')!, original = pending.querySelector<HTMLButtonElement>('button')!
  expect(original.getAttribute('aria-label')).toContain('Original Agent')
  await act(async () => original.click()); expect(select).toHaveBeenLastCalledWith(original.dataset.sessionId)
  await scrollTo(2200)
  expect(full().length).toBeGreaterThan(30); expect(full().length).toBeLessThan(80)
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('does not instantiate a distant one-row group until its actual scrollport intersection', async () => {
  contexts = contexts.slice(0, 1); start = 1800
  await render(); expect(slots()).toHaveLength(1); expect(full()).toHaveLength(0)
  expect(slotGeometryReads, 'An entirely distant grid has no per-slot synchronous reads').toHaveLength(0)
  await scrollTo(1700); expect(full()).toHaveLength(1)
  const original = button(contexts[0]!.id)
  await scrollTo(0); expect(button(contexts[0]!.id)).toBe(original)
  expect(full()).toHaveLength(1)
})

it.each([18, 279])('keeps viewport observation through live facts and sorting (%i slots)', async size => {
  contexts = contexts.slice(0, size)
  viewport = 145
  await render()
  const target = contexts[0]!, original = button(target.id)
  expect(slots()).toHaveLength(size)
  const originalSlots = new Map(slots().map(slot => [slot.dataset.focusCardKey, slot] as const))
  const reads = { viewport: viewportGeometryReads.length, group: groupGeometryReads.length, slot: slotGeometryReads.length }
  const registrations = { observers: observers.length, observed: observed.length, unobserved: unobserved.length }
  expect(reads.group).toBeGreaterThan(0); expect(reads.slot).toBeGreaterThan(0); expect(registrations.observed).toBeGreaterThan(0)
  for (const [name, activity] of [['First current name', 'waiting'], ['Second current name', 'running']] as const) {
    const at = Date.now()
    await act(async () => useAppStore.setState(state => ({
      agentNames: { ...state.agentNames, [target.id]: name },
      sessions: state.sessions.map(session => session.id !== target.id || session.kind !== 'agent' ? session : {
        ...session, status: { state: activity, source: 'native-hook', observedAt: at },
        semanticStatus: { state: activity, source: 'native-hook', observedAt: at, stateEnteredAt: at }
      })
    })))
    const next = createFocusProjectionSelector()(useAppStore.getState()).contexts.slice(0, size).reverse()
    if (name.startsWith('Second')) next.push(next.shift()!)
    await render({ order: next })
    expect(button(target.id)).toBe(original); expect(original.textContent).toContain(name)
    expect(original.dataset.state).toBe(activity)
    expect(slots().map(slot => JSON.parse(slot.dataset.focusCardKey!)[1])).toEqual(next.map(card => card.id))
    expect(slots().every(slot => originalSlots.get(slot.dataset.focusCardKey) === slot)).toBe(true)
  }
  expect(viewportGeometryReads.length, 'Live facts and sorting need no synchronous viewport measurement').toBe(reads.viewport)
  expect(groupGeometryReads.length, 'Live facts and sorting need no synchronous grid measurement').toBe(reads.group)
  expect(slotGeometryReads.length, 'Live facts and sorting need no synchronous slot measurement').toBe(reads.slot)
  expect(observers.length, 'The original observer still owns future intersections').toBe(registrations.observers)
  expect(observed, 'Retained slots must not be observed again').toHaveLength(registrations.observed)
  expect(unobserved, 'Retained slots must not be unobserved').toHaveLength(registrations.unobserved)
  await act(async () => intersect())
  expect(slots().slice(0, 12).every(slot => slot.dataset.focusCardBody === 'mounted')).toBe(true)
})

it('lets the original intersection owner reveal slots after a visited card changes height', async () => {
  const target = contexts[1]!
  tall.add(target.id); await render()
  const original = button(target.id), count = observers.length
  const before = full().length
  tall.delete(target.id)
  await render({ order: contexts.map(context => ({ ...context })) })
  await act(async () => intersect())
  const visible = slots().filter(slot => { const rect = slot.getBoundingClientRect(); return rect.bottom > 0 && rect.top < viewport })
  expect(visible.length).toBeGreaterThan(0)
  expect(visible.every(slot => slot.dataset.focusCardBody === 'mounted')).toBe(true)
  expect(full().length).toBeGreaterThan(before)
  expect(button(target.id)).toBe(original)
  expect(observers.length).toBe(count)
})

it('synchronously reveals newly inserted visible slots without waiting for an intersection delivery', async () => {
  await render({ order: contexts.slice(0, 3) })
  expect(full()).toHaveLength(3)
  const original = button(contexts[0]!.id)
  await render()
  expect(slots()).toHaveLength(279)
  expect(slots().slice(0, 12).every(slot => slot.dataset.focusCardBody === 'mounted')).toBe(true)
  expect(button(contexts[0]!.id)).toBe(original)
})

it('consumes real viewport intersection after resize without an idle preload', async () => {
  await render(); const mounted = full().length
  viewport = 640
  await act(async () => {
    intersect()
  })
  expect(full().length).toBeGreaterThan(mounted)
  expect(slots().slice(0, 33).every(slot => slot.dataset.focusCardBody === 'mounted')).toBe(true)
  expect(full().length).toBeLessThan(70)
})

it('uses actual slots after column/order changes when a visited tall card occupies a non-head column', async () => {
  await render()
  const target = contexts[1]!, original = button(target.id)
  tall.add(target.id)
  const order = [contexts[100]!, target, contexts[101]!, contexts[2]!, ...contexts.filter(context => ![target.id, contexts[100]!.id, contexts[101]!.id, contexts[2]!.id].includes(context.id))]
  columns = 2; await render({ order }); await scrollTo(160)
  const visible = slots().filter(slot => { const rect = slot.getBoundingClientRect(); return rect.bottom > 0 && rect.top < viewport })
  expect(visible.length).toBeGreaterThan(2)
  expect(visible.every(slot => slot.dataset.focusCardBody === 'mounted')).toBe(true)
  expect(visible.every(slot => slot.querySelector('.focus-context__identity'))).toBe(true)
  expect(button(target.id)).toBe(original)
})

it('reveals a displaced later grid through IO even though its own dimensions and the total scroll content size do not change', async () => {
  contexts = contexts.slice(0, 1); start = 1800; await render()
  expect(full()).toHaveLength(0)
  const observer = observers.find(observer => observer.targets.size)!
  expect(observer.options.root).toBe(container.querySelector('.test-scroll')); expect(observer.options.rootMargin).toBe('104px 0px')
  // A preceding lane shrinks while a following lane grows by the same amount.
  // There is no render/resize/scroll event here, only the browser's intersection.
  start = 100; await act(async () => intersect())
  expect(full()).toHaveLength(1); expect(realBodies()).toHaveLength(1)
})

it('rejects queued intersections after hide and keeps already visited bodies', async () => {
  await render(); const pending = slots().at(-1)!, active = observers.find(observer => observer.targets.has(pending))!, count = full().length
  await render({ visible: false })
  await act(async () => active.callback([intersection(pending)], {} as IntersectionObserver))
  expect(full()).toHaveLength(count); expect(pending.dataset.focusCardBody).toBe('pending')
})

it('shares the actual scrollport across grids and registers only added and removed slots', async () => {
  start = 1800
  const first = contexts.slice(0, 3), other = contexts.slice(3, 6)
  await render({ order: first, other })
  const original = button(first[0]!.id), removed = slots()[1]!, sibling = slots()[4]!
  expect(observers).toHaveLength(1)
  const owner = observers[0]!
  expect(owner.targets.size).toBe(6)
  expect(owner.options.root).toBe(container.querySelector('.test-scroll'))

  await render({ order: [first[0]!, contexts[6]!, first[2]!], other })
  const added = slots()[1]!
  expect(button(first[0]!.id)).toBe(original)
  expect(sibling).toBe(slots()[4])
  expect(observers).toHaveLength(1)
  expect(observed).toHaveLength(7)
  expect(observed.at(-1)).toBe(added)
  expect(unobserved).toHaveLength(1)
  expect(unobserved[0]).toBe(removed)
  expect(owner.targets.size).toBe(6)
  expect(owner.targets.has(removed)).toBe(false)
  await act(async () => owner.callback([intersection(removed), intersection(added)], {} as IntersectionObserver))
  expect(added.dataset.focusCardBody).toBe('mounted')
  expect(sibling.dataset.focusCardBody).toBe('pending')
})

it('rejects a hidden grid’s earlier queued record after its slot rejoins the shared observation', async () => {
  start = 1800
  const order = contexts.slice(0, 3), other = contexts.slice(3, 6)
  await render({ order, other })
  const sibling = slots()[0]!, pending = slots().at(-1)!, owner = observers[0]!
  const stale = intersection(pending)
  await render({ order, other, otherVisible: false })
  expect(owner.targets.has(pending)).toBe(false)
  expect(owner.targets.has(sibling)).toBe(true)
  await render({ order, other })
  expect(slots().at(-1)).toBe(pending)
  expect(observers).toHaveLength(1)
  expect(owner.targets.has(pending)).toBe(true)
  await act(async () => owner.callback([stale], {} as IntersectionObserver))
  expect(pending.dataset.focusCardBody).toBe('pending')
  await act(async () => owner.callback([intersection(pending)], {} as IntersectionObserver))
  expect(pending.dataset.focusCardBody).toBe('mounted')
})

it('binds the same pending slot to the changed physical scrollport and rejects the previous owner', async () => {
  start = 1800
  await render()
  const original = slots().at(-1)!, old = observers[0]!
  await render({ outerScroll: true })
  const next = observers[1]!
  expect(slots().at(-1)).toBe(original)
  expect(old.targets.size).toBe(0)
  expect(next.options.root).toBe(container.querySelector('.test-outer-scroll'))
  expect(next.targets.has(original)).toBe(true)
  await act(async () => old.callback([intersection(original)], {} as IntersectionObserver))
  expect(original.dataset.focusCardBody).toBe('pending')
  await act(async () => next.callback([intersection(original)], {} as IntersectionObserver))
  expect(original.dataset.focusCardBody).toBe('mounted')
})

it('measures only the exact requested card and scrollport for an explicit offscreen reveal', async () => {
  await render()
  const target = contexts.at(-1)!, requested = slots().at(-1)!, rows = container.querySelector<HTMLElement>('.test-scroll')!
  const original = button(contexts[0]!.id), onRevealed = vi.fn(), scroll = vi.spyOn(rows, 'scrollBy')
  const owner = observers.find(observer => observer.targets.has(requested))!
  expect(owner).toBeDefined()
  const reads = { viewport: viewportGeometryReads.length, group: groupGeometryReads.length, slot: slotGeometryReads.length }
  await render({ reveal: { requestId: 'requested-agent', hostId: target.hostId, agentSessionId: target.id, pending: true }, onRevealed })
  expect(requested.dataset.focusCardBody).toBe('mounted')
  expect(requested.querySelector('.focus-context__identity')).not.toBeNull()
  expect(button(contexts[0]!.id)).toBe(original)
  expect(viewportGeometryReads.slice(reads.viewport)).toEqual([rows])
  expect(groupGeometryReads).toHaveLength(reads.group)
  expect(slotGeometryReads.slice(reads.slot)).toEqual([requested])
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: expect.any(Number), left: 0, behavior: 'instant' })
  expect(onRevealed).toHaveBeenCalledExactlyOnceWith('requested-agent')
  expect(owner.targets.has(requested)).toBe(false)
})

it('keeps ordinary pointer activation on the exact placeholder without replacing its mousedown focus target', async () => {
  await render(); const pending = slots().at(-1)!, original = pending.querySelector<HTMLButtonElement>('button')!
  await act(async () => {
    const down = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    original.dispatchEvent(down)
    // Browser default focus only runs if mousedown is not cancelled.
    if (!down.defaultPrevented) original.focus()
    expect(original.isConnected).toBe(true)
    original.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })); original.click()
  })
  expect(select).toHaveBeenCalledExactlyOnceWith(original.dataset.sessionId)
})

it('retains visited card DOM and the same rename draft through scroll, columns, sorting and hide/reveal', async () => {
  await render(); const target = contexts[1]!, original = button(target.id)
  const rename = [...(await menu(original)).querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Rename Agent')!
  await act(async () => rename.click()); await settle()
  const input = container.querySelector<HTMLInputElement>('.focus-context__rename')!
  expect(input).not.toBeNull(); expect(document.activeElement).toBe(input)
  await scrollTo(2600)
  expect(container.querySelector('.focus-context__rename')).toBe(input)
  columns = 2; await render({ order: [...contexts].reverse() })
  expect(container.querySelector('.focus-context__rename')).toBe(input); expect(document.activeElement).toBe(input)
  await render({ order: [...contexts].reverse(), visible: false }); await render({ order: [...contexts].reverse() })
  expect(container.querySelector('.focus-context__rename')).toBe(input)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
  expect(document.activeElement).toBe(button(target.id)); expect(useAppStore.getState().agentNames[target.id]).toBe(target.name)
})

it.each(['focus', 'contextmenu'] as const)('upgrades a never-seen exact slot on %s and hands focus/menu to the original owner', async method => {
  await render()
  const pending = slots().at(-1)!, placeholder = pending.querySelector<HTMLButtonElement>('button')!, id = placeholder.dataset.sessionId!
  expect(pending.dataset.focusCardBody).toBe('pending')
  const stop = vi.spyOn(api.sessions, 'stop'), restart = vi.spyOn(api.sessions, 'restart')
  if (method === 'focus') {
    await act(async () => placeholder.focus())
    expect(document.activeElement).toBe(button(id)); expect(button(id)).not.toBe(placeholder)
    await act(async () => button(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })))
    await settle()
  } else await menu(placeholder)
  const opened = document.querySelector<HTMLElement>('.focus-context-menu')!
  expect(opened).not.toBeNull(); expect(opened.dataset.agentSessionId).toBe(id)
  expect(pending.dataset.focusCardBody).toBe('mounted')
  await act(async () => opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
  expect(document.activeElement).toBe(button(id)); expect(select).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled()
})

it('keeps the original usable bodies when actual viewport dimensions are unavailable', async () => {
  viewport = 0; await render({ layoutReady: false }); expect(full()).toHaveLength(279)
})

it('creates the first body tree only after the original column owner has resolved its real layout', async () => {
  columns = 1; await render({ layoutReady: false })
  expect(realBodies()).toHaveLength(0); expect(slotGeometryReads).toHaveLength(0)
  columns = 3
  await act(async () => {
    flushSync(() => root.render(<Scene layoutReady />))
    expect(realBodies().length).toBeGreaterThan(9); expect(realBodies().length).toBeLessThan(40)
    expect(slots().slice(0, 12).every(slot => slot.querySelector('.focus-context__identity'))).toBe(true)
  })
})

it('keeps every original usable body when IntersectionObserver is unavailable', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  await render({ layoutReady: false }); expect(realBodies()).toHaveLength(279)
})
