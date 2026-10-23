import { processNativeRecordIds } from './helpers/conversation-process-members'
import { fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentMuxStoredAgentSession, type AgentTimelineItem } from '@agentmux/core'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { conversationRulerRecords, conversationRulerWindow } from '../src/renderer/src/lib/conversation-ruler'
import { describeSpan } from '../src/renderer/src/lib/activity-ruler'

const sid = 'ruler-managed-a', native = 'ruler-native'
const initial = useAppStore.getState()
const start = Date.UTC(_hygiene_fixtureYear - 1, 0, 1, 0)
let container: HTMLDivElement, root: Root, home: string, client: AgentMuxClient, store: AgentMuxFileAgentSessionStore, session: AgentMuxStoredAgentSession, page: AgentSessionHistoryPage
let controls: ReturnType<typeof vi.spyOn>[]
let acceptedReadCount = 0
const closes: Array<() => unknown | Promise<unknown>> = []
const readCount = () => vi.mocked(api.conversation.readAgentConversation).mock.calls.length + vi.mocked(api.conversation.readConversationChanges).mock.calls.length
class VisibleObserver {
 static instances: VisibleObserver[] = []
 targets = new Set<Element>()
 constructor(readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) { VisibleObserver.instances.push(this) }
 observe(element: Element) { this.targets.add(element) }
 unobserve(element: Element) { this.targets.delete(element) }
 disconnect() { this.targets.clear() }
 show(elements: Element[]) {
  expect(elements.length).toBeGreaterThan(0)
  for (const element of elements) expect(this.targets.has(element)).toBe(true)
  this.callback([...this.targets].map(target => ({ target, isIntersecting: elements.includes(target) }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
 }
 hideAll() {
  expect(this.targets.size).toBeGreaterThan(0)
  this.callback([...this.targets].map(target => ({ target, isIntersecting: false }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
 }
}
class MeasuringObserver {
 static instances: MeasuringObserver[] = []
 targets = new Set<Element>()
 constructor(readonly callback: ResizeObserverCallback) { MeasuringObserver.instances.push(this) }
 observe(element: Element) { this.targets.add(element) }
 unobserve(element: Element) { this.targets.delete(element) }
 disconnect() { this.targets.clear() }
 measure(element: Element) { this.callback([{ target: element }] as ResizeObserverEntry[], this as unknown as ResizeObserver) }
}
function record(n: number) {
 const user = n % 6 === 0
 return { uuid: `ruler-${n}`, type: user ? 'user' : 'assistant', sessionId: native,
  timestamp: new Date(start + n * 6 * 3_600_000).toISOString(), message: { role: user ? 'user' : 'assistant',
   content: user ? `User ${n}` : n < 5 ? [{ type: 'thinking', thinking: `Process ${n}` }] : [{ type: 'text', text: `Reply ${n}` }] } }
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function render(node: ReactNode, expected = page, sourceChanged = false) {
 if (!sourceChanged) expect(readCount()).toBe(acceptedReadCount)
 await act(async () => root.render(node)); await flush()
 if (node !== null) await vi.waitFor(async () => {
  await flush()
  const consumer = inspectConversationConsumers({ hostId: 'local', agentSessionId: expected.agentSessionId,
   records: expected.items.map(item => ({ hostId: 'local', agentSessionId: expected.agentSessionId,
    source: { kind: 'native', ...expected.source, recordId: item.id } })) }).consumers[0]
  expect(consumer?.accepted?.membership).toHaveLength(expected.items.length)
  expect(consumer?.accepted?.membership.every(item => item.present)).toBe(true)
  expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false); expect(consumer?.watch.binding).toBe(false)
  expect(consumer?.error).toBeNull(); expect(consumer?.sourceError).toBeNull(); expect(consumer?.observationError).toBeNull()
  expect(consumer?.dirty).toBe(false)
 }, { timeout: 3000 })
 acceptedReadCount = readCount()
}
function view(p = page) {
 return <ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: p.agentSessionId },
  describeSpeaker: speaker => ({ name: speaker.role === 'agent' ? 'Execution agent' : 'Original user' }) })} />
}
function rulerRecords(agentSessionId: string, original: AgentSessionHistoryPage, items: readonly AgentTimelineItem[]) {
 // These expected references use the original FileStore's explicit Host. The
 // test never reconstructs or decodes an opaque accepted record identity.
 return conversationRulerRecords(agentSessionId, original, items, projectConversationRecords({ agentSessionId,
  historyPage: { ...original, sourceHostId: 'local' }, timeline: { agentSessionId, sourceHostId: 'local', revision: 0, items: [...items] } }))
}

function observer(): VisibleObserver {
 const feed = container.querySelector('.activity-feed')!
 const result = [...VisibleObserver.instances].reverse().find(item => item.options?.root === feed && item.targets.size > 0)
 expect(result).toBeDefined(); return result!
}
function spanText() { return container.querySelector('.activity-ruler__span-range')?.textContent?.replace('→', '') }
function expectedSpan(items: ReturnType<typeof conversationRulerRecords>, visible = new Set<string>()) {
 const span = describeSpan(conversationRulerWindow(items, '24h', visible).scale)!
 return span.from + span.to
}
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 vi.stubGlobal('ResizeObserver', MeasuringObserver); MeasuringObserver.instances = []
 vi.stubGlobal('IntersectionObserver', VisibleObserver); VisibleObserver.instances = []
 Element.prototype.scrollIntoView = vi.fn()
 useAppStore.setState({ sessions: [], timelines: {}, agentNames: {} })
 home = await mkdtemp(join(tmpdir(), 'amx-ruler-follow-')); await mkdir(join(home, 'workspace'))
 const transcript = join(home, 'conversation.jsonl')
 await writeFile(transcript, Array.from({ length: 22 }, (_, n) => JSON.stringify(n === 21 ? { ...record(n), timestamp: undefined } : record(n))).join('\n') + '\n')
 store = new AgentMuxFileAgentSessionStore(join(home, 'sessions.json'))
 session = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: join(home, 'workspace'), run: { runId: 'ruler-retained-run-a' }, retiredRuns: [], hookBindingId: 'ruler-private-hook', hookToken: 'ruler-private-token', createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } }
 await store.compareAndSwap(null, session); client = new AgentMuxClient({ store }); page = await client.sessionHistoryPage(sid, { limit: 30 })
 expect(page.items).toHaveLength(22)
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(Reflect.get(client, 'kernel'), key).mockImplementation(() => { throw new Error('Unexpected Runtime control') }))
 await desktopConversationReadBridge({ root: home, client }, closes)
 acceptedReadCount = 0
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 window.getSelection()?.removeAllRanges(); await act(async () => root.unmount()); container.remove()
 try {
  expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(readCount()).toBe(acceptedReadCount)
 } finally {
  for (const close of closes.splice(0).reverse()) await close()
  await client.dispose(); await rm(home, { recursive: true })
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
 }
})
it('moves the finite overview to visible older records and keeps recent relative to latest loaded facts', async () => {
 const records = rulerRecords(sid, page, [])
 const latest = conversationRulerWindow(records, '6h')
 const old = conversationRulerWindow(records, '6h', new Set([records[0]!.id]))
 expect(old.items[0]!.record.id).toBe('ruler-0')
 expect(old.items.at(-1)!.record.id).toBe('ruler-1')
 expect(latest.items[0]!.record.id).toBe('ruler-19')
 const twelveHours = conversationRulerWindow([...records].reverse(), '12h', new Set([records[8]!.id]))
 // A time-domain filter preserves the supplied durable source order.
 expect(twelveHours.items.map(record => record.record.id)).toEqual(['ruler-10', 'ruler-9', 'ruler-8'])
 expect(conversationRulerWindow(records, '24h', new Set([records[0]!.id])).items).toHaveLength(5)
 expect(old.recentFraction).toBeGreaterThan(1)
 expect(latest.recentFraction).toBeCloseTo(5 / 6)
 expect(conversationRulerWindow(records, 'all', new Set([records[0]!.id])).items).toHaveLength(21)
 await writeFile(join(home, 'conversation.jsonl'), Array.from({ length: 21 }, (_, n) => JSON.stringify({ ...record(n), timestamp: new Date(start + n * 4 * 3_600_000).toISOString() })).join('\n') + '\n')
 const extended = await client.sessionHistoryPage(sid, { limit: 30 })
 const wide = rulerRecords(sid, extended, [])
 expect(wide.at(-1)!.recordedAt! - wide[0]!.recordedAt!).toBe(80 * 3_600_000)
 expect(conversationRulerWindow(wide, '24h', new Set([wide[0]!.id])).items.map(record => record.record.id)).toEqual(Array.from({ length: 7 }, (_, n) => `ruler-${n}`))
 expect(conversationRulerWindow(wide, '24h').items.map(record => record.record.id)).toEqual(Array.from({ length: 7 }, (_, n) => `ruler-${14 + n}`))
})
it('does not invent time when only an untimed record is visible or all times are absent', () => {
 const records = rulerRecords(sid, page, [])
 const result = conversationRulerWindow(records, '6h', new Set([records.at(-1)!.id]))
 expect(result.items.map(item => item.id)).toEqual(conversationRulerWindow(records, '6h').items.map(item => item.id))
 expect(result.untimed).toHaveLength(1)
 const unknown = records.map(({ recordedAt: _recordedAt, ...record }) => record)
 const ordinal = conversationRulerWindow(unknown, '12h', new Set([unknown[0]!.id]))
 expect(ordinal.scale.axis).toBe('ordinal'); expect(ordinal.items).toHaveLength(22); expect(ordinal.scale.readoutOf(0)).not.toHaveProperty('at')
})
it('uses current managed identity for both native and captured ruler references without changing source targets', async () => {
 const reservation = { kind: 'stop' as const, reservationId: 'retire-ruler-a', ownerId: 'ruler-fixture', ownerPid: process.pid, agentSessionId: sid, operationId: 'retire-ruler', expiresAt: Date.now() + 60000, expectedRun: session.run, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'retire-ruler', runId: session.run.runId } }
 await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
 const other = { ...session, agentSessionId: 'ruler-managed-b', run: { runId: 'ruler-retained-run-b' }, hookBindingId: 'ruler-private-hook-b', hookToken: 'ruler-private-token-b' }
 await store.compareAndSwap(null, other)
 const next = await client.sessionHistoryPage(other.agentSessionId, { limit: 30 })
 const observed: AgentTimelineItem = { id: 'same-observed-id', agentSessionId: sid, kind: 'user_message', source: 'user', content: 'Original captured input', title: 'Input', status: 'complete', createdAt: start, updatedAt: start }
 const before = rulerRecords(sid, page, [observed]), after = rulerRecords(other.agentSessionId, next, [{ ...observed, agentSessionId: other.agentSessionId }])
 expect(before).toHaveLength(after.length)
 expect(before.every((record, index) => record.id !== after[index]!.id)).toBe(true)
 expect(before[0]!.target).toEqual(after[0]!.target)
 await render(view()); const slider = container.querySelector('[role="slider"]')!
 await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))); await flush()
 expect(container.querySelector('[data-selected]')).not.toBeNull()
 await render(view(next), next); expect(container.querySelector('[data-selected]')).toBeNull()
})
it('consumes actual shell visibility while retaining original body DOM, Range and zero reading demand', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 expect(user).not.toBeNull(); const body = user.querySelector('.log-turn__body') ?? user
 const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let text: Text | null = null
 while (walker.nextNode()) if (walker.currentNode.textContent?.includes('User 0')) { text = walker.currentNode as Text; break }
 expect(text).not.toBeNull(); const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4); window.getSelection()!.addRange(range)
 await act(async () => observer().show([user])); await flush()
 const records = rulerRecords(sid, page, [])
 expect(spanText()).toBe(expectedSpan(records, new Set([records[0]!.id])))
 expect(container.querySelector('[data-native-record-id="ruler-0"]')).toBe(user)
 expect(text!.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
 expect(container.querySelector('.activity-ruler__band')).not.toBeNull()
 expect(container.querySelector('[aria-label="History window: 24h"]')?.getAttribute('title')).toContain('reading position')
 await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-20"]')!])); await flush()
 expect(spanText()).toBe(expectedSpan(records))
 expect(user.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
})
it('defaults to 24h and selects all six real menu windows without replacing the original message', async () => {
 await render(view())
 const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 const body = user.querySelector('.log-turn__body') ?? user
 const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
 let text: Text | null = null
 while (walker.nextNode()) if (walker.currentNode.textContent?.includes('User 0')) { text = walker.currentNode as Text; break }
 expect(text).not.toBeNull()
 const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4); window.getSelection()!.addRange(range)
 const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label^="History window:"]')!
 expect(trigger().getAttribute('aria-label')).toBe('History window: 24h')
 const records = rulerRecords(sid, page, [])
 for (const preset of ['6h', '12h', '24h', '3d', '7d', 'all'] as const) {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))); await flush()
  const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  expect(options.map(item => item.textContent)).toEqual(['6h reading window', '12h reading window', '24h reading window', '3d reading window', '7d reading window', 'All · bounded reading'])
  const target = options.find(item => item.textContent === (preset === 'all' ? 'All · bounded reading' : preset + ' reading window'))!
  expect(target).toBeDefined(); await act(async () => target.click()); await flush()
  expect(trigger().getAttribute('aria-label')).toBe('History window: ' + (preset === 'all' ? 'All' : preset))
  const span = describeSpan(conversationRulerWindow(records, preset).scale)!
  expect(spanText()).toBe(span.from + span.to)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(container.querySelector('[data-native-record-id="ruler-0"]')).toBe(user)
  expect(text!.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
 }
})

it('maps a collapsed Workflow header to all original record references and observes the real opened steps', async () => {
 await render(view()); const group = container.querySelector<HTMLElement>('[data-conversation-process-members]')!
 const head = group.querySelector<HTMLElement>('.wf-head')!
 expect(head.getAttribute('aria-expanded')).toBe('false')
 const raw = processNativeRecordIds(group); expect(raw).toHaveLength(4)
 await act(async () => observer().show([head])); await flush()
 const records = rulerRecords(sid, page, []); const visible = new Set(records.filter(record => raw.includes(record.record.id)).map(record => record.id))
 expect(spanText()).toBe(expectedSpan(records, visible))
 expect(container.querySelector('.activity-ruler__band')).not.toBeNull()
 await act(async () => head.click()); await flush(); expect(head.getAttribute('aria-expanded')).toBe('true')
 const step = group.querySelector<HTMLElement>('[data-native-step-id="ruler-4"]')!
 expect(step).not.toBeNull(); await act(async () => observer().show([step])); await flush()
 expect(group.isConnected).toBe(true); expect(head.isConnected).toBe(true)
 expect(spanText()).toBe(expectedSpan(records, new Set([records.find(record => record.record.id === 'ruler-4')!.id])))
})

it('follows an original captured Message Tool shell without changing either source body or requesting pages', async () => {
 await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'captured-old-input', agentSessionId: sid, kind: 'user_message', source: 'user', sourceChannel: 'message-tool', title: 'Accepted input', status: 'complete', content: 'Original Message Tool input', createdAt: start - 3_600_000, updatedAt: start - 3_600_000 } })
 const timeline = await client.sessionTimeline(sid)
 expect(timeline.items).toHaveLength(1)
 await render(view())
 const shell = [...container.querySelectorAll<HTMLElement>('[data-segment-key]')].find(node => node.textContent?.includes('Original Message Tool input'))!
 expect(shell).toBeDefined()
 const nativeBody = container.querySelector('[data-native-record-id="ruler-20"]')!
 await act(async () => observer().show([shell])); await flush()
 const records = rulerRecords(sid, page, timeline.items), captured = records.find(record => record.target.kind === 'observed')!
 expect(spanText()).toBe(expectedSpan(records, new Set([captured.id])))
 expect(container.querySelector('.activity-ruler__band')).not.toBeNull()
 expect(shell.isConnected).toBe(true); expect(nativeBody.isConnected).toBe(true)
 expect(shell.textContent).toContain('Original Message Tool input')
})

it('keeps all-old final avatars historical and omits a cutoff outside the displayed time domain', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([user])); await flush()
 const marks = [...container.querySelectorAll<HTMLElement>('.conversation-axis__mark')]
 expect(marks.length).toBeGreaterThan(0)
 expect(marks.every(mark => mark.dataset.era === 'history')).toBe(true)
 expect(container.querySelector('.conversation-ruler__cutoff')).toBeNull()
})

it('keeps a known single older record historical and untimed ordinal records unclassified', async () => {
 await writeFile(join(home, 'conversation.jsonl'), Array.from({ length: 21 }, (_, n) => JSON.stringify({ ...record(n), timestamp: new Date(start + n * 48 * 3_600_000).toISOString() })).join('\n') + '\n')
 const extended = await client.sessionHistoryPage(sid, { limit: 30 })
 await render(view(extended), extended); const old = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([old])); await flush()
 // Direct public window projection supplies the same zero-span, known-time domain as the actual renderer.
 const records = rulerRecords(sid, extended, [])
 const single = conversationRulerWindow(records, '6h', new Set([records[0]!.id]))
 expect(single.items).toHaveLength(1); expect(single.scale.axis).toBe('ordinal'); expect(single.recentFraction).toBe(Infinity)
 expect(container.querySelector('.conversation-ruler__cutoff')).toBeNull()
 expect(container.querySelector('.conversation-axis__mark')?.getAttribute('data-era')).toBe('history')
 await render(null)
 await writeFile(join(home, 'conversation.jsonl'), [record(0), { ...record(6), timestamp: new Date(start).toISOString() }, { ...record(20), timestamp: new Date(start + 80 * 3_600_000).toISOString() }].map(record => JSON.stringify(record)).join('\n') + '\n')
 const tied = await client.sessionHistoryPage(sid, { limit: 30 }); expect(tied.items).toHaveLength(3)
 await render(view(tied), tied); await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!])); await flush()
 expect(container.querySelector('[role="slider"]')?.getAttribute('data-axis')).toBe('ordinal')
 const tiedMarks = [...container.querySelectorAll<HTMLElement>('.conversation-axis__mark')]
 expect(tiedMarks).toHaveLength(2); expect(tiedMarks.every(mark => mark.dataset.era === 'history')).toBe(true)
 await render(null)
 await writeFile(join(home, 'conversation.jsonl'), JSON.stringify({ ...record(0), timestamp: undefined }) + '\n')
 const unknown = await client.sessionHistoryPage(sid, { limit: 30 }); expect(unknown.items).toHaveLength(1)
 await render(view(unknown), unknown); expect(container.querySelector('.conversation-axis__mark')).not.toBeNull()
 expect(container.querySelector('.conversation-axis__mark')?.hasAttribute('data-era')).toBe(false)
 expect(container.querySelector('.conversation-ruler__cutoff')).toBeNull()
 expect(container.querySelector('.conversation-ruler__recent')).toBeNull()
})


it('keeps the original visible reading band during sticky-header measurement handoff', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([user])); await flush()
 const before = spanText(), band = container.querySelector('.activity-ruler__band')
 expect(band).not.toBeNull(); expect(before).toBe(expectedSpan(rulerRecords(sid, page, []), new Set([rulerRecords(sid, page, [])[0]!.id])))
 const header = container.querySelector<HTMLElement>('.activity-ruler')!
 vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ height: 80 } as DOMRect)
 const measure = MeasuringObserver.instances.find(instance => instance.targets.has(header))!
 expect(measure).toBeDefined()
 await act(async () => measure.measure(header)); await flush()
 // No replacement IO callback has arrived yet: an empty transfer placeholder is not viewport truth.
 expect(spanText()).toBe(before)
 expect(container.querySelector('.activity-ruler__band')).toBe(band)
 expect(container.querySelector('[data-native-record-id="ruler-0"]')).toBe(user)
 expect(observer().options?.rootMargin).toBe('-80px 0px 0px 0px')
 await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-20"]')!])); await flush()
 expect(spanText()).toBe(expectedSpan(rulerRecords(sid, page, [])))
})

it('retains visible records, body node and Range while a new native reply arrives', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([user])); await flush()
 const before = spanText(), band = container.querySelector('.activity-ruler__band')
 const walker = document.createTreeWalker(user, NodeFilter.SHOW_TEXT); let text: Text | null = null
 while (walker.nextNode()) if (walker.currentNode.textContent?.includes('User 0')) { text = walker.currentNode as Text; break }
 expect(text).not.toBeNull(); const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4); window.getSelection()!.addRange(range)
 await appendFile(join(home, 'conversation.jsonl'), JSON.stringify(record(22)) + '\n')
 const updated = await client.sessionHistoryPage(sid, { limit: 30 }); expect(updated.items).toHaveLength(23)
 await render(view(updated), updated, true)
 expect(spanText()).toBe(before); expect(container.querySelector('.activity-ruler__band')).toBe(band)
 expect(container.querySelector('[data-native-record-id="ruler-0"]')).toBe(user)
 expect(text!.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
 await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-22"]')!])); await flush()
 expect(spanText()).toBe(expectedSpan(rulerRecords(sid, updated, [])))
})

it('does not rerender the parent for an unchanged shell membership or ruler-only child mutation', async () => {
 const commits = vi.fn(); await render(<Profiler id="activity" onRender={commits}>{view()}</Profiler>)
 const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([user])); await flush(); const before = commits.mock.calls.length
 await act(async () => observer().show([user])); await flush()
 expect(commits.mock.calls.length).toBe(before)
 const ornament = document.createElement('span'); container.querySelector('.activity-ruler')!.append(ornament); await flush()
 expect(commits.mock.calls.length).toBe(before)
 ornament.remove(); await flush(); expect(commits.mock.calls.length).toBe(before)
})

it('discards retired viewport callbacks while honestly clearing a truly empty current viewport', async () => {
 await render(view()); const oldObserver = observer(), oldUser = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => oldObserver.show([oldUser])); await flush()
 const reservation = { kind: 'stop' as const, reservationId: 'retire-ruler-visible-a', ownerId: 'ruler-fixture', ownerPid: process.pid,
  agentSessionId: sid, operationId: 'retire-ruler-visible', expiresAt: Date.now() + 60000, expectedRun: session.run,
  stopOperation: { daemonInstance: 'no-runtime', operationKey: 'retire-ruler-visible', runId: session.run.runId } }
 await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
 const other = { ...session, agentSessionId: 'ruler-managed-other', run: { runId: 'ruler-retained-run-other' }, hookBindingId: 'ruler-hook-other', hookToken: 'ruler-token-other' }
 await store.compareAndSwap(null, other)
 const next = await client.sessionHistoryPage(other.agentSessionId, { limit: 30 }); await render(view(next), next)
 const currentObserver = observer(), currentUser = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => currentObserver.show([currentUser])); await flush()
 const before = spanText(), band = container.querySelector('.activity-ruler__band'); expect(band).not.toBeNull()
 await act(async () => oldObserver.callback([{ target: oldUser, isIntersecting: true }] as unknown as IntersectionObserverEntry[], oldObserver as unknown as IntersectionObserver)); await flush()
 expect(spanText()).toBe(before); expect(container.querySelector('.activity-ruler__band')).toBe(band)
 await act(async () => currentObserver.hideAll()); await flush()
 expect(container.querySelector('.activity-ruler__band')).toBeNull()
 expect(spanText()).toBe(expectedSpan(rulerRecords(next.agentSessionId, next, [])))
})
