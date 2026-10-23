// @vitest-environment happy-dom
import { fixtureIso } from '../scripts/lib/fixture-values.mjs'
import { act, useEffect } from 'react'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionConversationWindow, type ConversationReading } from '../src/renderer/src/lib/session-conversation-window'
import { conversationRulerRecords, conversationRulerWindow } from '../src/renderer/src/lib/conversation-ruler'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'

// These cases keep the real built-in Provider and mounted presentation boundary.
// Source-page batching, wire fragments and cancellation belong to coverage-batch;
// retained-window byte/record limits belong to the public Core Reader.
const END = Date.parse(fixtureIso(24494400000, 'second')), HOUR = 3_600_000
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
let value: ReturnType<typeof useSessionConversationWindow> | undefined
const closes: Array<() => unknown | Promise<unknown>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host); value = undefined
})
afterEach(async () => {
  const failures: unknown[] = []
  try { await act(async () => root.unmount()) } catch (error) { failures.push(error) }
  host.remove(); window.getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Original time-coverage fixture cleanup failed')
})
async function fixture(count: number, options: { timed?: boolean; untimed?: number } = {}) {
  const nativeSessionId = 'original-native', agentSessionId = 'original-session'
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: count }, (_, index) => ({
    sessionId: nativeSessionId, uuid: `record-${index}`, type: index % 2 ? 'assistant' : 'user',
    ...(options.timed === false || index >= count - (options.untimed ?? 0) ? {} :
      { timestamp: new Date(END - (count - 1 - index) * HOUR / 20).toISOString() }),
    message: { role: index % 2 ? 'assistant' : 'user', content: `Original body ${index}.` }
  }))), { agentSessionId, nativeSessionId })
  closes.push(f.close)
  // Finish the original captured-source handover before taking source facts.
  await f.store.readCapturedHistory(agentSessionId, { limit: 1 })
  const metadata = await f.store.loadMetadata(), nativeBytes = await readFile(f.path)
  closes.push(async () => {
    expect(await f.store.loadMetadata()).toEqual(metadata)
    expect(await readFile(f.path)).toEqual(nativeBytes)
    expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  })
  await desktopConversationReadBridge(f, closes)
  const originalOwner = f.client['readSessionHistoryPage']
  const original = originalOwner.bind(f.client)
  closes.push(() => { f.client['readSessionHistoryPage'] = originalOwner })
  const reads: Array<{ cursor?: string; limit?: number }> = [], pages: AgentSessionHistoryPage[] = []
  const pending: Promise<unknown>[] = [], gates: Array<() => void> = []
  let holdAt = -1, failAt = -1, blocked = false
  f.client['readSessionHistoryPage'] = vi.fn<typeof original>((...args) => {
    const response = (async () => {
      const at = reads.length, input = args[1]
      reads.push({ ...(input?.cursor ? { cursor: input.cursor } : {}), ...(input?.limit === undefined ? {} : { limit: input.limit }) })
      const page = await original(...args); pages.push(page)
      // Delay only the original Provider's completed response, retaining its exact cursor.
      if (at === holdAt) { blocked = true; await new Promise<void>(resolve => gates.push(resolve)) }
      if (at === failAt) throw new Error('Controlled original page unavailable')
      return page
    })()
    pending.push(response); return response
  })
  const release = () => { for (const resolve of gates.splice(0)) resolve() }
  closes.push(async () => { release(); await Promise.allSettled(pending) })
  const reading: ConversationReading = { reference: { hostId: f.session.hostId, agentSessionId }, identity: f.session.run.runId, enabled: true }
  const activity = () => act(async () => root.render(<ActivityView {...activityReadingProps({ control: { ...reading.reference, run: f.session.run } })} />))
  return { ...f, reading, reads, pages, pending, activity, release, blocked: () => blocked,
    hold: (at: number) => { holdAt = at; blocked = false }, fail: (at: number) => { failAt = at } }
}
function Hook({ reading, duration }: { reading: ConversationReading; duration: number }) {
  const current = useSessionConversationWindow(reading, () => true, duration)
  useEffect(() => { value = current }, [current])
  const projection = current.projection
  return <ConversationView sessionId={reading.reference.agentSessionId} executionHostId={reading.reference.hostId}
    records={projection?.records ?? []} originalRecords={projection?.originalRecords ?? []}
    page={current.page} timeline={projection?.captured} coverage={projection?.timeline.coverage ?? []} active={reading.enabled} />
}
const mount = (f: Awaited<ReturnType<typeof fixture>>, duration = 24 * HOUR) => act(async () => root.render(<Hook reading={f.reading} duration={duration} />))
const wait = (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); assertion() }, { timeout: 10000, interval: 10 })
function current() { expect(value).toBeDefined(); return value! }
const ids = () => [...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(row => row.dataset.nativeRecordId)
function row(id: string) { const actual = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"]`); expect(actual, id).not.toBeNull(); return actual! }

it('short actual Provider EOF retains the recorded ruler extent and untimed records without reading again for a larger range', async () => {
  const f = await fixture(14, { untimed: 2 }); await mount(f)
  await wait(() => { expect(current().page?.items).toHaveLength(14); expect(current().loading).toBe(false) })
  const ruler = conversationRulerWindow(conversationRulerRecords(f.reading.reference.agentSessionId, current().page, []), '24h')
  expect(ruler.scale.span).toBe(11 * HOUR / 20)
  expect(ruler.scale.origin + ruler.scale.span).toBe(END - 2 * HOUR / 20)
  expect(ruler.untimed).toHaveLength(2); expect(ids()).toEqual(Array.from({ length: 14 }, (_, index) => `record-${index}`))
  await mount(f, 7 * 24 * HOUR)
  await wait(() => { expect(current().loading).toBe(false); expect(current().hasMore).toBe(false) })
  expect(f.reads).toHaveLength(1)
})

it('actual Activity keeps its first Provider page, pending status and original Range during the bounded automatic supplement', async () => {
  const f = await fixture(700); f.hold(1); await f.activity()
  await wait(() => { expect(f.blocked()).toBe(true); expect(ids()).toHaveLength(100) })
  const original = row('record-699'), body = original.querySelector('.log-turn__body p')!, text = body.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); window.getSelection()!.addRange(range)
  const earlier = host.querySelector<HTMLButtonElement>('.activity-feed__reading-entry .activity-feed__reading-action[aria-busy="true"]')!
  expect(earlier).not.toBeNull()
  const pending = earlier.querySelector<HTMLElement>('[role="status"]')!
  expect(pending).not.toBeNull()
  expect(pending.getAttribute('role')).toBe('status'); expect(pending.getAttribute('aria-live')).toBe('polite')
  expect(pending.textContent).toBe('Loading earlier…'); expect(earlier.querySelector('[data-semantic-icon="status.loading"]')).not.toBeNull()
  expect(host.querySelector('.activity-ruler__count')!.textContent?.trim()).toBe('100 records')
  expect(host.querySelector('.activity-feed__loading-layer, .activity-feed__empty-reading')).toBeNull()
  await act(async () => f.release())
  await wait(() => { expect(ids()).toHaveLength(300); expect(earlier.getAttribute('aria-busy')).toBeNull() })
  expect(f.reads).toHaveLength(3); expect(f.reads.filter(read => !read.cursor)).toHaveLength(1)
  expect(row('record-699')).toBe(original); expect(body.firstChild).toBe(text); expect(pending.isConnected).toBe(true); expect(earlier.contains(pending)).toBe(true)
  expect(pending.getAttribute('role')).toBeNull(); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('Original')
})

it('actual Activity time-menu expansion admits one original three-page supplement without remounting its current message', async () => {
  const f = await fixture(750); await f.activity()
  await wait(() => {
    const consumers = inspectConversationConsumers(f.reading.reference).consumers
    expect(consumers).toHaveLength(1)
    expect(consumers[0]).toMatchObject({ loading: false, inFlight: false, held: false, dirty: false,
      accepted: { recordCount: 300 }, watch: { binding: false, bound: true, closed: false } })
    expect(ids()).toHaveLength(300)
  })
  expect(f.reads).toHaveLength(3)
  const original = row('record-749'), trigger = host.querySelector<HTMLButtonElement>('[aria-label="History window: 24h"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  let option: HTMLElement | undefined
  await wait(() => { option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === '3d reading window'); expect(option).toBeDefined() })
  await act(async () => option!.click())
  await wait(() => { expect(ids()).toHaveLength(600); expect(host.querySelector('.activity-feed__reading-action')?.getAttribute('aria-busy')).toBeNull() })
  expect(f.reads).toHaveLength(6); expect(f.reads.filter(read => !read.cursor)).toHaveLength(1)
  expect(row('record-749')).toBe(original); expect(host.querySelector('[aria-label="History window: 3d"]')).not.toBeNull()
})

it('an untimed original Provider failure retains its prefix and exact physical source cursor for explicit Retry', async () => {
  const f = await fixture(420, { timed: false }); f.fail(1); await mount(f, Infinity)
  await wait(() => { expect(current().inspect().error).toMatchObject({ code: 'AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE' }); expect(current().loading).toBe(false) })
  expect(current().page?.items).toHaveLength(100); expect(current().page!.items.every(item => item.startedAt === undefined)).toBe(true)
  expect(f.reads).toHaveLength(2); const cursor = f.reads[1]!.cursor, original = row('record-419')
  expect(cursor).toBeTruthy(); f.fail(-1)
  await act(async () => current().retry())
  await wait(() => { expect(current().page?.items).toHaveLength(200); expect(current().loading).toBe(false); expect(current().inspect().error).toBeNull() })
  expect(f.reads).toHaveLength(3); expect(f.reads[2]!.cursor).toBe(cursor); expect(row('record-419')).toBe(original)
})

it('actual Activity Earlier supersedes delayed Provider coverage and its late reply cannot replace the accepted exact window', async () => {
  const f = await fixture(900); f.hold(1); await f.activity()
  await wait(() => { expect(f.blocked()).toBe(true); expect(ids()).toHaveLength(100) })
  const original = row('record-899')
  const earlier = host.querySelector<HTMLButtonElement>('.activity-feed__reading-action[title="Read earlier conversation and process records in the original sequence"]')!
  expect(earlier).not.toBeNull(); expect(earlier.disabled).toBe(false)
  await act(async () => earlier.click())
  await wait(() => {
    expect(ids()).toHaveLength(200)
    expect(host.querySelector('.activity-feed__reading-action')?.getAttribute('aria-busy')).toBeNull()
    expect(inspectConversationConsumers(f.reading.reference).consumers[0]).toMatchObject({
      loading: false, inFlight: false, dirty: false, watch: { binding: false } })
  })
  const accepted = ids(), frame = inspectConversationConsumers(f.reading.reference).consumers[0]!.accepted
  expect(frame).not.toBeNull()
  await act(async () => { f.release(); await Promise.allSettled(f.pending) })
  await wait(() => {
    const sample = inspectConversationConsumers(f.reading.reference).consumers[0]!
    expect(sample).toMatchObject({ loading: false, inFlight: false })
    expect(sample.accepted).toEqual(frame); expect(ids()).toEqual(accepted)
  })
  expect(f.reads).toHaveLength(3); expect(row('record-899')).toBe(original)
})
