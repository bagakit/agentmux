// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage, type AgentSessionUserMessage } from '@agentmux/core'
import type { ConversationItemRef } from '@agentmux/core/conversation'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionControl, AgentTimelineItem } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'

type Shape = 'spanned' | 'untimed'
type WireRecord = ReturnType<typeof record>
const sid = 'latest-order-session', native = 'latest-order-native'
const source = { providerId: 'claude', nativeSessionId: native }
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-healthy-run' } }
const initial = useAppStore.getState(), speechIds = ['old-user', 'old-reply', 'new-user', 'new-reply']
let container: HTMLDivElement, root: Root, directory: string, transcript: string, client: AgentMuxClient, stored: AgentMuxStoredAgentSession
let originalStore: Buffer, originalTranscript: Buffer, originalRecords: WireRecord[], reads: Promise<AgentSessionHistoryPage>[]
let completed: { input: { cursor?: string; limit?: number }; page: AgentSessionHistoryPage }[]
let controls: Array<{ mock: { calls: unknown[][] } }>, observation: Parameters<typeof api.sessions.observeHistory>[1] | null
let latestRead: ReturnType<typeof useSessionUserMessages> | undefined, releaseSeed: (() => void) | undefined
function record(id: string, index: number, role: string, content: unknown, shape: Shape) {
 return { uuid: id, type: role, sessionId: native, ...(shape === 'spanned' ? { timestamp: new Date(fixtureTime(-index * 7_200_000)).toISOString() } : {}), message: { role, content } }
}
function oldRecords(shape: Shape) {
 return [record('old-user', 0, 'user', 'Repeated native input', shape), record('old-reply', 1, 'assistant', 'Original old reply', shape)]
}
function newRecords(shape: Shape) {
 const count = shape === 'spanned' ? 160 : 320, middle = count / 2
 const processes = Array.from({ length: count }, (_, n) => record(`tool-${n}`, n + 2 + (n >= middle ? 1 : 0), 'assistant', [{ type: 'tool_use', id: `call-${n}`, name: 'read', input: { file: `relative-${n}` } }], shape))
 processes.splice(middle, 0, record('original-system', middle + 2, 'system', 'Original runtime context', shape))
 return [...processes, record('new-user', count + 3, 'user', 'Repeated native input', shape), record('new-reply', count + 4, 'assistant', 'Original latest reply', shape)]
}
async function writeOriginal(records: WireRecord[]) {
 originalRecords = records; await writeFile(transcript, records.map(value => JSON.stringify(value)).join('\n') + '\n'); originalTranscript = await readFile(transcript)
}
async function appendOriginal(shape: Shape, publish = true) {
 const appended = newRecords(shape); originalRecords.push(...appended)
 await appendFile(transcript, appended.map(value => JSON.stringify(value)).join('\n') + '\n'); originalTranscript = await readFile(transcript)
 if (publish) await act(async () => observation?.({ agentSessionId: sid, source, kind: 'invalidated' }))
 await flush()
}
function Reading() {
 const read = useSessionUserMessages(control, { enabled: true }); latestRead = read
 return <ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" displayState="working"
  nativeHistoryPage={read.nativeHistoryPage} nativeContextItems={read.nativeContextItems} userMessages={read.messages}
  conversationReading={{ reference: control, identity: control.run.runId, enabled: true, nativeSourceFacts: stored }} />
}
async function flush() {
 for (let n = 0; n < 8; n++) await act(async () => { await Promise.allSettled([...reads]); await new Promise(resolve => setTimeout(resolve, 15)) })
}
async function render(node: ReactNode) { await act(async () => root.render(node)); await flush() }
function viewport() { const feed = container.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull(); return feed }
async function followAt(top: number) {
 const feed = viewport(); Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 600 } })
 feed.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 600, left: 0, right: 500, width: 500, height: 600, toJSON() {} })
 const tail = feed.querySelector<HTMLElement>('[data-conversation-native-tail]')!
 tail.getBoundingClientRect = () => ({ x: 0, y: 1500 - feed.scrollTop, top: 1500 - feed.scrollTop, bottom: 1500 - feed.scrollTop, left: 0, right: 500, width: 500, height: 0, toJSON() {} })
 feed.scrollTop = top; await act(async () => feed.dispatchEvent(new Event('scroll')))
}
function button(label: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label) }
async function click(label: string) { const action = button(label); expect(action, label).toBeDefined(); await act(async () => action!.click()); await flush() }
function nativeRawIds() {
 // Collapsed process cards still declare every original raw member, in source order.
 return [...viewport().querySelectorAll<HTMLElement>('.conversation-native-thread > [data-native-record-id], .conversation-native-thread > [data-native-record-ids]')]
  .flatMap(node => node.dataset.nativeRecordIds ? JSON.parse(node.dataset.nativeRecordIds) as string[] : [node.dataset.nativeRecordId!])
}
function sourceMessages() {
 return [...viewport().querySelectorAll<HTMLElement>('[data-conversation-item-ref]')].map(node => ({ node, reference: JSON.parse(node.dataset.conversationItemRef!) as ConversationItemRef }))
}
function supplements() { return sourceMessages().filter(message => !message.node.closest('.conversation-native-thread') && message.reference.source.kind === 'native') }
function speech() { return sourceMessages().flatMap(({ reference }) => reference.source.kind === 'native' && reference.source.providerId === source.providerId && reference.source.nativeSessionId === native && speechIds.includes(reference.source.recordId) ? [reference.source.recordId] : []) }
function expectSequence(items: AgentSessionHistoryPage['items']) {
 const expected = items.map(item => item.id), actual = nativeRawIds()
 expect(actual).toEqual(expected); expect(new Set(actual).size).toBe(actual.length)
 for (const { reference } of sourceMessages().filter(message => message.node.closest('.conversation-native-thread'))) {
  expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid, source: { kind: 'native', ...source } })
 }
}
async function originalSequence() {
 const items: AgentSessionHistoryPage['items'] = []; let cursor: string | undefined
 do { const page = await client.sessionHistoryPage(sid, { limit: 100, ...(cursor ? { cursor } : {}) }); items.unshift(...page.items); cursor = page.nextCursor ?? undefined } while (cursor)
 expect(items.map(item => item.id)).toEqual(originalRecords.map(record => record.uuid))
 return items
}
function acceptedOriginalSince(index: number) { return [...completed.slice(index).filter(read => read.input.limit === 100)].reverse().flatMap(read => read.page.items) }
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
 vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
 Element.prototype.scrollIntoView = vi.fn()
 directory = await mkdtemp(join(tmpdir(), 'conversation-latest-order-')); transcript = join(directory, 'native.jsonl')
 await writeOriginal(oldRecords('spanned'))
 const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
 stored = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory, run: control.run,
  retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1),
  nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } }
 await store.compareAndSwap(null, stored); originalStore = await readFile(join(directory, 'sessions.json'))
 client = new AgentMuxClient({ store }); const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Runtime ' + name) }))
 controls.push(...(['submitPrompt', 'resume', 'replyQuestion'] as const).map(name => vi.spyOn(api.sessions, name)))
 reads = []; completed = []; observation = null; latestRead = undefined; releaseSeed = undefined
 vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => {
  expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid })
  const read = client.sessionHistoryPage(reference.agentSessionId, options).then(page => { completed.push({ input: options ?? {}, page }); return page }); reads.push(read); return read
 })
 vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_reference, listener) => { observation = listener; return { source, dispose() {} } })
 useAppStore.setState({ sessions: [], timelines: {}, agentComposerDrafts: { [sid]: 'Original unsent draft' } })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 releaseSeed?.(); await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges()
 try {
  expect(controls.map(spy => spy.mock.calls.length)).toEqual(Array(10).fill(0))
  expect(completed.every(read => read.input.limit !== undefined && read.input.limit > 0 && read.input.limit <= 100)).toBe(true)
  expect(await readFile(join(directory, 'sessions.json'))).toEqual(originalStore)
  expect(await readFile(transcript)).toEqual(originalTranscript)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent draft')
 } finally { await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

it.each(['spanned', 'untimed'] as const)('Show latest preserves the complete original %s sequence, including process groups and system records; Earlier keeps the original cursor', async shape => {
 await writeOriginal(oldRecords(shape)); await render(<Reading />); await followAt(900); await followAt(300)
 const before = nativeRawIds(); await appendOriginal(shape)
 expect(nativeRawIds()).toEqual(before); expect(button('Show latest messages')).toBeDefined(); expect(viewport().scrollTop).toBe(300)
 expect(latestRead!.nativeContextItems.some(item => item.id === 'old-user')).toBe(true)
 const all = await originalSequence(), mark = completed.length
 await click('Show latest messages')
 const current = acceptedOriginalSince(mark); expectSequence(current)
 expect(current.some(item => item.id === 'old-user')).toBe(false)
 expect(current.find(item => item.id === 'original-system')).toMatchObject({ kind: 'system-message', contentParts: [{ kind: 'text', text: 'Original runtime context' }] })
 expect(speech()).toEqual(['new-user', 'new-reply']); expect(supplements()).toEqual([])
 if (shape === 'spanned') expect(current[0]!.startedAt).toBeGreaterThan(current.at(-1)!.startedAt!)
 else expect(current.every(item => item.startedAt === undefined)).toBe(true)
 const earlierCursor = completed.at(-1)!.page.nextCursor, earlierMark = completed.length
 expect(earlierCursor).not.toBeNull(); await click('Earlier')
 expect(completed.slice(earlierMark).some(read => read.input.cursor === earlierCursor)).toBe(true)
 expectSequence(all); expect(speech()).toEqual(speechIds); expect(supplements()).toEqual([])
 expect(all.find(item => item.id === 'old-user')!.contentParts).toEqual(all.find(item => item.id === 'new-user')!.contentParts)
})

it('automatic latest replaces a no-overlap tail with its complete original sequence without moving retained inputs behind replies', async () => {
 await render(<Reading />); await followAt(900); const mark = completed.length
 await appendOriginal('spanned')
 expectSequence(acceptedOriginalSince(mark)); expect(speech()).toEqual(['new-user', 'new-reply']); expect(supplements()).toEqual([])
 expect(button('Show latest messages')).toBeUndefined()
 expect(latestRead!.nativeContextItems.some(item => item.id === 'old-user')).toBe(true)
 const count = completed.length; await render(<Reading />); expect(completed).toHaveLength(count)
})

it('a failed actual latest read keeps its original raw window and shared context, and Retry reads the original latest sequence', async () => {
 await render(<Reading />); await followAt(900); await followAt(300); const originalIds = nativeRawIds()
 await appendOriginal('spanned'); const context = latestRead!.nativeContextItems, original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let failures = 0
 vi.mocked(api.sessions.historyPage).mockImplementation((reference, options) => {
  if (options?.limit === 100 && !options.cursor && failures++ === 0) return Promise.reject(new Error('Actual original latest read unavailable'))
  return original(reference, options)
 })
 await click('Show latest messages'); expect(nativeRawIds()).toEqual(originalIds)
 expect(latestRead!.nativeContextItems).toBe(context); expect(container.textContent).toContain('Actual original latest read unavailable')
 expect(context.some(item => item.id === 'old-user')).toBe(true); expect(supplements()).toEqual([])
 const mark = completed.length; await click('Retry'); expectSequence(acceptedOriginalSince(mark))
 expect(speech()).toEqual(['new-user', 'new-reply']); expect(supplements()).toEqual([])
})

it('static, null and empty fallbacks keep their input; an original reading owner takes over only its own nonempty source and keeps foreign and captured input', async () => {
 const known = await client.sessionHistoryPage(sid), inputs = projectSessionUserMessages({ agentSessionId: sid, historyPage: known })
 await appendOriginal('spanned', false); const current = await client.sessionHistoryPage(sid, { limit: 100 })
 const empty = { ...known, items: [], nextCursor: null }
 const surface = (page: AgentSessionHistoryPage | null, reading?: { enabled: boolean }, messages = inputs) => <ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" nativeHistoryPage={page} userMessages={messages}
  {...(reading ? { conversationReading: { reference: control, identity: control.run.runId, enabled: reading.enabled } } : {})} />
 await render(surface(null)); const fallback = supplements()[0]!.node; expect(fallback.textContent).toContain('Repeated native input')
 await render(surface(null, { enabled: false })); expect(supplements()[0]!.node).toBe(fallback)
 await render(surface(empty, { enabled: false })); expect(supplements()[0]!.node).toBe(fallback)
 await render(surface(current)); expect(supplements().map(message => message.reference.source.recordId)).toEqual(['old-user'])
 // Only the owner presence changes: memoization must not retain the former tail supplement.
 await render(surface(current, { enabled: false })); expect(supplements()).toEqual([])
 const foreign = projectSessionUserMessages({ agentSessionId: sid, historyPage: { ...known, source: { ...source, nativeSessionId: 'foreign-original-native' } } })
 const captured: AgentTimelineItem = { id: 'original-captured-input', agentSessionId: sid, kind: 'user_message', source: 'user', title: 'Original captured input', content: 'Original captured input', status: 'complete', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }
 const capturedInputs = projectSessionUserMessages({ agentSessionId: sid, timeline: { agentSessionId: sid, items: [captured], revision: 1 } })
 await render(surface(current, { enabled: true }, [...inputs, ...foreign, ...capturedInputs]))
 expectSequence(completed.at(-1)!.page.items)
 expect(supplements().map(message => message.reference.source)).toEqual([foreign[0]!.source])
 const observed = container.querySelector<HTMLElement>('.activity-feed__observations')!
 expect(observed.textContent).toContain('Original captured input')
 expect(sourceMessages().some(message => message.reference.source.kind === 'captured' && message.reference.source.recordId === captured.id)).toBe(true)
})

it.each(['retained-id', 'outside-page'] as const)('a selected native fallback keeps its original body, TextNode and Range during %s takeover, then explicit Retry remains available', async mode => {
 const known = await client.sessionHistoryPage(sid), inputs = projectSessionUserMessages({ agentSessionId: sid, historyPage: known })
 if (mode === 'outside-page') await appendOriginal('untimed', false)
 else { const reply = record('new-reply', 2, 'assistant', 'Original latest reply', 'spanned'); originalRecords.push(reply); await appendFile(transcript, JSON.stringify(reply)+'\n'); originalTranscript = await readFile(transcript) }
 const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 vi.mocked(api.sessions.historyPage).mockImplementation(async (reference, options) => {
  const page = await original(reference, options)
  if (!options?.cursor && !releaseSeed) await new Promise<void>(resolve => { releaseSeed = resolve })
  return page
 })
 await act(async () => root.render(<ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" userMessages={inputs}
  nativeHistoryPage={mode === 'outside-page' ? { ...known, items: [], nextCursor: null } : null}
  conversationReading={{ reference: control, identity: control.run.runId, enabled: true, nativeSourceFacts: stored }} />))
 await vi.waitFor(() => expect(releaseSeed).toBeTypeOf('function'))
 const body = supplements()[0]!.node.querySelector<HTMLElement>('.log-turn__body p')!, text = body.firstChild!
 const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.addRange(range)
 await act(async () => releaseSeed!()); await flush()
 expect(body.isConnected).toBe(true); expect(supplements()[0]!.node.querySelector('.log-turn__body p')).toBe(body)
 expect(text.isConnected).toBe(true); expect(selection.getRangeAt(0)).toBe(range); expect(range.startContainer).toBe(text)
 expect(selection.toString()).toBe('Repeated native input'); expect(container.textContent).toContain('selected content')
 await act(async () => selection.removeAllRanges()); const mark = completed.length; await click('Retry')
 expectSequence(acceptedOriginalSince(mark)); expect(supplements()).toEqual([]); expect(nativeRawIds().at(-1)).toBe('new-reply')
})

it('a Range outside this native fallback does not block its ordinary first nonempty seed', async () => {
 const known = await client.sessionHistoryPage(sid), inputs = projectSessionUserMessages({ agentSessionId: sid, historyPage: known })
 const outside = document.createElement('p'); outside.textContent = 'Independent selected body'; document.body.append(outside)
 try {
  const text = outside.firstChild!, range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.addRange(range)
  await render(<ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" userMessages={inputs} nativeHistoryPage={null}
   conversationReading={{ reference: control, identity: control.run.runId, enabled: true, nativeSourceFacts: stored }} />)
  expectSequence(completed.at(-1)!.page.items); expect(supplements()).toEqual([])
  expect(text.isConnected).toBe(true); expect(range.startContainer).toBe(text); expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('Independent selected body')
  expect(container.textContent).not.toContain('Move your reading position')
 } finally { outside.remove() }
})
