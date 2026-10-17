import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxError } from '../src/errors.js'
import { consumeConversationWindowPage, type ConversationWindowSnapshot, type ConversationWindowAssembly, type ConversationChangesInput } from '../src/conversation.js'
import { conversationReaderCli } from './helpers/conversation-reader-cli.js'
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { const errors: unknown[] = []; for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }; vi.restoreAllMocks(); if (errors.length) throw new AggregateError(errors, 'Private isolation cleanup failed') })
const native = (id: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: id } })
async function fixture() {
  const f = await nativeHistoryFixture('claude', jsonl([native('retained-native')])); closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  return { ...f, rpc, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const captured = (f: Fixture, id: string) => f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
  item: { id, agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: id, content: id, createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1) } })
async function frame(f: Fixture, previous?: ConversationWindowSnapshot) {
  let assembly: ConversationWindowAssembly | undefined, cursor: string | undefined
  for (let count = 0; count < 40; count++) {
    const page = previous ? await f.rpc.call('agent.conversation.changes', { ...f.ref, view: previous.window.view!, checkpoint: previous.window.checkpoint, ...(cursor ? { cursor } : {}), maxBytes: 64 * 1024 })
      : await f.rpc.call('agent.conversation.inspect', { ...f.ref, ...(cursor ? { cursor } : {}), maxBytes: 64 * 1024 })
    const consumed = consumeConversationWindowPage(page, assembly)
    if (consumed.kind === 'complete') return consumed.snapshot
    assembly = consumed.pending; expect(page.nextCursor).toBeTruthy(); cursor = page.nextCursor!
  }
  throw Error('The exact original frame must complete')
}
async function availableFrame(f: Fixture, before: ConversationWindowSnapshot) {
  const result = await frame(f, before).then(snapshot => ({ snapshot, error: null }), error => ({ snapshot: null, error: error.code ?? String(error) }))
  expect(result.error, 'An accepted source failure cannot suppress the independent healthy source').toBeNull()
  return result.snapshot!
}
const ids = (snapshot: ConversationWindowSnapshot) => snapshot.units.flatMap(unit => unit.records.map(record => record.original.item.id))
const cut = (snapshot: ConversationWindowSnapshot, kind: 'native' | 'captured') => snapshot.window.checkpoint.frontier.cuts.find(cut => cut.kind === kind)
const untouched = (f: Fixture) => expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
it('a rejected native primitive keeps its exact cut and body while actual captured progress reaches public RPC and the compiled CLI', async () => {
  const f = await fixture(), before = await frame(f)
  await writeFile(f.path, jsonl([native('replacement-source-bytes')]))
  await captured(f, 'independent-captured-progress')
  const after = await availableFrame(f, before)
  expect(ids(after)).toEqual(expect.arrayContaining(['retained-native', 'independent-captured-progress']))
  expect(ids(after)).not.toContain('replacement-source-bytes'); expect(cut(after, 'native')).toEqual(cut(before, 'native'))
  expect(cut(after, 'captured')).not.toEqual(cut(before, 'captured'))
  expect(after.coverage.find(source => source.source.kind === 'native')).toMatchObject({ current: 'unavailable', gaps: [expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })] })
  expect(after.coverage.find(source => source.source.kind === 'captured')!.current).toBe('complete-through-cut')
  const cli = await conversationReaderCli(f.root); closes.push(cli.close)
  const result = await cli.run(['agent', 'conversation', 'changes', '--input', '-'], JSON.stringify({ ...f.ref, view: after.window.view!, checkpoint: after.window.checkpoint, maxBytes: 4 * 1024 * 1024 }))
  expect(result.code, result.stderr).toBe(0)
  const parsed = consumeConversationWindowPage(JSON.parse(result.stdout).result); expect(parsed.kind).toBe('complete')
  if (parsed.kind === 'complete') { expect(ids(parsed.snapshot)).toEqual(ids(after)); expect(cut(parsed.snapshot, 'native')).toEqual(cut(before, 'native')); expect(parsed.snapshot.coverage.find(source => source.source.kind === 'native')!.current).toBe('unavailable') }
  untouched(f)
})
it.each(['refusal', 'epoch', 'future', 'range', 'foreign-current', 'foreign-page', 'unordered', 'changed-position', 'within-batch-position'] as const)('a captured %s failure keeps its exact cut and originals while native progress remains readable', async mode => {
  const f = await fixture(); await captured(f, 'retained-captured'); const before = await frame(f)
  if (mode === 'range' || mode === 'foreign-page' || mode === 'unordered') await captured(f, 'unqualified-captured-row')
  if (mode === 'unordered') await captured(f, 'unqualified-captured-row-second')
  if (mode === 'within-batch-position') {
    await captured(f, 'same-batch-original')
    await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.session.agentSessionId, item: { id: 'same-batch-original', agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Changed original', content: 'Unqualified changed batch position', createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 2) } })
  }
  if (mode === 'changed-position') await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: f.session.agentSessionId, item: { id: 'retained-captured', agentSessionId: f.session.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Changed original', content: 'Unqualified changed source position', createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 2) } })
  await appendFile(f.path, jsonl([native('independent-native-progress')]))
  const read = f.store.readCapturedHistory.bind(f.store)
  const leaf = vi.spyOn(f.store, 'readCapturedHistory').mockImplementation(async (...args) => {
    const page = await read(...args)
    if (mode === 'refusal') throw new AgentMuxError('The exact captured primitive refused its original cut.', 'CONTROL_PROTOCOL_ERROR')
    if (mode === 'epoch') return { ...page, stream: { ...page.stream, epoch: 'different-original-epoch' } }
    if (mode === 'future') return { ...page, stream: { ...page.stream, sequence: 0 } }
    if (mode === 'foreign-current' && args[1]?.afterSequence === undefined) return { ...page, agentSessionId: 'foreign-current-source' }
    if (args[1]?.afterSequence !== undefined) {
      if (mode === 'range') throw new AgentMuxError('The exact captured range is unavailable.', 'AGENT_CONVERSATION_CAPTURED_GAP')
      if (mode === 'foreign-page') return { ...page, agentSessionId: 'foreign-page-source' }
      if (mode === 'unordered') return { ...page, records: [...page.records].reverse() }
      if (mode === 'within-batch-position') { expect(page.records).toHaveLength(2); return { ...page, records: page.records.map((record, index) => ({ ...record, firstSequence: record.firstSequence + index })) } }
      if (mode === 'changed-position') return { ...page, records: page.records.map(record => ({ ...record, firstSequence: record.firstSequence + 1 })) }
    }
    return page
  })
  const after = await availableFrame(f, before)
  expect(ids(after)).toEqual(expect.arrayContaining(['retained-native', 'retained-captured', 'independent-native-progress']))
  expect(ids(after)).not.toContain('unqualified-captured-row'); expect(ids(after)).not.toContain('unqualified-captured-row-second'); expect(ids(after)).not.toContain('same-batch-original')
  expect(cut(after, 'captured'), 'A failed source cannot advance its frontier').toEqual(cut(before, 'captured')); expect(cut(after, 'native')).not.toEqual(cut(before, 'native'))
  expect(after.coverage.find(source => source.source.kind === 'captured')!.current).toBe('unavailable'); expect(after.coverage.find(source => source.source.kind === 'captured')!.gaps.length).toBeGreaterThan(0)
  expect(after.scope).toEqual(before.scope)
  if (mode === 'refusal') {
    const cli = await conversationReaderCli(f.root); closes.push(cli.close)
    const result = await cli.run(['agent', 'conversation', 'changes', '--input', '-'], JSON.stringify({ ...f.ref, view: after.window.view!, checkpoint: after.window.checkpoint, maxBytes: 4 * 1024 * 1024 }))
    expect(result.code, result.stderr).toBe(0)
    const parsed = consumeConversationWindowPage(JSON.parse(result.stdout).result); expect(parsed.kind).toBe('complete')
    if (parsed.kind === 'complete') { expect(ids(parsed.snapshot)).toEqual(ids(after)); expect(cut(parsed.snapshot, 'captured')).toEqual(cut(before, 'captured')); expect(parsed.snapshot.coverage.find(source => source.source.kind === 'captured')!.current).toBe('unavailable') }
  }
  leaf.mockRestore(); untouched(f)
})
it('foreign whole-input scope and modified signed view intent still reject before either source primitive runs', async () => {
  const f = await fixture(), before = await frame(f)
  const nativeRead = vi.spyOn(f.client, 'readSessionHistoryChanges'), capturedRead = vi.spyOn(f.store, 'readCapturedHistory')
  const input: ConversationChangesInput = { ...f.ref, view: before.window.view!, checkpoint: before.window.checkpoint }
  for (const changed of [{ ...input, agentSessionId: 'foreign-session' }, { ...input, view: input.view!.slice(0, -1) + (input.view!.endsWith('A') ? 'B' : 'A') },
    { ...input, checkpoint: { ...input.checkpoint, frontier: { ...input.checkpoint.frontier, cuts: input.checkpoint.frontier.cuts.map(cut => cut.kind === 'captured' ? { ...cut, sequence: cut.sequence + 1 } : cut) } } }]) {
    await expect(f.rpc.call('agent.conversation.changes', changed)).rejects.toBeTruthy()
  }
  expect(nativeRead).not.toHaveBeenCalled(); expect(capturedRead).not.toHaveBeenCalled(); untouched(f)
})

it('a foreign result from an accurately selected native primitive is isolated before any of its rows or cut are admitted', async () => {
  const f = await fixture(), before = await frame(f), original = f.client.readSessionHistoryChanges.bind(f.client)
  vi.spyOn(f.client, 'readSessionHistoryChanges').mockImplementation(async (...args) => {
    const result = await original(...args)
    return { ...result, agentSessionId: 'foreign-native-result', items: [{ id: 'unqualified-native-row', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Unqualified source body' }] }] }
  })
  await captured(f, 'captured-with-rejected-native-result')
  const after = await availableFrame(f, before)
  expect(ids(after)).toEqual(expect.arrayContaining(['retained-native', 'captured-with-rejected-native-result']))
  expect(ids(after)).not.toContain('unqualified-native-row'); expect(cut(after, 'native')).toEqual(cut(before, 'native'))
  expect(after.coverage.find(source => source.source.kind === 'native')!.current).toBe('unavailable'); untouched(f)
})
