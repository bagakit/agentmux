// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxInteractionRequest } from '@agentmux/core'

const geometry = vi.hoisted(() => ({ height: 40, width: 352, calls: [] as number[], updates: [] as Array<() => void> }))
// Declared geometry adapter: React and the production request/queue components
// are real. Pixels and trusted pointer hit-testing are separate Electron proof.
vi.mock('@floating-ui/dom', () => ({
  autoUpdate: (_anchor: unknown, _floating: unknown, update: () => void) => { geometry.updates.push(update); update(); return () => { geometry.updates.splice(geometry.updates.indexOf(update), 1) } },
  offset: (value: number) => ({ name: 'offset', options: value }), shift: () => ({}), size: () => ({}),
  computePosition: async (reference: { getBoundingClientRect(): DOMRect }, _floating: HTMLElement, options: { middleware: Array<{ name?: string; options?: number }> }) => {
    const gap = options.middleware.find(value => value.name === 'offset')!.options!
    geometry.calls.push(gap)
    return { x: 0, y: reference.getBoundingClientRect().top - geometry.height - gap }
  }
}))
vi.mock('../src/renderer/src/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({ sessions: [], agentNames: {}, noticeReadReceipts: {} }), { setState() {} })
}))
vi.mock('../src/renderer/src/lib/session-user-messages', () => ({ useSessionUserMessages: () => ({ messages: [], hasMore: false, loadEarlier() {}, refresh() {} }) }))
vi.mock('@agentmux/client-ui/components/InlineComposer', () => ({ InlineComposer: () => <input aria-label="Original draft" defaultValue="Original draft" /> }))
vi.mock('@agentmux/client-ui/components/ComposerReferenceTool', () => ({ ComposerReferenceTool: () => null }))

import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
import type { ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'

const queue: ComposerQueuedMessage[] = Array.from({ length: 3 }, (_, index) => ({ id: `original-${index}`, text: `Original body ${index}`, status: 'queued', deliverable: true, editable: true }))
const respond = vi.fn(async () => {}), send = vi.fn(), edit = vi.fn(async () => {}), copy = vi.fn(async () => true), archive = vi.fn(async () => {}), change = vi.fn()
const request = (kind: 'permission' | 'question'): AgentMuxInteractionRequest => ({
  id: `original-${kind}`, agentSessionId: 'original-session', evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'original-run' }, hookReceiptId: `original-${kind}` },
  ...(kind === 'permission' ? { kind, title: 'Original permission', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'reject-once' }] }
    : { kind, questions: [{ id: 'original-question', title: 'Original question', prompt: 'Choose the original target', options: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] }] })
})
let root: Root, container: HTMLElement, outside: HTMLInputElement, style: HTMLStyleElement
let requestRect: DOMRect, sourceRect: DOMRect | undefined, terminalRect: DOMRect, hidden = false, inert = false
const resizeObservers = new Set<{ targets: Set<Element>; callback: ResizeObserverCallback }>()
const panel = () => document.querySelector<HTMLElement>('.composer-pending')!
const body = () => container.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] .agent-body')!
const interaction = () => body().querySelector<HTMLElement>('.agent-interaction')!
const top = () => parseFloat(panel().style.top)
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function render(kind?: 'permission' | 'question', entries = queue, neighbor = false, notice = false, retainHost = false) {
  await act(async () => root.render(<>
    <section className="agent-surface" data-workbench-region-id="original-region">
      <div className="agent-body" hidden={hidden} inert={inert}>
        <div className="terminal-view__xterm"><div className="xterm"><textarea className="xterm-helper-textarea" aria-label="Original terminal" /></div></div>
        {!neighbor && (kind || retainHost) ? <div className="agent-interaction-source">{notice ? <p className="agent-interaction-source__notice">This current request belongs to the retained source.</p> : null}{kind ? <AgentInteractionCard request={request(kind)} onRespond={respond} /> : null}</div> : null}
      </div>
      <SessionMailbox queued={entries} pendingInteraction={Boolean(kind)} onSendQueued={send} onEditQueued={edit} onCopyQueued={copy} onArchiveQueued={archive}
        system={{ notices: [], unread: [], available: true, acknowledge() {} }}>
        {(mailbox, pending) => <AgentComposer value="Original draft" onChange={change} disabled={false} placeholder="Original" aboveInput={pending} mailbox={mailbox} />}
      </SessionMailbox>
    </section>
    <section className="agent-surface" data-workbench-region-id="neighbor-region"><div className="agent-body">{kind && neighbor ? <div className="agent-interaction-source"><AgentInteractionCard request={request(kind)} onRespond={respond} /></div> : null}</div><input defaultValue="Neighbor draft" /></section>
  </>))
  await settle()
}
async function resize(target: Element) {
  await act(async () => { for (const observer of resizeObservers) if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver) })
  await settle()
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  geometry.height = 40; geometry.width = 352; geometry.calls.length = 0; geometry.updates.length = 0
  requestRect = new DOMRect(500, 500, 300, 70); sourceRect = undefined; terminalRect = new DOMRect(0, 0, 0, 0); hidden = false; inert = false
  resizeObservers.clear(); for (const fn of [respond, send, edit, copy, archive, change]) fn.mockClear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>(); constructor(readonly callback: ResizeObserverCallback) { resizeObservers.add(this) }
    observe(target: Element) { this.targets.add(target) } unobserve(target: Element) { this.targets.delete(target) } disconnect() { this.targets.clear(); resizeObservers.delete(this) }
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value(this: HTMLElement) {
    if (this.classList.contains('agent-interaction-source')) return sourceRect ?? requestRect
    if (this.classList.contains('agent-interaction')) return requestRect
    if (this.classList.contains('composer')) return new DOMRect(100, 600, 700, 50)
    if (this.hasAttribute('data-workbench-region-id')) return new DOMRect(100, 80, 700, 570)
    if (this.classList.contains('xterm-helper-textarea')) return terminalRect
    if (this.classList.contains('xterm')) return new DOMRect(100, 100, 700, 470)
    return new DOMRect(100, 100, 700, 470)
  } })
  for (const property of ['offsetWidth', 'clientWidth']) Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get(this: HTMLElement) { return this.classList.contains('composer-pending') || this.classList.contains('composer-pending__cards') ? geometry.width : 700 } })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('composer-pending') ? geometry.height : 40 } })
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 })
  style = document.createElement('style'); style.textContent = '.composer-pending__cards{padding:6px}'; document.head.append(style)
  container = document.createElement('div'); outside = document.createElement('input'); document.body.append(container, outside); outside.focus(); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); outside.remove(); style.remove(); document.querySelector('#agentmux-window-overlay-host')?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['permission', 'question'] as const)('protects the actual current %s footprint and preserves the complete original queue and draft', async kind => {
  const original = structuredClone(queue); await render(kind)
  expect(interaction().dataset.requestId).toBe(`original-${kind}`)
  expect(top() + geometry.height).toBeLessThanOrEqual(requestRect.top - 2)
  expect(panel().hidden).toBe(false); expect(panel().querySelectorAll('li')).toHaveLength(3)
  expect(queue).toEqual(original); expect(container.querySelector<HTMLInputElement>('[aria-label="Original draft"]')!.value).toBe('Original draft')
  expect(document.activeElement).toBe(outside); for (const fn of [respond, send, edit, copy, archive, change]) expect(fn).not.toHaveBeenCalled()
})
it('does not reserve an unconditional request height when footprints do not intersect', async () => {
  requestRect = new DOMRect(500, 300, 300, 100); await render('permission'); expect(top()).toBe(558); expect(geometry.calls.length).toBeGreaterThan(0); expect(geometry.calls.every(gap => gap === 2)).toBe(true)
})
it.each(['hidden', 'inert', 'visibility'] as const)('ignores a %s request and restores its actual visible geometry', async state => {
  await render('question'); const original = interaction(); await act(async () => { if (state === 'visibility') original.style.visibility = 'hidden'; else original.setAttribute(state, '') }); await settle()
  expect(top()).toBe(558)
  await act(async () => { if (state === 'visibility') original.style.visibility = ''; else original.removeAttribute(state) }); await settle()
  expect(top() + geometry.height).toBeLessThanOrEqual(requestRect.top - 2)
})
it('does not borrow the neighboring Region request even when its screen rectangle intersects', async () => {
  await render('permission', queue, true); expect(container.querySelector('[data-workbench-region-id="neighbor-region"] .agent-interaction')).not.toBeNull(); expect(top()).toBe(558)
})
it('updates on real request mount, owned resize and removal without queue or focus changes', async () => {
  await render(); expect(top()).toBe(558)
  await render('permission'); const original = interaction(); expect(top()).toBe(458)
  requestRect = new DOMRect(500, 440, 300, 140); await resize(original); expect(top()).toBe(398)
  await render(); expect(top()).toBe(558); expect(geometry.updates).toHaveLength(1); expect(document.activeElement).toBe(outside)
})
it('observes the local body hidden/inert boundary without adopting other workface content', async () => {
  await render('permission'); hidden = true; await render('permission'); expect(top()).toBe(558)
  hidden = false; inert = true; await render('permission'); expect(top()).toBe(558)
  inert = false; await render('permission'); expect(top()).toBe(458)
})
it('retains the original terminal protection when it is above the current request', async () => {
  terminalRect = new DOMRect(700, 470, 12, 110); await render('question'); expect(top() + geometry.height).toBeLessThanOrEqual(terminalRect.top - 2)
})
it('keeps all original identities traversable in a bounded long queue and preserves the right pivot', async () => {
  geometry.height = 180; const entries = Array.from({ length: 100 }, (_, i) => ({ ...queue[0]!, id: `original-row-${i}`, text: `Original body ${i}` })); await render('question', entries)
  expect(top() + geometry.height).toBeLessThanOrEqual(requestRect.top - 2)
  expect(panel().querySelectorAll('li')).toHaveLength(100); expect(panel().querySelector('[data-operation-id="original-row-99"] .composer-pending__more')!.textContent).toBe('100/100')
  expect(panel().style.left).toBe('auto'); expect(panel().style.right).not.toBe(''); expect(send).not.toHaveBeenCalled()
})
it('keeps the exact original copy and request response wiring after the geometric move', async () => {
  await render('permission'); await act(async () => { panel().querySelector<HTMLButtonElement>('[data-operation-id="original-1"] .composer-pending__copy')!.click() }); expect(copy).toHaveBeenCalledExactlyOnceWith(queue[1]!.text)
  await act(async () => interaction().querySelector<HTMLButtonElement>('button.is-primary')!.click()); expect(respond).toHaveBeenCalledExactlyOnceWith({ requestId: 'original-permission', kind: 'permission', decision: { outcome: 'selected', optionId: 'allow' } }); expect(send).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled()
})
it('releases only its local geometry observers after unmount', async () => {
  await render('permission'); expect([...resizeObservers].some(observer => observer.targets.has(interaction()))).toBe(true)
  await act(async () => root.render(null)); expect(geometry.updates).toHaveLength(0); expect(resizeObservers.size).toBe(0); expect(send).not.toHaveBeenCalled()
})

it('rechecks the final footprint when avoiding a request moves onto the original terminal helper', async () => {
  terminalRect = new DOMRect(700, 470, 12, 20)
  await render('permission')
  expect(top() + geometry.height).toBeLessThanOrEqual(terminalRect.top - 2)
  expect(top() + geometry.height).toBeLessThanOrEqual(requestRect.top - 2)
  expect(send).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled()
})

it('observes request insertion and replacement inside a retained current source host', async () => {
  await render(undefined, queue, false, false, true)
  const host = body().querySelector('.agent-interaction-source')!
  expect(top()).toBe(558)
  await render('permission', queue, false, false, true)
  expect(body().querySelector('.agent-interaction-source')).toBe(host)
  expect(interaction().dataset.requestId).toBe('original-permission')
  expect(top()).toBe(458)
  await render('question', queue, false, false, true)
  expect(body().querySelector('.agent-interaction-source')).toBe(host)
  expect(interaction().dataset.requestId).toBe('original-question')
  expect(top()).toBe(458)
  await render(undefined, queue, false, false, true)
  expect(top()).toBe(558)
})

it.each(['hidden', 'inert', 'display', 'visibility'] as const)('releases and restores the current %s source wrapper', async state => {
  await render('permission')
  const host = body().querySelector<HTMLElement>('.agent-interaction-source')!
  await act(async () => {
    if (state === 'display') host.style.display = 'none'
    else if (state === 'visibility') host.style.visibility = 'hidden'
    else host.setAttribute(state, '')
  })
  await settle()
  expect(top()).toBe(558)
  await act(async () => { host.removeAttribute(state); host.style.display = ''; host.style.visibility = '' })
  await settle()
  expect(top()).toBe(458)
})

it('protects the visible source notice when the inner request card alone does not intersect', async () => {
  requestRect = new DOMRect(500, 610, 300, 70)
  sourceRect = new DOMRect(500, 500, 300, 180)
  await render('permission', queue, false, true)
  expect(body().querySelector('.agent-interaction-source__notice')).not.toBeNull()
  expect(top() + geometry.height).toBeLessThanOrEqual(sourceRect.top - 2)
  sourceRect = new DOMRect(500, 440, 300, 240)
  await resize(body().querySelector('.agent-interaction-source')!)
  expect(top() + geometry.height).toBeLessThanOrEqual(sourceRect.top - 2)
  expect(respond).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
})

it('ignores historical request descendants and their mutations in the same body', async () => {
  await render()
  const history = document.createElement('div')
  history.className = 'activity-feed'
  history.innerHTML = '<section class="agent-interaction" data-request-id="historical-request"></section>'
  await act(async () => { body().append(history) }); await settle()
  expect(top()).toBe(558)
  const calls = geometry.calls.length
  await act(async () => { history.firstElementChild!.setAttribute('style', 'height:200px'); history.append(document.createElement('p')) }); await settle()
  expect(geometry.calls).toHaveLength(calls)
  expect(top()).toBe(558); expect(send).not.toHaveBeenCalled()
})
