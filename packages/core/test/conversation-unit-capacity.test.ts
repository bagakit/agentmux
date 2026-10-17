import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, parseConversationReadPage, parseConversationUnit, projectConversationTimeline, conversationRecordId,
  type AgentConversationReadPage, type ConversationWindowAssembly, type ConversationUnit, type ConversationTimelineReadInput, type ConversationSourceOrder } from '../src/conversation.js'
import type { AgentTimelineItem } from '../src/types.js'
import { conversationReaderCli } from './helpers/conversation-reader-cli.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const native = (id: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: 'Original native ' + id } })
async function fixture(ids = ['canonical']) {
  const f = await nativeHistoryFixture('claude', jsonl(ids.map(native))); closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  return { ...f, rpc, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const contribution = (f: Fixture, index: number, target = 'canonical'): AgentTimelineItem => ({ id: 'contribution-' + index, agentSessionId: f.session.agentSessionId,
  kind: 'tool_call', source: 'native-hook', status: 'complete', title: 'Original contribution', content: 'Complete original detail ' + index, createdAt: _followupFixtureEpoch(0, 0, 1), updatedAt: _followupFixtureEpoch(0, 0, 1),
  conversation: { sameEvent: { ...f.ref, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: target } } } })
async function seed(f: Fixture, count: number) {
  for (let index = 0; index < count; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: contribution(f, index) })
}
async function frame(f: Fixture, input: ConversationTimelineReadInput) {
  const pages: AgentConversationReadPage[] = []; let assembly: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let count = 0; count < 80; count++) {
    const request = { ...input, ...(cursor ? { cursor } : {}) }, page = await f.rpc.call('agent.conversation.inspect', request)
    pages.push(page); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(input.maxBytes ?? 64 * 1024)
    let consumed: ReturnType<typeof consumeConversationWindowPage>
    try { consumed = consumeConversationWindowPage(page, assembly) }
    catch (error) { expect(error, 'A legal original producer unit must survive strict assembly').toBeUndefined(); throw error }
    if (consumed.kind === 'complete') return { snapshot: consumed.snapshot, pages }
    assembly = consumed.pending; expect(page.nextCursor).toBeTruthy(); cursor = page.nextCursor!
  }
  throw Error('The original bounded frame must finish')
}
const untouched = (f: Fixture) => expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])

it('public fragmented reads and the actual CLI preserve all 201 exact contributions in one canonical event', async () => {
  const f = await fixture(); await seed(f, 200)
  const input = { ...f.ref, limit: 100, maxBytes: 64 * 1024 }, first = await frame(f, input)
  expect(first.snapshot.units).toHaveLength(1); expect(first.snapshot.units[0]!.records).toHaveLength(101)
  const second = await frame(f, { ...input, cursor: first.snapshot.window.navigation.older! })
  const unit = second.snapshot.units[0]!
  expect(second.snapshot.units).toHaveLength(1); expect(unit.records).toHaveLength(201)
  expect(unit.event.id).toBe(first.snapshot.units[0]!.event.id); expect(unit.event.recordIds).toHaveLength(201)
  expect(unit.records.map(record => record.original.item.id).sort()).toEqual(['canonical', ...Array.from({ length: 200 }, (_, i) => 'contribution-' + i)].sort())
  expect(unit.records.filter(record => record.original.kind === 'captured').map(record => record.original.item)).toEqual(expect.arrayContaining(Array.from({ length: 200 }, (_, i) => contribution(f, i))))
  expect(second.pages.some(page => page.items.some(entry => entry.kind === 'fragment'))).toBe(true)
  const cli = await conversationReaderCli(f.root); closes.push(cli.close)
  const result = await cli.run(['agent', 'conversation', 'inspect', '--input', '-'], JSON.stringify({ ...f.ref, view: second.snapshot.window.view!, maxBytes: 4 * 1024 * 1024 }))
  expect(result.code, result.stderr).toBe(0)
  const output = JSON.parse(result.stdout); expect(output.operation).toBe('agent.conversation.inspect')
  const consumed = consumeConversationWindowPage(output.result)
  expect(consumed.kind).toBe('complete')
  if (consumed.kind === 'complete') expect(consumed.snapshot.units).toEqual(second.snapshot.units)
  expect(output.result.window.checkpoint).toEqual(second.snapshot.window.checkpoint)
  untouched(f)
})

it('strict copied window assembly counts actual original identities across units and still rejects duplicate or oversized units', async () => {
  const f = await fixture(['canonical-a', 'canonical-b']), opening = await f.rpc.call('agent.conversation.inspect', f.ref)
  const nativePage = await f.client.sessionHistoryPage(f.session.agentSessionId), epoch = opening.scope.sources.find(s => s.kind === 'captured')
  if (epoch?.kind !== 'captured' || !epoch.epoch) throw Error('The original captured source epoch is required')
  const projected = (count: number, oneEvent = false) => {
    const items = Array.from({ length: count }, (_, i) => contribution(f, i, !oneEvent && i % 2 ? 'canonical-b' : 'canonical-a'))
    const sourceOrders = new Map<string, ConversationSourceOrder>(items.map((item, i) => [conversationRecordId({ ...f.ref, source: { kind: 'captured', recordId: item.id } }), { kind: 'captured-stream', epoch: epoch.epoch!, firstSequence: i + 1 }]))
    const timeline = projectConversationTimeline({ agentSessionId: f.session.agentSessionId, executionHostId: 'local', historyPage: nativePage,
      timeline: { agentSessionId: f.session.agentSessionId, revision: 1, items }, sourceOrders })
    const records = new Map(timeline.records.map(record => [record.id, record]))
    return timeline.events.map(event => ({ event, records: event.recordIds.map(id => records.get(id)!) }))
  }
  const copy = (units: ConversationUnit[]): AgentConversationReadPage => ({ ...structuredClone(opening), items: units.map(item => ({ kind: 'item', item })), budgetBytes: 4 * 1024 * 1024,
    window: { ...opening.window, itemCount: units.length } })
  const input = { ...f.ref, maxBytes: 4 * 1024 * 1024 }, legal = projected(1198)
  expect(legal).toHaveLength(2); expect(legal.flatMap(unit => unit.records)).toHaveLength(1200)
  expect(consumeConversationWindowPage(parseConversationReadPage(copy(legal), input))).toMatchObject({ kind: 'complete' })
  const over = projected(1199)
  expect(over).toHaveLength(2); expect(over.flatMap(unit => unit.records)).toHaveLength(1201)
  expect(over.every(unit => unit.records.length < 1200)).toBe(true)
  const parsed = parseConversationReadPage(copy(over), input)
  expect(() => consumeConversationWindowPage(parsed)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => consumeConversationWindowPage(copy([legal[0]!, legal[0]!]))).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const fullEvent = projected(1199, true).find(unit => unit.records.length === 1200)!
  expect(fullEvent).toBeDefined(); expect(fullEvent.records).toHaveLength(1200)
  expect(parseConversationUnit(fullEvent, f.ref, opening.scope)).toEqual(fullEvent)
  const huge = projected(1200, true).find(unit => unit.records.length === 1201)!
  expect(huge).toBeDefined(); expect(huge.records).toHaveLength(1201)
  expect(() => parseConversationUnit(huge, f.ref, opening.scope)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  untouched(f)
})
