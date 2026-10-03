import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useEffect, useState } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'

import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const BODY = 'One original input body.'
const DRAFT = 'Keep the original unsent first-window draft.'
const initial = useAppStore.getState()
type Read = ReturnType<typeof useSessionUserMessages>
type ProtocolRecord = { turnId: string; item: Record<string, unknown> }
type Request = { method?: string; params?: { cursor?: string; limit?: number }; kind?: string; pid?: number; args?: string[] }
type Fixture = {
  directory: string; nativePath: string; storePath: string; originalNative: Buffer; expectedNative: Buffer; originalStore: Buffer
  physicalLoads: Promise<unknown>[]; client: AgentMuxClient; controls: MockInstance[]; control: AgentSessionControl
  reads: MockInstance<typeof api.sessions.historyPage>; pages: AgentSessionHistoryPage[]
  trace(): Promise<Request[]>; hold(cursor: string): void; release(): void; held(): boolean
  replace(values: ProtocolRecord[]): Promise<void>; failRead(failed?: boolean): Promise<void>; render(enabled?: boolean): Promise<void>
}
let host: HTMLDivElement, root: Root, current: Read | undefined, sequence = 0
const fixtures: Fixture[] = []

function records(count: number, userAt: number, body = BODY): ProtocolRecord[] {
  return Array.from({ length: count }, (_, i) => ({ turnId: 'original-turn', item: i === userAt
    ? { type: 'userMessage', id: `protocol-${i}`, content: [{ type: 'text', text: body },
      { type: 'mention', name: 'Original file', path: _hygiene_fixturePath("workspace/original.ts") }, { type: 'text', text: 'After original resource.  ' }] }
    : { type: 'commandExecution', id: `protocol-${i}`, command: `original-command-${i}`, status: 'completed', aggregatedOutput: `Original result ${i}`, exitCode: 0 } }))
}

function Conversation({ control, enabled = true }: { control: AgentSessionControl; enabled?: boolean }) {
  const [history, setHistory] = useState(false)
  const read = useSessionUserMessages(control, { enabled })
  useEffect(() => { current = read }, [read])
  return <ActivityView sessionId={control.agentSessionId} items={[]} userMessages={read.messages}
    nativeHistoryPage={read.nativeHistoryPage} nativeContextItems={read.nativeContextItems} capability="complete-events" displayState="working"
    conversationReading={{ reference: control, identity: control.run.runId, enabled, opened: history,
      onClose: () => setHistory(false), returnLabel: 'Conversation' }}
    userMessageRead={{ loading: read.loading, error: read.error, observationError: read.observationError, windowFrozen: read.windowFrozen,
      hasMore: read.hasMore, onRetry: () => void read.refresh(), onReadEarlier: () => setHistory(true) }} />
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  current = undefined; useAppStore.setState({ agentComposerDrafts: { 'first-window-draft': DRAFT }, timelines: {} })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  expect(fixtures.length).toBeGreaterThan(0)
  for (const f of fixtures.splice(0)) {
    expect(useAppStore.getState().agentComposerDrafts[f.control.agentSessionId]).toBe(DRAFT)
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(f.nativePath)).toEqual(f.expectedNative)
    expect(await readFile(f.storePath)).toEqual(f.originalStore)
    await f.client.dispose(); await Promise.allSettled(f.physicalLoads)
    const trace = await f.trace()
    expect(trace.filter(value => value.kind === 'helper').length).toBeGreaterThan(0)
    expect(trace.filter(value => value.method && !['initialize', 'initialized', 'thread/read', 'thread/items/list'].includes(value.method))).toEqual([])
    for (const helper of trace.filter(value => value.kind === 'helper')) {
      expect(helper.args?.slice(-6)).toEqual(['-s', 'read-only', '-a', 'never', 'app-server', '--stdio'])
      expect(() => process.kill(helper.pid!, 0)).toThrow(/ESRCH/)
    }
    await rm(f.directory, { recursive: true })
  }
  expect(useAppStore.getState().agentComposerDrafts['first-window-draft']).toBe(DRAFT)
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function fixture(input: ProtocolRecord[]): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'native-first-window-'))
  const nativePath = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  const protocolPath = join(directory, 'protocol.json'), helperPath = join(directory, 'readonly.mjs'), tracePath = join(directory, 'requests.jsonl')
  const nativeId = 'original-native-source', agentSessionId = `first-window-${++sequence}`
  await writeFile(nativePath, JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n')
  const protocol = { readFailed: false, current: 'snapshot-0', snapshots: { 'snapshot-0': input } as Record<string, ProtocolRecord[]> }
  await writeFile(protocolPath, JSON.stringify(protocol)); await writeFile(tracePath, '')
  // Only the transport is controlled. Every displayed record comes through the
  // built-in Codex readonly RPC reader, real FileStore and public Client.
  await writeFile(helperPath, `import { readFileSync, appendFileSync } from 'node:fs'; import { createInterface } from 'node:readline';
const protocol=JSON.parse(readFileSync(process.env.FIRST_WINDOW_PROTOCOL,'utf8'));
const trace=value=>appendFileSync(process.env.FIRST_WINDOW_TRACE,JSON.stringify(value)+'\\n');
trace({kind:'helper',pid:process.pid,args:process.argv.slice(2)});
for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);trace(q);const reply=result=>process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
if(q.method==='initialize')reply({userAgent:'controlled-readonly-transport'});
else if(q.method==='thread/read')reply({thread:{id:'${nativeId}',historyMode:'paginated'}});
else if(q.method==='thread/items/list'){if(protocol.readFailed){process.stdout.write(JSON.stringify({id:q.id,error:{code:-32001,message:'Native reading unavailable'}})+'\\n');continue;}const cursor=q.params.cursor;const [snapshot,offset]=cursor?cursor.split('|'):[protocol.current,'0'];
const all=[...protocol.snapshots[snapshot]].reverse(),start=Number(offset),end=Math.min(all.length,start+q.params.limit);
reply({data:all.slice(start,end),nextCursor:end<all.length?snapshot+'|'+end:null});}
else if(q.method!=='initialized')throw Error('Unexpected control '+q.method);}`)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: directory, run: { runId: 'healthy-unchanged-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId, transcriptPath: nativePath } }
  await store.compareAndSwap(null, stored)
  const originalNative = await readFile(nativePath), originalStore = await readFile(storePath)
  const physicalLoads: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const pending = load(); physicalLoads.push(pending); return pending })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Run ' + name) }))
  const invocation = { commandOverride: process.execPath, args: [helperPath], env: { FIRST_WINDOW_PROTOCOL: protocolPath, FIRST_WINDOW_TRACE: tracePath } }
  const pages: AgentSessionHistoryPage[] = []
  let heldCursor: string | null = null, release: (() => void) | undefined
  const reads = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (control, options) => {
    expect(control.agentSessionId).toBe(agentSessionId)
    const page = await client.sessionHistoryPage(control.agentSessionId, { ...invocation, ...options }); pages.push(page)
    if (heldCursor && options?.cursor === heldCursor) await new Promise<void>(resolve => { release = resolve })
    return page
  })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation((control, listener, options) =>
    client.observeSessionHistory(control.agentSessionId, listener, { ...invocation, ...options }))
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId, run: stored.run! }
  useAppStore.setState(state => ({ agentComposerDrafts: { ...state.agentComposerDrafts, [agentSessionId]: DRAFT } }))
  const f: Fixture = { directory, nativePath, storePath, originalNative, expectedNative: originalNative, originalStore, physicalLoads, client, controls, control, reads, pages,
    trace: async (): Promise<Request[]> => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    hold: (cursor: string) => { heldCursor = cursor }, release: () => { expect(release).toBeDefined(); release!(); heldCursor = null },
    held: () => release !== undefined,
    replace: async (values: ProtocolRecord[]) => { protocol.current = `snapshot-${Object.keys(protocol.snapshots).length}`; protocol.snapshots[protocol.current] = values; await writeFile(protocolPath, JSON.stringify(protocol)) },
    failRead: async (failed = true) => { protocol.readFailed = failed; await writeFile(protocolPath, JSON.stringify(protocol)) },
    render: async (enabled = true) => { await act(async () => root.render(<Conversation control={control} enabled={enabled} />)) } }
  fixtures.push(f); return f
}
async function wait(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() }, { timeout: 5000, interval: 10 })
}
function reading() { expect(current).toBeDefined(); return current! }
function ids() { const thread = host.querySelector('.conversation-native-thread'); return thread ? [...thread.children].flatMap(node => {
  const row = node as HTMLElement
  return row.dataset.nativeRecordId ? [row.dataset.nativeRecordId] : row.dataset.nativeRecordIds ? JSON.parse(row.dataset.nativeRecordIds) as string[] : []
}) : [] }
function expected(from: number, to: number) { return Array.from({ length: to - from }, (_, i) => `protocol-${i + from}`) }
function button(text: string, scope: ParentNode = host) { const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === text); expect(result).toBeDefined(); return result! }
async function click(node: HTMLButtonElement) { await act(async () => node.click()) }

it('actual public Codex two-page input reaches sole hook and shared Message with complete protocol IDs/parts; explicit replace uses the same bounded window', async () => {
  const f = await fixture(records(90, 45)); await f.render()
  await wait(() => expect(ids()).toEqual(expected(30, 90)))
  expect(f.reads.mock.calls.map(([, options]) => options)).toEqual([{ limit: 30 }, { limit: 30, cursor: 'snapshot-0|30' }])
  expect(reading().nativeHistoryPage?.nextCursor).toBe('snapshot-0|60')
  expect(reading().messages.map(message => [message.rawId, message.author.kind, message.recordedAt])).toEqual([['protocol-45', 'unknown', undefined]])
  expect(reading().nativeHistoryPage?.items.find(item => item.id === 'protocol-45')?.contentParts).toEqual(f.pages[1]!.items.find(item => item.id === 'protocol-45')!.contentParts)
  const row = host.querySelector<HTMLElement>('[data-native-record-id="protocol-45"]')!; expect(row.textContent).toContain(BODY)
  await click(row.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!)
  expect(row.textContent).toContain('Not recorded · shown as You')
  await act(async () => reading().refresh()); await wait(() => expect(reading().loading).toBe(false))
  expect(f.reads.mock.calls.map(([, options]) => options)).toEqual([{ limit: 30 }, { limit: 30, cursor: 'snapshot-0|30' }, { limit: 30 }, { limit: 30, cursor: 'snapshot-0|30' }])
  expect(ids()).toEqual(expected(30, 90)); expect(reading().error).toBeNull()
})

it.each([[90, 75, 60, 1], [120, 35, 30, 3]])('native first-window early stop: %i records/input %i retains from %i with exactly %i readonly pages', async (count, user, from, pages) => {
  const f = await fixture(records(count, user)); await f.render(); await wait(() => expect(ids()).toEqual(expected(from, count)))
  expect(f.reads).toHaveBeenCalledTimes(pages); expect(f.pages).toHaveLength(pages)
  expect(reading().messages.map(message => message.rawId)).toEqual([`protocol-${user}`])
  expect(reading().hasMore).toBe(true); expect(reading().error).toBeNull()
})

it('the shared recent owner keeps its current window while the same Activity reaches the fourth-page user with the actual opaque cursor', async () => {
  const f = await fixture(records(120, 0)); await f.render(); await wait(() => expect(ids()).toEqual(expected(30, 120)))
  expect(f.reads).toHaveBeenCalledTimes(3); expect(reading().messages).toEqual([])
  expect(reading().nativeHistoryPage?.nextCursor).toBe('snapshot-0|90')
  const currentPage = reading().nativeHistoryPage
  await click(button('Earlier'))
  await wait(() => expect(ids()).toEqual(expected(0, 90)))
  expect(f.reads).toHaveBeenCalledTimes(4)
  expect(f.reads.mock.calls.at(-1)?.[1]).toEqual({ limit: 30, cursor: 'snapshot-0|90' })
  expect(host.querySelector('[data-native-record-id="protocol-0"]')?.textContent).toContain(BODY)
  expect(reading().nativeHistoryPage).toBe(currentPage)
  expect(host.querySelectorAll('.activity-feed')).toHaveLength(1)
})

it('a failed public native replacement preserves accepted body, Range, expanded Workflow, complete parts and cursor, then recovers without controlling the healthy Run', async () => {
  const f = await fixture(records(60, 55)); await f.render(); await wait(() => expect(ids()).toEqual(expected(30, 60)))
  const body = host.querySelector<HTMLElement>('[data-native-record-id="protocol-55"] .log-turn__body p')!
  expect(body.textContent).toBe(BODY)
  const head = host.querySelector<HTMLButtonElement>('[data-native-record-ids] .wf-head')!
  expect(head).not.toBeNull(); await click(head); expect(head.getAttribute('aria-expanded')).toBe('true')
  const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.addRange(range)
  const page = reading().nativeHistoryPage!, parts = page.items.find(item => item.id === 'protocol-55')!.contentParts, cursor = page.nextCursor
  expect(parts).toHaveLength(3); expect(cursor).toBe('snapshot-0|30')
  await f.failRead(); await act(async () => reading().refresh())
  await wait(() => { expect(reading().loading).toBe(false); expect(reading().error?.message).toBe('Native read request failed.') })
  expect(reading().nativeHistoryPage).toBe(page); expect(reading().nativeHistoryPage!.nextCursor).toBe(cursor)
  expect(reading().nativeHistoryPage!.items.find(item => item.id === 'protocol-55')!.contentParts).toBe(parts)
  expect(host.querySelector('[data-native-record-id="protocol-55"] .log-turn__body p')).toBe(body)
  expect(selection.toString()).toBe(BODY); expect(selection.getRangeAt(0).startContainer).toBe(body)
  expect(head.isConnected).toBe(true); expect(head.getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('Native read request failed.')
  await f.failRead(false); await act(async () => reading().refresh())
  await wait(() => { expect(reading().loading).toBe(false); expect(reading().error).toBeNull() })
  expect(ids()).toEqual(expected(30, 60)); expect(selection.toString()).toBe(BODY)
  expect(head.isConnected).toBe(true); expect(head.getAttribute('aria-expanded')).toBe('true')
})

it('a late real second page after hiding cannot commit or read more; visible return reads fresh bounded pages without unrelated work', async () => {
  const f = await fixture(records(60, 15)); f.hold('snapshot-0|30'); await f.render()
  await wait(() => expect(f.held()).toBe(true)); expect(f.pages).toHaveLength(2)
  await f.render(false); const calls = f.reads.mock.calls.length
  await act(async () => f.release()); await act(async () => new Promise(resolve => setTimeout(resolve, 60)))
  expect(reading().nativeHistoryPage).toBeNull(); expect(ids()).toEqual([]); expect(f.reads).toHaveBeenCalledTimes(calls)
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, unrelated: 'Actually changed unrelated Context' } })))
  expect(useAppStore.getState().agentNames.unrelated).toBe('Actually changed unrelated Context')
  expect(f.reads).toHaveBeenCalledTimes(calls)
  await f.render(); await wait(() => expect(ids()).toEqual(expected(0, 60)))
  expect(f.reads).toHaveBeenCalledTimes(calls + 2); expect(reading().messages.map(message => message.rawId)).toEqual(['protocol-15'])
})

it('actual registered Codex observer appends a distinct same-body native input into the kept shared DOM; a changed unrelated source does zero reads', async () => {
  const original = records(60, 15), f = await fixture(original); await f.render()
  await wait(() => expect(ids()).toEqual(expected(0, 60)))
  expect(reading().observationError).toBeNull()
  const body = host.querySelector<HTMLElement>('[data-native-record-id="protocol-15"] .log-turn__body p')!; expect(body.textContent).toBe(BODY)
  const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const next = records(61, 60).at(-1)!
  await f.replace([...original, next])
  const append = Buffer.from(JSON.stringify({ type: 'response_item', payload: { id: 'controlled-writer-file-id', type: 'message', role: 'user',
    content: [{ type: 'input_text', text: BODY }] } }) + '\n')
  f.expectedNative = Buffer.concat([f.originalNative, append])
  await appendFile(f.nativePath, append)
  await wait(() => expect(ids()).toEqual(expected(0, 61)))
  expect(reading().messages.map(message => [message.rawId, message.author.kind, message.recordedAt])).toEqual([
    ['protocol-15', 'unknown', undefined], ['protocol-60', 'unknown', undefined]
  ])
  expect(f.reads).toHaveBeenCalledTimes(3)
  expect(host.querySelector('[data-native-record-id="protocol-15"] .log-turn__body p')).toBe(body)
  expect(selection.toString()).toBe(BODY); expect(selection.getRangeAt(0).startContainer).toBe(body)
  const unrelated = join(f.directory, 'unrelated-native.jsonl')
  await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'different-unrelated-native-source' } }) + '\n')
  const before = await readFile(unrelated), calls = f.reads.mock.calls.length
  await appendFile(unrelated, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Actual unrelated source update' }] } }) + '\n')
  expect((await readFile(unrelated)).byteLength).toBeGreaterThan(before.byteLength)
  await act(async () => new Promise(resolve => setTimeout(resolve, 120)))
  expect(f.reads).toHaveBeenCalledTimes(calls)
  expect(reading().nativeHistoryPage?.items.map(item => item.id)).toEqual(expected(0, 61))
})
