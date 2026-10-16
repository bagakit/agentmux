// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch, fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { DEFAULT_FOCUS_RULER, focusDateCandidates, focusRulerLabels, focusRulerTicks, type FocusRulerPreferences } from '../src/renderer/src/lib/focus-timeline-ruler'
import rulerStyles from '../src/renderer/src/styles/focus-timeline-ruler.css?raw'

const baseline = useAppStore.getState(), now = _tailFixtureEpoch(1, 12 * 60 * 60)
const entries: AgentFocusHistoryEntry[] = [{ sessionId: 'original-context', focusedAt: now - 60_000,
  identity: { kind: 'agent', name: 'Original context', hostId: 'local', providerId: 'claude', workspacePath: _tailFixturePath("private/original-project") } }]
let root: Root | undefined, host: HTMLElement | undefined, stylesheet: HTMLStyleElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; host?.remove(); host = undefined; stylesheet?.remove(); stylesheet = undefined
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})

async function fixture(initialVisible = true, options: { now?: number; ruler?: Partial<FocusRulerPreferences>; labelWidth?: (node: Element) => number } = {}) {
  const fixtureNow = options.now ?? now
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(fixtureNow)
  let documentVisible = true, width = 800
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => documentVisible ? 'visible' : 'hidden')
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  useAppStore.setState({ config: null, sessions: [], tabs: {}, timelines: {}, focusTimelineNameWidth: 320, focusTimelineHeight: 168,
    focusTimelineRuler: { ...DEFAULT_FOCUS_RULER, timeZone: 'UTC', ...options.ruler }, agentComposerDrafts: { original: 'Original unsent draft' } })
  stylesheet = document.createElement('style'); stylesheet.textContent = rulerStyles; document.head.append(stylesheet)
  const labelWidths = new Map<Element, number>()
  const observers: ControlledResizeObserver[] = []
  class ControlledResizeObserver {
    targets = new Set<Element>(); disconnected = false
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.disconnected = true }
  }
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
  const geometry = (node: Element): DOMRect => {
    const timeline = node.closest<HTMLElement>('.recent-focus'), name = Number.parseFloat(timeline?.style.getPropertyValue('--focus-name-width') || '320')
    const scaleWidth = Math.max(0, width - name - 24), scaleLeft = 100 + name
    if (node.classList.contains('recent-focus')) return new DOMRect(100, 0, width, 168)
    if (node.classList.contains('recent-focus__gutter')) return new DOMRect(100, 0, name, 18)
    if (node.classList.contains('recent-focus__time-scale')) return new DOMRect(scaleLeft, 0, scaleWidth, 18)
    if (node.matches('.recent-focus__tick > time')) {
      // RO supplies the platform's real font/padding width. Actual production
      // CSS consumes the measured offset; the fixture owns no edge formula.
      const labelWidth = labelWidths.get(node) ?? options.labelWidth?.(node) ?? 90, x = Number.parseFloat((node.parentElement as HTMLElement).style.left) / 100 * scaleWidth
      const actualTransform = getComputedStyle(node).transform
      const transform = actualTransform.match(/^translateX\(\s*([-\d.]+)(px|%)\s*\)$/)
      expect(transform, `The original ruler CSS consumes the measured offset: ${JSON.stringify(actualTransform)}`).not.toBeNull()
      const offset = Number(transform![1]) * (transform![2] === '%' ? labelWidth / 100 : 1)
      const left = scaleLeft + x + offset
      return new DOMRect(left, 1, labelWidth, 12)
    }
    return new DOMRect(0, 0, width, node.classList.contains('recent-focus__header') ? 28 : 600)
  }
  const measurementReads: Element[] = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.recent-focus, .recent-focus__ruler > .recent-focus__gutter, .recent-focus__time-scale, .recent-focus__tick > time')) measurementReads.push(this)
    return geometry(this)
  })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  const onSelect = vi.fn(), contexts: [] = [], observedEntries = entries.map(entry => ({ ...entry, focusedAt: fixtureNow - 60_000 }))
  const render = async (visible: boolean) => act(async () => root!.render(createElement(RecentFocusTimeline, { visible, contexts, entries: observedEntries, currentSessionId: null, onSelect })))
  await render(initialVisible)
  const timeline = host.querySelector<HTMLElement>('.recent-focus')!
  const measurementObservers = () => observers.filter(observer => !observer.disconnected && [...observer.targets].some(node => node === timeline || node.matches('.recent-focus__time-scale, .recent-focus__tick > time')))
  const deliver = (observer: ControlledResizeObserver, zero = false, targets = [...observer.targets], borderBoxes = true) => observer.callback(targets.map(target => {
    const rect = zero ? new DOMRect() : geometry(target)
    const style = getComputedStyle(target), edges = (['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const)
      .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0)
    const contentRect = new DOMRect(rect.x, rect.y, Math.max(0, rect.width - edges), rect.height)
    return { target, borderBoxSize: borderBoxes ? [{ inlineSize: rect.width, blockSize: rect.height }] : [], contentBoxSize: [{ inlineSize: contentRect.width, blockSize: rect.height }], contentRect } as unknown as ResizeObserverEntry
  }), observer as unknown as ResizeObserver)
  const resize = async (nextWidth = width) => {
    width = nextWidth
    // ResizeObserver's first delivery follows layout. A state-driven label set
    // may install a new observer; deliver those initial entries as well.
    for (let round = 0; round < 4; round++) await act(async () => { for (const observer of measurementObservers()) deliver(observer) })
  }
  const button = (label: string) => host!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  const click = async (label: string) => act(async () => button(label).click())
  const key = async (key: string) => act(async () => host!.querySelector('[aria-label="Resize timeline names"]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  const range = () => [timeline.dataset.windowStart, timeline.dataset.windowEnd]
  return { timeline, render, resize, observers, measurementObservers, measurementReads, deliver, geometry, click, key, range, onSelect, labelWidths,
    documentVisibility: async (visible: boolean) => act(async () => { documentVisible = visible; document.dispatchEvent(new Event('visibilitychange')) }) }
}

it.each([false, true])('the first actual ruler RO reveals correct labels without a second observer cycle (split delivery: %s)', async split => {
  const h = await fixture(true, { labelWidth: () => 32 })
  const initial = [...host!.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
  expect(initial.length, 'Original tick text must be measurable in the first layout').toBeGreaterThan(0)
  expect(initial.every(node => getComputedStyle(node).visibility === 'hidden'), 'Unmeasured text cannot overlap before the first RO').toBe(true)
  const observer = h.measurementObservers().find(observer => [...observer.targets].some(target => target.matches('.recent-focus__tick > time')))!
  const scale = host!.querySelector('.recent-focus__time-scale')!, bounds = h.geometry(scale)
  const window = { start: Number(h.range()[0]), end: Number(h.range()[1]) }
  const preferences = { ...DEFAULT_FOCUS_RULER, timeZone: 'UTC' }
  const expected = focusRulerLabels(focusRulerTicks(window, preferences), window, bounds.width)
  expect(expected.size).toBeGreaterThan(0)
  if (split) {
    await act(async () => h.deliver(observer, false, [scale]))
    expect(observer.disconnected, 'A scale-only delivery must not prune/reobserve unmeasured original labels').toBe(false)
    expect([...host!.querySelectorAll('.recent-focus__tick > time')]).toEqual(initial)
    expect(initial.every(node => getComputedStyle(node).visibility === 'hidden')).toBe(true)
    await act(async () => h.deliver(observer, false, initial))
  } else await act(async () => h.deliver(observer))
  const labels = [...host!.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
  expect(labels.every(node => initial.includes(node)), 'React preserves measured time nodes and their imperative placement').toBe(true)
  const visible = labels.filter(node => getComputedStyle(node).visibility === 'visible' && node.getAttribute('aria-hidden') !== 'true')
  expect(visible.map(node => Number(node.parentElement!.dataset.tickAt)).sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b))
  const rects = visible.map(h.geometry).sort((a, b) => a.left - b.left)
  rects.forEach((rect, index) => {
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left); expect(rect.right).toBeLessThanOrEqual(bounds.right)
    if (index) expect(rect.left).toBeGreaterThanOrEqual(rects[index - 1]!.right)
  })
  expect(visible.every(node => node.style.getPropertyValue('--focus-label-offset') !== '')).toBe(true)
  expect(h.measurementReads).toHaveLength(0)
})

it('inactive mounted timelines have zero width/ruler observers or rect work, including queued deliveries', async () => {
  const h = await fixture(false)
  expect.soft(h.measurementObservers(), 'Inactive timeline measurement observers').toHaveLength(0)
  expect.soft(h.measurementReads, 'Inactive timeline measurement rect reads').toHaveLength(0)
  await h.render(true); await h.resize()
  expect(h.measurementObservers()).toHaveLength(2); expect(h.measurementReads).toHaveLength(0)
  const active = h.measurementObservers(), tickStyle = host!.querySelector<HTMLElement>('.recent-focus__tick')!.style.cssText
  const labels = [...host!.querySelectorAll<HTMLElement>('.recent-focus__tick > time')], labelStyles = labels.map(node => node.style.cssText)
  const segment = host!.querySelector<HTMLElement>('.recent-focus__segment')!, facts = [segment.dataset.focusedAt, segment.dataset.knownEnd]
  expect(facts[0]).toBe(String(entries[0]!.focusedAt))
  const viewport = host!.querySelector<HTMLElement>('.recent-focus__viewport')!; viewport.scrollTop = 24; viewport.scrollLeft = 12
  const selection = window.getSelection()!, reading = document.createRange(); reading.selectNodeContents(segment.firstChild!)
  selection.removeAllRanges(); selection.addRange(reading); const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  await h.render(false); h.measurementReads.length = 0
  await h.resize(640)
  for (const label of labels) h.labelWidths.set(label, 140)
  expect(h.measurementObservers(), 'Inactive timeline measurement observers after hide').toHaveLength(0)
  await act(async () => { for (const observer of active) { h.deliver(observer, true); h.deliver(observer) } })
  expect(h.measurementReads, 'Queued inactive timeline rect reads').toHaveLength(0)
  expect(host!.querySelector<HTMLElement>('.recent-focus__tick')!.style.cssText).toBe(tickStyle)
  expect(labels.map(node => node.style.cssText)).toEqual(labelStyles)
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('320px')
  expect(host!.querySelector('.recent-focus__segment')).toBe(segment)
  expect([segment.dataset.focusedAt, segment.dataset.knownEnd]).toEqual(facts)
  expect(selection.toString()).toBe(selected); expect([viewport.scrollTop, viewport.scrollLeft]).toEqual([24, 12])
})

it('hidden document and collapsed mode stop observers, retaining widths until accurate resize on reveal', async () => {
  const h = await fixture(); await h.resize(320)
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('136px')
  const before = h.range(), draft = useAppStore.getState().agentComposerDrafts
  const active = h.measurementObservers()
  await h.documentVisibility(false); expect(h.measurementObservers(), 'Hidden document measurement observers').toHaveLength(0)
  h.measurementReads.length = 0
  await act(async () => { for (const observer of active) h.deliver(observer) })
  expect(h.measurementReads).toHaveLength(0)
  await h.documentVisibility(true); await h.resize(800)
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('320px')
  await h.click('Collapse focus history'); expect(h.measurementObservers(), 'Collapsed measurement observers').toHaveLength(0)
  await h.resize(320); expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('320px')
  await h.click('Show focus history'); await h.resize(320)
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('136px')
  expect(useAppStore.getState().focusTimelineNameWidth).toBe(320)
  expect(h.range()).toEqual(before); expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
})

it('RO geometry keeps ruler labels bounded and disjoint at narrow/wide widths while original controls and range work', async () => {
  const h = await fixture(), before = h.range(), draft = useAppStore.getState().agentComposerDrafts
  expect(h.measurementReads, 'Visible mount waits for existing RO layout sizes').toHaveLength(0)
  for (const width of [320, 800, 400]) {
    await h.resize(width)
    const scale = host!.querySelector('.recent-focus__time-scale')!, bounds = h.geometry(scale)
    const labels = [...host!.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
    const accepted = labels.filter(node => node.getAttribute('aria-hidden') !== 'true').map(h.geometry).sort((a, b) => a.left - b.left)
    expect(accepted.length).toBeGreaterThan(0)
    if (width === 800) expect(labels.some(node => node.getAttribute('aria-hidden') === 'true')).toBe(true)
    for (let index = 0; index < accepted.length; index++) {
      expect(accepted[index]!.left).toBeGreaterThanOrEqual(bounds.left); expect(accepted[index]!.right).toBeLessThanOrEqual(bounds.right)
      if (index) expect(accepted[index]!.left).toBeGreaterThanOrEqual(accepted[index - 1]!.right)
    }
  }
  expect(h.measurementReads, 'Actual RO delivery never rereads ruler rects').toHaveLength(0)
  await h.resize(800); await h.key('Home'); expect(useAppStore.getState().focusTimelineNameWidth).toBe(96)
  await h.key('ArrowRight'); expect(useAppStore.getState().focusTimelineNameWidth).toBe(112)
  const handle = host!.querySelector<HTMLElement>('[aria-label="Resize timeline names"]')!
  await act(async () => handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 112, bubbles: true, cancelable: true })))
  await act(async () => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 180 })); await new Promise(requestAnimationFrame) })
  expect(h.timeline.style.getPropertyValue('--focus-name-width')).toBe('180px')
  expect(useAppStore.getState().focusTimelineNameWidth).toBe(112)
  await act(async () => window.dispatchEvent(new MouseEvent('mouseup')))
  expect(useAppStore.getState().focusTimelineNameWidth).toBe(180)
  expect(h.range()).toEqual(before); expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  await h.click('Previous focus window')
  expect(Number(h.range()[1])).toBeLessThan(Number(before[1]))
  await h.click('Return to current focus window'); expect(h.range()).toEqual(before)
  expect(host!.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(1)
})

it('uses variable real label border boxes and the actual CSS offset after a font-only RO delivery', async () => {
  const h = await fixture(); await h.resize(1000)
  const labels = [...host!.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
  expect(labels.length).toBeGreaterThan(2)
  const before = labels.map(node => node.style.getPropertyValue('--focus-label-offset'))
  labels.forEach((node, index) => h.labelWidths.set(node, index % 2 ? 180 : 42))
  const observer = h.measurementObservers().find(observer => [...observer.targets].some(target => target.matches('.recent-focus__tick > time')))!
  await act(async () => h.deliver(observer, false, labels))
  const bounds = h.geometry(host!.querySelector('.recent-focus__time-scale')!)
  const accepted = labels.filter(node => node.getAttribute('aria-hidden') !== 'true')
  expect(accepted.length).toBeGreaterThan(0)
  expect(labels.map(node => node.style.getPropertyValue('--focus-label-offset'))).not.toEqual(before)
  for (const node of labels) {
    const rect = h.geometry(node), tickX = Number.parseFloat(node.parentElement!.style.left) / 100 * bounds.width
    // Independent form of the original CSS clamp: min wins if the label is
    // wider than the scale. The production stylesheet uses only the RO offset.
    const oldCssOffset = Math.max(-tickX, Math.min(-rect.width / 2, bounds.width - tickX - rect.width))
    expect(rect.left - bounds.left).toBeCloseTo(tickX + oldCssOffset, 8)
  }
  const rects = accepted.map(h.geometry).sort((a, b) => a.left - b.left)
  rects.forEach((rect, index) => {
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left); expect(rect.right).toBeLessThanOrEqual(bounds.right)
    if (index) expect(rect.left).toBeGreaterThanOrEqual(rects[index - 1]!.right)
  })
  expect(h.measurementReads).toHaveLength(0)
  const offsets = labels.map(node => node.style.getPropertyValue('--focus-label-offset'))
  await act(async () => h.deliver(observer, false, labels, false))
  expect(labels.map(node => node.style.getPropertyValue('--focus-label-offset'))).toEqual(offsets)
  expect(labels.every(node => h.geometry(node).width > 0)).toBe(true)
})

it('retains both DST fold instants and UTC offsets while real long labels remain bounded at narrow and wide sizes', async () => {
  const zone = 'America/New_York', fold = focusDateCandidates(new Date(_tailFixtureEpoch(297, 60 * 60)).toISOString().slice(0, 16), zone)
  expect(fold).toHaveLength(2)
  const h = await fixture(true, { now: fold[1]!.instant + 60 * 60_000, ruler: { mode: 'uniform', timeZone: zone, intervalMinutes: 60, phaseMinutes: 0 },
    labelWidth: node => node.querySelector('small') ? node.textContent?.includes('−05:00') ? 180 : 150 : 72 })
  await h.resize(1600)
  const allTicks = () => [...host!.querySelectorAll<HTMLElement>('[data-tick-at]')].map(node => Number(node.dataset.tickAt))
  const original = allTicks(), labels = [...host!.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
  const repeated = labels.filter(node => node.querySelector('small'))
  expect(repeated).toHaveLength(2)
  expect(repeated.map(node => node.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('UTC−04:00'), expect.stringContaining('UTC−05:00')]))
  expect(repeated.map(node => Date.parse(node.dateTime))).toEqual(fold.map(value => value.instant))
  repeated.forEach((node, index) => h.labelWidths.set(node, 150 + index * 30))
  await h.resize(1600)
  expect(repeated.every(node => node.getAttribute('aria-hidden') !== 'true')).toBe(true)
  const range = h.range(), draft = useAppStore.getState().agentComposerDrafts
  for (const width of [400, 800, 1600]) {
    await h.resize(width)
    const bounds = h.geometry(host!.querySelector('.recent-focus__time-scale')!)
    const visible = [...host!.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')].filter(node => node.getAttribute('aria-hidden') !== 'true').map(h.geometry).sort((a, b) => a.left - b.left)
    expect(visible.length).toBeGreaterThan(0)
    visible.forEach((rect, index) => {
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left); expect(rect.right).toBeLessThanOrEqual(bounds.right)
      if (index) expect(rect.left).toBeGreaterThanOrEqual(visible[index - 1]!.right)
    })
    expect(allTicks()).toEqual(original); expect(h.range()).toEqual(range)
  }
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
  expect(h.measurementReads).toHaveLength(0)
})
