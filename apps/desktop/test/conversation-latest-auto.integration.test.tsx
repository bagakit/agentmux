import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import type { AgentNativeSourceFacts } from '../src/shared/agent-native-source'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

const sid = 'automatic-current-session', native = 'automatic-native-source'
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'healthy-original-run' } }
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, directory: string, transcript: string, client: AgentMuxClient
let originalStore: Buffer, stored: AgentMuxStoredAgentSession
let requests: { cursor?: string; limit?: number }[], reads: Promise<AgentSessionHistoryPage>[], observation: Parameters<typeof api.sessions.observeHistory>[1] | null
let controls: ReturnType<typeof vi.spyOn>[]
function record(n: number) {
 const role = n % 2 === 0 ? 'user' : 'assistant'
 return { uuid: `original-${n}`, type: role, sessionId: native, timestamp: new Date(_hygiene_fixtureTime(-37225600000) + n * 7200000).toISOString(),
  message: { role, content: role === 'user' ? `Original input ${n}` : [{ type: 'thinking', thinking: `Original thought ${n}` }, { type: 'text', text: `Original reply ${n}` }] } }
}
function Reading({ visible = true, identity = control.run.runId, facts = stored }: { visible?: boolean; identity?: string; facts?: AgentNativeSourceFacts }) {
 const read = useSessionUserMessages(control, { enabled: visible })
 return <ActivityView sessionId={sid} executionHostId="local" items={[]} capability="complete-events" displayState="working"
  nativeHistoryPage={read.nativeHistoryPage} nativeContextItems={read.nativeContextItems} userMessages={read.messages}
  conversationReading={{ reference: control, identity, enabled: visible, nativeSourceFacts: facts }} />
}
async function flush() { for (let i = 0; i < 8; i++) await act(async () => { await Promise.allSettled([...reads]); await new Promise(resolve => setTimeout(resolve, 15)) }) }
async function render(visible = true, identity = control.run.runId, facts: AgentNativeSourceFacts = stored) { await act(async () => root.render(<Reading visible={visible} identity={identity} facts={facts} />)); await flush() }
async function publish(from: number, count = 100) {
 await appendFile(transcript, Array.from({ length: count }, (_, n) => JSON.stringify(record(from + n))).join('\n') + '\n')
 await act(async () => observation?.({ agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: native }, kind: 'invalidated' })); await flush()
}
function ids() { return [...container.querySelectorAll<HTMLElement>('.conversation-native-thread > [data-native-record-id]')].map(node => node.dataset.nativeRecordId!) }
function viewport() { const node = container.querySelector<HTMLElement>('.activity-feed')!; expect(node).not.toBeNull(); return node }
async function followAt(top: number) {
 const feed = viewport(); Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 600 } })
 feed.scrollTop = top; await act(async () => feed.dispatchEvent(new Event('scroll')))
}
function currentButton() { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Show latest messages') }
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
 vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
 Element.prototype.scrollIntoView = vi.fn()
 directory = await mkdtemp(join(tmpdir(), 'conversation-latest-auto-')); transcript = join(directory, 'native.jsonl')
 await writeFile(transcript, Array.from({ length: 60 }, (_, n) => JSON.stringify(record(n))).join('\n') + '\n')
 const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
 stored = { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory, run: control.run,
  retiredRuns: [], hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1,
  nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } }
 await store.compareAndSwap(null, stored); originalStore = await readFile(join(directory, 'sessions.json'))
 client = new AgentMuxClient({ store }); const kernel = Reflect.get(client, 'kernel')
 controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Runtime ' + name) }))
 requests = []; reads = []; observation = null
 vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => {
  expect(reference).toMatchObject({ hostId: 'local', agentSessionId: sid }); requests.push(options ?? {})
  const read = client.sessionHistoryPage(reference.agentSessionId, options); reads.push(read); return read
 })
 vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (_reference, listener) => { observation = listener; return { source: { providerId: 'claude', nativeSessionId: native }, dispose() {} } })
 useAppStore.setState({ sessions: [], timelines: {}, agentComposerDrafts: { [sid]: 'Original unsent draft' } })
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
 await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges()
 expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
 expect(requests.length).toBeGreaterThan(0); expect(requests.every(input => input.limit !== undefined && input.limit > 0 && input.limit <= 100)).toBe(true)
 expect(await readFile(join(directory, 'sessions.json'))).toEqual(originalStore)
 expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original unsent draft')
 await client.dispose(); await rm(directory, { recursive: true }); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('automatically reads a same-source no-overlap current tail without requiring Show latest messages', async () => {
 await render(); expect(ids()).toHaveLength(60); expect(ids().at(-1)).toBe('original-59')
 await followAt(900); const before = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids().at(-1), 'the latest actual native reply should be readable without clicking Current').toBe('original-159')
 expect(ids()).toHaveLength(100); expect(currentButton()).toBeUndefined()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(before + 1)
 const count = requests.length; await render(); await render()
 expect(requests).toHaveLength(count)
})
it('keeps upward reading and its original expanded body/scroll when recent native facts have a gap', async () => {
 await render(); await followAt(900); await followAt(300)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body')!
 const details = body.querySelector<HTMLDetailsElement>('details')!; details.open = true
 const before = ids(), count = requests.filter(input => input.limit === 100).length
 await publish(60)
 expect(ids()).toEqual(before); expect(body.isConnected).toBe(true); expect(details.open).toBe(true)
 expect(viewport().scrollTop).toBe(300); expect(currentButton()).toBeDefined()
 expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 await followAt(900); await flush(); expect(ids().at(-1)).toBe('original-159')
})
it('does not auto-replace a real noncollapsed Range even when the original follow intent is current', async () => {
 await render(); await followAt(900)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body p')!
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
 expect(selection.toString()).toBe('Original reply 1')
 const count = requests.filter(input => input.limit === 100).length; await publish(60)
 expect(body.isConnected).toBe(true); expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('Original reply 1')
 expect(ids().at(-1)).toBe('original-59'); expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 expect(ids().at(-1), 'clearing this feed selection resumes its retained current-tail intent').toBe('original-159')
 expect(requests.filter(input => input.limit === 100)).toHaveLength(count + 1)
})
it('selection clear in the same event batch as upward scrolling cannot reuse stale follow permission', async () => {
 await render(); await followAt(900)
 const body = container.querySelector<HTMLElement>('[data-native-record-id="original-1"] .log-turn__body p')!
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
 await publish(60); const count = requests.filter(input => input.limit === 100).length
 await act(async () => { viewport().scrollTop = 300; viewport().dispatchEvent(new Event('scroll')); selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
 expect(ids().at(-1)).toBe('original-59'); expect(body.isConnected).toBe(true)
 expect(requests.filter(input => input.limit === 100), 'selection clear must read the current follow intent before effect cleanup').toHaveLength(count)
})
it('resumes the original tail on visible return after hidden native updates without a click', async () => {
 await render(); await followAt(900); await render(false)
 const count = requests.length; await publish(60); expect(requests).toHaveLength(count); expect(ids().at(-1)).toBe('original-59')
 await render(); expect(ids().at(-1), 'visible return at the retained current tail should catch up automatically').toBe('original-159')
 expect(currentButton()).toBeUndefined()
})
it('discards a hidden automatic reply and resumes that interrupted attempt once on visible return', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let release: (() => void) | undefined, held = false
 vi.mocked(api.sessions.historyPage).mockImplementation(async (reference, options) => {
  const page = await original(reference, options)
  if (options?.limit === 100 && !held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
  return page
 })
 await publish(60); expect(held).toBe(true); expect(release).toBeTypeOf('function')
 await render(false); await act(async () => release!()); await flush()
 expect(ids().at(-1)).toBe('original-59')
 const before = requests.filter(input => input.limit === 100).length
 await render(); expect(ids().at(-1)).toBe('original-159'); expect(requests.filter(input => input.limit === 100)).toHaveLength(before + 1)
 const done = requests.length; await render(); expect(requests).toHaveLength(done)
})
it('retains the old window after a genuine read failure and never render-retries that request', async () => {
 await render(); await followAt(900); const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let attempts = 0
 vi.mocked(api.sessions.historyPage).mockImplementation((reference, options) => {
  if (options?.limit === 100) { attempts++; return Promise.reject(new Error('Actual latest read unavailable')) }
  return original(reference, options)
 })
 await publish(60); expect(ids().at(-1)).toBe('original-59'); expect(container.textContent).toContain('Actual latest read unavailable')
 expect(attempts).toBe(1); const count = requests.length; await render(); await render(); expect(requests).toHaveLength(count); expect(currentButton()).toBeDefined()
 await publish(160); expect(attempts).toBe(1); expect(ids().at(-1)).toBe('original-59')
})
it('a new native binding keeps the old conversation and never auto-reads it as the new source', async () => {
 await render(); await followAt(900); const count = requests.filter(input => input.limit === 100).length
 const newFacts: AgentNativeSourceFacts = { nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'different-native-source' } }
 await render(true, control.run.runId, newFacts); await publish(60)
 expect(ids().at(-1)).toBe('original-59'); expect(requests.filter(input => input.limit === 100)).toHaveLength(count)
 expect(container.textContent).toContain('Native source changed'); expect(currentButton()).toBeDefined()
})

it('a late automatic page cannot overwrite a newly established reading identity', async () => {
 await render(); await followAt(900)
 const original = vi.mocked(api.sessions.historyPage).getMockImplementation()!
 let release: (() => void) | undefined, held = false
 vi.mocked(api.sessions.historyPage).mockImplementation(async (reference, options) => {
  const page = await original(reference, options)
  if (options?.limit === 100 && !held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
  return page
 })
 await publish(60); expect(held).toBe(true)
 await appendFile(transcript, Array.from({ length: 100 }, (_, n) => JSON.stringify(record(160 + n))).join('\n') + '\n')
 await render(true, 'new-reading-identity'); expect(ids().at(-1)).toBe('original-259')
 await act(async () => release!()); await flush(); expect(ids().at(-1)).toBe('original-259')
 expect(ids()).not.toContain('original-159')
})
