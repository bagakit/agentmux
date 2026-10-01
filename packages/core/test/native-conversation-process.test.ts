import { fixtureEpoch } from './helpers/fixture-values.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentProviderSessionHistoryPage, AgentSessionHistoryCollaboration, AgentSessionHistoryPage, AgentSessionHistoryPageOptions } from '../src/types.js'

const SID = 'private-main-session', NATIVE = 'private-native-main', BODY = '\n  公开进度说明 exact 中\n'
const source = { providerId: 'codex', nativeSessionId: NATIVE }
const ref = (nativeSessionId: string) => ({ providerId: source.providerId, nativeSessionId })
const call = { type: 'collabAgentToolCall', id: 'collab-call', tool: 'spawnAgent', status: 'inProgress',
  senderThreadId: NATIVE, receiverThreadIds: ['native-worker-b', 'native-worker-a'],
  prompt: '\n  Review exact 原输入\n' + '请仔细检查公开记录的身份、来源与失败事实；不要推断未记录的执行结果。'.repeat(40), model: 'recorded-request-model', reasoningEffort: 'high',
  agentsStates: { 'native-worker-a': { status: 'completed', message: 'Recorded result A' },
    'native-worker-b': { status: 'errored', message: 'Recorded failure B' } }, extraField: { keep: 'complete native payload' } }
const activity = { type: 'subAgentActivity', id: 'agent-activity', kind: 'interacted', agentThreadId: 'native-worker-a', agentPath: 'root/reviewer' }
const rawItems: Record<string, unknown>[] = [
  { type: 'userMessage', id: 'user-original', content: [{ type: 'text', text: 'Please inspect the recorded process.' }] },
  { type: 'agentMessage', id: 'progress-a', text: BODY, phase: 'commentary' }, call, activity,
  { type: 'commandExecution', id: 'command', command: 'read-only-example', aggregatedOutput: 'complete output', status: 'completed', exitCode: 0 },
  { type: 'agentMessage', id: 'final-a', text: BODY, phase: 'final_answer' },
  { type: 'agentMessage', id: 'progress-b', text: BODY, phase: 'commentary' },
  { type: 'agentMessage', id: 'missing-phase', text: 'Contains commentary and final_answer; these words prove nothing.' },
  { type: 'agentMessage', id: 'null-phase', text: 'A phase is not recorded.', phase: null },
  { type: 'agentMessage', id: 'future-phase', text: 'A future phase stays unclassified.', phase: 'future-phase' },
  { type: 'collabAgentToolCall', id: 'unknown-call', tool: '__proto__', status: 'future-state',
    receiverThreadIds: ['native-unknown'], agentsStates: { 'native-unknown': { status: 'future-state', message: 'Exact unknown-state message' } } },
  { type: 'futureActivity', id: 'unknown-activity', phase: 'commentary', nested: { keep: 'complete record' } },
  { type: 'subAgentActivity', id: 'unknown-event', kind: 'future-event', agentThreadId: 'native-worker-a', agentPath: 'native/path' },
  { type: 'collabAgentToolCall', id: 'missing-fields', tool: 'sendMessage', status: 'completed', senderThreadId: null, prompt: null },
  { type: 'subAgentActivity', id: 'missing-agent', kind: 'started' }
]
const entries = rawItems.map((item, index) => ({ turnId: index < 7 ? 'native-turn-1' : 'native-turn-2', item,
  ...(index === 1 ? { startedAtMs: fixtureEpoch(1, 80000, 100), completedAtMs: fixtureEpoch(1, 80000, 200) } : {}) }))
const olderRaw = [
  { type: 'agentMessage', id: 'old-progress', text: 'Earlier public progress.', phase: 'commentary' },
  { ...call, id: 'old-collab', tool: 'sendMessage', status: 'completed' },
  { type: 'agentMessage', id: 'old-final', text: 'Earlier final answer.', phase: 'final_answer' }
]
const olderEntries = olderRaw.map(item => ({ turnId: 'native-turn-0', item }))

type Fixture = { client: AgentMuxClient; store: AgentMuxFileAgentSessionStore; home: string;
  read(options?: AgentSessionHistoryPageOptions): Promise<AgentSessionHistoryPage>;
  requests(): Promise<{ method: string; params?: Record<string, unknown> }[]>; responses(): Promise<unknown[]> }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

/** Controlled read-only producer using official shapes, not a vendor model or user Runtime. */
async function fixture(provider?: AgentProvider): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'amx-native-process-'))
  const workspace = join(home, 'workspace'); await mkdir(workspace)
  const producer = join(home, 'readonly-producer.mjs'), requestsPath = join(home, 'requests.jsonl'), responsesPath = join(home, 'responses.jsonl')
  const producerSource = `import { appendFileSync } from 'node:fs';\nimport { createInterface } from 'node:readline';
const entries = ${JSON.stringify(entries)}, older = ${JSON.stringify(olderEntries)};
const nativeId = ${JSON.stringify(NATIVE)};
const send = (id, result) => { const response={id,result}; appendFileSync(process.env.AMX_NATIVE_PROCESS_RESPONSES,JSON.stringify(response)+'\\n'); process.stdout.write(JSON.stringify(response)+'\\n'); };
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 appendFileSync(process.env.AMX_NATIVE_PROCESS_REQUESTS,JSON.stringify(request)+'\\n');
 if(request.method==='initialize') send(request.id,{userAgent:'controlled-readonly-producer'});
 else if(request.method==='thread/read') send(request.id,{thread:{id:nativeId,historyMode:'paginated'}});
 else if(request.method==='thread/items/list') {
  const mode=request.params.cursor;
  const data=mode==='older-opaque' ? older : mode==='duplicate-id' ? [entries[0],entries[0]] : entries;
  send(request.id,{data:[...data].reverse(),nextCursor:mode==='older-opaque'?null:'older-opaque'});
 }
});\n`
  await writeFile(producer, producerSource)
  const providerId = provider?.id ?? 'codex'
  const store = new AgentMuxFileAgentSessionStore(join(home, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: SID, providerId, executorId: providerId,
    hostId: 'local', workspacePath: workspace, run: { runId: 'original-run-not-connected' }, retiredRuns: [],
    hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId, sessionId: NATIVE } })
  const before = await readFile(join(home, 'sessions.json'))
  const client = new AgentMuxClient({ store, ...(provider ? { providers: [provider] } : {}) })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const controls = (['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'] as const).map(name =>
    vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden Runtime control: ' + name) }))
  cleanups.push(async () => {
    expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(join(home, 'sessions.json'))).toEqual(before)
    await client.dispose(); await rm(home, { recursive: true, force: true })
  })
  const requests = async () => readFile(requestsPath, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => [])
  const responses = async () => readFile(responsesPath, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => [])
  const read = (options?: AgentSessionHistoryPageOptions) => client.sessionHistoryPage(SID, {
    commandOverride: process.execPath, args: [producer], env: { CODEX_HOME: home, AMX_NATIVE_PROCESS_REQUESTS: requestsPath, AMX_NATIVE_PROCESS_RESPONSES: responsesPath }, ...options })
  const proof = process.env.AGENTMUX_NATIVE_PROCESS_ARTIFACTS
  if (proof && !provider) {
    await mkdir(proof, { recursive: true })
    await writeFile(join(proof, 'native-input.json'), JSON.stringify({ source, entries, olderEntries }, null, 2)+'\n')
    await writeFile(join(proof, 'readonly-producer.mjs'), producerSource)
  }
  return { client, store, home, read, requests, responses }
}

it('keeps real phase, IDs, source-order, original body and only item-owned times through public Core', async () => {
  const f = await fixture(), page = await f.read()
  expect(page.items.map(item => item.id)).toEqual(rawItems.map(item => item.id))
  const byId = new Map(page.items.map(item => [item.id, item]))
  expect(['progress-a', 'final-a', 'progress-b'].map(id => byId.get(id)?.messagePhase)).toEqual(['progress', 'final', 'progress'])
  for (const id of ['progress-a', 'final-a', 'progress-b']) expect(byId.get(id)?.contentParts).toEqual([{ kind: 'text', text: BODY }])
  expect(byId.get('progress-a')).toMatchObject({ startedAt: fixtureEpoch(1, 80000, 100), completedAt: fixtureEpoch(1, 80000, 200), turnId: 'native-turn-1' })
  expect(byId.get('progress-b')).not.toHaveProperty('startedAt')
  for (const id of ['missing-phase', 'null-phase', 'future-phase', 'unknown-activity']) expect(byId.get(id)).not.toHaveProperty('messagePhase')
  expect(page.source).toEqual(source); expect(page.agentSessionId).toBe(SID)
  expect(page.nextCursor).toBe('older-opaque')
  expect((await f.requests()).map(r => r.method)).toEqual(['initialize', 'initialized', 'thread/read', 'thread/items/list'])
  const proof = process.env.AGENTMUX_NATIVE_PROCESS_ARTIFACTS
  if (proof) { await writeFile(join(proof, 'public-current-page.json'), JSON.stringify(page, null, 2)+'\n');
    await writeFile(join(proof, 'public-requests.json'), JSON.stringify(await f.requests(), null, 2)+'\n') }
})

it('keeps operation scope separate from recipient snapshots and preserves complete raw payload', async () => {
  const f = await fixture(), item = (await f.read()).items.find(item => item.id === call.id)!
  expect(item.kind).toBe('activity')
  expect(item.collaboration).toEqual({ kind: 'operation', operation: 'spawn', status: 'running',
    sender: ref(NATIVE), receivers: [ref('native-worker-b'), ref('native-worker-a')], prompt: call.prompt,
    agentStates: [{ source: ref('native-worker-a'), state: 'completed', message: 'Recorded result A' },
      { source: ref('native-worker-b'), state: 'failed', message: 'Recorded failure B' }] })
  expect(item.contentParts).toEqual([{ kind: 'text', text: JSON.stringify(call, null, 2) }])
  expect(JSON.parse(item.contentParts[0]!.kind === 'text' ? item.contentParts[0]!.text : '')).toEqual(call)
  expect(item).not.toHaveProperty('startedAt'); expect(item).not.toHaveProperty('run')
})

it('represents a native Agent activity without inventing a sender, prompt or operation', async () => {
  const f = await fixture(), item = (await f.read()).items.find(item => item.id === activity.id)!
  expect(item.collaboration).toEqual({ kind: 'agent-activity', event: 'interacted', agent: ref('native-worker-a'), path: 'root/reviewer' })
  expect(item.contentParts).toEqual([{ kind: 'text', text: JSON.stringify(activity, null, 2) }])
  expect(item.collaboration).not.toHaveProperty('operation'); expect(item.collaboration).not.toHaveProperty('sender')
  expect(item.collaboration).not.toHaveProperty('prompt')
})

it('keeps unknown phases/statuses/operations and incomplete activities unclassified and readable', async () => {
  const f = await fixture(), page = await f.read(), byId = new Map(page.items.map(item => [item.id, item]))
  expect(byId.get('unknown-call')?.collaboration).toEqual({ kind: 'operation', receivers: [ref('native-unknown')],
    agentStates: [{ source: ref('native-unknown'), message: 'Exact unknown-state message' }] })
  expect(byId.get('missing-fields')?.collaboration).toEqual({ kind: 'operation', operation: 'send-message', status: 'completed', receivers: [], agentStates: [] })
  for (const id of ['unknown-event', 'missing-agent', 'unknown-activity']) {
    const item = byId.get(id)!, raw = rawItems.find(raw => raw.id === id)!
    expect(item.kind).toBe('activity'); expect(item).not.toHaveProperty('collaboration')
    expect(item.contentParts).toEqual([{ kind: 'text', text: JSON.stringify(raw, null, 2) }])
  }
  expect(byId.get('unknown-call')?.contentParts).toEqual([{ kind: 'text', text: JSON.stringify(rawItems[10], null, 2) }])
})

it('continues older native source through the original opaque cursor, preserving phase and collaboration', async () => {
  const f = await fixture(), latest = await f.read(), older = await f.read({ cursor: latest.nextCursor! })
  expect(older.items.map(item => item.id)).toEqual(['old-progress', 'old-collab', 'old-final'])
  expect(older.items[0]!.messagePhase).toBe('progress'); expect(older.items[2]!.messagePhase).toBe('final')
  expect(older.items[1]!.collaboration).toMatchObject({ kind: 'operation', operation: 'send-message', status: 'completed' })
  expect(older.nextCursor).toBeNull()
  expect((await f.requests()).at(-1)?.params).toEqual({ threadId: NATIVE, limit: 30, sortDirection: 'desc', cursor: 'older-opaque' })
  const proof = process.env.AGENTMUX_NATIVE_PROCESS_ARTIFACTS
  if (proof) {
    await writeFile(join(proof, 'public-older-page.json'), JSON.stringify(older, null, 2)+'\n')
    await writeFile(join(proof, 'public-pages.json'), JSON.stringify({ agentSessionId: SID, source, pages: [latest, older], requests: await f.requests(), responses: await f.responses() }, null, 2)+'\n')
  }
})

it('retains duplicate-ID and finite-page guards instead of trusting new metadata', async () => {
  const f = await fixture()
  await expect(f.read({ cursor: 'duplicate-id' })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_HISTORY_PAGE' })
  await expect(f.read({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_HISTORY_OPTIONS' })
})

async function genericFixture(page: AgentProviderSessionHistoryPage | (() => AgentProviderSessionHistoryPage)) {
  const base = new AgentProviderRegistry().get('claude'), id = 'alternate-history-protocol'
  const readSessionHistoryPage = vi.fn(async () => typeof page === 'function' ? page() : page)
  const provider: AgentProvider = { ...base, id, label: 'Alternative read-only history', catalog: { ...base.catalog, id }, readSessionHistoryPage }
  return { ...(await fixture(provider)), readSessionHistoryPage, id }
}
const genericSource = { providerId: 'alternate-history-protocol', nativeSessionId: NATIVE }
const genericRecord = (collaboration: AgentSessionHistoryCollaboration): AgentProviderSessionHistoryPage => ({ source: genericSource, nextCursor: null,
  items: [{ id: 'generic-collab', kind: 'activity', contentParts: [{ kind: 'text', text: 'Original alternative protocol record' }], collaboration }] })

it('registered alternate Provider preserves the same generic metadata and cross-provider native references', async () => {
  const collaboration: AgentSessionHistoryCollaboration = { kind: 'operation', operation: 'wait', status: 'interrupted',
    sender: { providerId: 'alternate-history-protocol', nativeSessionId: 'native-parent' }, receivers: [ref('cross-provider-native')],
    prompt: '', agentStates: [{ source: ref('cross-provider-native'), state: 'not-found', message: '' }] }
  const page = genericRecord(collaboration)
  page.items.unshift({ id: 'generic-progress', kind: 'assistant-message', messagePhase: 'progress', contentParts: [{ kind: 'text', text: BODY }] })
  const f = await genericFixture(page)
  expect(await f.read()).toEqual({ agentSessionId: SID, ...page })
  expect(f.readSessionHistoryPage).toHaveBeenCalledOnce()
})

it('registered alternate Provider supports a separate genuine Agent activity', async () => {
  const page = genericRecord({ kind: 'agent-activity', event: 'started', agent: { providerId: genericSource.providerId, nativeSessionId: 'agent-one' } })
  const f = await genericFixture(page)
  expect(await f.read()).toEqual({ agentSessionId: SID, ...page })
})

it('counts the entire metadata DTO in the existing 4MiB page budget', async () => {
  const f = await genericFixture(genericRecord({ kind: 'operation', receivers: [], agentStates: [], prompt: 'x'.repeat(4*1024*1024) }))
  await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
})

it('preserves source refusal and a malformed metadata reading failure without changing the original Run or Store', async () => {
  const wrong = { ...genericRecord({ kind: 'operation', receivers: [], agentStates: [] }), source: { providerId: 'other', nativeSessionId: NATIVE } }
  const f = await genericFixture(wrong)
  await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const invalid = genericRecord({ kind: 'operation', receivers: [], agentStates: [] })
  Reflect.set(invalid.items[0]!.collaboration!, 'status', 'unknown-public-enum')
  const g = await genericFixture(invalid)
  await expect(g.read()).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_HISTORY_PAGE' })
})
