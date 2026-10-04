// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { LiquidSelectionSurface } from '../src/renderer/src/components/LiquidSelectionSurface'

let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function readingTree(visible: boolean, targetId: string | null, revision = 0) {
  return <>
    <div id="retained-home" /><div id="retained-next" />
    <StableWorkbenchView homeId="retained-home" targetId={targetId} active visible={visible} retainedRegionId={null}>
      <div data-workbench-reading-scroll>
        <p contentEditable suppressContentEditableWarning>Original unsent reading</p>
        <span data-unrelated-revision={revision} />
      </div>
    </StableWorkbenchView>
  </>
}

it('previously hidden reading commits skip container scans and reveal the same reader and draft', async () => {
  await act(async () => root.render(readingTree(false, null)))
  const host = container.querySelector<HTMLElement>('.retained-workbench-view')!
  const reader = host.querySelector<HTMLElement>('[data-workbench-reading-scroll]')!, input = reader.querySelector('p')!
  reader.scrollTop = 127; reader.scrollLeft = 9
  const scan = vi.spyOn(host, 'querySelectorAll')
  for (let revision = 1; revision <= 12; revision++) await act(async () => root.render(readingTree(false, null, revision)))
  await act(async () => root.render(readingTree(true, null, 13)))
  expect(scan.mock.calls.filter(([selector]) => selector === '[data-workbench-reading-scroll]')).toHaveLength(0)
  expect(container.querySelector('.retained-workbench-view')).toBe(host)
  expect(reader.querySelector('p')).toBe(input)
  expect(input.textContent).toBe('Original unsent reading')
  expect([reader.scrollTop, reader.scrollLeft]).toEqual([127, 9])
})

it.each(['none', 'wheel', 'selection'] as const)('outgoing visible reading survives a hidden reparent and immediate reveal without overriding later %s intent', async intent => {
  await act(async () => root.render(readingTree(true, null)))
  const reader = container.querySelector<HTMLElement>('[data-workbench-reading-scroll]')!, input = reader.querySelector<HTMLElement>('p')!, text = input.firstChild!
  const host = input.closest<HTMLElement>('.retained-workbench-view')!, next = container.querySelector<HTMLElement>('#retained-next')!
  const selection = document.getSelection()!
  const select = (start: number, end = start) => {
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end)
    selection.removeAllRanges(); selection.addRange(range)
  }
  input.focus(); select(4); reader.scrollTop = 127; reader.scrollLeft = 9
  const originalMove = next.moveBefore.bind(next)
  vi.spyOn(next, 'moveBefore').mockImplementation((node, before) => {
    originalMove(node, before)
    // Model Chromium resetting the original reader during a hidden/inert move.
    // The production snapshot must be captured before this native mutation.
    input.focus(); select(0); reader.scrollTop = 0; reader.scrollLeft = 0
    if (intent === 'wheel') { input.dispatchEvent(new Event('wheel', { bubbles: true })); select(2); reader.scrollTop = 31 }
    if (intent === 'selection') { select(2, 6); reader.scrollTop = 31 }
  })
  await act(async () => {
    flushSync(() => root.render(readingTree(false, 'retained-next')))
    // Reveal before the outgoing snapshot restoration microtask. Guarding by
    // new visible instead of previous visible loses the only original values.
    flushSync(() => root.render(readingTree(true, 'retained-next')))
  })
  expect(next.querySelector('.retained-workbench-view')).toBe(host)
  expect(next.querySelector('p')).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(input.textContent).toBe('Original unsent reading')
  expect(selection.anchorNode).toBe(text)
  expect(selection.anchorOffset).toBe(intent === 'none' ? 4 : 2)
  expect(selection.toString()).toBe(intent === 'selection' ? 'igin' : '')
  expect(reader.scrollTop).toBe(intent === 'none' ? 127 : 31)
  if (intent === 'none') expect(reader.scrollLeft).toBe(9)
})

function liquidFixture() {
  let reduced = false, width = 300, height = 100, intermediate: number | undefined
  const changes = new Set<() => void>(), resizes: ControlledResize[] = [], mutations: ControlledMutation[] = []
  class ControlledResize {
    readonly targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) { resizes.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    emit() { this.callback([], this as unknown as ResizeObserver) }
  }
  class ControlledMutation {
    observing = false
    constructor(private callback: MutationCallback) { mutations.push(this) }
    observe() { this.observing = true }
    disconnect() { this.observing = false }
    emit() { this.callback([], this as unknown as MutationObserver) }
  }
  vi.stubGlobal('ResizeObserver', ControlledResize); vi.stubGlobal('MutationObserver', ControlledMutation)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, get matches() { return reduced },
    addEventListener(_type: string, callback: () => void) { changes.add(callback) },
    removeEventListener(_type: string, callback: () => void) { changes.delete(callback) } } as MediaQueryList))
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.closest('[data-retained-selection]')) return originalRect.call(this)
    if (this.hasAttribute('data-retained-selection')) return new DOMRect(0, 0, width, height)
    const x = this.classList.contains('liquid-selection') && intermediate !== undefined ? intermediate : this.dataset.retainedChoice === 'second' ? 140 : 0
    return new DOMRect(x, 0, 120, 32)
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return this.closest('[data-retained-selection]') && !this.hidden && width > 0 && height > 0
      ? [this.getBoundingClientRect()] as unknown as DOMRectList : [] as unknown as DOMRectList
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-retained-selection') ? height : 0
  })
  const originalQuery = Element.prototype.querySelector
  const queries = vi.spyOn(Element.prototype, 'querySelector').mockImplementation(function (this: Element, selector: string) {
    return originalQuery.call(this, selector)
  })
  const animate = vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(() => ({ cancel: vi.fn() }) as unknown as Animation)
  const tree = (active: boolean, selected = 'first') => <div data-retained-selection>
    <LiquidSelectionSurface selected={selected} active={active} targetAttribute="data-retained-choice" />
    <button data-retained-choice="first">First original control</button><button data-retained-choice="second">Second original control</button>
  </div>
  const render = async (active: boolean, selected = 'first') => { await act(async () => root.render(tree(active, selected))) }
  const targetQueries = () => queries.mock.calls.filter(([selector]) => selector.startsWith('[data-retained-choice=')).length
  return { render, resizes, mutations, geometry, targetQueries, animate, changes, hidden,
    animationAt(x: number) { intermediate = x },
    resize(widthValue: number, heightValue = 100) { width = widthValue; height = heightValue },
    reduce(value: boolean) { reduced = value; changes.forEach(callback => callback()) } }
}

it('inactive liquid updates and disposed observer callbacks perform no target query or geometry', async () => {
  const fixture = liquidFixture()
  await fixture.render(false)
  for (let revision = 0; revision < 12; revision++) await fixture.render(false, revision % 2 ? 'first' : 'second')
  fixture.resizes.forEach(observer => observer.emit()); fixture.mutations.forEach(observer => observer.emit())
  expect(fixture.targetQueries()).toBe(0); expect(fixture.geometry).not.toHaveBeenCalled()
  expect(fixture.resizes.every(observer => observer.targets.size === 0)).toBe(true)
  expect(fixture.mutations.every(observer => !observer.observing)).toBe(true)
  await fixture.render(true)
  expect(container.querySelector<HTMLSpanElement>('.liquid-selection')!.hidden).toBe(false)
  expect(fixture.geometry.mock.calls.length).toBeGreaterThan(0)
  const resize = fixture.resizes.at(-1)!, mutation = fixture.mutations.at(-1)!
  await act(async () => root.unmount())
  fixture.geometry.mockClear(); const queries = fixture.targetQueries()
  resize.emit(); mutation.emit()
  expect(fixture.targetQueries()).toBe(queries); expect(fixture.geometry).not.toHaveBeenCalled()
  expect(resize.targets.size).toBe(0); expect(mutation.observing).toBe(false); expect(fixture.changes.size).toBe(0)
})

it('document-hidden liquid cancels animation without geometry and resumes its existing host once', async () => {
  const fixture = liquidFixture()
  await fixture.render(true); await fixture.render(true, 'second')
  expect(fixture.animate).toHaveBeenCalledTimes(1)
  const lens = container.querySelector<HTMLSpanElement>('.liquid-selection')!, resize = fixture.resizes.at(-1)!, mutation = fixture.mutations.at(-1)!
  fixture.geometry.mockClear(); const queries = fixture.targetQueries()
  fixture.hidden.mockReturnValue(true)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  resize.emit(); mutation.emit()
  expect(fixture.targetQueries()).toBe(queries); expect(fixture.geometry).not.toHaveBeenCalled()
  expect(lens.hidden).toBe(true); expect(lens.dataset.liquidPaused).toBe('true')
  expect(resize.targets.size).toBe(0); expect(mutation.observing).toBe(false)
  fixture.hidden.mockReturnValue(false)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('.liquid-selection')).toBe(lens)
  expect(lens.hidden).toBe(false); expect(lens.style.transform).toContain('140px, 0px')
  expect(resize.targets.size).toBe(2); expect(mutation.observing).toBe(true)
  expect(fixture.animate).toHaveBeenCalledTimes(1)
})

it('active liquid retains its zero-area resize sentinel, original animation and reduced-motion static bounds', async () => {
  const fixture = liquidFixture(); fixture.resize(0, 0)
  await fixture.render(true)
  const lens = container.querySelector<HTMLSpanElement>('.liquid-selection')!, host = lens.parentElement!, resize = fixture.resizes.at(-1)!, mutation = fixture.mutations.at(-1)!
  expect(lens.hidden).toBe(true); expect([...resize.targets]).toEqual([host]); expect(mutation.observing).toBe(false)
  fixture.resize(300)
  await act(async () => resize.emit())
  expect(lens.hidden).toBe(false); expect(resize.targets.size).toBe(2); expect(mutation.observing).toBe(true)
  await fixture.render(true, 'second')
  const [frames, options] = fixture.animate.mock.calls.at(-1)!
  expect(frames).toHaveLength(4)
  expect((frames as Keyframe[])[1]!.transform).toContain('scale(1.45, 0.93)')
  expect((frames as Keyframe[])[2]!.transform).toContain('142px, 0px')
  expect(options).toEqual({ duration: 420, easing: 'cubic-bezier(.22,.72,.2,1)' })
  fixture.animationAt(55)
  await fixture.render(true, 'first')
  expect((fixture.animate.mock.calls.at(-1)![0] as Keyframe[])[0]!.transform).toContain('55px, 0px')
  await act(async () => fixture.reduce(true))
  const animations = fixture.animate.mock.calls.length
  await fixture.render(true, 'second')
  expect(lens.hidden).toBe(false); expect(lens.style.transform).toContain('140px, 0px')
  expect(lens.dataset.liquidPaused).toBe('true'); expect(fixture.animate).toHaveBeenCalledTimes(animations)
  const resizeCalls = fixture.geometry.mock.calls.length
  await act(async () => fixture.resizes.at(-1)!.emit())
  expect(fixture.geometry.mock.calls.length).toBeGreaterThan(resizeCalls)
})
