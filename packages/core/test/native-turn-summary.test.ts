import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, normalizeAgentSession } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { normalizeSessionHistoryPage, SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import { extractTurnUsage, parseTurnUsage } from '../src/agent-usage-transcript.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryItem } from '../src/types.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const nativeSessionId = 'original-native-summary'
const source = { providerId: 'codex', nativeSessionId }
const event = (id: string, turnId: string | undefined, type: string, extra = {}) => ({ type: 'event_msg',
  payload: { id, type, ...(turnId === undefined ? {} : { turn_id: turnId }), ...extra } })
// Real rollout schema: token_usage_record is a top-level record type, not an event_msg payload type.
const usage = (id: string, turnId: string, input: number, output: number, total: number) => ({ type: 'token_usage_record',
  payload: { id, turn_id: turnId, response_id: `response-${id}`,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    turn_token_usage: { input_tokens: input, output_tokens: output, total_tokens: total,
      cached_input_tokens: 4, reasoning_output_tokens: 5 },
    thread_token_usage: { input_tokens: 99999, output_tokens: 88888, total_tokens: 188887 } } })
const speech = (id: string, turnId: string, phase: string, text: string) => ({ type: 'response_item',
  payload: { type: 'message', id, turn_id: turnId, role: 'assistant', phase, content: [{ type: 'output_text', text }] } })

async function fixture(providerId: 'codex' | 'claude', rows: unknown[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'amx-summary-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'original.jsonl'), storePath = join(root, 'sessions.json')
  await writeFile(path, jsonl(providerId === 'codex'
    ? [{ type: 'session_meta', payload: { id: nativeSessionId, cwd: root } }, ...rows] : rows))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent-summary', hostId: 'local',
    providerId, executorId: providerId, workspacePath: root, run: { runId: 'original-ended-run' }, retiredRuns: [],
    createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1), hookBindingId: 'original-binding', hookToken: 'original-token',
    nativeHandle: { kind: 'provider', providerId, sessionId: nativeSessionId, transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const reservation = { kind: 'stop' as const, reservationId: 'original-retirement', ownerId: 'fixture-owner', ownerPid: process.pid,
    agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'original-stop', expiresAt: Date.now() + 60000,
    stopOperation: { daemonInstance: 'no-runtime', operationKey: 'original-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const beforeStore = await readFile(storePath), client = new AgentMuxClient({ store })
  cleanups.push(() => client.dispose())
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'stop', 'resize', 'attach', 'status'].map(name => vi.spyOn(kernel, name as 'start'))
  const connect = vi.spyOn(client, 'connect')
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(() => rpc.dispose())
  const reference = { hostId: 'local', agentSessionId: session.agentSessionId }
  const cli = (args: string[], input = '') => runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...args], objectCliEnvironment(root), input)
  return { root, path, storePath, store, session, client, reference, rpc, cli,
    async unchanged() {
      expect(await readFile(storePath)).toEqual(beforeStore)
      expect(connect).not.toHaveBeenCalled()
      for (const control of controls) expect(control).not.toHaveBeenCalled()
    } }
}

it('preserves exact native turn snapshots, duration, response phase and public CLI history/context', async () => {
  const originalText = '  Exact final answer 中🙂\n'
  const f = await fixture('codex', [speech('progress', 'turn-one', 'commentary', 'Public progress'),
    usage('usage-early', 'turn-one', 10, 20, 39), speech('answer', 'turn-one', 'final_answer', originalText),
    usage('usage-final', 'turn-one', 110, 220, 339),
    event('complete', 'turn-one', 'task_complete', { duration_ms: 12345 }),
    event('other-turn', 'turn-two', 'task_complete', { duration_ms: 98765 }),
    event('interrupted', 'turn-three', 'turn_aborted'),
    event('orphan', undefined, 'task_complete', { duration_ms: 77 }),
    event('response-count', 'turn-one', 'token_count', { info: { last_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })])
  const bytes = await readFile(f.path), page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  const byId = new Map(page.items.map(item => [item.id, item]))
  expect(page.source).toEqual(source)
  expect(page.items.map(item => item.id)).toEqual(['progress', 'usage-early', 'answer', 'usage-final', 'complete', 'other-turn', 'interrupted', 'orphan'])
  expect(byId.get('progress')?.messagePhase).toBe('progress')
  expect(byId.get('answer')).toMatchObject({ turnId: 'turn-one', messagePhase: 'final', contentParts: [{ kind: 'text', text: originalText }] })
  expect(byId.get('answer')?.metrics).toBeUndefined()
  expect(byId.get('usage-early')?.metrics).toEqual({ scope: 'turn', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 39, cachedInputTokens: 4, reasoningOutputTokens: 5 } })
  expect(byId.get('usage-final')?.metrics).toEqual({ scope: 'turn', usage: { inputTokens: 110, outputTokens: 220, totalTokens: 339, cachedInputTokens: 4, reasoningOutputTokens: 5 } })
  expect(byId.get('complete')).toMatchObject({ turnId: 'turn-one', metrics: { scope: 'turn', durationMs: 12345, status: 'completed' } })
  expect(byId.get('other-turn')?.metrics).toEqual({ scope: 'turn', durationMs: 98765, status: 'completed' })
  expect(byId.get('interrupted')?.metrics).toEqual({ scope: 'turn', status: 'interrupted' })
  expect(byId.get('orphan')?.metrics).toBeUndefined()
  expect(byId.get('orphan')?.metricsDiagnostic?.code).toBe('NATIVE_HISTORY_METRICS_UNAVAILABLE')
  expect(JSON.parse((byId.get('complete')!.contentParts[0] as { text: string }).text).duration_ms).toBe(12345)
  const input = { ...f.reference, source: 'native' as const, limit: 30 }
  for (const method of ['agent.history', 'agent.conversation.inspect'] as const) {
    const read = await f.rpc.call(method, input)
    expect(read.nativeSource).toEqual(source)
    expect(read.items.map(entry => entry.kind === 'item' ? entry.item : null)).toEqual(page.items)
  }
  const context = await f.rpc.call('agent.context', f.reference)
  expect(context.native?.items).toEqual(page.items)
  for (const command of [['agent', 'history'], ['agent', 'conversation', 'inspect']]) {
    const output = await f.cli([...command, '--host', 'local', '--session', f.session.agentSessionId, '--source', 'native'])
    expect(output.code, output.stdout + output.stderr).toBe(0)
    expect(JSON.parse(output.stdout).result.items.map((entry: { item: AgentSessionHistoryItem }) => entry.item)).toEqual(page.items)
  }
  const output = await f.cli(['agent', 'context', '--host', 'local', '--session', f.session.agentSessionId])
  expect(output.code, output.stdout + output.stderr).toBe(0)
  expect(JSON.parse(output.stdout).result.native.items).toEqual(page.items)
  if (process.env.AGENTMUX_TURN_SUMMARY_RECEIPT) await writeFile(process.env.AGENTMUX_TURN_SUMMARY_RECEIPT, JSON.stringify({
    chain: 'original saved Provider → public Core Client → Unix JSON-RPC service/client → compiled CLI history/conversation/context',
    reference: f.reference, source: page.source, items: page.items, controls: 0, runtimeConnections: 0
  }, null, 2) + '\n')
  expect(await readFile(f.path)).toEqual(bytes)
  await f.unchanged()
})

it('keeps native append snapshots scoped and bounded across original change cursors and partial pages', async () => {
  const f = await fixture('codex', [speech('original', 'prior-turn', 'final_answer', 'Earlier original answer')])
  const original = await f.rpc.call('agent.conversation.checkpoint', f.reference)
  const latest = usage('new-usage', 'new-turn', 71, 8, 82)
  await appendFile(f.path, jsonl([latest]))
  const partialComplete = JSON.stringify(event('new-complete', 'new-turn', 'task_complete', { duration_ms: 321 }))
  await appendFile(f.path, partialComplete)
  const first = await f.rpc.call('agent.conversation.changes', { ...f.reference, checkpoint: original.checkpoint, limit: 1 })
  expect(first.items).toHaveLength(1)
  expect(first.items[0]).toMatchObject({ id: 'new-usage', turnId: 'new-turn', metrics: { scope: 'turn', usage: { inputTokens: 71, outputTokens: 8, totalTokens: 82 } } })
  const unfinished = await f.rpc.call('agent.conversation.changes', { ...f.reference, checkpoint: first.checkpoint })
  expect(unfinished.items).toEqual([])
  expect(unfinished.checkpoint).toEqual(first.checkpoint)
  await appendFile(f.path, '\n')
  const next = await f.rpc.call('agent.conversation.changes', { ...f.reference, checkpoint: unfinished.checkpoint })
  expect(next.items).toMatchObject([{ id: 'new-complete', turnId: 'new-turn', metrics: { scope: 'turn', durationMs: 321, status: 'completed' } }])
  expect((await f.rpc.call('agent.conversation.changes', { ...f.reference, checkpoint: next.checkpoint })).items).toEqual([])
  const latestPage = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  expect(latestPage.items).toEqual(next.items)
  expect(latestPage.items[0]!.metrics?.usage).toBeUndefined()
  const older = await f.client.sessionHistoryPage(f.session.agentSessionId, { cursor: latestPage.nextCursor!, limit: 1 })
  expect(older.items).toEqual(first.items)
  const output = await f.cli(['agent', 'conversation', 'changes', '--input', '-'], JSON.stringify(original))
  expect(output.code, output.stdout + output.stderr).toBe(0)
  expect(JSON.parse(output.stdout).result.items).toEqual([...first.items, ...next.items])
  await f.unchanged()
})

it('retains physical record identities from the actual id-less Codex usage and completion protocol', async () => {
  const nativeUsage = { type: 'token_usage_record', payload: { thread_id: nativeSessionId, session_id: nativeSessionId,
    turn_id: 'exact-native-turn', root_turn_id: 'different-root-turn', response_id: 'different-response',
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    turn_token_usage: { input_tokens: 42, cached_input_tokens: 9, output_tokens: 17, reasoning_output_tokens: 8, total_tokens: 59 },
    thread_token_usage: { input_tokens: 4200, output_tokens: 1700, total_tokens: 5900 } } }
  const completion = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'exact-native-turn', duration_ms: 1234 } }
  const foreignUsage = { ...nativeUsage, payload: { ...nativeUsage.payload, thread_id: 'different-native-source' } }
  const invalidTurn = { type: 'event_msg', payload: { type: 'task_complete', turn_id: '', duration_ms: -1 } }
  const f = await fixture('codex', [nativeUsage, completion, foreignUsage, invalidTurn]), bytes = await readFile(f.path, 'utf8')
  const expectedIds = [nativeUsage, completion, foreignUsage, invalidTurn].map(record => `codex-record:${Buffer.byteLength(bytes.slice(0, bytes.indexOf(JSON.stringify(record))))}`)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items.map(item => item.id)).toEqual(expectedIds)
  expect(page.items.map(item => item.turnId)).toEqual(['exact-native-turn', 'exact-native-turn', 'exact-native-turn', undefined])
  expect(page.items[0]!.metrics).toEqual({ scope: 'turn', usage: { inputTokens: 42, cachedInputTokens: 9, outputTokens: 17, reasoningOutputTokens: 8, totalTokens: 59 } })
  expect(page.items[1]!.metrics).toEqual({ scope: 'turn', durationMs: 1234, status: 'completed' })
  expect(page.items[2]!.metrics).toBeUndefined()
  expect(page.items[2]!.metricsDiagnostic?.code).toBe('NATIVE_HISTORY_METRICS_SOURCE_UNCONFIRMED')
  expect(JSON.parse((page.items[2]!.contentParts[0] as { text: string }).text).thread_id).toBe('different-native-source')
  expect(page.items[3]!.metrics).toBeUndefined()
  expect(page.items[3]!.metricsDiagnostic?.code).toBe('NATIVE_HISTORY_METRICS_UNAVAILABLE')
  const output = await f.cli(['agent', 'history', '--host', 'local', '--session', f.session.agentSessionId, '--source', 'native'])
  expect(output.code, output.stdout + output.stderr).toBe(0)
  expect(JSON.parse(output.stdout).result.items.map((entry: { item: AgentSessionHistoryItem }) => entry.item)).toEqual(page.items)
  await f.unchanged()
})

it('retains Claude response usage and original mixed parts without fabricating a turn, total or duration', async () => {
  const content = [{ type: 'thinking', thinking: 'Recorded reasoning' }, { type: 'text', text: 'Exact response' },
    { type: 'tool_use', id: 'original-call', name: 'inspect', input: { path: 'original' } }]
  const row = (uuid: string, counts: unknown, extra = {}) => ({ type: 'assistant', uuid, sessionId: nativeSessionId,
    ...extra, message: { role: 'assistant', usage: counts, content } })
  const f = await fixture('claude', [row('response-one', { input_tokens: 9, output_tokens: 11, cache_read_input_tokens: 4 }),
    row('response-two', { input_tokens: 90, output_tokens: 110 }, { user_message_uuid: 'explicit-native-user' }),
    row('response-bad', { input_tokens: -1, output_tokens: 'unknown' })])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items[0]!.metrics).toEqual({ scope: 'response', usage: { inputTokens: 9, outputTokens: 11, cachedInputTokens: 4 } })
  expect(page.items[0]!.turnId).toBeUndefined()
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'reasoning', text: 'Recorded reasoning' }, { kind: 'text', text: 'Exact response' },
    { kind: 'tool-call', callId: 'original-call', name: 'inspect', input: '{"path":"original"}' }])
  expect(page.items[1]).toMatchObject({ id: 'response-two', turnId: 'explicit-native-user', metrics: { scope: 'response', usage: { inputTokens: 90, outputTokens: 110 } } })
  expect(page.items[2]!.metrics).toBeUndefined()
  expect(page.items[2]!.metricsDiagnostic?.code).toBe('NATIVE_HISTORY_METRICS_UNAVAILABLE')
  expect(page.items[2]!.contentParts).toEqual(page.items[0]!.contentParts)
  const output = await f.cli(['agent', 'conversation', 'inspect', '--host', 'local', '--session', f.session.agentSessionId, '--source', 'native'])
  expect(output.code, output.stdout + output.stderr).toBe(0)
  expect(JSON.parse(output.stdout).result.items.map((entry: { item: AgentSessionHistoryItem }) => entry.item)).toEqual(page.items)
  await f.unchanged()
})

it('keeps malformed optional metadata out of authority and retains valid fields and real zero', () => {
  const body = { id: 'original-record', turnId: 'exact-turn', kind: 'activity' as const, contentParts: [{ kind: 'text' as const, text: 'Original body' }] }
  const read = (metrics: unknown) => normalizeSessionHistoryPage(source, { source, items: [{ ...body, metrics }], nextCursor: null }, 1).items[0]!
  const value = read({ scope: 'turn', durationMs: -1, usage: { inputTokens: 0, outputTokens: 'unknown', totalTokens: 17 }, status: 'completed' })
  expect(value.metrics).toEqual({ scope: 'turn', status: 'completed', usage: { inputTokens: 0, totalTokens: 17 } })
  expect(value.metricsDiagnostic?.code).toBe('NATIVE_HISTORY_METRICS_UNAVAILABLE')
  expect(value.contentParts).toEqual(body.contentParts)
  expect(read({ scope: 'session', durationMs: 12 }).metrics).toBeUndefined()
  expect(read({ scope: 'turn', durationMs: 0 }).metrics).toEqual({ scope: 'turn', durationMs: 0 })
  expect(read({ scope: 'turn', usage: { outputTokens: Number.MAX_SAFE_INTEGER + 1 } }).metrics).toBeUndefined()
  // A bogus optional field cannot alone make the unchanged original history exceed its budget.
  expect(read({ scope: 'turn', unexpected: 'x'.repeat(SESSION_HISTORY_MAX_PAGE_BYTES) }).contentParts).toEqual(body.contentParts)
  const input = { hostId: 'local', agentSessionId: 'original-agent', source: 'native' as const }
  const wire = { ...input, revision: 'a'.repeat(64), availability: 'available', order: 'chronological-page', budgetBytes: 65536,
    nativeSource: source, nextCursor: null, items: [{ kind: 'item', item: { ...body, metrics: { scope: 'response', durationMs: -1 } } }] }
  const parsed = parseRpcNativeResult('agent.conversation.inspect', wire, input) as unknown as { items: Array<{ item: AgentSessionHistoryItem }> }
  expect(parsed.items[0]!.item.contentParts).toEqual(body.contentParts)
  expect(parsed.items[0]!.item.metrics).toBeUndefined()
  expect(parsed.items[0]!.item.metricsDiagnostic?.code).toBe('NATIVE_HISTORY_METRICS_UNAVAILABLE')
})

it('labels existing Hook samples as response scope and preserves unknown old persisted scope', async () => {
  const sample = { inputTokens: 2, outputTokens: 5, totalTokens: 7, observedAt: _newTailFixtureEpoch(0, 0, 1234) }
  const codex = extractTurnUsage({ kind: 'native-transcript', transcriptFormat: 'codex-rollout' }, jsonl([
    event('one-response', 'exact-turn', 'token_count', { info: { last_token_usage: { input_tokens: 2, output_tokens: 5, total_tokens: 7 }, model_context_window: 100 } })]), 1234)
  expect(codex).toEqual({ ...sample, scope: 'response', context: { usedTokens: 7, capacityTokens: 100 } })
  expect(extractTurnUsage({ kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }, jsonl([
    { type: 'assistant', message: { usage: { input_tokens: 2, output_tokens: 5 } } }]), 1234)).toEqual({ ...sample, scope: 'response' })
  expect(parseTurnUsage(sample)).toEqual(sample)
  expect(parseTurnUsage({ ...sample, scope: 'response' })).toEqual({ ...sample, scope: 'response' })
  const f = await fixture('codex')
  expect(normalizeAgentSession({ ...f.session, turnUsage: sample }).turnUsage).toEqual(sample)
  expect(normalizeAgentSession({ ...f.session, turnUsage: codex }).turnUsage).toEqual(codex)
  const store = new AgentMuxFileAgentSessionStore(join(f.root, 'scoped-usage.json'))
  await store.compareAndSwap(null, { ...f.session, turnUsage: codex! })
  expect(normalizeAgentSession((await store.load())[0]).turnUsage).toEqual(codex)
  await f.unchanged()
})
