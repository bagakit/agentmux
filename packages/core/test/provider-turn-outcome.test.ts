import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, projectConversationWindow, type AgentConversationReadPage } from '../src/conversation.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import { normalizeSessionHistoryPage } from '../src/session-history.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const failure = { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' }
const event = (turn: string, ordinal: number, type: string, extra = {}) => ({ type: 'event_msg', ordinal,
  payload: { type, turn_id: turn, ...extra } })
async function fixture(rows: unknown[]) {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, ...rows]))
  closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  return { ...f, rpc, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}
function reading(page: AgentConversationReadPage) {
  const result = consumeConversationWindowPage(page)
  expect(result.kind).toBe('complete')
  if (result.kind !== 'complete') throw Error('The bounded test window must be complete')
  return { snapshot: result.snapshot, records: projectConversationWindow(result.snapshot).records }
}
it('delivers the same failed native turn through evidence, history, RPC conversation and deferred exact reading', async () => {
  const f = await fixture([event('original-turn', 1, 'task_complete', { error: failure, duration_ms: 37 })])
  const evidence = await readCodexPromptExecutionEvidence({ args: [], workspacePath: f.root,
    nativeHandle: f.session.nativeHandle!, signal: new AbortController().signal })
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items).toHaveLength(1)
  const item = page.items[0]!
  expect(item.turnOutcome).toEqual({ status: 'failed', failure: evidence!.failure })
  expect(item.metrics).toEqual({ scope: 'turn', durationMs: 37 })
  expect(evidence!.nativeRecordId).toBe(item.id)
  expect(evidence!.failure).toMatchObject({ code: 'AGENT_MODEL_OVERLOADED', nativeCode: 'server_overloaded', nativeTurnId: 'original-turn' })
  expect(evidence!.failure).not.toHaveProperty('httpStatusCode')
  const rawHistory = await f.rpc.call('agent.history', { ...f.ref, source: 'native' })
  expect(rawHistory.items).toContainEqual({ kind: 'item', item })
  const read = reading(await f.rpc.call('agent.conversation.inspect', { ...f.ref, processDetails: 'deferred' }))
  expect(read.records).toHaveLength(1)
  const record = read.records[0]!
  expect(record.original).toMatchObject({ kind: 'deferred', item: { kind: 'native', item: { turnOutcome: item.turnOutcome } } })
  const unit = read.snapshot.units[0]!
  const exact = reading(await f.rpc.call('agent.conversation.inspect', { ...f.ref, anchor: {
    record: unit.records[0]!.reference, revision: unit.records[0]!.revision, frontier: read.snapshot.window.checkpoint } }))
  expect(exact.records[0]!.original).toMatchObject({ kind: 'native', item: { turnOutcome: item.turnOutcome } })
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('keeps failure followed by a new turn in changes, and distinguishes unknown native errors and abort reasons', async () => {
  const f = await fixture([])
  const first = reading(await f.rpc.call('agent.conversation.inspect', f.ref))
  await appendFile(f.path, jsonl([
    event('failed', 1, 'task_complete', { error: failure }), event('next', 2, 'task_started'),
    event('unknown-error', 3, 'task_complete', { error: { message: 'Private diagnostic', code: 'future_native_error' } }),
    event('interrupted', 4, 'turn_aborted', { reason: 'interrupted' }),
    event('unknown-abort', 5, 'turn_aborted', { reason: 'future_reason' }),
    event('child', 6, 'task_complete', { thread_id: 'another-native-source', error: failure }),
    event('complete', 7, 'task_complete')
  ]))
  const next = reading(await f.rpc.call('agent.conversation.changes', { ...f.ref, checkpoint: first.snapshot.window.checkpoint,
    view: first.snapshot.window.view!, limit: 30 }))
  const items = next.records.flatMap(record => record.original.kind === 'native' ? [record.original.item] : [])
  const outcomes = new Map(items.map(item => [item.turnId, item.turnOutcome]))
  expect(outcomes.get('failed')).toMatchObject({ status: 'failed', failure: { code: 'AGENT_MODEL_OVERLOADED' } })
  expect(outcomes.get('unknown-error')).toMatchObject({ status: 'failed', failure: { code: 'AGENT_PROVIDER_ERROR', nativeCode: 'future_native_error' } })
  expect(outcomes.get('unknown-error')).not.toHaveProperty('failure.publicMessage')
  expect(outcomes.get('interrupted')).toEqual({ status: 'interrupted' })
  expect(outcomes.get('unknown-abort')).toBeUndefined()
  expect(outcomes.get('child')).toBeUndefined()
  expect(outcomes.get('complete')).toEqual({ status: 'completed' })
})
it('keeps original reading with a diagnostic when optional outcome identity is malformed', () => {
  const source = { providerId: 'custom', nativeSessionId: 'native-source' }
  const original = { id: 'original', kind: 'activity', turnId: 'actual-turn', contentParts: [{ kind: 'text', text: 'Original bytes' }],
    turnOutcome: { status: 'failed', failure: { code: 'REPORTED_ERROR', message: 'Reported failure', recovery: 'Inspect original', nativeTurnId: 'wrong-turn' } } }
  const page = normalizeSessionHistoryPage(source, { source, items: [original], nextCursor: null }, 1)
  expect(page.items[0]).toMatchObject({ id: 'original', contentParts: original.contentParts,
    turnOutcomeDiagnostic: { code: 'NATIVE_TURN_OUTCOME_UNCONFIRMED' } })
  expect(page.items[0]).not.toHaveProperty('turnOutcome')
})
