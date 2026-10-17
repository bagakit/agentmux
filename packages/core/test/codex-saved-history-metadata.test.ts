import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { projectConversationRecords } from '../src/conversation.js'
import { readCodexSavedSessionHistoryRecord } from '../src/providers/codex-saved-history.js'
import { fixtureEpoch } from './helpers/fixture-values.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const SOURCE = { providerId: 'codex', nativeSessionId: 'original-native' }
const AT = fixtureEpoch(4, 3, 2)
const iso = (at: number) => new Date(at).toISOString()
const message = (id: string, extra: Record<string, unknown> = {}, timestamp: unknown = iso(AT)) => ({
  timestamp, type: 'response_item', payload: { id, type: 'message', role: 'assistant', phase: 'commentary',
    content: [{ type: 'output_text', text: 'Original public progress reply.' }], ...extra }
})
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const fixtures: Awaited<ReturnType<typeof createFixture>>[] = []
const closes: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const f of fixtures.splice(0)) {
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    if (f.unifiedCapturedRead) {
      // Opening the unified reader initializes its captured stream in the same
      // SQLite owner. Protect the original Session and native bytes, not page layout.
      expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(f.session)
      expect(await readFile(f.transcriptPath)).toEqual(f.nativeBefore)
    } else expect(await readFile(f.storePath)).toEqual(f.before)
    await f.client.dispose()
    await Promise.allSettled(f.pending)
    await rm(f.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function fixture(rows: unknown[]) {
  const value = await createFixture(rows)
  fixtures.push(value)
  return value
}

async function createFixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'saved-metadata-'))
  const transcriptPath = join(root, 'original.jsonl'), storePath = join(root, 'sessions.json')
  await writeFile(transcriptPath, jsonl([{ type: 'session_meta', payload: { id: SOURCE.nativeSessionId, cwd: root } }, ...rows]))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: root, run: { runId: 'retained-run' }, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: SOURCE.nativeSessionId, transcriptPath } }
  await store.compareAndSwap(null, session)
  const before = await readFile(storePath), pending: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const read = load(); pending.push(read); return read })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name =>
    vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading cannot operate a Run') }))
  const value = { root, transcriptPath, storePath, store, session, client, before, controls, pending,
    nativeBefore: await readFile(transcriptPath), unifiedCapturedRead: false }
  return value
}

it('retains saved message times and structured turns through public pages, projection and exact original reads', async () => {
  const f = await fixture([
    message('older', { turn_id: 'direct-turn' }, iso(AT - 1)),
    message('reply', { internal_chat_message_metadata_passthrough: { turn_id: 'original-turn' } })
  ])
  const originalBytes = await readFile(f.transcriptPath)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  expect(page.items).toEqual([expect.objectContaining({ id: 'reply', kind: 'assistant-message', startedAt: AT,
    turnId: 'original-turn', messagePhase: 'progress', contentParts: [{ kind: 'text', text: 'Original public progress reply.', contentEligibility: 'public' }] })])
  expect(page.items[0]).not.toHaveProperty('completedAt')
  expect(projectConversationRecords({ agentSessionId: f.session.agentSessionId, historyPage: page })[0]).toMatchObject({ recordedAt: AT })
  expect(page.nextCursor).not.toBeNull()
  await appendFile(f.transcriptPath, jsonl([message('later', { turn_id: 'later-turn' }, iso(AT + 1))]))
  const older = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1, cursor: page.nextCursor! })
  expect(older.items).toEqual([expect.objectContaining({ id: 'older', startedAt: AT - 1, turnId: 'direct-turn' })])
  const context = { source: SOURCE, transcriptPath: f.transcriptPath, workspacePath: f.root,
    command: 'unused', args: [], env: {}, signal: new AbortController().signal }
  const exact = await readCodexSavedSessionHistoryRecord({ ...context, recordId: 'reply', turnId: 'original-turn' })
  expect(exact).toMatchObject({ id: 'reply', turnId: 'original-turn', startedAt: AT })
  await expect(readCodexSavedSessionHistoryRecord({ ...context, recordId: 'reply', turnId: 'another-turn' }))
    .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD' })
  expect((await readFile(f.transcriptPath)).subarray(0, originalBytes.length)).toEqual(originalBytes)
})

it('the original changes converter exposes recorded time and turn after a durable cut', async () => {
  const f = await fixture([message('previous', { turn_id: 'previous-turn' })])
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  await appendFile(f.transcriptPath, jsonl([message('appended', { internal_chat_message_metadata_passthrough: { turn_id: 'appended-turn' } }, iso(AT + 2))]))
  const page = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint })
  expect(page.items).toEqual([expect.objectContaining({ id: 'appended', startedAt: AT + 2, turnId: 'appended-turn' })])
  expect(page.more).toBe(false)
})

it('the public resource reader can locate a saved message using its recorded metadata turn', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  const reference = 'data:image/png;base64,' + png
  const f = await fixture([message('resource-reply', {
    internal_chat_message_metadata_passthrough: { turn_id: 'resource-turn' },
    content: [{ type: 'output_text', text: 'Original image reply.' }, { type: 'input_image', image_url: reference }]
  })])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ turnId: 'resource-turn' })
  const request = { source: page.source, recordId: page.items[0]!.id, turnId: page.items[0]!.turnId!, partIndex: 1, expectedReference: reference }
  await expect(f.client.sessionHistoryResource(f.session.agentSessionId, request)).resolves.toMatchObject({
    agentSessionId: f.session.agentSessionId, source: SOURCE, recordId: 'resource-reply', turnId: 'resource-turn',
    result: { status: 'read', mimeType: 'image/png', dataBase64: png }
  })
})

it('public RPC and compiled history CLI return the same qualified message metadata', async () => {
  const f = await fixture([message('public-reply', { internal_chat_message_metadata_passthrough: { turn_id: 'public-turn' } })])
  f.unifiedCapturedRead = true
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'native' as const }
  const history = await rpc.call('agent.history', input)
  const original = expect.objectContaining({ id: 'public-reply', startedAt: AT, turnId: 'public-turn' })
  expect(history.items).toEqual([{ kind: 'item', item: original }])
  const conversation = await rpc.call('agent.conversation.inspect', { hostId: input.hostId, agentSessionId: input.agentSessionId })
  expect(conversation.items).toEqual([{ kind: 'item', item: expect.objectContaining({
    event: expect.objectContaining({ role: 'message' }), records: [expect.objectContaining({ original: { kind: 'native', item: original } })]
  }) }])
  const result = await runCompiledObjectCli(['agent', 'history', '--host', 'local', '--session', f.session.agentSessionId, '--source', 'native'], objectCliEnvironment(f.root))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.items).toEqual([{ kind: 'item', item: expect.objectContaining({ id: 'public-reply', startedAt: AT, turnId: 'public-turn' }) }])
})

it('keeps absent, malformed and negative recorded time unknown without hiding original content', async () => {
  const f = await fixture([undefined, 'not-a-native-time', -1, null, iso(_historyFixtureEpoch(0, 0, -1))].map((timestamp, index) => ({ ...message('unknown-' + index), timestamp })))
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.map(item => item.id)).toEqual(['unknown-0', 'unknown-1', 'unknown-2', 'unknown-3', 'unknown-4'])
  for (const item of page.items) {
    expect(item).not.toHaveProperty('startedAt')
    expect(item.contentParts).toEqual([{ kind: 'text', text: 'Original public progress reply.', contentEligibility: 'public' }])
  }
})

it('does not infer message turns from unrelated, empty or conflicting metadata', async () => {
  const f = await fixture([
    message('same', { turn_id: 'same-turn', internal_chat_message_metadata_passthrough: { turn_id: 'same-turn' } }),
    message('conflict', { turn_id: 'top-turn', internal_chat_message_metadata_passthrough: { turn_id: 'other-turn' } }),
    message('empty', { internal_chat_message_metadata_passthrough: { turn_id: '' } }),
    message('not-text', { internal_chat_message_metadata_passthrough: { turn_id: 12 } }),
    { timestamp: iso(AT), type: 'response_item', payload: { id: 'activity', type: 'reasoning', summary: [], internal_chat_message_metadata_passthrough: { turn_id: 'unqualified-turn' } } }
  ])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.map(item => item.id)).toEqual(['same', 'conflict', 'empty', 'not-text', 'activity'])
  expect(page.items[0]).toMatchObject({ turnId: 'same-turn' })
  for (const item of page.items.slice(1)) expect(item).not.toHaveProperty('turnId')
})
