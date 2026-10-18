// @vitest-environment happy-dom
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage } from '@agentmux/core'
import { consumeConversationWindowPage, type AgentConversationReadPage, type ConversationItemRef, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { AgentSessionControl, AgentTimelineItem } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { processNativeRecordIds } from './helpers/conversation-process-members'

type Shape = 'spanned' | 'untimed'
type WireRecord = ReturnType<typeof record>
const sid = 'latest-order-session', native = 'latest-order-native'
const source = { providerId: 'claude', nativeSessionId: native }
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-healthy-run' } }
const initial = useAppStore.getState(), speechIds = ['old-user', 'old-reply', 'new-user', 'new-reply']
let container: HTMLDivElement, root: Root, directory: string, transcript: string, client: AgentMuxClient, stored: AgentMuxStoredAgentSession
let originalStore: Buffer, originalTranscript: Buffer, originalRecords: WireRecord[], reads: Promise<AgentSessionHistoryPage>[]
let completed: { input: { cursor?: string; limit?: number }; page: AgentSessionHistoryPage }[]
let controls: Array<{ mock: { calls: unknown[][] } }>, observation: Parameters<AgentMuxClient['observeSessionHistory']>[1] | null
let closes: Array<() => unknown | Promise<unknown>>, frames: Map<string, ConversationWindowSnapshot>, fragments: Map<string, ConversationWindowAssembly>
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
async function appendOriginal(shape: Shape) {
 const appended = newRecords(shape); originalRecords.push(...appended)
 await appendFile(transcript, appended.map(value => JSON.stringify(value)).join('\n') + '\n'); originalTranscript = await readFile(transcript)
 await act(async () => observation?.({ agentSessionId: sid, source, kind: 'invalidated' })); await flush()
}
function Reading({ identity = control.run.runId, enabled = true }: { identity?: string; enabled?: boolean }) {
 return <ActivityView sessionId={sid} executionHostId="local" capability="complete-events" displayState="working"
  conversationReading={{ reference: control, identity, enabled, nativeSourceFacts: stored }} />
}
async function flush() {
 for (let n = 0; n < 4; n++) await act(async () => { await Promise.allSettled([...reads]); await new Promise(resolve => setTimeout(resolve, 15)) })
}
const wait = (assertion: () => void) => vi.waitFor(async () => { await flush(); assertion() }, { timeout: 10000, interval: 20 })
async function render(identity = control.run.runId, enabled = true) { await act(async () => root.render(<Reading identity={identity} enabled={enabled} />)); await flush() }
function viewport() { const feed = container.querySelector<HTMLElement>('.activity-feed')!; expect(feed).not.toBeNull(); return feed }
async function followAt(top: number) {
 const feed = viewport(); Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 600 } })
 feed.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 600, left: 0, right: 500, width: 500, height: 600, toJSON() {} })
 for (const tail of feed.querySelectorAll<HTMLElement>('[data-conversation-native-tail], [data-conversation-reading-tail]'))
  tail.getBoundingClientRect = () => ({ x: 0, y: 1500 - feed.scrollTop, top: 1500 - feed.scrollTop, bottom: 1500 - feed.scrollTop, left: 0, right: 500, width: 500, height: 0, toJSON() {} })
 feed.scrollTop = top; await act(async () => feed.dispatchEvent(new Event('scroll')))
}
function button(label: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label) }
async function click(label: string) { const action = button(label); expect(action, label).toBeDefined(); expect(action!.disabled).toBe(false); await act(async () => action!.click()); await flush() }
function nativeRawIds() {
 return [...viewport().querySelectorAll<HTMLElement>('.conversation-native-thread > [data-native-record-id], .conversation-native-thread > [data-conversation-process-members]')]
  .flatMap(node => node.dataset.conversationProcessMembers ? processNativeRecordIds(node) : [node.dataset.nativeRecordId!])
}
function sourceMessages() {
 return [...viewport().querySelectorAll<HTMLElement>('[data-conversation-item-ref]')].map(node => ({ node, reference: JSON.parse(node.dataset.conversationItemRef!) as ConversationItemRef }))
}
function speech() { return sourceMessages().flatMap(({ reference }) => reference.source.kind === 'native' && reference.source.providerId === source.providerId && reference.source.nativeSessionId === native && speechIds.includes(reference.source.recordId) ? [reference.source.recordId] : []) }
function sample() { return inspectConversationConsumers({ hostId: 'local', agentSessionId: sid }).consumers[0]! }
function capture<T extends AgentConversationReadPage>(page: T): T {
 const key = JSON.stringify([page.window.id, page.window.revision]), consumed = consumeConversationWindowPage(page, fragments.get(key))
 if (consumed.kind === 'pending') fragments.set(key, consumed.pending)
 else { fragments.delete(key); frames.set(key, consumed.snapshot) }
 return page
}
function accepted() {
 const actual = sample().accepted!; expect(actual).not.toBeNull()
 const frame = frames.get(JSON.stringify([actual.id, actual.revision]))!; expect(frame).toBeDefined()
 return frame
}
function expectSequence() {
 const originals = [...accepted().units].reverse().flatMap(unit => unit.records).filter(row => row.original.kind === 'native').map(row => row.original.item.id)
 expect(nativeRawIds()).toEqual(originals); expect(new Set(nativeRawIds()).size).toBe(originals.length)
 for (const { node, reference } of sourceMessages().filter(message => message.reference.source.kind === 'native')) {
  expect(node.closest('.conversation-native-thread'), 'No sparse native supplement may compete with the unified order').not.toBeNull()
  expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid, source: { kind: 'native', ...source } })
 }
}
async function originalSequence() {
 const items: AgentSessionHistoryPage['items'] = []; let cursor: string | undefined
 do { const page = await client.sessionHistoryPage(sid, { limit: 100, ...(cursor ? { cursor } : {}) }); items.unshift(...page.items); cursor = page.nextCursor ?? undefined } while (cursor)
 expect(items.map(item => item.id)).toEqual(originalRecords.map(record => record.uuid)); return items
}
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
 vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
 Element.prototype.scrollIntoView = vi.fn()
 directory = await mkdtemp(join(tmpdir(), 'conversation-latest-order-')); transcript = join(directory, 'native.jsonl')
 await writeOriginal(oldRecords('spanned'))
 const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
 stored = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory, run: control.run,
  retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1),
  nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } }
 await store.compareAndSwap(null, stored); await store.readCapturedHistory(sid); originalStore = await readFile(join(directory, 'sessions.json'))
 client = new AgentMuxClient({ store }); const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Runtime ' + name) }))
 controls.push(...(['submitPrompt', 'resume', 'replyQuestion'] as const).map(name => vi.spyOn(api.sessions, name)))
 reads = []; completed = []; observation = null; closes = []; frames = new Map(); fragments = new Map()
 const historyPage = client.sessionHistoryPage.bind(client), observeHistory = client.observeSessionHistory.bind(client)
 vi.spyOn(client, 'sessionHistoryPage').mockImplementation((agentSessionId, options) => {
  expect(agentSessionId).toBe(sid)
  const read = historyPage(agentSessionId, options).then(page => { completed.push({ input: options ?? {}, page }); return page }); reads.push(read); return read
 })
 vi.spyOn(client, 'observeSessionHistory').mockImplementation((agentSessionId, listener, options) => { observation = listener; return observeHistory(agentSessionId, listener, options) })
 const port = await desktopConversationReadBridge({ root: directory, client }, closes)
 vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => capture(await port.readAgentConversation(...args)))
 vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (...args) => capture(await port.readConversationChanges(...args)))
 useAppStore.setState({ sessions: [], timelines: {}, agentComposerDrafts: { [sid]: 'Original unsent draft' } })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges()
 try {
  expect(controls.map(spy => spy.mock.calls.length)).toEqual(Array(10).fill(0))
  expect(completed.every(read => read.input.limit !== undefined && read.input.limit > 0 && read.input.limit <= 100)).toBe(true)
  expect(await readFile(join(directory, 'sessions.json'))).toEqual(originalStore)
  expect(await readFile(transcript)).toEqual(originalTranscript)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent draft')
 } finally { for (const close of closes.reverse()) await close(); await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

it.each(['spanned', 'untimed'] as const)('the accepted %s sequence preserves original process/system order and Earlier consumes its exact unified token', async shape => {
 await writeOriginal([...oldRecords(shape), ...newRecords(shape)])
 await render(); await wait(() => { expect(nativeRawIds()).toHaveLength(100); expect(sample().loading).toBe(false) })
 await followAt(900); await followAt(300)
 const all = await originalSequence()
 let pages = 0
 while (nativeRawIds().length < all.length) {
  const token = accepted().window.navigation.older; expect(token).toBeTruthy()
  const mark = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await click('Earlier')
  await wait(() => { expect(sample().loading).toBe(false); expect(nativeRawIds().length).toBeGreaterThan(Math.min(100 + pages * 100, all.length)) })
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(mark).some(([input]) => input.cursor === token)).toBe(true)
  expectSequence(); pages++; expect(pages).toBeLessThanOrEqual(3)
 }
 expect(nativeRawIds()).toEqual(all.map(item => item.id)); expect(speech()).toEqual(speechIds)
 expect(all.find(item => item.id === 'original-system')).toMatchObject({ kind: 'system-message', contentParts: [{ kind: 'text', text: 'Original runtime context' }] })
 if (shape === 'spanned') expect(all[0]!.startedAt).toBeGreaterThan(all.at(-1)!.startedAt!)
 else expect(all.every(item => item.startedAt === undefined)).toBe(true)
 expect(all.find(item => item.id === 'old-user')!.contentParts).toEqual(all.find(item => item.id === 'new-user')!.contentParts)
 const before = completed.length; await click('滚动到最新'); await flush()
 expectSequence(); expect(nativeRawIds().at(-1)).toBe('new-reply'); expect(completed).toHaveLength(before)
})

it('automatic same-source append keeps every original input ahead of its reply and introduces no sparse supplement', async () => {
 await render(); await wait(() => expect(nativeRawIds()).toEqual(['old-user', 'old-reply'])); await followAt(900)
 await appendOriginal('spanned'); await wait(() => expect(nativeRawIds().at(-1)).toBe('new-reply'))
 expectSequence(); expect(nativeRawIds()).toEqual(originalRecords.map(row => row.uuid)); expect(speech()).toEqual(speechIds)
 expect(container.querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull()
 const count = completed.length; await render(); expect(completed).toHaveLength(count)
})

it('a failed public changes read retains the exact accepted sequence and Retry adopts the original complete sequence', async () => {
 await render(); await wait(() => expect(nativeRawIds()).toHaveLength(2)); await followAt(900)
 const before = accepted(), original = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
 let failing = true
 vi.mocked(api.conversation.readConversationChanges).mockImplementation((...args) => failing ? Promise.reject(new Error('Actual original latest read unavailable')) : original(...args))
 await appendOriginal('spanned'); await wait(() => expect(container.textContent).toContain('Actual original latest read unavailable'))
 expect(accepted()).toBe(before); expectSequence(); expect(nativeRawIds()).toEqual(['old-user', 'old-reply'])
 failing = false; await click('Retry conversation records'); await wait(() => expect(nativeRawIds().at(-1)).toBe('new-reply'))
 expectSequence(); expect(speech()).toEqual(speechIds)
})

it('only actual accepted source records populate an initially empty owner, including its persisted captured input', async () => {
 await writeOriginal([]); await render(); await wait(() => { expect(sample().accepted?.recordCount).toBe(0); expect(sample().loading).toBe(false) })
 const own: AgentTimelineItem = { id: 'original-captured-input', agentSessionId: sid, kind: 'user_message', source: 'user', title: 'Original captured input', content: 'Original captured input', status: 'complete', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }
 // Foreign store inventory is deliberately present, but is never an input to this reader.
 await act(async () => useAppStore.setState({ timelines: { foreign: { agentSessionId: 'foreign', revision: 1, items: [{ ...own, id: 'foreign-input', agentSessionId: 'foreign', content: 'Foreign input must stay outside' }] } } }))
 await client['persistAndPublishTimeline']({ type: 'upsert', agentSessionId: sid, item: own }, { source: 'agentmux', observedAt: own.updatedAt }, 'local')
 originalStore = await readFile(join(directory, 'sessions.json'))
 await wait(() => expect(sourceMessages().some(row => row.reference.source.kind === 'captured' && row.reference.source.recordId === own.id)).toBe(true))
 expect(sourceMessages().every(row => row.reference.hostId === 'local' && row.reference.agentSessionId === sid)).toBe(true)
 expect(container.textContent).toContain('Original captured input'); expect(container.textContent).not.toContain('Foreign input must stay outside')
 expect(nativeRawIds()).toEqual([])
})

it.each(['retained-id', 'outside-page'] as const)('an accepted original body and Range survive %s generation takeover without a fallback projection', async mode => {
 await render(); await wait(() => expect(nativeRawIds()).toHaveLength(2)); await followAt(900); await followAt(300)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="old-user"] .log-turn__body p')!, text = body.firstChild!
 const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.addRange(range)
 if (mode === 'outside-page') await appendOriginal('untimed')
 else {
  const reply = record('new-reply', 2, 'assistant', 'Original latest reply', 'spanned'); originalRecords.push(reply)
  await appendFile(transcript, JSON.stringify(reply) + '\n'); originalTranscript = await readFile(transcript)
 }
 await render('new-original-reading-generation')
 await wait(() => expect(sample().loading).toBe(false))
 expect(body.isConnected).toBe(true); expect(text.isConnected).toBe(true); expect(selection.getRangeAt(0)).toBe(range)
 expect(range.startContainer).toBe(text); expect(selection.toString()).toBe('Repeated native input')
 if (mode === 'outside-page') { expect(sample().held).toBe(true); expect(sample().pending?.recordCount).toBe(100) }
 else { expect(sample().held).toBe(false); expect(nativeRawIds()).toContain('new-reply') }
 await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 if (sample().held) await click('滚动到最新')
 await wait(() => { expect(sample().held).toBe(false); expect(nativeRawIds().at(-1)).toBe('new-reply') })
 expectSequence()
})

it('an external Range does not block the actual first accepted source window', async () => {
 const outside = document.createElement('p'); outside.textContent = 'Independent selected body'; document.body.append(outside)
 try {
  const text = outside.firstChild!, range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.addRange(range)
  await render(); await wait(() => expect(nativeRawIds()).toHaveLength(2)); expectSequence()
  expect(text.isConnected).toBe(true); expect(range.startContainer).toBe(text); expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('Independent selected body')
  expect(sample().held).toBe(false)
 } finally { outside.remove() }
})
