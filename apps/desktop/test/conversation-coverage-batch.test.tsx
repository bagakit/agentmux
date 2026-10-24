import { processNativeRecordIds } from './helpers/conversation-process-members'
import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentSessionHistoryPage, type AgentTimelineItem } from '@agentmux/core'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionConversationWindow } from '../src/renderer/src/lib/session-conversation-window'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { useConversationReadAhead } from '../src/renderer/src/lib/use-conversation-read-ahead'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private coverage batch cleanup failed')
})
const HOUR = 3_600_000
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(); assertion() }, { timeout: 10000, interval: 20 })

async function fixture(options: { total?: number; timed?: boolean; step?: number; pageSize?: number; bodySize?: number; initialShort?: number; process?: boolean; renderMessageActions?: () => null } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const total = options.total ?? 1000, reference = { hostId: 'local', agentSessionId: 'original-coverage-batch' }
  const source = { providerId: 'claude', nativeSessionId: 'original-native' }
  const items: AgentSessionHistoryPage['items'] = Array.from({ length: total }, (_, index) => ({ id: `original-${index}`, kind: options.process ? 'activity' : 'assistant-message',
    ...(options.timed === false ? {} : { startedAt: 1 + index * (options.step ?? 1000) }),
    contentParts: [{ kind: 'text', text: `Original body ${index}.` + 'x'.repeat(options.bodySize ?? 0) }] }))
  const calls: Array<{ cursor?: string; limit: number }> = []
  const gates: Array<() => void> = []
  let holdAt = -1, blocked = false
  const f = await conversationPagePortFixture(reference, source, async (_id, input = {}) => {
    const at = calls.length, limit = input.limit ?? 100
    calls.push({ ...(input.cursor ? { cursor: input.cursor } : {}), limit })
    if (at === holdAt) { blocked = true; await new Promise<void>(resolve => gates.push(resolve)) }
    const end = input.cursor ? Number(input.cursor.slice('original-page:'.length)) : total
    const size = Math.min(limit - (!input.cursor ? options.initialShort ?? 0 : 0), options.pageSize ?? limit)
    const start = Math.max(0, end - size)
    return { agentSessionId: reference.agentSessionId, source, items: items.slice(start, end), nextCursor: start ? `original-page:${start}` : null }
  })
  closes.push(f.close)
  closes.push(() => { for (const release of gates.splice(0)) release() })
  closes.push(() => expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]))
  const transport = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  const packets: Array<{ complete: boolean; fragmented: boolean; entries: number; limit: number | undefined }> = []
  let wireBytes: number | undefined, openingView: string | undefined
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (input, readOptions) => {
    const view = openingView; openingView = undefined
    const packet = await transport({ ...input, ...(wireBytes ? { maxBytes: wireBytes } : {}), ...(view ? { view } : {}) }, readOptions)
    packets.push({ complete: packet.window.complete, fragmented: packet.items.some(item => item.kind === 'fragment'), entries: packet.items.length, limit: input.limit })
    return packet
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  let current!: ReturnType<typeof useSessionConversationWindow>
  const reading = { reference, identity: 'original-run', enabled: true }
  function Consumer({ duration, active }: { duration: number; active: boolean }) {
    current = useSessionConversationWindow({ ...reading, enabled: active }, () => true, duration)
    return <div>{current.page?.items.map(item => <p key={item.id} data-original={item.id}>{item.contentParts.flatMap(part => part.kind === 'text' ? [part.text] : [])}</p>)}</div>
  }
  const render = (duration = 24 * HOUR, active = true) => act(async () => root.render(<Consumer duration={duration} active={active} />))
  const activity = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control: { ...reference, run: { runId: 'original-run' } }, visible, ...(options.renderMessageActions ? { renderMessageActions: options.renderMessageActions } : {}) })} />))
  const appendCaptured = async (id: string) => {
    const item: AgentTimelineItem = { id, agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook',
      status: 'complete', title: 'Original captured record', content: id, createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1) }
    await Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type: 'append', agentSessionId: reference.agentSessionId, item }, { source: 'agentmux', observedAt: _followupFixtureEpoch(0, 0, 1) }, 'local')
  }
  return { ...f, reference, source, calls, packets, host, render, activity, appendCaptured, current: () => current,
    block: (at: number) => { holdAt = at; blocked = false }, blocked: () => blocked,
    release: () => { for (const release of gates.splice(0)) release() },
    fragment: (bytes: number) => { wireBytes = bytes }, replay: (view: string) => { openingView = view } }
}

it('actual Activity stops its initial batch at three source pages and changes or repaint cannot refill it', async () => {
  const f = await fixture(), store = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.reference.agentSessionId]: 'Unsent original draft' } })
  closes.push(() => useAppStore.setState(store, true))
  await f.activity()
  await wait(() => expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(300))
  await wait(() => expect(f.host.querySelector('.activity-feed__reading-action')?.getAttribute('aria-busy')).toBeNull())
  expect(f.calls).toHaveLength(3); expect(f.calls.map(call => call.limit)).toEqual([100, 100, 100])
  const row = f.host.querySelector('[data-native-record-id="original-999"]')!, text = row.querySelector('.log-turn__body p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); window.getSelection()!.addRange(range)
  const button = f.host.querySelector<HTMLButtonElement>('.activity-feed__reading-action')!
  await wait(() => expect(button.disabled).toBe(false))
  button.focus(); expect(document.activeElement).toBe(button)
  await act(async () => f.appendCaptured('Independent source progress'))
  await wait(() => expect(f.host.textContent).toContain('Independent source progress'))
  await f.activity(); await act(async () => window.dispatchEvent(new Event('resize'))); await pause()
  expect(f.calls).toHaveLength(3); expect(f.host.querySelector('[data-native-record-id="original-999"]')).toBe(row)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('Original')
  expect(document.activeElement).toBe(button); expect(useAppStore.getState().agentComposerDrafts[f.reference.agentSessionId]).toBe('Unsent original draft')
  window.getSelection()!.removeAllRanges()
  await act(async () => button.click())
  await wait(() => expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(400))
  expect(f.calls).toHaveLength(4); expect(f.calls.filter(call => !call.cursor)).toHaveLength(1)
})

it('range expansion starts only one three-page supplement and shrinking cancels unsent pages', async () => {
  const f = await fixture()
  await f.render(1); await wait(() => { expect(f.current().page?.items).toHaveLength(100); expect(f.current().loading).toBe(false) })
  f.block(1); await f.render(Infinity); await wait(() => expect(f.blocked()).toBe(true))
  const original = f.host.querySelector('[data-original="original-999"]')!
  await f.render(HOUR); await act(async () => f.release())
  await wait(() => { expect(f.current().page?.items).toHaveLength(200); expect(f.current().loading).toBe(false) })
  expect(f.calls).toHaveLength(2)
  await f.render(Infinity)
  await wait(() => { expect(f.current().page?.items).toHaveLength(500); expect(f.current().loading).toBe(false) })
  await f.render(Infinity); await pause()
  expect(f.calls).toHaveLength(5); expect(f.host.querySelector('[data-original="original-999"]')).toBe(original)
  expect(f.calls.filter(call => !call.cursor)).toHaveLength(1); expect(f.current().historyBoundary).toBeNull()
})

it('wire fragments do not spend semantic pages and untimed originals remain honest and explicitly continuable', async () => {
  const f = await fixture({ total: 8, timed: false, pageSize: 1, bodySize: 80000 })
  f.fragment(64 * 1024)
  await f.render(Infinity)
  await wait(() => { expect(f.current().page?.items).toHaveLength(3); expect(f.current().loading).toBe(false) })
  expect(f.calls).toHaveLength(3); expect(f.packets.length).toBeGreaterThan(3); expect(f.packets.some(packet => packet.fragmented)).toBe(true)
  expect(f.current().page!.items.every(item => item.startedAt === undefined)).toBe(true); expect(f.current().hasMore).toBe(true)
  await act(async () => f.current().readEarlier())
  await wait(() => { expect(f.current().page?.items).toHaveLength(4); expect(f.current().loading).toBe(false) })
  expect(f.calls).toHaveLength(4)
})

it('a failed automatic page retains its prefix and original Retry without restarting background demand', async () => {
  const f = await fixture(), read = f.client.readAgentConversation.bind(f.client)
  const requests: Array<Parameters<typeof read>[0]> = []
  let reject = true
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation((input, options) => {
    requests.push(input)
    if (reject && requests.length === 2) throw new AgentMuxError('The original automatic transport page failed', 'CONTROL_UNAVAILABLE')
    return read(input, options)
  })
  const pageRequests = () => requests.filter(input => !input.view)
  await f.activity()
  const retry = () => f.host.querySelector<HTMLButtonElement>('.activity-feed__reading-action[data-read-error="true"]')
  await wait(() => { expect(retry()?.textContent).toContain('original automatic transport page failed'); expect(retry()?.disabled).toBe(false) })
  expect(pageRequests()).toHaveLength(2); expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(100)
  const row = f.host.querySelector('[data-native-record-id="original-999"]')!
  await f.activity(); await pause(); expect(pageRequests()).toHaveLength(2)
  reject = false
  await wait(() => expect(retry()?.disabled, 'The original operation must settle before its existing Retry can be clicked').toBe(false))
  await act(async () => retry()!.click())
  await wait(() => {
    const sample = inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]
    expect(f.host.querySelectorAll('[data-native-record-id]'), JSON.stringify({ calls: f.calls, requests: requests.map(input => ({ cursor: Boolean(input.cursor), limit: input.limit })),
      held: sample?.held, loading: sample?.loading, error: sample?.error, accepted: sample?.accepted?.recordCount, pending: sample?.pending?.recordCount })).toHaveLength(200)
    expect(retry()).toBeNull()
  })
  await pause()
  expect(pageRequests()[2]!.cursor).toBeTruthy()
  expect(f.calls[1]!.cursor, 'Retry reads the original physical source page even when a newer frame signs its navigation token').toBe('original-page:900')
  expect(pageRequests()).toHaveLength(f.packets.length + 1)
  expect(f.packets.filter(packet => packet.complete)).toHaveLength(2)
  expect(f.calls).toHaveLength(2)
  expect(f.host.querySelector('[data-native-record-id="original-999"]')).toBe(row)
})

it('hidden abandons automatic demand without refilling it on retained-window resume', async () => {
  const f = await fixture(); f.block(1); await f.render(Infinity)
  await wait(() => expect(f.blocked()).toBe(true))
  const displayed = f.current().page
  await f.render(Infinity, false); await act(async () => f.release())
  await pause(); expect(f.current().page).toBe(displayed); expect(f.calls).toHaveLength(2)
  await f.render(Infinity); await wait(() => expect(f.current().loading).toBe(false)); await pause()
  expect(f.calls).toHaveLength(2)
})

it('explicit Earlier supersedes a delayed automatic page and its late reply cannot replace the accepted frame', async () => {
  const f = await fixture(); f.block(1); await f.render(Infinity)
  await wait(() => expect(f.blocked()).toBe(true))
  await act(async () => f.current().readEarlier())
  await wait(() => { expect(f.current().page?.items).toHaveLength(200); expect(f.current().loading).toBe(false) })
  const accepted = f.current().page
  await act(async () => f.release()); await pause()
  expect(f.current().page).toBe(accepted); expect(f.calls).toHaveLength(3)
})

function foldedReadingGeometry(host: HTMLElement) {
  const feed = host.querySelector<HTMLElement>('.activity-feed')!
  Object.defineProperties(feed, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 200 } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this === feed ? 0 : this.matches('.activity-feed__reading') ? 20 : 80
    const height = this === feed ? 200 : 24
    return { x: 0, y: top, top, left: 0, bottom: top + height, right: 600, width: 600, height, toJSON() {} }
  })
  return feed
}

it('one upward demand passes three folded pages and stops at original EOF without renewing on repaint', async () => {
  const f = await fixture({ total: 1000, process: true })
  const read = vi.mocked(api.conversation.readAgentConversation), original = read.getMockImplementation()!
  const requests: Array<Parameters<typeof original>[0]> = []
  read.mockImplementation((input, options) => { requests.push(input); return original(input, options) })
  await f.activity(); await wait(() => expect(f.calls).toHaveLength(3)); await wait(() => expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false))
  const feed = foldedReadingGeometry(f.host)
  const before = requests.length
  await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 })))
  await wait(() => { expect(f.calls).toHaveLength(10); expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false) })
  const demandReads = requests.slice(before).filter(input => !input.view)
  expect(demandReads.length).toBeGreaterThan(3)
  expect(demandReads.every(input => !input.preserveCurrent)).toBe(true)
  const loaded = () => [...f.host.querySelectorAll('[data-conversation-process-members]')].flatMap(node => processNativeRecordIds(node))
  expect(loaded()).toHaveLength(1000)
  await f.activity(); await pause(); await act(async () => window.dispatchEvent(new Event('resize'))); await pause()
  expect(f.calls).toHaveLength(10)
  expect(loaded()).toContain('original-999')
})

it.each(['wheel', 'Earlier'] as const)('a %s demand fills three actual screens even when each source page folds to a short strip', async action => {
  const f = await fixture({ total: 1600, process: true })
  await f.activity(); await wait(() => { expect(f.calls).toHaveLength(3); expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false) })
  const feed = foldedReadingGeometry(f.host)
  const boundary = f.host.querySelector<HTMLElement>('.activity-feed__reading')!
  // Model the completed layout: one hundred process originals add only a 128px
  // readable strip. The actual Electron proof separately measures real DOM layout.
  const start = f.calls.length
  vi.spyOn(boundary, 'getBoundingClientRect').mockImplementation(() => {
    const bottom = 20 - (f.calls.length - start) * 128
    return { top: bottom - 20, bottom, left: 0, right: 600, width: 600, height: 20, x: 0, y: bottom - 20, toJSON() {} }
  })
  await act(async () => action === 'wheel'
    ? feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 }))
    : f.host.querySelector<HTMLButtonElement>('.activity-feed__reading-action')!.click())
  await wait(() => { expect(f.calls).toHaveLength(start + 5); expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false) })
  expect(-boundary.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(3 * feed.clientHeight)
  expect(f.calls.slice(start).map(call => call.limit)).toEqual([100, 100, 100, 100, 100])
  await f.activity(); await pause(); expect(f.calls).toHaveLength(start + 5)
})

it('a full captured-only window continues on upward reading and retains its visible captured anchor', async () => {
  const f = await fixture({ total: 0 })
  for (let n = 0; n < 1500; n++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.reference.agentSessionId,
    item: { id: `captured-${n}`, agentSessionId: f.reference.agentSessionId, kind: 'user_message', source: 'user', authorHuman: true,
      title: 'Original input', content: `Captured original input ${n}`, status: 'complete', createdAt: n + 1, updatedAt: n + 1 } })
  await f.activity()
  const sample = () => inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]!
  const button = () => f.host.querySelector<HTMLButtonElement>('.activity-feed__reading-action')!
  for (let page = 0; page < 11; page++) {
    await wait(() => expect(sample().loading).toBe(false))
    await act(async () => button().click())
  }
  await wait(() => { expect(sample().accepted?.recordCount).toBe(1200); expect(sample().loading).toBe(false) })
  const feed = f.host.querySelector<HTMLElement>('.activity-feed')!
  const anchor = f.host.querySelector<HTMLElement>('[data-segment-key]')!
  expect(anchor.textContent).toContain('Captured original input 300')
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON() {} })
  Object.defineProperties(feed, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 5000 } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === feed) return rect(0, 200)
    if (this === anchor) return rect(50, 30)
    if (this.matches('.activity-feed__reading')) return rect(0, 20)
    return rect(600, 30)
  })
  await act(async () => anchor.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 })))
  await wait(() => {
    expect(f.host.textContent).toContain('Captured original input 0')
    expect(sample().loading).toBe(false)
  })
  expect(anchor.isConnected).toBe(true); expect(anchor.getBoundingClientRect().top).toBe(50)
  expect([...f.host.querySelectorAll('.activity-feed__reading-action')].map(node => node.textContent)).not.toContain('Earlier')
  expect(f.host.textContent).toContain('Newer')
}, 60000)

it('opposite intent and hiding cancel the remaining read-ahead pages without replaying the batch', async () => {
  const f = await fixture({ total: 1000, process: true })
  await f.activity(); await wait(() => { expect(f.calls).toHaveLength(3); expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false) })
  const feed = foldedReadingGeometry(f.host)
  f.block(3)
  await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 })))
  await wait(() => expect(f.blocked()).toBe(true))
  await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 })))
  await act(async () => f.release()); await wait(() => expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false)); await pause()
  expect(f.calls).toHaveLength(4)
  f.block(4)
  await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 })))
  await wait(() => expect(f.blocked()).toBe(true))
  await f.activity(false); await act(async () => f.release()); await pause(); await f.activity(); await pause()
  expect(f.calls).toHaveLength(5)
})

it('flat folded layout spends a finite demand and needs fresh reading before traversing another window', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const read = vi.fn(() => true)
  let demand!: ReturnType<typeof useConversationReadAhead>
  function Probe({ frame }: { frame: object }) {
    demand = useConversationReadAhead({ identity: 'original-folded-source', active: true, stopped: false, loading: false,
      frame, nearEdge: () => true, read })
    return null
  }
  const repaint = () => act(async () => root.render(<Probe frame={{}} />))
  await repaint(); expect(read).not.toHaveBeenCalled()
  await act(async () => demand.request('earlier'))
  for (let n = 0; n < 30; n++) await repaint()
  expect(read).toHaveBeenCalledTimes(12)
  await act(async () => demand.request('earlier'))
  expect(read).toHaveBeenCalledTimes(13)
})

it('a retained hook discards hidden demand before a new frame arrives and does not resume it on visibility alone', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host)
  const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const read = vi.fn(() => true)
  let demand!: ReturnType<typeof useConversationReadAhead>
  function Probe({ frame, active }: { frame: object; active: boolean }) {
    demand = useConversationReadAhead({ identity: 'retained-original', active, stopped: false, loading: false,
      frame, nearEdge: () => true, read })
    return null
  }
  const frame = {}
  await act(async () => root.render(<Probe frame={frame} active />))
  await act(async () => demand.request('earlier'))
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<Probe frame={frame} active={false} />))
  await act(async () => root.render(<Probe frame={{}} active={false} />))
  await act(async () => root.render(<Probe frame={{}} active />))
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => demand.request('earlier'))
  expect(read).toHaveBeenCalledTimes(2)
})

async function seedRetained(f: Awaited<ReturnType<typeof fixture>>, captured: number) {
  for (let index = 0; index < captured; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.reference.agentSessionId,
    item: { id: `captured-${index}`, agentSessionId: f.reference.agentSessionId, kind: 'assistant_message', source: 'native-hook',
      status: 'complete', title: 'Original captured answer', content: 'Original captured contribution', createdAt: index + 1, updatedAt: index + 1 } })
  let snapshot!: ConversationWindowSnapshot
  for (let page = 0; page < 6; page++) {
    let assembly: ConversationWindowAssembly | undefined, cursor = page ? snapshot.window.navigation.older! : undefined
    for (;;) {
      const packet = await api.conversation.readAgentConversation({ ...f.reference, processDetails: 'deferred', limit: 100, maxBytes: 4 * 1024 * 1024, ...(cursor ? { cursor } : {}) })
      const result = consumeConversationWindowPage(packet, assembly)
      if (result.kind === 'complete') { snapshot = result.snapshot; break }
      assembly = result.pending; cursor = packet.nextCursor!
    }
  }
  return snapshot
}

it.each([2, 1])('a real two-source retained window with %i slots protects both original source limits without closing Earlier', async remaining => {
  const f = await fixture({ total: 601, initialShort: remaining })
  const seeded = await seedRetained(f, 601)
  expect(seeded.units.reduce((count, unit) => count + unit.records.length, 0)).toBe(1200 - remaining)
  expect(seeded.scope.sources.filter(source => source.kind === 'native' || source.kind === 'captured')).toHaveLength(2)
  const sourceRead = vi.spyOn(f.store, 'readCapturedHistory')
  const before = f.calls.length, firstPacket = f.packets.length
  const completed = f.packets.filter(packet => packet.complete).length
  const read = f.client.readAgentConversation.bind(f.client)
  const retries: Array<Parameters<typeof read>[0]> = []
  let interrupted = false
  if (remaining === 2) vi.spyOn(f.client, 'readAgentConversation').mockImplementation((input, options) => {
    if (input.cursor && f.packets.filter(packet => packet.complete).length > completed) {
      retries.push(input)
      if (!interrupted) {
        interrupted = true
        throw new AgentMuxError('The exact remaining-capacity transport page failed', 'CONTROL_UNAVAILABLE')
      }
    }
    return read(input, options)
  })
  f.replay(seeded.window.view!)
  await f.render(Infinity)
  if (remaining === 2) {
    await wait(() => { expect(f.current().automaticReadError?.message).toContain('remaining-capacity transport'); expect(f.current().loading).toBe(false) })
    expect(retries).toHaveLength(1); expect(retries[0]!.limit, 'Each of two original sources receives only one of the two remaining slots').toBe(1)
    await act(async () => f.current().retry())
  }
  await wait(() => { expect(f.current().snapshot?.units.reduce((count, unit) => count + unit.records.length, 0)).toBe(remaining === 2 ? 1200 : 1199); expect(f.current().loading).toBe(false) })
  await pause()
  expect(f.current().hasMore).toBe(true); expect(f.current().error).toBeNull()
  if (remaining === 2) {
    expect(retries[1]!.cursor).toBeTruthy(); expect(retries[1]!.limit).toBe(1)
    expect(f.calls.slice(before)).toEqual([{ cursor: 'original-page:3', limit: 1 }])
    const newPackets = f.packets.slice(firstPacket), openingEnd = newPackets.findIndex(packet => packet.complete)
    const supplemental = newPackets.slice(openingEnd + 1)
    expect(supplemental).toHaveLength(1 + Math.ceil((1200 - 1) / 100))
    expect(supplemental[0]!.limit).toBe(1)
    expect(supplemental.slice(1).every(packet => packet.limit === 100), 'Frozen transport continuation must not repeat the one-record source IO limit').toBe(true)
    expect(sourceRead.mock.calls.filter(([_id, input]) => input?.beforeFirstSequence !== undefined).map(([_id, input]) => input!.limit)).toEqual([1])
  } else {
    expect(f.calls).toHaveLength(before); expect(sourceRead.mock.calls.filter(([_id, input]) => input?.beforeFirstSequence !== undefined)).toHaveLength(0)
    await act(async () => f.current().readEarlier())
    await wait(() => { expect(f.calls).toHaveLength(before + 1); expect(f.current().loading).toBe(false) })
    expect(f.calls.at(-1)!.limit).toBe(100)
  }
})


it('actual Activity keeps ruler visibility local and measures only observed rows for a reading anchor', async () => {
  const view = vi.fn(() => null)
  const f = await fixture({ total: 100, renderMessageActions: view })
  const observers: Array<{ callback: IntersectionObserverCallback; nodes: Set<Element> }> = []
  vi.stubGlobal('IntersectionObserver', class {
    nodes = new Set<Element>()
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, nodes: this.nodes }) }
    observe(node: Element) { this.nodes.add(node) }
    unobserve(node: Element) { this.nodes.delete(node) }
    disconnect() { this.nodes.clear() }
  })
  await f.activity()
  await wait(() => expect(f.host.querySelectorAll('[data-native-record-id]')).toHaveLength(100))
  await wait(() => expect(inspectConversationConsumers({ ...f.reference, records: [] }).consumers[0]?.loading).toBe(false))
  const feed = f.host.querySelector<HTMLElement>('.activity-feed')!
  const rows = [...f.host.querySelectorAll<HTMLElement>('[data-native-record-id]')]
  const visible = rows.slice(-3)
  const observer = [...observers].reverse().find(candidate => candidate.nodes.has(visible[0]!))!
  expect(observer).toBeTruthy()
  expect(view).toHaveBeenCalled()
  const before = view.mock.calls.length
  await act(async () => observer.callback(visible.map(target => ({ target, isIntersecting: true, intersectionRatio: 1,
    boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect(), rootBounds: null, time: 0 })), {} as IntersectionObserver))
  expect(view.mock.calls.length, 'Ruler visibility must not render the conversation again').toBe(before)
  const measured = new Set<string>()
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top, toJSON() {} })
  vi.spyOn(feed, 'getBoundingClientRect').mockReturnValue(rect(0, 200))
  Object.defineProperties(feed, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 4000 } })
  rows.forEach((node, index) => vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => {
    measured.add(node.dataset.nativeRecordId!)
    return rect((index - 97) * 50 + 10, 50)
  }))
  feed.scrollTop = 2000
  await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 })))
  expect(measured.has('original-97'), 'The actual wheel path must capture its first visible record').toBe(true)
  expect([...measured].every(id => visible.some(node => node.dataset.nativeRecordId === id)), 'Anchor capture must not measure the invisible historical prefix').toBe(true)
  expect(f.calls).toHaveLength(1)
})
