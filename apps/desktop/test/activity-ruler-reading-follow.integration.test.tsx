import { fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, Profiler, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi, type MockInstance } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage, type AgentMuxStoredAgentSession, type AgentTimelineItem } from '@agentmux/core'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { conversationRulerRecords, conversationRulerWindow } from '../src/renderer/src/lib/conversation-ruler'
import { describeSpan } from '../src/renderer/src/lib/activity-ruler'

const sid = 'ruler-managed-a', native = 'ruler-native'
const initial = useAppStore.getState()
const start = Date.UTC(_hygiene_fixtureYear - 1, 0, 1, 0)
let container: HTMLDivElement, root: Root, home: string, client: AgentMuxClient, store: AgentMuxFileAgentSessionStore, session: AgentMuxStoredAgentSession, page: AgentSessionHistoryPage
let reads: MockInstance<typeof api.sessions.historyPage>, controls: ReturnType<typeof vi.spyOn>[]
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
  timestamp: new Date(start + n * 600_000).toISOString(), message: { role: user ? 'user' : 'assistant',
   content: user ? `User ${n}` : n < 5 ? [{ type: 'thinking', thinking: `Process ${n}` }] : [{ type: 'text', text: `Reply ${n}` }] } }
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function render(node: ReactNode) { await act(async () => root.render(node)); await flush() }
function view(p = page) { return <ActivityView sessionId={p.agentSessionId} items={[]} capability="complete-events" nativeHistoryPage={p} describeSpeaker={speaker => ({ name: speaker.role === 'agent' ? 'Execution agent' : 'Original user' })} /> }
function observer(): VisibleObserver {
 const feed = container.querySelector('.activity-feed')!
 const result = [...VisibleObserver.instances].reverse().find(item => item.options?.root === feed && item.targets.size > 0)
 expect(result).toBeDefined(); return result!
}
function spanText() { return container.querySelector('.activity-ruler__span-range')?.textContent?.replace('→', '') }
function expectedSpan(items: ReturnType<typeof conversationRulerRecords>, visible = new Set<string>()) {
 const span = describeSpan(conversationRulerWindow(items, '1h', visible).scale)!
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
 reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(() => { throw new Error('Ruler must never read pages') })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 await act(async () => root.unmount()); container.remove(); await client.dispose(); await rm(home, { recursive: true })
 expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]); expect(reads).not.toHaveBeenCalled()
 useAppStore.setState(initial, true); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('moves the finite overview to visible older records and keeps recent relative to latest loaded facts', async () => {
 const records = conversationRulerRecords(sid, page, [])
 const latest = conversationRulerWindow(records, '1h')
 const old = conversationRulerWindow(records, '1h', new Set([records[0]!.id]))
 expect(old.items[0]!.record.id).toBe('ruler-0')
 expect(old.items.at(-1)!.record.id).toBe('ruler-6')
 expect(latest.items[0]!.record.id).toBe('ruler-14')
 const quarter = conversationRulerWindow([...records].reverse(), '15m', new Set([records[8]!.id]))
 expect(quarter.items.map(record => record.record.id)).toEqual(['ruler-8', 'ruler-9'])
 expect(conversationRulerWindow(records, '24h', new Set([records[0]!.id])).items).toHaveLength(21)
 expect(old.recentFraction).toBeGreaterThan(1)
 expect(latest.recentFraction).toBe(0)
 expect(conversationRulerWindow(records, 'all', new Set([records[0]!.id])).items).toHaveLength(21)
 await writeFile(join(home, 'conversation.jsonl'), Array.from({ length: 21 }, (_, n) => JSON.stringify({ ...record(n), timestamp: new Date(start + n * 4 * 3_600_000).toISOString() })).join('\n') + '\n')
 const extended = await client.sessionHistoryPage(sid, { limit: 30 })
 const wide = conversationRulerRecords(sid, extended, [])
 expect(wide.at(-1)!.recordedAt! - wide[0]!.recordedAt!).toBe(80 * 3_600_000)
 expect(conversationRulerWindow(wide, '24h', new Set([wide[0]!.id])).items.map(record => record.record.id)).toEqual(Array.from({ length: 7 }, (_, n) => `ruler-${n}`))
 expect(conversationRulerWindow(wide, '24h').items.map(record => record.record.id)).toEqual(Array.from({ length: 7 }, (_, n) => `ruler-${14 + n}`))
})
it('does not invent time when only an untimed record is visible or all times are absent', () => {
 const records = conversationRulerRecords(sid, page, [])
 const result = conversationRulerWindow(records, '1h', new Set([records.at(-1)!.id]))
 expect(result.items.map(item => item.id)).toEqual(conversationRulerWindow(records, '1h').items.map(item => item.id))
 expect(result.untimed).toHaveLength(1)
 const unknown = records.map(({ recordedAt: _recordedAt, ...record }) => record)
 const ordinal = conversationRulerWindow(unknown, '15m', new Set([unknown[0]!.id]))
 expect(ordinal.scale.axis).toBe('ordinal'); expect(ordinal.items).toHaveLength(22); expect(ordinal.scale.readoutOf(0)).not.toHaveProperty('at')
})
it('uses current managed identity for both native and captured ruler references without changing source targets', async () => {
 const reservation = { kind: 'stop' as const, reservationId: 'retire-ruler-a', ownerId: 'ruler-fixture', ownerPid: process.pid, agentSessionId: sid, operationId: 'retire-ruler', expiresAt: Date.now() + 60000, expectedRun: session.run, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'retire-ruler', runId: session.run.runId } }
 await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
 const other = { ...session, agentSessionId: 'ruler-managed-b', run: { runId: 'ruler-retained-run-b' }, hookBindingId: 'ruler-private-hook-b', hookToken: 'ruler-private-token-b' }
 await store.compareAndSwap(null, other)
 const next = await client.sessionHistoryPage(other.agentSessionId, { limit: 30 })
 const observed: AgentTimelineItem = { id: 'same-observed-id', agentSessionId: sid, kind: 'user_message', source: 'user', content: 'Original captured input', title: 'Input', status: 'complete', createdAt: start, updatedAt: start }
 const before = conversationRulerRecords(sid, page, [observed]), after = conversationRulerRecords(other.agentSessionId, next, [{ ...observed, agentSessionId: other.agentSessionId }])
 expect(before).toHaveLength(after.length)
 expect(before.every((record, index) => record.id !== after[index]!.id)).toBe(true)
 expect(before[0]!.target).toEqual(after[0]!.target)
 await render(view()); const slider = container.querySelector('[role="slider"]')!
 await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))); await flush()
 expect(container.querySelector('[data-selected]')).not.toBeNull()
 await render(view(next)); expect(container.querySelector('[data-selected]')).toBeNull()
})
it('consumes actual shell visibility while retaining original body DOM, Range and zero reading demand', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 expect(user).not.toBeNull(); const body = user.querySelector('.log-turn__body') ?? user
 const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let text: Text | null = null
 while (walker.nextNode()) if (walker.currentNode.textContent?.includes('User 0')) { text = walker.currentNode as Text; break }
 expect(text).not.toBeNull(); const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4); window.getSelection()!.addRange(range)
 await act(async () => observer().show([user])); await flush()
 const records = conversationRulerRecords(sid, page, [])
 expect(spanText()).toBe(expectedSpan(records, new Set([records[0]!.id])))
 expect(container.querySelector('[data-native-record-id="ruler-0"]')).toBe(user)
 expect(text!.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
 expect(container.querySelector('.activity-ruler__band')).not.toBeNull()
 expect(container.querySelector('[aria-label="History window: 1h"]')?.getAttribute('title')).toContain('reading position')
 await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-20"]')!])); await flush()
 expect(spanText()).toBe(expectedSpan(records))
 expect(user.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
})
it('maps a collapsed Workflow header to all original record references and observes the real opened steps', async () => {
 await render(view()); const group = container.querySelector<HTMLElement>('[data-native-record-ids]')!
 const head = group.querySelector<HTMLElement>('.wf-head')!
 expect(head.getAttribute('aria-expanded')).toBe('false')
 const raw = JSON.parse(group.dataset.nativeRecordIds!) as string[]; expect(raw).toHaveLength(4)
 await act(async () => observer().show([head])); await flush()
 const records = conversationRulerRecords(sid, page, []); const visible = new Set(records.filter(record => raw.includes(record.record.id)).map(record => record.id))
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
 await render(<ActivityView sessionId={sid} items={timeline.items} capability="complete-events" nativeHistoryPage={page} />)
 const shell = [...container.querySelectorAll<HTMLElement>('[data-segment-key]')].find(node => node.textContent?.includes('Original Message Tool input'))!
 expect(shell).toBeDefined()
 const nativeBody = container.querySelector('[data-native-record-id="ruler-20"]')!
 await act(async () => observer().show([shell])); await flush()
 const records = conversationRulerRecords(sid, page, timeline.items), captured = records.find(record => record.target.kind === 'observed')!
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
 await writeFile(join(home, 'conversation.jsonl'), Array.from({ length: 21 }, (_, n) => JSON.stringify({ ...record(n), timestamp: new Date(start + n * 4 * 3_600_000).toISOString() })).join('\n') + '\n')
 const extended = await client.sessionHistoryPage(sid, { limit: 30 })
 await render(view(extended)); const old = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([old])); await flush()
 // Direct public window projection supplies the same zero-span, known-time domain as the actual renderer.
 const records = conversationRulerRecords(sid, extended, [])
 const single = conversationRulerWindow(records, '1h', new Set([records[0]!.id]))
 expect(single.items).toHaveLength(1); expect(single.scale.axis).toBe('ordinal'); expect(single.recentFraction).toBe(Infinity)
 expect(container.querySelector('.conversation-ruler__cutoff')).toBeNull()
 expect(container.querySelector('.conversation-axis__mark')?.getAttribute('data-era')).toBe('history')
 await writeFile(join(home, 'conversation.jsonl'), [record(0), { ...record(6), timestamp: new Date(start).toISOString() }, { ...record(20), timestamp: new Date(start + 80 * 3_600_000).toISOString() }].map(record => JSON.stringify(record)).join('\n') + '\n')
 const tied = await client.sessionHistoryPage(sid, { limit: 30 }); expect(tied.items).toHaveLength(3)
 await render(view(tied)); await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!])); await flush()
 expect(container.querySelector('[role="slider"]')?.getAttribute('data-axis')).toBe('ordinal')
 const tiedMarks = [...container.querySelectorAll<HTMLElement>('.conversation-axis__mark')]
 expect(tiedMarks).toHaveLength(2); expect(tiedMarks.every(mark => mark.dataset.era === 'history')).toBe(true)
 await writeFile(join(home, 'conversation.jsonl'), JSON.stringify({ ...record(0), timestamp: undefined }) + '\n')
 const unknown = await client.sessionHistoryPage(sid, { limit: 30 }); expect(unknown.items).toHaveLength(1)
 await render(view(unknown)); expect(container.querySelector('.conversation-axis__mark')).not.toBeNull()
 expect(container.querySelector('.conversation-axis__mark')?.hasAttribute('data-era')).toBe(false)
 expect(container.querySelector('.conversation-ruler__cutoff')).toBeNull()
 expect(container.querySelector('.conversation-ruler__recent')).toBeNull()
})


it('keeps the original visible reading band during sticky-header measurement handoff', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([user])); await flush()
 const before = spanText(), band = container.querySelector('.activity-ruler__band')
 expect(band).not.toBeNull(); expect(before).toBe(expectedSpan(conversationRulerRecords(sid, page, []), new Set([conversationRulerRecords(sid, page, [])[0]!.id])))
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
 expect(spanText()).toBe(expectedSpan(conversationRulerRecords(sid, page, [])))
})

it('retains visible records, body node and Range while a new native reply arrives', async () => {
 await render(view()); const user = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => observer().show([user])); await flush()
 const before = spanText(), band = container.querySelector('.activity-ruler__band')
 const walker = document.createTreeWalker(user, NodeFilter.SHOW_TEXT); let text: Text | null = null
 while (walker.nextNode()) if (walker.currentNode.textContent?.includes('User 0')) { text = walker.currentNode as Text; break }
 expect(text).not.toBeNull(); const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 4); window.getSelection()!.addRange(range)
 await writeFile(join(home, 'conversation.jsonl'), Array.from({ length: 23 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
 const updated = await client.sessionHistoryPage(sid, { limit: 30 }); expect(updated.items).toHaveLength(23)
 await render(view(updated))
 expect(spanText()).toBe(before); expect(container.querySelector('.activity-ruler__band')).toBe(band)
 expect(container.querySelector('[data-native-record-id="ruler-0"]')).toBe(user)
 expect(text!.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('User')
 await act(async () => observer().show([container.querySelector<HTMLElement>('[data-native-record-id="ruler-22"]')!])); await flush()
 expect(spanText()).toBe(expectedSpan(conversationRulerRecords(sid, updated, [])))
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
 const next = { ...page, agentSessionId: 'ruler-managed-other' }; await render(view(next))
 const currentObserver = observer(), currentUser = container.querySelector<HTMLElement>('[data-native-record-id="ruler-0"]')!
 await act(async () => currentObserver.show([currentUser])); await flush()
 const before = spanText(), band = container.querySelector('.activity-ruler__band'); expect(band).not.toBeNull()
 await act(async () => oldObserver.callback([{ target: oldUser, isIntersecting: true }] as unknown as IntersectionObserverEntry[], oldObserver as unknown as IntersectionObserver)); await flush()
 expect(spanText()).toBe(before); expect(container.querySelector('.activity-ruler__band')).toBe(band)
 await act(async () => currentObserver.hideAll()); await flush()
 expect(container.querySelector('.activity-ruler__band')).toBeNull()
 expect(spanText()).toBe(expectedSpan(conversationRulerRecords(next.agentSessionId, next, [])))
})
