// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({ refs: [] as Array<{ reads: Array<{ value: unknown; stack: string }>; assigned: unknown; }> , positions: 0, stopped: 0 }))
// Observe the real SessionMailbox-created refs; original React useRef is called once.
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  const tracked = new WeakSet<object>()
  return { ...actual, useRef: (initial: unknown) => {
    const ref = actual.useRef(initial)
    if (initial === null && new Error().stack?.includes('SessionMailbox.tsx') && !tracked.has(ref)) {
      tracked.add(ref)
      let value = ref.current
      const record = { reads: [] as Array<{ value: unknown; stack: string }>, assigned: value }
      observed.refs.push(record)
      Object.defineProperty(ref, 'current', { configurable: true, get() {
        record.reads.push({ value, stack: new Error().stack ?? '' }); return value
      }, set(next) { value = next; record.assigned = next } })
    }
    return ref
  } }
})
// Geometry is a declared DOM adapter only: this test proves when production
// starts its original placement, not pixels or Native frame readiness.
vi.mock('@floating-ui/dom', () => ({
  autoUpdate: (_anchor: unknown, _floating: unknown, update: () => void) => { update(); return () => { observed.stopped++ } },
  computePosition: async () => { observed.positions++; return { x: 0, y: 500 } },
  offset: () => ({}), shift: () => ({}), size: () => ({})
}))
vi.mock('../src/renderer/src/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({ sessions: [], agentNames: {}, noticeReadReceipts: {}, acquireNativeSurfaceOverlay() {}, releaseNativeSurfaceOverlay() {} }), { setState() {} })
}))
vi.mock('../src/renderer/src/lib/session-user-messages', () => ({
  useSessionUserMessages: () => ({ messages: [], hasMore: false, loadEarlier() {}, refresh() {} })
}))
vi.mock('@agentmux/client-ui/components/InlineComposer', () => ({ InlineComposer: () => <div data-private-input="true" /> }))
vi.mock('@agentmux/client-ui/components/ComposerReferenceTool', () => ({ ComposerReferenceTool: () => null }))

import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import type { ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'

let root: Root, container: HTMLElement
const facts: unknown[] = []
const queue: ComposerQueuedMessage[] = [{ id: 'original-operation', text: 'Original queued body', status: 'queued', deliverable: true, editable: true }]
function OriginalOrder({ queued }: { queued: ComposerQueuedMessage[] }) {
  return <div className="agent-surface" data-workbench-region-id="private-original">
    <SessionMailbox queued={queued} system={{ notices: [], unread: [], available: true, acknowledge() {} }}>
      {(mailbox, pending) => <AgentComposer value="Original draft" disabled={false} placeholder="Original" onChange={() => {}}
        aboveInput={pending} mailbox={mailbox} />}
    </SessionMailbox>
  </div>
}
function snapshot(name: string) {
  const panel = document.querySelector<HTMLElement>('.composer-pending')
  const anchor = container.querySelector<HTMLButtonElement>('.composer__mailbox') ?? container.querySelector<HTMLButtonElement>('[aria-label="Mailbox"]')
  const triggerRef = observed.refs.find(ref => ref.assigned === anchor)
  const placementReads = triggerRef?.reads.filter(read => read.stack.includes('ComposerPendingDelivery.tsx')) ?? []
  const result = { name, anchorFound: Boolean(anchor), anchorConnected: anchor?.isConnected ?? false,
    placementObservedNull: placementReads.some(read => read.value === null), placementReadCount: placementReads.length,
    panelFound: Boolean(panel), positioned: panel?.dataset.positioned ?? null, placementCalls: observed.positions,
    body: panel?.querySelector('.composer-pending__preview')?.textContent, draft: 'Original draft', queue };
  facts.push(result)
  return result
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  observed.refs.length = 0; observed.positions = 0; observed.stopped = 0
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value() { return new DOMRect(100, 600, 640, 40) } })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.querySelector('#agentmux-window-overlay-host')?.remove(); vi.unstubAllGlobals() })
it('cold existing queue starts placement after the real following Mail ref attaches', async () => {
  await act(async () => root.render(<OriginalOrder queued={queue} />))
  const actual = snapshot('cold-existing-queue')
  expect(actual.anchorConnected).toBe(true)
  expect(actual.body).toBe(queue[0]!.text)
  expect(actual.positioned).toBe('true')
})
it('a queue arriving after the original Mail mount starts placement', async () => {
  await act(async () => root.render(<OriginalOrder queued={[]} />))
  await act(async () => root.render(<OriginalOrder queued={queue} />))
  const actual = snapshot('warm-enqueue')
  expect(actual.anchorConnected).toBe(true); expect(actual.positioned).toBe('true')
  expect(actual.placementCalls).toBeGreaterThan(0)
})

it('the same retained queue is positioned after a genuine root unmount and cold remount', async () => {
  await act(async () => root.render(<OriginalOrder queued={[]} />))
  await act(async () => root.render(<OriginalOrder queued={queue} />))
  expect(snapshot('before-unmount').positioned).toBe('true')
  await act(async () => root.render(null))
  expect(observed.stopped).toBe(1)
  await act(async () => root.render(<OriginalOrder queued={queue} />))
  const actual = snapshot('cold-remount')
  expect(actual.anchorConnected).toBe(true); expect(actual.positioned).toBe('true')
  expect(actual.body).toBe(queue[0]!.text); expect(observed.positions).toBe(2)
})
