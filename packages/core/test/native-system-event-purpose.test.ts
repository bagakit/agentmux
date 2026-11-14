import { appendFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { normalizeSessionHistoryPage } from '../src/session-history.js'
import { consumeConversationWindowPage, parseConversationReadPage, parseConversationChangesPage,
  type ConversationTimelineReadInput, type ConversationWindowAssembly } from '../src/conversation.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import type { AgentSessionHistoryItem } from '../src/types.js'

const source = { providerId: 'codex' as const, nativeSessionId: 'native-main' }
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Original private read cleanup failed')
})
const event = (id: string, type: string, extra: object = {}) => ({ type: 'event_msg', payload: { id, type, turn_id: 'original-turn', ...extra } })
const usage = (id: string) => ({ type: 'token_usage_record', payload: { id, thread_id: source.nativeSessionId,
  turn_id: 'original-turn', turn_token_usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } })
const rows = [
  { type: 'response_item', payload: { id: 'user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'token_usage_record task_complete agent_state' }] } },
  { type: 'response_item', payload: { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original public reply.' }] } },
  { type: 'response_item', payload: { id: 'tool', type: 'function_call', name: 'agent_state', call_id: 'original-call', arguments: '{"type":"task_complete"}' } },
  { type: 'response_item', payload: { id: 'result', type: 'function_call_output', call_id: 'original-call', output: '{"type":"token_usage_record","recordPurpose":"system-event"}' } },
  { type: 'response_item', payload: { id: 'reasoning', type: 'reasoning', summary: [{ type: 'summary_text', text: 'task_complete is ordinary reasoning text here.' }] } },
  event('unknown-agent-state', 'agent_state', { state: 'running', recordPurpose: 'system-event' }),
  { type: 'future_activity', payload: { id: 'future', type: 'task_complete', recordPurpose: 'system-event', text: 'Unknown outer record format.' } },
  usage('usage'), event('started', 'task_started'), event('completed', 'task_complete', { duration_ms: 20 }),
  event('interrupted', 'turn_aborted', { reason: 'interrupted' })
]
const systemIds = ['completed', 'interrupted', 'started', 'usage']
const purposes = (items: readonly { id: string; recordPurpose?: unknown }[]) => items.filter(item => item.recordPurpose === 'system-event').map(item => item.id).sort()

it.each([undefined, 'future-purpose', { kind: 'system-event' }])('keeps unsupported optional purpose %j readable without classifying it', purpose => {
  const original = { id: 'original', kind: 'activity', recordPurpose: purpose, contentParts: [{ kind: 'text', text: 'Complete original body.' }] }
  const page = normalizeSessionHistoryPage(source, { source, items: [original], nextCursor: null }, 1)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toEqual({ id: original.id, kind: original.kind, contentParts: original.contentParts })
})

it('preserves Provider system-event purpose through nonempty public history, deferred detail, changes and source CLI reads', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: root } }, ...rows]))
  closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const history = await rpc.call('agent.history', { ...ref, source: 'native', limit: 100, maxBytes: 128 * 1024 })
  const items = history.items.flatMap(entry => entry.kind === 'item' ? [entry.item as AgentSessionHistoryItem] : [])
  expect(items).toHaveLength(rows.length)
  expect(purposes(items)).toEqual(systemIds)
  const byId = new Map(items.map(item => [item.id, item]))
  expect(byId.get('unknown-agent-state')).toMatchObject({ kind: 'activity', contentParts: [{ kind: 'text', text: JSON.stringify(rows[5]!.payload) }] })
  expect(byId.get('unknown-agent-state')?.recordPurpose).toBeUndefined()
  expect(byId.get('tool')).toMatchObject({ kind: 'activity', contentParts: [{ kind: 'tool-call', name: 'agent_state', input: '{"type":"task_complete"}', callId: 'original-call' }] })
  expect(byId.get('result')?.contentParts[0]).toMatchObject({ kind: 'tool-result', output: '{"type":"token_usage_record","recordPurpose":"system-event"}' })
  expect(byId.get('usage')).toMatchObject({ kind: 'activity', metrics: { scope: 'turn', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } })
  expect(byId.get('completed')).toMatchObject({ kind: 'activity', turnOutcome: { status: 'completed' }, metrics: { scope: 'turn', durationMs: 20 } })
  expect(byId.get('interrupted')).toMatchObject({ kind: 'activity', turnOutcome: { status: 'interrupted' } })
  async function read(input: Omit<ConversationTimelineReadInput, 'hostId' | 'agentSessionId'> = {}) {
    let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
    for (let index = 0; index < 100; index++) {
      const request = { ...ref, limit: 100, maxBytes: 1048576, ...input, ...(cursor ? { cursor } : {}) }
      const page = await rpc.call('agent.conversation.inspect', request)
      expect(parseConversationReadPage(page, request)).toEqual(page)
      const result = consumeConversationWindowPage(page, pending)
      if (result.kind === 'complete') return result.snapshot
      pending = result.pending; cursor = page.nextCursor!
    }
    throw Error('Public conversation did not complete in its bounded original window')
  }
  const full = await read(), deferred = await read({ processDetails: 'deferred' })
  const originals = full.units.flatMap(unit => unit.records), summaries = deferred.units.flatMap(unit => unit.records)
  expect(originals).toHaveLength(rows.length)
  expect(summaries).toHaveLength(rows.length)
  expect(purposes(originals.flatMap(record => record.original.kind === 'native' ? [record.original.item] : []))).toEqual(systemIds)
  expect(purposes(summaries.flatMap(record => record.original.kind === 'deferred' && record.original.item.kind === 'native' ? [record.original.item.item] : []))).toEqual(systemIds)
  for (const id of systemIds) {
    const summary = summaries.find(record => record.reference!.source.recordId === id)!
    const original = originals.find(record => record.id === summary.id)!
    expect(summary.original.kind).toBe('deferred')
    expect(summary.reference).toEqual(original.reference)
    expect(summary.revision).toBe(original.revision)
    expect(full.units.find(unit => unit.records.includes(original))!.event.role).toBe('process')
    expect(full.units.find(unit => unit.records.includes(original))!.event.author).toEqual({ kind: 'unknown' })
    const detail = await read({ anchor: { record: summary.reference!, revision: summary.revision, frontier: deferred.window.checkpoint } })
    expect(detail.units.flatMap(unit => unit.records).find(record => record.id === original.id)?.original).toEqual(original.original)
  }
  const loader = new URL('./fixtures/hook-delivery/source-loader.mjs', import.meta.url)
  const environment = objectCliEnvironment(f.root, { AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED: process.env.AGENTMUX_SYSTEM_EVENT_CLI_LOADED })
  const cliHistory = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'history', '--host', 'local', '--session', ref.agentSessionId, '--source', 'native', '--limit', '100', '--max-bytes', '131072'], environment, '', 15000, loader)
  expect(cliHistory.code, cliHistory.stderr).toBe(0)
  expect(purposes(JSON.parse(cliHistory.stdout).result.items.map((entry: { item: { id: string; recordPurpose?: unknown } }) => entry.item))).toEqual(systemIds)
  const cliDeferred = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'conversation', 'inspect', '--input', '-'], environment,
    JSON.stringify({ ...ref, limit: 100, maxBytes: 1048576, processDetails: 'deferred' }), 15000, loader)
  expect(cliDeferred.code, cliDeferred.stderr).toBe(0)
  const cliUnits = JSON.parse(cliDeferred.stdout).result.items.map((entry: { item: { records: unknown[] } }) => entry.item)
  expect(purposes(cliUnits.flatMap((unit: { records: any[] }) => unit.records.flatMap(record => record.original.kind === 'deferred' && record.original.item.kind === 'native' ? [record.original.item.item] : [])))).toEqual(systemIds)
  await appendFile(f.path, jsonl([usage('later-usage')]))
  const input = { ...ref, checkpoint: deferred.window.checkpoint, view: deferred.window.view!, limit: 100, maxBytes: 1048576, processDetails: 'deferred' as const }
  const changes = await rpc.call('agent.conversation.changes', input)
  expect(parseConversationChangesPage(changes, input)).toEqual(changes)
  const changed = changes.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : [])
  expect(changed.some(record => record.reference!.source.recordId === 'later-usage' && record.original.kind === 'deferred' && record.original.item.kind === 'native' && record.original.item.item.recordPurpose === 'system-event')).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  if (process.env.AGENTMUX_SYSTEM_EVENT_FACTS) appendFileSync(process.env.AGENTMUX_SYSTEM_EVENT_FACTS, JSON.stringify({
    provider: 'codex', protocol: 'original saved JSONL outer token_usage_record and event_msg turn boundaries',
    historyRecordIds: items.map(item => item.id), systemIds, fullRecordCount: originals.length, deferredRecordCount: summaries.length,
    changedRecordIds: changed.map(record => record.reference!.source.recordId), unknownAgentStateReadable: true,
    publicMethods: ['agent.history', 'agent.conversation.inspect', 'agent.conversation.changes'], sourceCliExitCodes: [cliHistory.code, cliDeferred.code],
    runtimeControlCalls: f.controls.flatMap(control => control.mock.calls) }) + '\n')
}, 30000)
