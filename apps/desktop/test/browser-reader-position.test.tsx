const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBrowserContextualComposer } from '../src/renderer/src/components/BrowserContextualComposer'
import { observeBrowserReader } from '../src/renderer/src/lib/browser-reader-position'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

type SizeFacts = { availableWidth: number; availableHeight: number }
type Middleware = { name: string; options: number | { padding: number; apply?: (facts: SizeFacts) => void } }
type PositionCall = {
  reference: unknown; surface: HTMLElement; placement: string
  apply: (availableWidth?: number, availableHeight?: number) => void
  complete: (x?: number, y?: number) => void
}
const layout = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  return { deferred: false, calls: [] as PositionCall[], subscriptions: [] as {
    reference: HTMLElement; surface: HTMLElement; update: () => void; stopped: boolean
  }[] }
})

// Only the external layout/observation port is controlled. Production callers,
// size.apply, display tickets, Portal, Store and the actual composer all run.
// These supplied rectangles and completions do not qualify native geometry.
vi.mock('@floating-ui/dom', () => ({
  autoUpdate(reference: HTMLElement, surface: HTMLElement, update: () => void) {
    const subscription = { reference, surface, update, stopped: false }
    layout.subscriptions.push(subscription); update()
    return () => { subscription.stopped = true }
  },
  computePosition(reference: unknown, surface: HTMLElement, options: { placement: string; middleware: Middleware[] }) {
    return new Promise(resolve => {
      const call: PositionCall = { reference, surface, placement: options.placement,
        apply: (availableWidth = 1000, availableHeight = 1000) => {
          const middleware = options.middleware.find(item => item.name === 'size')!
          const sizing = middleware.options as { apply: (facts: SizeFacts) => void }
          sizing.apply({ availableWidth, availableHeight })
        },
        complete: (x = 12, y = 300) => resolve({ x, y }) }
      layout.calls.push(call)
      if (!layout.deferred) { call.apply(); call.complete() }
    })
  },
  offset: (options: number) => ({ name: 'offset', options }),
  shift: (options: { padding: number }) => ({ name: 'shift', options }),
  size: (options: { padding: number; apply: (facts: SizeFacts) => void }) => ({ name: 'size', options })
}))

const resizeOwners: LayoutResizeObserver[] = []
class LayoutResizeObserver {
  readonly targets = new Set<Element>()
  disconnected = false
  constructor(private readonly callback: ResizeObserverCallback) { resizeOwners.push(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.disconnected = true; this.targets.clear() }
  deliver() { this.callback([], this as unknown as ResizeObserver) }
}
const dom = composerDOM()
const roots: HTMLElement[] = []
const stops: (() => void)[] = []
const operation: BrowserOperation = { id: 'original-operation', browserId: 'original-browser',
  operator: { id: 'agent-1', name: 'Original Agent' }, phase: 'running', summary: 'Working',
  startedAt: _batchFixtureEpoch(0, 0, 1), url: 'https://example.invalid/original', steps: [] }
function attached(tag: string) {
  const element = document.createElement(tag); document.body.append(element); roots.push(element)
  return element
}
function rectangle(element: HTMLElement, width: number, height: number, x = 0, y = 0) {
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => new DOMRect(x, y, width, height))
}
function PortalComment({ pane, host }: { pane: HTMLElement; host: HTMLElement }) {
  const opinion = useBrowserContextualComposer(operation.browserId, { hostId: 'local', agentSessionId: 'agent-1' }, operation, true)
  return <>{createPortal(<button onClick={event => opinion.open(event.currentTarget,
    { operationId: 'historical-operation', sequence: 2 }, pane)}>Comment on step 2</button>, host)}{opinion.dialog}</>
}
beforeEach(() => {
  layout.calls.length = 0; layout.subscriptions.length = 0; layout.deferred = false
  resizeOwners.length = 0
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('ResizeObserver', LayoutResizeObserver)
  const session = composerSession(); session.status = { state: 'working', source: 'native-hook', observedAt: _batchFixtureEpoch(0, 0, 1) }
  useAppStore.setState({ sessions: [session], browserOpinionDrafts: {} })
  vi.spyOn(api.browser, 'captureInputContext').mockRejectedValue(new Error('Capture unavailable in the layout fixture'))
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const element of roots.splice(0)) element.remove()
  vi.unstubAllGlobals()
})

it('uses the exact Pane for a Portal comment without treating the invoker as the compact reader area', async () => {
  const pane = attached('section'); pane.className = 'browser-surface'; rectangle(pane, 360, 600)
  const stage = document.createElement('div'); stage.dataset.nativeBrowserStage = operation.browserId; pane.append(stage)
  const host = attached('div')
  await dom.render(<PortalComment pane={pane} host={host} />)
  const button = host.querySelector('button')!; rectangle(button, 120, 30, 20, 80)
  expect(button.closest('.browser-surface')).toBeNull()
  await act(async () => button.click())
  const panel = document.querySelector<HTMLElement>('[aria-label="Message Browser operator"]')!
  const editor = panel.querySelector('textarea')!
  expect(panel.dataset.compactReader).toBe('true')
  expect(panel.style.maxHeight).toBe('264px')
  expect(layout.calls.at(-1)?.reference).toMatchObject({ contextElement: pane })
  expect(layout.calls.at(-1)?.placement).toBe('top-end')
  const newOpinion = Array.from(panel.querySelectorAll('button')).find(item => item.textContent === 'New opinion')!
  expect(newOpinion).toBeDefined()
  await act(async () => newOpinion.click())
  expect(panel.dataset.compactReader).toBe('true')
  expect(panel.style.maxHeight).toBe('264px')
  expect(layout.calls.at(-1)?.reference).toMatchObject({ contextElement: pane })
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Original draft')
    editor.dispatchEvent(new Event('input', { bubbles: true })); editor.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.activeElement).toBe(editor)
  const resize = resizeOwners.find(owner => owner.targets.has(pane))!
  expect(resize).toBeDefined()
  rectangle(pane, 640, 600)
  await act(async () => resize.deliver())
  expect(panel.dataset.compactReader).toBe('false')
  expect(panel.style.maxHeight).toBe('1000px')
  expect(layout.calls.at(-1)?.reference).toBe(button)
  expect(layout.calls.at(-1)?.placement).toBe('bottom-end')
  expect(panel.querySelector('textarea')).toBe(editor)
  expect(editor.value).toBe('Original draft'); expect(document.activeElement).toBe(editor)
  expect(stage.parentElement).toBe(pane); expect(stage.getAttribute('style')).toBeNull()
})

it('observes an independent Pane resize and rejects late size and position writes across replacement and cleanup', async () => {
  layout.deferred = true
  const pane = attached('section'), anchor = document.createElement('button'), surface = attached('aside')
  pane.append(anchor); rectangle(pane, 360, 600); rectangle(anchor, 360, 38)
  const input = { pane, anchor, surface, maximumHeight: 520, gap: 6 }
  const stop = observeBrowserReader(input); stops.push(stop)
  const first = layout.calls[0]!, resize = resizeOwners.find(owner => owner.targets.has(pane))!
  expect(layout.calls).toHaveLength(1); expect(resize).toBeDefined()
  const unchangedAnchor = anchor.getBoundingClientRect().toJSON()
  rectangle(pane, 360, 400)
  resize.deliver()
  expect(layout.calls).toHaveLength(2)
  expect(anchor.getBoundingClientRect().toJSON()).toEqual(unchangedAnchor)
  const latest = layout.calls[1]!
  await act(async () => { latest.apply(); latest.complete(12, 200) })
  expect(surface.style.maxHeight).toBe('176px')
  expect(surface.style.left).toBe('12px'); expect(surface.style.top).toBe('200px')
  await act(async () => { first.apply(800, 900); first.complete(99, 999) })
  expect(surface.style.maxHeight).toBe('176px')
  expect(surface.style.left).toBe('12px'); expect(surface.style.top).toBe('200px')

  rectangle(pane, 360, 500); resize.deliver()
  const pendingOldOwner = layout.calls[2]!
  stop()
  expect(resize.disconnected).toBe(true); expect(layout.subscriptions[0]?.stopped).toBe(true)
  rectangle(pane, 360, 300)
  stops.push(observeBrowserReader(input))
  const replacement = layout.calls[3]!
  await act(async () => { replacement.apply(); replacement.complete(8, 180) })
  expect(surface.style.maxHeight).toBe('132px')
  await act(async () => { pendingOldOwner.apply(100, 100); pendingOldOwner.complete(77, 777) })
  expect(surface.style.maxHeight).toBe('132px'); expect(surface.style.width).toBe('360px')
  expect(surface.style.left).toBe('8px'); expect(surface.style.top).toBe('180px')
})
