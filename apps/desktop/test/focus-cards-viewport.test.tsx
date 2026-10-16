// @vitest-environment happy-dom
import { act, useMemo, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createFocusProjectionSelector, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { FocusContextCards } from '../src/renderer/src/components/FocusContextCards'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => <span /> }))
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement, contexts: readonly FocusContext[]
let columns = 3, start = 0, viewport = 240
const tall = new Set<string>()
const slotGeometryReads: HTMLElement[] = []
const observers: { callback: IntersectionObserverCallback; targets: Set<Element>; options: IntersectionObserverInit }[] = []
const select = vi.fn(), noLinks = new Map(), noIdentities = new Map()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); columns = 3; start = 0; viewport = 240; select.mockClear(); observers.length = 0; tall.clear(); slotGeometryReads.length = 0
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number]
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { this.record = { callback, targets: new Set(), options }; observers.push(this.record) }
    observe(element: Element) { this.record.targets.add(element) }
    unobserve(element: Element) { this.record.targets.delete(element) }
    disconnect() { this.record.targets.clear() }
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('test-scroll') ? viewport : 52 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('test-scroll') ? viewport : 52 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = start - (this.closest<HTMLElement>('.test-scroll')?.scrollTop ?? 0)
    if (this.classList.contains('focus-context-group__cards')) return new DOMRect(0, top, 600, Math.ceil(contexts.length / columns) * 54)
    if (this.dataset.focusCardBody) {
      slotGeometryReads.push(this)
      const siblings = [...this.parentElement!.children] as HTMLElement[], index = siblings.indexOf(this), row = Math.floor(index / columns)
      const rowHeight = (position: number) => siblings.slice(position * columns, (position + 1) * columns).some(slot => tall.has(JSON.parse(slot.dataset.focusCardKey!)[1])) ? 180 : 52
      const offset = Array.from({ length: row }, (_, position) => rowHeight(position) + 2).reduce((sum, height) => sum + height, 0)
      return new DOMRect(index % columns * 200, top + offset, 200, rowHeight(row))
    }
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
function Scene({ order = contexts, visible = true, layoutReady = true }: { order?: readonly FocusContext[]; visible?: boolean; layoutReady?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null)
  // Keep the same surface owner that original cards consume for focus/menu.
  const presentation = useMemo(() => ({ active: visible, retainedRegionId: null }), [visible])
  return <WorkbenchPresentationContext.Provider value={presentation}><div ref={scroll} className="test-scroll focus-project-lanes__rows">
    <FocusContextCards contexts={order} columns={columns} scrollRef={scroll} visible={visible} layoutReady={layoutReady} selectedId={null} goalLinks={noLinks} identities={noIdentities} onSelect={select} />
  </div><input aria-label="Later input" /></WorkbenchPresentationContext.Provider>
}
const full = () => [...container.querySelectorAll<HTMLElement>('.focus-context-group__cards > [data-focus-card-body="mounted"]')]
const realBodies = () => container.querySelectorAll('.focus-context-group__cards .focus-context__identity')
const slots = () => [...container.querySelectorAll<HTMLElement>('.focus-context-group__cards > [data-focus-card-body]')]
const button = (id: string) => container.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`)!
const render = (props: Parameters<typeof Scene>[0] = {}) => act(async () => { root.render(<Scene {...props} />) })
const intersect = () => {
  for (const observer of observers) {
    const entries = [...observer.targets].map(target => {
      const rect = target.getBoundingClientRect()
      return { target, isIntersecting: rect.bottom >= -104 && rect.top <= viewport + 104 } as IntersectionObserverEntry
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
  await act(async () => active.callback([{ target: pending, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(full()).toHaveLength(count); expect(pending.dataset.focusCardBody).toBe('pending')
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
