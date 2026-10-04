import { fixtureIso as _hygiene_fixtureIso } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage } from '@agentmux/core'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useSessionConversationWindow, type ConversationReading } from '../src/renderer/src/lib/session-conversation-window'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { conversationRulerRecords, conversationRulerWindow } from '../src/renderer/src/lib/conversation-ruler'

const END = Date.parse(_hygiene_fixtureIso(24494400000, "second")), HOUR = 3_600_000
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, value: ReturnType<typeof useSessionConversationWindow> | undefined
type Fixture = Awaited<ReturnType<typeof createFixture>>
const fixtures: Fixture[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host); value = undefined
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  expect(fixtures.length).toBeGreaterThan(0)
  for (const f of fixtures.splice(0)) {
    f.release?.(); await Promise.allSettled(f.pending)
    expect(createHash('sha256').update(await readFile(f.nativePath)).digest('hex')).toBe(createHash('sha256').update(f.nativeBytes).digest('hex'))
    expect(createHash('sha256').update(await readFile(f.storePath)).digest('hex')).toBe(createHash('sha256').update(f.storeBytes).digest('hex'))
    expect(f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    await f.client.dispose(); await rm(f.directory, { recursive: true })
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function fixture(count: number, step = HOUR / 20, timed = true, bodySize: number | ((index: number) => number) = 0): Promise<Fixture> {
  const value = await createFixture(count, step, timed, bodySize); fixtures.push(value); return value
}
async function createFixture(count: number, step: number, timed: boolean, bodySize: number | ((index: number) => number)) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-time-coverage-'))
  const nativePath = join(directory, 'original.jsonl'), storePath = join(directory, 'sessions.json')
  const nativeId = 'original-native', id = 'original-session'
  await writeFile(nativePath, Array.from({ length: count }, (_, i) => JSON.stringify({
    sessionId: nativeId, uuid: `record-${i}`, type: i % 2 ? 'assistant' : 'user',
    ...(timed ? { timestamp: new Date(END - (count - 1 - i) * step).toISOString() } : {}),
    message: { role: i % 2 ? 'assistant' : 'user', content: `Original body ${i}.` + 'x'.repeat(typeof bodySize === 'function' ? bodySize(i) : bodySize) }
  })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: directory, run: { runId: 'healthy-original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: nativeId, transcriptPath: nativePath } })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Read must not operate Run') }))
  const reading: ConversationReading = { reference: { hostId: 'local', agentSessionId: id }, identity: 'healthy-original-run', enabled: true }
  const f = { directory, nativePath, storePath, client, controls, reading, nativeBytes: await readFile(nativePath), storeBytes: await readFile(storePath),
    pending: [] as Promise<unknown>[], reads: [] as { cursor?: string; limit: number | undefined }[], pages: [] as AgentSessionHistoryPage[],
    holdAt: -1, failAt: -1, release: undefined as (() => void) | undefined, blocked: false }
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (reference, options) => {
    expect(reference).toEqual(reading.reference)
    const call = f.reads.length; f.reads.push({ ...(options?.cursor ? { cursor: options.cursor } : {}), limit: options?.limit })
    const pending = client.sessionHistoryPage(reference.agentSessionId, options); f.pending.push(pending)
    const page = await pending; f.pages.push(page)
    if (call === f.holdAt) { f.blocked = true; await new Promise<void>(resolve => { f.release = resolve }) }
    if (call === f.failAt) throw Error('Controlled original page unavailable')
    return page
  })
  return f
}
function Hook({ reading, duration = 24 * HOUR, recent = null }: { reading: ConversationReading; duration?: number; recent?: AgentSessionHistoryPage | null }) {
  const window = useSessionConversationWindow(reading, recent, () => true, undefined, duration)
  useEffect(() => { value = window }, [window])
  return <div>{window.page?.items.map(item => <p key={item.id} data-native-record-id={item.id}>{item.contentParts.flatMap(p => p.kind === 'text' ? [p.text] : []).join('')}</p>)}</div>
}
async function mount(f: Awaited<ReturnType<typeof fixture>>, duration = 24 * HOUR, enabled = true, recent: AgentSessionHistoryPage | null = null) {
  await act(async () => root.render(<Hook reading={{ ...f.reading, enabled }} duration={duration} recent={recent} />))
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() }, { timeout: 5000, interval: 10 }) }
function current() { expect(value).toBeDefined(); return value! }
function count() { return current().page?.items.length ?? 0 }
function span() { const items = current().page!.items; return Math.max(...items.map(i => i.startedAt!)) - Math.min(...items.map(i => i.startedAt!)) }
it('fills default 24h past 300 through actual public Claude pages without rereading the current head or inventing a history boundary', async () => {
  const f = await fixture(700); await mount(f)
  await wait(() => { expect(count()).toBeGreaterThan(300); expect(span()).toBeGreaterThanOrEqual(24 * HOUR); expect(current().loading).toBe(false) })
  expect(count()).toBeLessThanOrEqual(600); expect(current().historical).toBe(false); expect(current().historyBoundary).toBeNull()
  expect(f.reads.filter(r => !r.cursor)).toHaveLength(1)
  expect(f.reads.every(r => r.limit === 100)).toBe(true)
  expect(current().page!.items.at(-1)!.id).toBe('record-699')
})
it('commits the first accepted page while the second is held, preserves body node/Range and keeps accepted prefix after failure without automatic retry', async () => {
  const f = await fixture(700); f.holdAt = 1; f.failAt = 1; await mount(f)
  await wait(() => { expect(f.blocked).toBe(true); expect(count()).toBe(100) })
  const row = host.querySelector('[data-native-record-id="record-699"]')!, text = row.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); window.getSelection()!.addRange(range)
  await act(async () => f.release!())
  await wait(() => expect(current().error).toContain('Controlled original page unavailable'))
  expect(count()).toBe(100); expect(host.querySelector('[data-native-record-id="record-699"]')).toBe(row); expect(window.getSelection()!.toString()).toBe('Original')
  await act(async () => new Promise(resolve => setTimeout(resolve, 40))); expect(f.reads).toHaveLength(2)
  const refusedCursor = f.reads[1]!.cursor; f.failAt = -1
  await act(async () => current().retry()); await wait(() => { expect(current().loading).toBe(false); expect(count()).toBeGreaterThan(300) })
  expect(f.reads[2]!.cursor).toBe(refusedCursor); expect(host.querySelector('[data-native-record-id="record-699"]')).toBe(row)
  expect(window.getSelection()!.toString()).toBe('Original')
})
it('expands a selected time range asynchronously from the retained cursor; shrinking keeps all loaded bodies and stops unissued pages', async () => {
  const f = await fixture(1000); await mount(f, 6 * HOUR)
  await wait(() => { expect(count()).toBe(200); expect(current().loading).toBe(false) })
  const row = host.querySelector('[data-native-record-id="record-999"]')!; f.holdAt = 2
  await mount(f, 3 * 24 * HOUR); await wait(() => expect(f.blocked).toBe(true))
  expect(count()).toBe(200); expect(f.reads[2]!.cursor).toBeDefined()
  await mount(f, 6 * HOUR); await act(async () => f.release!())
  await wait(() => expect(current().loading).toBe(false))
  expect(f.reads).toHaveLength(3); expect(count()).toBe(300); expect(host.querySelector('[data-native-record-id="record-999"]')).toBe(row)
})
it('short EOF uses the actual recorded ruler extent, keeps untimed records navigable and sends no more reads for a larger target', async () => {
  const f = await fixture(12, HOUR / 12); await mount(f)
  await wait(() => { expect(count()).toBe(12); expect(current().loading).toBe(false) })
  const ruler = conversationRulerWindow(conversationRulerRecords(f.reading.reference.agentSessionId, current().page, []), '24h')
  expect(ruler.scale.span).toBe(11 * HOUR / 12); expect(ruler.scale.origin + ruler.scale.span).toBe(END)
  await mount(f, 7 * 24 * HOUR); await act(async () => new Promise(resolve => setTimeout(resolve, 25)))
  expect(f.reads).toHaveLength(1); expect(count()).toBe(12)
})
it('does not invent time coverage for untimed native records; explicit All continues to real EOF', async () => {
  const f = await fixture(420, HOUR / 20, false); await mount(f)
  await wait(() => { expect(count()).toBe(300); expect(current().loading).toBe(false) })
  expect(f.reads).toHaveLength(3)
  await mount(f, Infinity); await wait(() => { expect(count()).toBe(420); expect(current().loading).toBe(false) })
  expect(current().hasMore).toBe(false); expect(current().page!.items.every(i => i.startedAt === undefined)).toBe(true)
})
it('stops background coverage at the original record budget and retains the complete accepted window/current head and real next cursor', async () => {
  const f = await fixture(1800, HOUR / 100); await mount(f)
  await wait(() => { expect(count()).toBe(1200); expect(current().loading).toBe(false) })
  expect(current().page!.items.at(-1)!.id).toBe('record-1799'); expect(current().hasMore).toBe(true)
  expect(f.reads).toHaveLength(12); expect(current().error).toContain('bounded')
})
it('hidden discards delayed coverage, keeping the original accepted body and refusing hidden new reads', async () => {
  const f = await fixture(700); f.holdAt = 3; await mount(f)
  await wait(() => expect(f.blocked).toBe(true)); const before = current().page
  await mount(f, 24 * HOUR, false); await act(async () => f.release!())
  await wait(() => expect(current().loading).toBe(false)); expect(current().page).toBe(before); expect(f.reads).toHaveLength(4)
  await mount(f); await act(async () => new Promise(resolve => setTimeout(resolve, 30))); expect(f.reads).toHaveLength(4)
  expect(current().error).toContain('paused')
})
it('manual earlier navigation supersedes in-flight coverage and late coverage cannot replace the user-requested window', async () => {
  const f = await fixture(900); f.holdAt = 3; await mount(f)
  await wait(() => expect(f.blocked).toBe(true))
  await act(async () => current().readEarlier())
  await wait(() => expect(current().historyBoundary).not.toBeNull()); const before = current().page
  await act(async () => f.release!()); await wait(() => expect(current().loading).toBe(false))
  expect(current().page).toBe(before); expect(count()).toBe(600); expect(current().page!.items.at(-1)!.id).toBe('record-899')
})
it('actual Activity defaults to the public 24h fill and keeps its common conversation row during delayed background loading', async () => {
  const f = await fixture(700); f.holdAt = 3
  await act(async () => root.render(<ActivityView sessionId={f.reading.reference.agentSessionId} items={[]} capability="complete-events" conversationReading={f.reading} />))
  await wait(() => { expect(f.blocked).toBe(true); expect(host.querySelector('[data-native-record-id="record-699"]')).not.toBeNull() })
  const row = host.querySelector('[data-native-record-id="record-699"]')!
  expect(host.textContent).toContain('Reading records'); await act(async () => f.release!())
  await wait(() => expect(f.reads.length).toBeGreaterThan(3)); expect(host.querySelector('[data-native-record-id="record-699"]')).toBe(row)
})

it('keeps the accepted prefix when real decoded bytes hit the unchanged memory budget, with no trim or retry loop', async () => {
  const f = await fixture(400, HOUR / 100, true, 33000); await mount(f)
  await wait(() => { expect(current().error).toContain('byte budget'); expect(current().loading).toBe(false) })
  expect(count()).toBe(100); expect(current().page!.items.at(-1)!.id).toBe('record-399')
  expect(f.reads).toHaveLength(2); expect(current().hasMore).toBe(true)
  const refusedCursor = f.reads[1]!.cursor
  await act(async () => current().retry()); await wait(() => { expect(current().loading).toBe(false); expect(f.reads).toHaveLength(3) })
  expect(f.reads[2]!.cursor).toBe(refusedCursor); expect(count()).toBe(100)
})
it('a byte-rejected later coverage page cannot mutate the accepted prefix or skip its original cursor on Retry', async () => {
  const f = await fixture(700, HOUR / 100, true, i => i >= 300 ? 10000 : i >= 200 ? 30000 : 0)
  await mount(f)
  await wait(() => { expect(current().error).toContain('byte budget'); expect(current().loading).toBe(false) })
  expect(count()).toBe(400)
  const failedCursor = f.reads.at(-1)!.cursor, beforeReads = f.reads.length
  expect(current().page!.nextCursor).toBe(failedCursor)
  const row = host.querySelector('[data-native-record-id="record-699"]')!
  await act(async () => current().retry())
  await wait(() => expect(f.reads.length).toBeGreaterThan(beforeReads))
  expect(f.reads[beforeReads]!.cursor).toBe(failedCursor)
  await wait(() => expect(current().loading).toBe(false))
  expect(count()).toBe(400); expect(host.querySelector('[data-native-record-id="record-699"]')).toBe(row)
})
it('keeps the original same-source live tail during coverage and uses only remaining raw slots rather than rejecting an oversized final batch', async () => {
  const f = await fixture(1800, HOUR / 100); f.holdAt = 3; await mount(f)
  await wait(() => expect(f.blocked).toBe(true))
  const original = current().page!, source = original.source
  const recent: AgentSessionHistoryPage = { ...original, source, items: [original.items.at(-1)!, ...Array.from({ length: 30 }, (_, i) => ({
    id: `live-${i}`, kind: 'assistant-message' as const, startedAt: END + i * 1000, contentParts: [{ kind: 'text' as const, text: `Live body ${i}` }]
  }))] }
  await mount(f, 24 * HOUR, true, recent); await act(async () => f.release!())
  await wait(() => { expect(current().loading).toBe(false); expect(current().page!.items.at(-1)!.id).toBe('live-29') })
  expect(count()).toBe(1200); expect(current().historical).toBe(false)
  expect(f.reads.at(-1)!.limit).toBe(70)
  expect(f.reads.filter(r => !r.cursor)).toHaveLength(1)
})

it('actual Activity time-menu expansion requests earlier original pages while keeping the same common message node', async () => {
  const f = await fixture(750)
  await act(async () => root.render(<ActivityView sessionId={f.reading.reference.agentSessionId} items={[]} capability="complete-events" conversationReading={f.reading} />))
  await wait(() => expect(f.reads).toHaveLength(5))
  await wait(() => expect(host.querySelector('[data-native-record-id="record-250"]')).not.toBeNull())
  const row = host.querySelector('[data-native-record-id="record-749"]')!, reads = f.reads.length
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="History window: 24h"]')!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await wait(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull())
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === '3d reading window')!
  expect(option).toBeDefined(); await act(async () => option.click())
  await wait(() => expect(host.querySelector('[data-native-record-id="record-0"]')).not.toBeNull())
  expect(f.reads.length).toBeGreaterThan(reads); expect(f.reads.filter(r => !r.cursor)).toHaveLength(1)
  expect(host.querySelector('[data-native-record-id="record-749"]')).toBe(row)
  expect(host.querySelector('[aria-label="History window: 3d"]')).not.toBeNull()
})

it('explicit Retry reads the failed untimed initial cursor instead of silently treating unknown time as completed coverage', async () => {
  const f = await fixture(420, HOUR / 20, false); f.failAt = 1; await mount(f)
  await wait(() => expect(current().error).toContain('Controlled original page unavailable'))
  expect(count()).toBe(100); const cursor = f.reads[1]!.cursor; f.failAt = -1
  await act(async () => current().retry()); await wait(() => { expect(current().loading).toBe(false); expect(count()).toBe(200) })
  expect(f.reads).toHaveLength(3); expect(f.reads[2]!.cursor).toBe(cursor); expect(current().error).toBeNull()
})

it('actual Activity Earlier remains usable and supersedes delayed automatic range fill without remounting the current message', async () => {
  const f = await fixture(900); f.holdAt = 3
  await act(async () => root.render(<ActivityView sessionId={f.reading.reference.agentSessionId} items={[]} capability="complete-events" conversationReading={f.reading} />))
  await wait(() => expect(f.blocked).toBe(true))
  const row = host.querySelector('[data-native-record-id="record-899"]')!
  const earlier = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Earlier')!
  expect(earlier).toBeDefined(); expect(earlier.disabled).toBe(false); await act(async () => earlier.click())
  await wait(() => expect(host.querySelector('[data-native-record-id="record-300"]')).not.toBeNull())
  const before = [...host.querySelectorAll('[data-native-record-id]')].map(row => row.getAttribute('data-native-record-id'))
  await act(async () => f.release!()); await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
  expect([...host.querySelectorAll('[data-native-record-id]')].map(row => row.getAttribute('data-native-record-id'))).toEqual(before)
  expect(host.querySelector('[data-native-record-id="record-899"]')).toBe(row)
})
