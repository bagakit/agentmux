import { fixturePath } from '../helpers/fixture-values.js'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentSessionHistoryObservation } from '../../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const ID = 'native-traex-main', BODY = '\n  Exact terminal 用户输入\n'
async function fixture(wrongSource = false) {
  const root = await mkdtemp(join(tmpdir(), 'amux-traex-read-')), path = join(root, 'rollout-owned.jsonl')
  const data = [
    { turnId: 'turn', item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: BODY }] } },
    { turnId: 'turn', item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'Native progress.' } },
    { turnId: 'turn', item: { type: 'reasoning', id: 'reason', summary: ['Native reasoning.'], content: [] } },
    { turnId: 'turn', item: { type: 'commandExecution', id: 'tool', command: 'pwd', status: 'completed', aggregatedOutput: 'native output' } },
    { turnId: 'turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Native answer.' } },
    { turnId: 'turn', item: { type: 'userMessage', id: 'user-2', content: [{ type: 'text', text: BODY }, { type: 'localImage', path: fixturePath("fixture/image.png") }] } }
  ]
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: ID, source: 'cli' } }) + '\n')
  const script = join(root, 'native-reader.mjs'), calls = join(root, 'requests.jsonl')
  await writeFile(script, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const data=${JSON.stringify(data)};createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},line+'\\n');const send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
if(r.method==='initialize')send({userAgent:'controlled-traex-read-protocol'});
else if(r.method==='thread/read')send({thread:{id:${JSON.stringify(wrongSource ? 'other-native' : ID)},historyMode:'paginated'}});
else if(r.method==='thread/items/list')send({data:r.params.cursor?data.slice(0,3).reverse():data.slice(3).reverse(),nextCursor:r.params.cursor?null:'opaque-native-page'});});`)
  const storePath = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'agent', providerId: 'traex', executorId: 'traex', hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'traex', sessionId: ID, transcriptPath: path } })
  const client = new AgentMuxClient({ store }), options = { commandOverride: process.execPath, args: [script], limit: 3 }
  cleanup.push(async () => { await client.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, path, storePath, store, client, options, calls, data }
}

it('uses registered TraeX public history pages for exact user/reply/progress/reasoning/tool records, opaque paging and durable reread', async () => {
  const f = await fixture(), newest = await f.client.sessionHistoryPage('agent', f.options)
  expect(newest.source).toEqual({ providerId: 'traex', nativeSessionId: ID })
  expect(newest.items.map(item => item.id)).toEqual(['tool', 'answer', 'user-2'])
  expect(newest.items.map(item => item.kind)).toEqual(['activity', 'assistant-message', 'user-message'])
  expect(newest.items[1]).toMatchObject({ kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: 'Native answer.' }] })
  expect(newest.items[2]!.contentParts).toEqual([{ kind: 'text', text: BODY }, { kind: 'resource', resourceType: 'image', reference: fixturePath("fixture/image.png") }])
  const older = await f.client.sessionHistoryPage('agent', { ...f.options, cursor: newest.nextCursor! })
  expect(older.items.map(item => item.id)).toEqual(['user-1', 'progress', 'reason'])
  expect(older.items[0]!.contentParts).toEqual([{ kind: 'text', text: BODY }])
  expect(older.items[1]).toMatchObject({ messagePhase: 'progress' })
  expect(older.items[2]!.contentParts).toEqual([{ kind: 'reasoning', text: 'Native reasoning.' }])
  expect(older.nextCursor).toBeNull()
  const fresh = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) })
  try { expect(await fresh.sessionHistoryPage('agent', f.options)).toEqual(newest) } finally { await fresh.dispose() }
  const requests = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(requests.filter(r => r.method === 'thread/items/list')[1].params.cursor).toBe('opaque-native-page')
  expect(requests.every(r => ['initialize', 'initialized', 'thread/read', 'thread/items/list'].includes(r.method))).toBe(true)
  expect((await f.store.load())[0]!.run).toEqual({ runId: 'original-run' })
})

it('observes the exact TraeX rollout without hooks and stops after consumer disposal', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const observer = await f.client.observeSessionHistory('agent', event => events.push(event), f.options)
  await appendFile(f.path, '{"type":"history_mutation","payload":{"operation":"append"}}\n')
  await vi.waitFor(() => expect(events.some(e => e.kind === 'invalidated')).toBe(true))
  expect(events[0]!.source).toEqual({ providerId: 'traex', nativeSessionId: ID })
  observer.dispose(); const count = events.length
  await appendFile(f.path, '{"type":"event_msg"}\n'); await new Promise(resolve => setTimeout(resolve, 30))
  expect(events).toHaveLength(count)
})

it('refuses foreign native metadata before reading any indexed items while preserving the original Run', async () => {
  const f = await fixture(true)
  await expect(f.client.sessionHistoryPage('agent', f.options)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect((await readFile(f.calls, 'utf8')).includes('thread/items/list')).toBe(false)
  expect((await f.store.load())[0]!.run).toEqual({ runId: 'original-run' })
})

it('declares only proved native resume; it does not invent hook, permission or token telemetry', () => {
  const provider = new AgentProviderRegistry().get('traex')
  expect(provider.buildResumeLaunch({ workspacePath: fixturePath("fixture"), nativeHandle: { kind: 'provider', providerId: 'traex', sessionId: 'native-id' }, prompt: 'follow up', args: ['--no-alt-screen'], env: {} }).args).toEqual(['resume', 'native-id', 'follow up', '--no-alt-screen'])
  expect(provider.catalog.capabilities.providerResume).toBe(true)
  expect(provider.catalog.capabilities.usage).toBeUndefined()
  expect(provider.catalog.hookStrategy).toEqual({ kind: 'none' })
  expect(provider.readSessionHistoryPage).toBeTypeOf('function')
  expect(provider.discoverNativeSession).toBeTypeOf('function')
})
