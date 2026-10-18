import { processNativeRecordIds } from './helpers/conversation-process-members'
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxHostExecutorOwner, AgentProviderRegistry, projectSessionUserMessages, type AgentMuxStoredAgentSession, type AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'

import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { useAppStore } from '../src/renderer/src/store'

const BODY = 'One original input body.'
const DRAFT = 'Keep the original unsent first-window draft.'
const initial = useAppStore.getState()
type ProtocolRecord = { turnId: string; item: Record<string, unknown> }
type Request = { method?: string; params?: { cursor?: string; limit?: number }; kind?: string; pid?: number; args?: string[] }
let host: HTMLDivElement, root: Root, sequence = 0
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []

function records(count: number, userAt: number): ProtocolRecord[] {
  return Array.from({ length: count }, (_, i) => ({ turnId: 'original-turn', item: i === userAt
    ? { type: 'userMessage', id: `protocol-${i}`, content: [{ type: 'text', text: BODY },
      { type: 'mention', name: 'Original file', path: _hygiene_fixturePath("workspace/original.ts") }, { type: 'text', text: 'After original resource.  ' }] }
    : { type: 'commandExecution', id: `protocol-${i}`, command: `original-command-${i}`, status: 'completed', aggregatedOutput: `Original result ${i}`, exitCode: 0 } }))
}

function savedRecord(value: ProtocolRecord) {
  const item = value.item
  return { type: 'response_item', payload: item.type === 'userMessage'
    ? { id: item.id, type: 'message', role: 'user', content: [{ type: 'input_text', text: BODY }] }
    : { id: item.id, type: 'function_call', call_id: 'call-' + String(item.id), name: 'exec_command', arguments: JSON.stringify({ cmd: item.command }) } }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  useAppStore.setState({ agentComposerDrafts: { 'first-window-draft': DRAFT }, timelines: {} })
})
afterEach(async () => {
  window.getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove()
  try {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const f of fixtures.splice(0)) {
      try {
        expect(useAppStore.getState().agentComposerDrafts[f.control.agentSessionId]).toBe(DRAFT)
        expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
        expect(await readFile(f.nativePath)).toEqual(f.expectedNative)
        expect(await f.store.loadMetadata()).toEqual(f.originalStore)
      } finally {
        for (const close of f.closes.reverse()) await close()
        await f.client.dispose(); await Promise.allSettled(f.physicalLoads)
        try {
          const trace = await f.trace()
          expect(trace.filter(value => value.kind === 'helper').length > 0).toBe(f.mode === 'stdio')
          expect(trace.filter(value => value.method && !['initialize', 'initialized', 'thread/read', 'thread/items/list'].includes(value.method))).toEqual([])
          for (const helper of trace.filter(value => value.kind === 'helper')) {
            expect(helper.args?.slice(-6)).toEqual(['-s', 'read-only', '-a', 'never', 'app-server', '--stdio'])
            expect(() => process.kill(helper.pid!, 0)).toThrow(/ESRCH/)
          }
        } finally { await rm(f.directory, { recursive: true }) }
      }
    }
    expect(useAppStore.getState().agentComposerDrafts['first-window-draft']).toBe(DRAFT)
  } finally { useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

async function fixture(input: ProtocolRecord[], mode: 'stdio' | 'saved-file' = 'stdio') {
  const directory = await mkdtemp(join(tmpdir(), 'native-first-window-'))
  const nativePath = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  const protocolPath = join(directory, 'protocol.json'), helperPath = join(directory, 'readonly.mjs'), tracePath = join(directory, 'requests.jsonl')
  const nativeId = 'original-native-source', agentSessionId = `first-window-${++sequence}`
  await writeFile(nativePath, [JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: directory } }),
    ...(mode === 'saved-file' ? input.map(value => JSON.stringify(savedRecord(value))) : [])].join('\n') + '\n')
  const protocol = { current: 'snapshot-0', snapshots: { 'snapshot-0': input } as Record<string, ProtocolRecord[]> }
  await writeFile(protocolPath, JSON.stringify(protocol)); await writeFile(tracePath, '')
  // The original registered Executor owns the readonly stdio invocation.
  // Renderer requests carry only public conversation identities and cursors.
  await writeFile(helperPath, `import { readFileSync, appendFileSync } from 'node:fs'; import { createInterface } from 'node:readline';
const protocol=JSON.parse(readFileSync(process.env.FIRST_WINDOW_PROTOCOL,'utf8'));
const trace=value=>appendFileSync(process.env.FIRST_WINDOW_TRACE,JSON.stringify(value)+'\\n');
trace({kind:'helper',pid:process.pid,args:process.argv.slice(2)});
for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);trace(q);const reply=result=>process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
if(q.method==='initialize')reply({userAgent:'controlled-readonly-transport'});
else if(q.method==='thread/read')reply({thread:{id:'${nativeId}',historyMode:'paginated'}});
else if(q.method==='thread/items/list'){const cursor=q.params.cursor;const [snapshot,offset]=cursor?cursor.split('|'):[protocol.current,'0'];
const all=[...protocol.snapshots[snapshot]].reverse(),start=Number(offset),end=Math.min(all.length,start+q.params.limit);
reply({data:all.slice(start,end),nextCursor:end<all.length?snapshot+'|'+end:null});}
else if(q.method!=='initialized')throw Error('Unexpected control '+q.method);}`)
  const providers = new AgentProviderRegistry()
  const owner = new AgentMuxHostExecutorOwner({ path: join(directory, 'executors.json'), runtimeId: 'original-history-owner', catalog: () => providers.catalog() })
  const registration = await owner.configure({ executorId: 'original-reader', config: { label: 'Original readonly Executor', providerId: 'codex', command: process.execPath,
    args: [helperPath], env: { FIRST_WINDOW_PROTOCOL: protocolPath, FIRST_WINDOW_TRACE: tracePath }, injectAgentMuxGuide: false } })
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'original-reader', hostId: 'local',
    workspacePath: directory, run: { runId: 'healthy-unchanged-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    creation: { createOperationId: 'original-create', executorRevision: registration.executor.configRevision, initialPrompt: 'confirmed' },
    hookBindingId: 'private-binding', hookToken: 'private-token', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeId, ...(mode === 'saved-file' ? { transcriptPath: nativePath } : {}) } }
  await store.compareAndSwap(null, stored)
  const originalNative = await readFile(nativePath), originalStore = await store.loadMetadata()
  const physicalLoads: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const pending = load(); physicalLoads.push(pending); return pending })
  const client = new AgentMuxClient({ store, hostExecutorOwner: owner }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot control Run ' + name) }))
  const pages: AgentSessionHistoryPage[] = [], read = client.sessionHistoryPage.bind(client)
  const reads = vi.spyOn(client, 'sessionHistoryPage').mockImplementation(async (...args) => { const page = await read(...args); pages.push(page); return page })
  const closes: Array<() => unknown | Promise<unknown>> = []
  await desktopConversationReadBridge({ root: directory, client }, closes)
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId, run: stored.run! }
  useAppStore.setState(state => ({ agentComposerDrafts: { ...state.agentComposerDrafts, [agentSessionId]: DRAFT } }))
  const f = { mode, directory, nativePath, store, originalNative, expectedNative: originalNative, originalStore, physicalLoads, client, controls, control, reads, pages, closes,
    trace: async (): Promise<Request[]> => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    render: async () => {
      await act(async () => root.render(<ActivityView {...activityReadingProps({ control })} />))
      await wait(() => { const consumer = inspectConversationConsumers(control).consumers[0]; expect(consumer?.accepted).toBeTruthy(); expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false) })
    } }

  fixtures.push(f); return f
}
async function wait(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() }, { timeout: 5000, interval: 10 })
}
function ids() { const thread = host.querySelector('.conversation-native-thread'); return thread ? [...thread.children].flatMap(node => {
  const row = node as HTMLElement
  return row.dataset.nativeRecordId ? [row.dataset.nativeRecordId] : row.dataset.conversationProcessMembers ? processNativeRecordIds(row) : []
}) : [] }
function expected(from: number, to: number) { return Array.from({ length: to - from }, (_, i) => `protocol-${i + from}`) }

it('registered readonly Codex stdio reaches the actual conversation window with complete IDs, parts and unknown authorship', async () => {
  const f = await fixture(records(60, 45)); await f.render()
  expect(ids()).toEqual(expected(0, 60))
  expect(f.reads.mock.calls.every(([id]) => id === f.control.agentSessionId)).toBe(true)
  const page = f.pages.find(page => page.items.some(item => item.id === 'protocol-45'))!
  expect(page.source).toEqual({ providerId: 'codex', nativeSessionId: 'original-native-source' })
  expect(page.items.find(item => item.id === 'protocol-45')!.contentParts).toEqual([
    { kind: 'text', text: BODY, contentEligibility: 'unconfirmed' },
    { kind: 'resource', resourceType: 'file', label: 'Original file', reference: _hygiene_fixturePath('workspace/original.ts'), contentEligibility: 'unconfirmed' },
    { kind: 'text', text: 'After original resource.  ', contentEligibility: 'unconfirmed' }])
  expect(projectSessionUserMessages({ agentSessionId: f.control.agentSessionId, historyPage: page }).map(message => [message.rawId, message.author.kind, message.publicContent, message.recordedAt]))
    .toEqual([['protocol-45', 'unknown', 'unknown', undefined]])
  const row = host.querySelector<HTMLElement>('[data-native-record-id="protocol-45"]')!; expect(row.textContent).toContain(BODY)
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(row.textContent).toContain('Not recorded · shown as You')
})
it('actual registered Codex observation appends distinct same-body input into retained DOM while an unrelated file does no reading work', async () => {
  const original = records(60, 15), f = await fixture(original, 'saved-file'); await f.render()
  expect(ids()).toEqual(expected(0, 60))
  const body = host.querySelector<HTMLElement>('[data-native-record-id="protocol-15"] .log-turn__body p')!; expect(body.textContent).toBe(BODY)
  const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const append = Buffer.from(JSON.stringify({ type: 'response_item', payload: { id: 'protocol-60', type: 'message', role: 'user', content: [{ type: 'input_text', text: BODY }] } }) + '\n')
  f.expectedNative = Buffer.concat([f.originalNative, append]); await appendFile(f.nativePath, append)
  await wait(() => expect(ids()).toEqual(expected(0, 61)))
  const consumer = inspectConversationConsumers(f.control).consumers[0]
  expect(consumer?.observationError).toBeNull(); expect(consumer?.error).toBeNull()
  expect(host.querySelector('[data-native-record-id="protocol-15"] .log-turn__body p')).toBe(body)
  expect(selection.toString()).toBe(BODY); expect(selection.getRangeAt(0).startContainer).toBe(body)
  const page = await f.client.sessionHistoryPage(f.control.agentSessionId, { limit: 100 })
  expect(projectSessionUserMessages({ agentSessionId: f.control.agentSessionId, historyPage: page }).map(message => [message.rawId, message.author.kind, message.publicContent, message.recordedAt]))
    .toEqual([['protocol-15', 'unknown', 'unknown', undefined], ['protocol-60', 'unknown', 'unknown', undefined]])
  const unrelated = join(f.directory, 'unrelated-native.jsonl'), calls = f.reads.mock.calls.length
  await writeFile(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'different-unrelated-native-source' } }) + '\n')
  const before = await readFile(unrelated)
  await appendFile(unrelated, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Actual unrelated source update' }] } }) + '\n')
  expect((await readFile(unrelated)).byteLength).toBeGreaterThan(before.byteLength)
  await act(async () => new Promise(resolve => setTimeout(resolve, 120)))
  expect(f.reads).toHaveBeenCalledTimes(calls); expect(ids()).toEqual(expected(0, 61))
})
