import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { fixtureEpoch } from './helpers/fixture-values.js'
import { normalizeSessionHistoryPage } from '../src/session-history.js'
import { projectConversationRecords, consumeConversationWindowPage, parseConversationUnit } from '../src/conversation.js'
import { readCodexSavedSessionHistoryRecord } from '../src/providers/codex-saved-history.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxError } from '../src/errors.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentSessionHistoryItem, AgentSessionHistoryCollaboration } from '../src/types.js'

const source = { providerId: 'codex', nativeSessionId: 'original-native-thread' }
const at = fixtureEpoch(2, 3, 4)
const sender = '/root/independent_review', recipient = '/root'
const body = 'Sender: misleading-display-author\n\nThe original collaboration report.'
const report = (id = 'original-agent-message', attribution: Record<string, unknown> = {}) => ({
  type: 'response_item', timestamp: new Date(at).toISOString(), payload: { type: 'agent_message', id,
    author: sender, recipient, content: [{ type: 'input_text', text: body }],
    internal_chat_message_metadata_passthrough: { turn_id: 'original-native-turn' }, ...attribution }
})
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(rows: unknown[] = [report()]) {
  const f = await nativeHistoryFixture('codex', root => jsonl([
    { type: 'session_meta', payload: { id: source.nativeSessionId, cwd: root, history_mode: 'paginated' } }, ...rows
  ]), { nativeSessionId: source.nativeSessionId })
  closes.push(f.close)
  return { ...f, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}
function expected(id = 'original-agent-message'): AgentSessionHistoryItem {
  return { id, kind: 'activity', title: 'agent_message', turnId: 'original-native-turn', startedAt: at,
    collaboration: { kind: 'message', source, sender, recipient },
    contentParts: [{ kind: 'text', text: body, contentEligibility: 'public' }] }
}
function units(page: Parameters<typeof consumeConversationWindowPage>[0]) {
  const value = consumeConversationWindowPage(page)
  expect(value.kind).toBe('complete')
  if (value.kind !== 'complete') throw Error('The bounded fixture must form complete original units')
  return value.snapshot.units
}

it('preserves native message identity, participants, turn and original parts through SDK and exact reads', async () => {
  const f = await fixture([report('first'), report('second', { content: [
    { type: 'input_text', text: body }, { type: 'encrypted_content', encrypted_content: 'original-opaque-payload' }
  ] })])
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId)
  expect(page.items[0]).toEqual(expected('first'))
  expect(page.items[1]).toMatchObject({ ...expected('second'), contentParts: [expected().contentParts[0],
    { kind: 'text', text: JSON.stringify({ type: 'encrypted_content', encrypted_content: 'original-opaque-payload' }), contentEligibility: 'unconfirmed' }] })
  const exact = await readCodexSavedSessionHistoryRecord({ source, recordId: 'first', turnId: 'original-native-turn',
    transcriptPath: f.path, workspacePath: f.root, command: 'unused', args: [], env: {}, signal: new AbortController().signal })
  expect(exact).toEqual(page.items[0])
  const reading = projectConversationRecords({ agentSessionId: f.ref.agentSessionId, executionHostId: f.ref.hostId, historyPage: page })
  expect(reading.map(record => [record.rawId, record.role, record.author])).toEqual([
    ['first', 'message', { kind: 'unknown' }], ['second', 'message', { kind: 'unknown' }]
  ])
  expect(await f.bytes()).toEqual(f.before)
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('preserves malformed optional native attribution as original readable content without guessing authors', async () => {
  const bad = { author: { unexpected: 'native actor shape' }, recipient: null }
  const f = await fixture([report('malformed', bad), report('absent', { author: undefined, recipient: undefined })])
  const page = await f.client.sessionHistoryPage(f.ref.agentSessionId)
  expect(page.items[0]).toMatchObject({ id: 'malformed', collaboration: { kind: 'message', source },
    conversationDiagnostic: { code: 'NATIVE_COLLABORATION_ATTRIBUTION_UNCONFIRMED' },
    contentParts: [expected().contentParts[0], { kind: 'text', text: JSON.stringify(bad), contentEligibility: 'unconfirmed' }] })
  expect(page.items[0]!.collaboration).not.toHaveProperty('sender')
  expect(page.items[0]!.collaboration).not.toHaveProperty('recipient')
  expect(page.items[1]).toMatchObject({ collaboration: { kind: 'message', source }, contentParts: expected().contentParts })
  expect(page.items[1]).not.toHaveProperty('conversationDiagnostic')
  const accepted = units(await f.client.readAgentConversation(f.ref))
  expect(accepted.map(unit => [unit.event.role, unit.event.author])).toEqual([
    ['message', { kind: 'unknown' }], ['message', { kind: 'unknown' }]
  ])
  expect(await readFile(f.path)).toEqual(f.before.native)
})

it('normalizes only exact source-scoped actor facts and keeps optional metadata failures readable', () => {
  const original: AgentSessionHistoryItem = { id: 'typed-native-message', kind: 'activity', contentParts: expected().contentParts }
  for (const attribution of [
    { kind: 'message', source: { ...source, nativeSessionId: 'foreign-thread' }, sender, recipient },
    { kind: 'message', source, sender: { forged: 'actor' }, recipient: '' },
    { kind: 'message', source: { ...source, authority: true }, sender, recipient }
  ]) {
    const normalized = normalizeSessionHistoryPage(source, { source, items: [{ ...original, collaboration: attribution }], nextCursor: null }, 1)
    expect(normalized.items[0]).toEqual({ ...original, collaboration: { kind: 'message', source },
      conversationDiagnostic: { code: 'NATIVE_COLLABORATION_ATTRIBUTION_UNCONFIRMED', message: expect.any(String), original: attribution } })
    expect(normalizeSessionHistoryPage(source, normalized, 1)).toEqual(normalized)
  }
  const exact: AgentSessionHistoryCollaboration = { kind: 'message', source, sender, recipient }
  expect(normalizeSessionHistoryPage(source, { source, items: [{ ...original, collaboration: exact }], nextCursor: null }, 1).items[0])
    .toEqual({ ...original, collaboration: exact })
})

it.each(['codex', 'claude'] as const)('keeps unassociated Stop copies and exact contributions distinct for %s protocol', async providerId => {
  const f = providerId === 'codex' ? await fixture([{ type: 'response_item', payload: { type: 'message', id: 'native-reply', role: 'assistant',
    phase: 'final_answer', content: [{ type: 'output_text', text: body }] } }]) : await (async () => {
    const original = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', sessionId: 'native-main', uuid: 'native-reply',
      message: { role: 'assistant', content: [{ type: 'text', text: body }] } }]))
    closes.push(original.close)
    return { ...original, ref: { hostId: 'local', agentSessionId: original.session.agentSessionId } }
  })()
  for (const [id, eventName] of [['stop-copy', 'Stop'], ['child-copy', 'SubagentStop']] as const) await f.store.applyTimelineMutation({
    type: 'append', agentSessionId: f.ref.agentSessionId, item: { id, kind: 'assistant_message', status: 'complete', source: 'native-hook',
      title: 'Original response snapshot', agentSessionId: f.ref.agentSessionId, content: body, eventName, createdAt: at, updatedAt: at }
  })
  const before = units(await f.client.readAgentConversation(f.ref))
  expect(before).toHaveLength(3)
  expect(before.filter(unit => unit.event.role === 'observation')).toHaveLength(2)
  expect(before.flatMap(unit => unit.event.relations).filter(relation => relation.kind === 'same-event')).toEqual([])
  const nativeSource = (await f.client.sessionHistoryPage(f.ref.agentSessionId)).source
  const original = (await f.client.sessionTimeline(f.ref.agentSessionId)).items.find(item => item.id === 'stop-copy')!
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.ref.agentSessionId, item: { ...original,
    conversation: { sameEvent: { ...f.ref, source: { kind: 'native', ...nativeSource, recordId: 'native-reply' } } } } })
  const after = units(await f.client.readAgentConversation(f.ref))
  expect(after).toHaveLength(2)
  const sameEvent = after.find(unit => unit.records.length === 2)!
  expect(sameEvent.event.content.filter(slot => slot.placement === 'body')).toHaveLength(1)
  expect(sameEvent.records.map(record => record.original.item.id).sort()).toEqual(['native-reply', 'stop-copy'])
  expect(after.find(unit => unit.records[0]!.original.item.id === 'child-copy')!.event.role).toBe('observation')
  expect(f.controls.every(control => !control.mock.calls.length)).toBe(true)
})

it('carries collaboration through real RPC, Hosted SDK, compiled CLI and source changes without operating a Run', async () => {
  const f = await fixture()
  f.controls[5]!.mockRejectedValue(new AgentMuxError('The original fixture Run has no current Runtime observation.', 'CTXMUX_DISCONNECTED'))
  vi.spyOn(f.client, 'connect').mockRejectedValue(new AgentMuxError('The private fixture has no Runtime; original history remains readable.', 'CTXMUX_DISCONNECTED'))
  vi.spyOn(f.client, 'statusAgent').mockRejectedValue(new AgentMuxError('The private fixture has no current Runtime observation.', 'CTXMUX_DISCONNECTED'))
  vi.spyOn(f.client, 'runtimeDiagnostics').mockRejectedValue(new AgentMuxError('The private fixture has no Runtime diagnostics.', 'CTXMUX_DISCONNECTED'))
  const hostedOwner = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner',
    protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null }))
  closes.push(() => hostedOwner.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), hostedRuntime: () => hostedOwner,
    coreClients: () => [{ hostId: 'local', client: f.client }], http: { host: '127.0.0.1', port: 0, token: 'private-collaboration-read' } })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-collaboration-read' } })
  closes.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); closes.push(() => hosted.dispose())
  expect((await hosted.sessionHistoryPage(f.ref.agentSessionId)).items).toEqual([expected()])
  const page = await rpc.call('agent.conversation.inspect', f.ref)
  const accepted = units(page)
  expect(accepted[0]!.records[0]!.original.item).toEqual(expected())
  expect(accepted[0]!.event).toMatchObject({ role: 'message', author: { kind: 'unknown' } })
  const forged = structuredClone(accepted[0]!)
  const raw = forged.records[0]!.original.item as AgentSessionHistoryItem
  raw.collaboration = { kind: 'message', source: { ...source, nativeSessionId: 'another-source' }, sender, recipient }
  expect(() => parseConversationUnit(forged, f.ref, page.scope)).toThrow()
  const env = objectCliEnvironment(f.root)
  for (const command of [['agent', 'history', '--source', 'native'], ['agent', 'conversation', 'inspect']]) {
    const result = await runCompiledObjectCli([...command, '--host', f.ref.hostId, '--session', f.ref.agentSessionId], env)
    expect(result.code, result.stderr).toBe(0)
    const read = JSON.parse(result.stdout)
    expect(read.ok).toBe(true)
    const item = command[1] === 'history' ? read.result.items[0].item : read.result.items[0].item.records[0].original.item
    expect(item).toEqual(expected())
    if (command[1] === 'conversation') expect(read.result.items[0].item.event).toMatchObject({ role: 'message', author: { kind: 'unknown' } })
  }
  const context = await runCompiledObjectCli(['agent', 'context', '--host', f.ref.hostId, '--session', f.ref.agentSessionId], env)
  expect(context.code, context.stderr).toBe(0)
  expect(JSON.parse(context.stdout).result.native.items).toEqual([expected()])
  const checkpoint = await runCompiledObjectCli(['agent', 'conversation', 'checkpoint', '--host', f.ref.hostId, '--session', f.ref.agentSessionId], env)
  expect(checkpoint.code, checkpoint.stderr).toBe(0)
  const observed: unknown[] = [], watch = await hosted.observeConversation(f.ref, event => observed.push(event))
  await appendFile(f.path, jsonl([report('appended-native-message')]))
  await vi.waitFor(() => expect(observed).toContainEqual(expect.objectContaining({ kind: 'invalidated', source: { kind: 'native', ...source } })))
  watch.dispose()
  const changed = await runCompiledObjectCli(['agent', 'conversation', 'changes', '--input', '-'], env,
    JSON.stringify({ ...f.ref, checkpoint: JSON.parse(checkpoint.stdout).result.checkpoint }))
  expect(changed.code, changed.stderr).toBe(0)
  const delta = JSON.parse(changed.stdout).result
  expect(delta.items).toHaveLength(1)
  expect(delta.items[0].item.records[0].original.item).toEqual(expected('appended-native-message'))
  expect(delta.items[0].item.event).toMatchObject({ role: 'message', author: { kind: 'unknown' } })
  expect(f.controls.slice(0, 5).map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
  for (const [runId] of f.controls[5]!.mock.calls) expect(runId).toBe(f.session.run.runId)
  expect(await f.store.readMetadata(f.ref.agentSessionId)).toEqual(f.session)
}, 30_000)
