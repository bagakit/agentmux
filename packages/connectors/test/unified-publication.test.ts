import { appendFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { renderAgentMuxMessageEnvelope, type AgentTimelineItem } from '@agentmux/core'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { PublicationHost } from '../src/publication-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { roomBindingFixture, context, core } from './fixtures/room-binding.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { ingressFixture } from './fixtures/ingress.js'
import { normalizeAgentTimelineItem } from '../../core/src/session-timeline.js'
import { savedQuestionFixture, savedQuestionEvent, savedQuestionReply, savedQuestionJsonl, savedQuestionPrompt, savedQuestionAnswer, savedQuestionId } from '../../core/test/helpers/codex-saved-question.js'
import { consumeJsonReadEntry, type ConversationUnit, type JsonReadAssembly } from '@agentmux/core/conversation'
import { ConnectionHost } from '../src/connection-host.js'
import { PublicationStore, type PublicationBoundary } from '../src/publication-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const row = (id: string, at: number, content: unknown[], type = 'assistant') => JSON.stringify({ sessionId: 'original-native', uuid: id, type,
  timestamp: new Date(at).toISOString(), message: { role: type, content } }) + '\n'
const captured = (agentSessionId: string, id: string, at: number, fields: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id, agentSessionId, kind: 'tool_call', source: 'native-hook', status: 'complete', title: 'Original process', createdAt: at, updatedAt: at, ...fields })
function allOperations(store: PublicationStore, boundary: PublicationBoundary) {
  const result: ReturnType<PublicationStore['list']> = []; let after: string | undefined
  for (;;) { const page = store.list(boundary, 100, after); result.push(...page); if (page.length < 100) return result; after = page.at(-1)!.operationId }
}
function originalRecordId(operation: ReturnType<PublicationStore['list']>[number]) {
  if (operation.reference.source.kind === 'interaction') throw Error('Expected an original conversation record')
  return operation.reference.source.recordId
}
async function fixture(publication: 'future-native-user-facing' | 'future-shared-conversation' = 'future-shared-conversation') {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http })
  const f = await roomBindingFixture(true, { adapters: [adapter], retired: false, config: feishuConfig, secrets: { resolve: async () => 'isolated-credential' } }); cleanup.push(f.close)
  const port = createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }])
  const bound = await f.bindings.bind({ ...f.input, scope: { ...f.input.scope, publication } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Binding not applied')
  const host = new PublicationHost({ connections: f.connections, bindings: f.bindings, conversation: port }); cleanup.push(() => host.close())
  const posts = () => remote.messageCalls().filter(call => call.method === 'POST')
  const texts = () => posts().map(call => { const body = JSON.parse(call.body), content = JSON.parse(body.content); return body.msg_type === 'interactive' ? content.elements.map((element: { text: { content: string } }) => element.text.content).join('\n') : content.zh_cn.content[0][0].text as string })
  return { ...f, remote, adapter, port, binding: bound.binding, host, posts, texts }
}

it('actual Core unified units carry authorized text, captured process and public input through the real Feishu SDK while durable unsupported gaps do not stop later effects', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  const tool = captured(id, 'captured-tool', _historyFixtureEpoch(0, 0, 30), { toolName: 'shell', toolInput: '{"command":"pwd"}', toolOutput: 'Complete original output' })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: tool })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'public-user', _historyFixtureEpoch(0, 0, 40),
    { kind: 'user_message', source: 'user', authorHuman: true, publicContent: 'confirmed', content: 'Qualified public original input' }) })
  await appendFile(f.transcript, row('native-before', _historyFixtureEpoch(0, 0, 20), [{ type: 'text', text: 'Original public answer' }]) +
    row('unqualified-user', _historyFixtureEpoch(0, 0, 50), [{ type: 'text', text: 'Never export unknown native input span' }], 'user') +
    row('media-gap', _historyFixtureEpoch(0, 0, 60), [{ type: 'text', text: 'Supported text beside image' }, { type: 'image', source: { type: 'url', url: 'https://unread.example/image.png' } }]) +
    row('native-later', _historyFixtureEpoch(0, 0, 70), [{ type: 'text', text: 'Later supported reply' }]))
  f.host.refresh()
  await vi.waitFor(() => {
    const operations = f.host.store.list(f.binding)
    expect(operations.length).toBeGreaterThanOrEqual(5)
    expect(operations.every(o => o.state === 'confirmed')).toBe(true)
  }, { timeout: 10_000 })
  const text = f.texts().join('\n')
  for (const value of ['Original public answer', 'Complete original output', '{"command":"pwd"}', 'Qualified public original input', 'Supported text beside image', 'Later supported reply']) expect(text).toContain(value)
  expect(text).toContain('via amux'); expect(text).toContain('process'); expect(text).not.toContain('Never export unknown native input span')
  const coverage = f.host.store.coverage(f.binding)
  expect(coverage.state).toBe('incomplete')
  expect(coverage.gaps.some(g => g.reason === 'public-content-unconfirmed' && g.part?.record.source.recordId === 'unqualified-user')).toBe(true)
  expect(coverage.gaps.some(g => g.reason === 'resource-unavailable' && g.part?.record.source.recordId === 'media-gap')).toBe(true)
  expect(f.host.store.checkpoint(f.binding, 'local')).not.toEqual(f.binding.sourceFrontier)
  expect(f.client.connect).not.toHaveBeenCalled()
}, 20_000)

it('the original native user-facing grant excludes private native reasoning and tool parts without granting a broader source scope', async () => {
  const f = await fixture('future-native-user-facing')
  await appendFile(f.transcript, row('narrow-original', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Complete original public reply' },
    { type: 'thinking', thinking: 'Private reasoning not authorized for this old grant' },
    { type: 'tool_use', id: 'private-tool-call', name: 'bash', input: { command: 'private-command' } },
    { type: 'tool_result', tool_use_id: 'private-tool-call', content: 'Private tool result outside old grant' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  const text = JSON.stringify([...f.remote.records.values()])
  expect(text).toContain('Complete original public reply')
  for (const privateText of ['Private reasoning', 'private-command', 'Private tool result']) expect(text).not.toContain(privateText)
  expect(f.binding.sourceFrontier!.frontier.scope.sources.every(source => source.kind === 'native')).toBe(true)
  expect(f.host.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
}, 20_000)

it('cut-before captured updates retain a durable private-history gap instead of exporting older content, while equal-text future events stay distinct', async () => {
  const f = await fixture(), id = f.session.agentSessionId, prior = (await f.client.sessionTimeline(id)).items[0]!
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: id, item: { ...prior, updatedAt: prior.updatedAt + 1000, publicContent: 'confirmed', content: 'Private old input must stay private' } })
  await appendFile(f.transcript, row('one', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Equal original reply' }]) + row('two', _historyFixtureEpoch(0, 0, 101), [{ type: 'text', text: 'Equal original reply' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.posts()).toHaveLength(2), { timeout: 10_000 })
  expect(f.texts()).toEqual(['Equal original reply', 'Equal original reply'])
  expect(new Set(f.posts().map(call => JSON.parse(call.body).uuid)).size).toBe(2)
  expect(f.host.store.coverage(f.binding).gaps).toContainEqual(expect.objectContaining({ reason: 'start-cut-unconfirmed', part: expect.objectContaining({ record: expect.objectContaining({ source: { kind: 'captured', recordId: prior.id } }) }) }))
}, 20_000)

it('a late exact same-event contribution preserves already represented native content and the original mapping without creating another message', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  const reads = vi.spyOn(f.port, 'changes')
  await appendFile(f.transcript, row('canonical-reply', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Complete original native reply' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  const first = f.host.store.list(f.binding)[0]!
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'later-observation', _historyFixtureEpoch(0, 0, 200), {
    kind: 'assistant_message', content: 'Complete original observation', conversation: {
      sameEvent: { hostId: 'local', agentSessionId: id, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'canonical-reply' } }
    }
  }) })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding).at(-1)).toMatchObject({ state: 'confirmed', mapping: first.mapping }), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.remote.messageCalls().some(call => call.method === 'PUT')).toBe(true), { timeout: 10_000 })
  expect(f.posts()).toHaveLength(1)
  const current = f.remote.records.get(first.mapping!.messageId)!
  const represented = JSON.stringify(JSON.parse((current.body as { content: string }).content))
  expect(represented).toContain('Complete original native reply')
  expect(represented).toContain('Complete original observation')
  const windows = await Promise.all(reads.mock.results.filter(result => result.type === 'return').map(result => result.value))
  const joined = windows.filter(page => page.window.complete).find(page => page.items.some(entry => entry.kind === 'item' && entry.item.records.some(record => record.original.item.id === 'later-observation')))
  expect(joined).toBeDefined()
  const unit = joined!.items.find(entry => entry.kind === 'item' && entry.item.records.some(record => record.original.item.id === 'later-observation'))!
  expect(unit).toMatchObject({ kind: 'item' })
  if (unit.kind !== 'item') throw Error('Expected the original complete consumer unit')
  expect(unit.item.records.map(record => record.original.item.id).sort()).toEqual(['canonical-reply', 'later-observation'])
  expect(reads.mock.calls.some(([input]) => typeof input.view === 'string')).toBe(true)
}, 20_000)

it('an unread canonical target never hides its captured body; the later native contribution updates the same original platform mapping', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'captured-first', _historyFixtureEpoch(0, 0, 200), {
    kind: 'assistant_message', content: 'Original captured body before canonical arrival', conversation: {
      sameEvent: { hostId: 'local', agentSessionId: id, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'native-after' } }
    }
  }) })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  const first = f.host.store.list(f.binding)[0]!
  expect(f.texts().join('\n')).toContain('Original captured body before canonical arrival')
  await appendFile(f.transcript, row('native-after', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Original canonical body arrives later' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.remote.messageCalls().some(call => call.method === 'PUT')).toBe(true), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.host.store.list(f.binding).at(-1)?.state).toBe('confirmed'), { timeout: 10_000 })
  expect(f.posts()).toHaveLength(1)
  expect(f.host.store.list(f.binding).at(-1)?.mapping).toEqual(first.mapping)
  const text = JSON.stringify(f.remote.records.get(first.mapping!.messageId)!.body)
  expect(text).toContain('Original captured body before canonical arrival')
  expect(text).toContain('Original canonical body arrives later')
}, 20_000)

it('a payload-noop canonical coalescence retains its mapping for a later canonical-only update', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  const reads = vi.spyOn(f.port, 'changes')
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'noop-first', _historyFixtureEpoch(0, 0, 200), {
    kind: 'assistant_message', content: 'Original body retained during canonical arrival', conversation: {
      sameEvent: { hostId: 'local', agentSessionId: id, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'noop-canonical' } }
    }
  }) })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  const first = f.host.store.list(f.binding)[0]!
  await appendFile(f.transcript, row('noop-canonical', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: '' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.coverage(f.binding).gaps.filter(g => g.code === 'CONVERSATION_ANCHOR_UNREAD')).toHaveLength(0), { timeout: 10_000 })
  expect(f.posts()).toHaveLength(1)
  await appendFile(f.transcript, row('noop-canonical', _historyFixtureEpoch(0, 0, 300), [{ type: 'text', text: 'Canonical-only changed original body' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding).length > 1).toBe(true), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.host.store.list(f.binding).at(-1)?.state).toBe('confirmed'), { timeout: 10_000 })
  await vi.waitFor(() => expect(JSON.stringify(f.remote.records.get(first.mapping!.messageId)!.body)).toContain('Canonical-only changed original body'), { timeout: 10_000 })
  expect(f.posts()).toHaveLength(1)
  expect(f.host.store.list(f.binding).at(-1)?.mapping).toEqual(first.mapping)
  const text = JSON.stringify(f.remote.records.get(first.mapping!.messageId)!.body)
  expect(text).toContain('Original body retained during canonical arrival')
  expect(text).toContain('Canonical-only changed original body')
  const pages = await Promise.all(reads.mock.results.filter(result => result.type === 'return').map(result => result.value))
  const windows = pages.filter(page => page.window.complete).flatMap(page => page.items.flatMap(entry => entry.kind === 'item' && entry.item.records.some(record => record.original.item.id === 'noop-canonical') ? [{ window: page.window, unit: entry.item }] : []))
  const earlier = windows.find(value => !JSON.stringify(value.unit).includes('Canonical-only changed original body'))!
  const updated = windows.find(value => JSON.stringify(value.unit).includes('Canonical-only changed original body'))!
  expect(updated.unit.event.id).toBe(earlier.unit.event.id)
  expect(updated.window.id).toBe(earlier.window.id)
  expect(updated.window.revision).toBeGreaterThan(earlier.window.revision)
  expect(updated.unit.records.map(record => record.original.item.id).sort()).toEqual(['noop-canonical', 'noop-first'])
}, 20_000)

it('removing an earlier same-event relation cannot silently split or duplicate a retained platform part without a replacement fact', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  await appendFile(f.transcript, row('retained-canonical', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Retained canonical body' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  const observation = captured(id, 'retained-contribution', _historyFixtureEpoch(0, 0, 200), { kind: 'assistant_message', content: 'Retained original contribution', conversation: {
    sameEvent: { hostId: 'local', agentSessionId: id, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'retained-canonical' } }
  } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: observation }); f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)).toHaveLength(2), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.host.store.list(f.binding).every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  const before = f.host.store.list(f.binding), { conversation: _relation, ...unrelated } = observation
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: id, item: { ...unrelated, updatedAt: _historyFixtureEpoch(0, 0, 300), content: 'A new body without an explicit original replacement edge' } }); f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding).length > before.length || f.host.store.coverage(f.binding).gaps.some(gap => gap.code === 'PUBLICATION_REPRESENTATION_RELATION_UNCONFIRMED')).toBe(true), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.host.store.list(f.binding).every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  expect(f.posts()).toHaveLength(1)
  expect(f.host.store.coverage(f.binding).gaps).toContainEqual(expect.objectContaining({ reason: 'source-gap', code: 'PUBLICATION_REPRESENTATION_RELATION_UNCONFIRMED', record: expect.objectContaining({ source: { kind: 'captured', recordId: observation.id } }) }))
  expect(f.host.store.inspect(before[1]!.operationId)).toEqual(before[1])
}, 20_000)

it('late same-event materialization cannot rewrite or replay an unknown frozen create, and resumes through its original receipt', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  const dispatch = vi.spyOn(f.adapter.publication!, 'dispatch').mockResolvedValueOnce({ state: 'unknown', reason: 'effect-unconfirmed' })
  await appendFile(f.transcript, row('unknown-canonical', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Original frozen unknown body' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('unknown'), { timeout: 10_000 })
  const first = structuredClone(f.host.store.list(f.binding)[0]!)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'unknown-contribution', _historyFixtureEpoch(0, 0, 200), { kind: 'assistant_message', content: 'Later original contribution', conversation: {
    sameEvent: { hostId: 'local', agentSessionId: id, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'unknown-canonical' } }
  } }) })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)).toHaveLength(2), { timeout: 10_000 })
  expect(f.host.store.inspect(first.operationId)).toEqual(first)
  expect(dispatch).toHaveBeenCalledTimes(1); expect(f.posts()).toHaveLength(0)
  expect(f.host.store.list(f.binding)[1]).toMatchObject({ state: 'pending', predecessorOperationId: first.operationId })
  expect(() => f.host.store.retry(first.operationId, () => true)).toThrowError(/not confirmed non-application/)
  // An explicit original attempt receipt proves non-application, so only the
  // newer full representation can enter the normal dispatch lane.
  f.host.store.settle(first.operationId, first.attempt!, { state: 'not-applied', reason: 'platform-rejected' })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[1]?.state).toBe('confirmed'), { timeout: 10_000 })
  expect(dispatch).toHaveBeenCalledTimes(2); expect(f.posts()).toHaveLength(1)
  expect(f.texts()[0]).toContain('Original frozen unknown body')
  expect(f.texts()[0]).toContain('Later original contribution')
  expect(f.host.store.inspect(first.operationId)?.prepared).toEqual(first.prepared)
}, 20_000)

it('a record-scoped Core relation gap survives empty and unrelated changes until its exact original target is accepted', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  const target = { hostId: 'local', agentSessionId: id, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'original-native', recordId: 'observed-target' } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'observing-original', _historyFixtureEpoch(0, 0, 200), { content: 'Original independent observation', conversation: { observes: target } }) })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.coverage(f.binding).gaps).toContainEqual(expect.objectContaining({ reason: 'source-gap', code: 'CONVERSATION_OBSERVED_TARGET_UNREAD', record: target })), { timeout: 10_000 })
  const before = f.host.store.coverage(f.binding).gaps.find(gap => gap.code === 'CONVERSATION_OBSERVED_TARGET_UNREAD')!
  const portRead = vi.spyOn(f.port, 'changes')
  f.host.refresh()
  await vi.waitFor(() => expect(portRead).toHaveBeenCalled(), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.host.observation(f.binding.bindingId, f.binding.revision)?.reason).toBe('content-unconfirmed'))
  expect(f.host.store.coverage(f.binding).gaps).toContainEqual(before)
  await appendFile(f.transcript, row('unrelated-after', _historyFixtureEpoch(0, 0, 300), [{ type: 'text', text: 'Independent supported content' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.posts()).toHaveLength(2), { timeout: 10_000 })
  expect(f.host.store.coverage(f.binding).gaps).toContainEqual(before)
  await appendFile(f.transcript, row('observed-target', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Exact original target now accepted' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.posts()).toHaveLength(3), { timeout: 10_000 })
  expect(f.host.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
}, 20_000)

it('lost acknowledgment after the real SQLite page COMMIT reloads its retained cut without duplicating the original platform operation', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.host.observation(f.binding.bindingId, f.binding.revision)?.state).toBe('ready'), { timeout: 10_000 })
  const database = f.connections.database, exec = database.exec.bind(database)
  let lost = false
  vi.spyOn(database, 'exec').mockImplementation(command => {
    const result = exec(command)
    if (!lost && command === 'COMMIT' && Number(database.prepare('SELECT COUNT(*) AS n FROM connector_publication_operation').get()!.n) > 0) {
      lost = true; throw Error('Original COMMIT completed; acknowledgment lost')
    }
    return result
  })
  await appendFile(f.transcript, row('commit-unknown', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Original durably accepted reply' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  expect(lost).toBe(true)
  const first = structuredClone(f.host.store.list(f.binding)[0]!), cut = f.host.store.checkpoint(f.binding, 'local')
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.observation(f.binding.bindingId, f.binding.revision)?.state).toBe('ready'), { timeout: 10_000 })
  expect(f.host.store.checkpoint(f.binding, 'local')).toEqual(cut)
  expect(f.host.store.inspect(first.operationId)).toEqual(first)
  expect(f.posts()).toHaveLength(1)
  await appendFile(f.transcript, row('after-unknown-ack', _historyFixtureEpoch(0, 0, 200), [{ type: 'text', text: 'Later healthy reply still works' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.posts()).toHaveLength(2), { timeout: 10_000 })
  expect(f.host.store.list(f.binding)).toHaveLength(2)
}, 20_000)

it('actual ingress submission carries its typed original Input key through Core and accounts the platform origin without fabricating a send receipt', async () => {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http })
  const f = await ingressFixture(true, feishuConfig, { resolve: async () => 'isolated-credential' }, { adapters: [adapter], publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const binding = f.bindings.readCurrent(f.input.bindingId)!, port = createPublicationConversationPort(f.coreClients)
  const connections = new ConnectionHost({ database: f.connections.database, secrets: { resolve: async () => 'isolated-credential' }, adapters: [adapter] }); cleanup.push(() => connections.close())
  const host = new PublicationHost({ connections, bindings: f.bindings, conversation: port }); cleanup.push(() => host.close())
  const received = await f.receive(), dispatched = await f.ingress.dispatch(received.ingress.ingressId)
  if (received.ingress.kind === 'action' || !dispatched.ingress || dispatched.ingress.kind === 'action' || !dispatched.ingress.input) throw Error('Original message claim unavailable')
  const input = dispatched.ingress.input
  let recorded: AgentTimelineItem | undefined
  await vi.waitFor(async () => {
    recorded = (await f.client.sessionTimeline(f.session.agentSessionId)).items.find(item => item.authorExternal?.externalMessageId === received.ingress.externalMessageId)
    expect(recorded?.inputRef).toEqual({ kind: 'message', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, messageId: input.messageId })
  }, { timeout: 10_000 })
  expect(recorded).toMatchObject({ source: 'user', kind: 'user_message', publicContent: 'confirmed', content: renderAgentMuxMessageEnvelope({ sender: input.author, senderSessionId: null, body: received.ingress.body }), authorExternal: input.author })
  host.refresh()
  await vi.waitFor(() => expect(host.store.coverage(binding).origins).toHaveLength(1), { timeout: 10_000 })
  const represented = host.store.coverage(binding).origins[0]!
  expect(represented).toMatchObject({ part: { record: { hostId: 'local', agentSessionId: input.agentSessionId, source: { kind: 'captured', recordId: recorded!.id } } },
    origin: { connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, externalMessageId: received.ingress.externalMessageId } })
  expect(host.store.list(binding)).toHaveLength(0)
  expect(remote.messageCalls()).toHaveLength(0)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()

  const original = recorded!, { inputRef: _ref, ...unlinked } = original, { publicContent: _public, ...hookCopy } = unlinked
  const originalInput = { kind: 'message' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, messageId: input.messageId }
  const copies: AgentTimelineItem[] = [
    unlinked,
    { ...original, inputRef: { ...originalInput, messageId: 'another-input-message' } },
    { ...original, inputRef: { ...originalInput, expectedRun: { runId: 'another-original-run' } } },
    { ...original, authorExternal: { ...original.authorExternal!, grantId: 'another-grant' } },
    { ...original, authorExternal: { ...original.authorExternal!, bindingId: 'another-binding' } },
    { ...hookCopy, source: 'native-hook', kind: 'assistant_message' }
  ]
  for (const [index, fields] of copies.entries()) {
    const item = { ...fields, id: 'unqualified-copy-' + index, createdAt: original.createdAt + index + 1, updatedAt: original.updatedAt + index + 1 }
    if (index === 0 || index === 5) delete item.inputRef
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item })
  }
  host.refresh()
  await vi.waitFor(() => expect(host.store.coverage(binding).gaps.filter(gap => gap.part?.record.source.recordId.startsWith('unqualified-copy-')).length).toBeGreaterThanOrEqual(4), { timeout: 10_000 })
  expect(host.store.coverage(binding).origins).toEqual([represented])
  expect(host.store.list(binding).some(operation => operation.mapping?.messageId === received.ingress.externalMessageId)).toBe(false)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const savedClaim = f.connections.database.prepare('SELECT record_json FROM connection_ingress_message WHERE ingress_id=?').get(received.ingress.ingressId)!
  for (const [index, wrong] of [{ hostId: 'foreign-execution-host' }, { agentSessionId: 'foreign-session' }].entries()) {
    const claim = JSON.parse(String(savedClaim.record_json))
    claim.input = { ...claim.input, ...wrong }
    f.connections.database.prepare('UPDATE connection_ingress_message SET record_json=? WHERE ingress_id=?').run(JSON.stringify(claim), received.ingress.ingressId)
    const copied = { ...original, id: 'foreign-claim-' + index, createdAt: original.createdAt + 20 + index, updatedAt: original.updatedAt + 20 + index }
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: copied })
    host.refresh()
    await vi.waitFor(() => expect(host.store.coverage(binding).gaps).toContainEqual(expect.objectContaining({ reason: 'public-content-unconfirmed', part: expect.objectContaining({ record: expect.objectContaining({ source: { kind: 'captured', recordId: copied.id } }) }) })), { timeout: 10_000 })
    expect(host.store.coverage(binding).origins).toEqual([represented])
    f.connections.database.prepare('UPDATE connection_ingress_message SET record_json=? WHERE ingress_id=?').run(savedClaim.record_json!, received.ingress.ingressId)
  }
  f.connections.delivery = host
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'unified-publication.sock'), connections: f.connections, spatialState: f.spatial, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  const params = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision, limit: 1 }
  const firstPage = await sdk.call('connection.delivery.ls', params)
  expect(firstPage.coverage).toMatchObject({ state: 'incomplete', origins: [represented], nextContent: expect.any(String) })
  const args = ['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'ls', '--connection', binding.connectionId, '--binding', binding.bindingId,
    '--binding-revision', String(binding.revision), '--limit', '1', '--after-content', firstPage.coverage!.nextContent!]
  const cli = await runCompiledObjectCli(args, objectCliEnvironment(f.root))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  const visible = JSON.parse(cli.stdout).result
  expect(visible.coverage).toMatchObject({ state: 'incomplete', gaps: [expect.objectContaining({ reason: 'public-content-unconfirmed', part: expect.objectContaining({ record: expect.objectContaining({ hostId: 'local', agentSessionId: input.agentSessionId }) }) })] })
  expect(JSON.stringify(visible)).not.toMatch(/payload|prepared|isolated-credential|Original external body|Message from External/)
  await expect(sdk.call('connection.delivery.ls', { ...params, connectionId: 'foreign-connection' })).rejects.toThrow()
  await expect(sdk.call('connection.delivery.ls', { ...params, afterContent: 'foreign-content-cursor' })).rejects.toThrow()
  for (const wrong of [{ ...original.inputRef!, agentSessionId: 'foreign-session' }, { ...original.inputRef!, extra: true }, { ...original.inputRef!, expectedRun: { runId: '' } }])
    expect(() => normalizeAgentTimelineItem({ ...original, inputRef: wrong })).toThrow()
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.session.agentSessionId, itemId: original.id, updatedAt: original.updatedAt + 100, content: 'An ordinary later content update is another unqualified body' })
  const currentRead = f.store.readCapturedHistory(f.session.agentSessionId, { recordId: original.id })
  await expect(currentRead).resolves.toHaveProperty('records.0.item.content', 'An ordinary later content update is another unqualified body')
  const current = (await currentRead).records[0]!.item
  expect(current).not.toHaveProperty('inputRef'); expect(current).not.toHaveProperty('publicContent')
  const old = (await f.store.readCapturedHistory(f.session.agentSessionId, { recordId: original.id, recordRevision: represented.part.recordRevision })).records[0]!.item
  expect(old.inputRef).toEqual(original.inputRef); expect(old.content).toBe(original.content)
}, 20_000)

it('a separate original outbox process reopens the same vector cut, unknown frozen effect, part intents and exact unsupported gap without dispatch', async () => {
  const f = await fixture(), id = f.session.agentSessionId
  vi.spyOn(f.adapter.publication!, 'dispatch').mockResolvedValueOnce({ state: 'unknown', reason: 'effect-unconfirmed' })
  await appendFile(f.transcript, row('reopened-original', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Original immutable unknown request' }, { type: 'image', source: { type: 'url', url: 'https://unread.example/original.png' } }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('unknown'), { timeout: 10_000 })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: captured(id, 'restart-contribution', _historyFixtureEpoch(0, 0, 200), { kind: 'assistant_message', content: 'Original late content retained across process restart', conversation: {
    sameEvent: { hostId: 'local', agentSessionId: id, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'reopened-original' } }
  } }) })
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)).toHaveLength(2), { timeout: 10_000 })
  f.host.close()
  const expected = { operations: f.host.store.list(f.binding), coverage: f.host.store.coverage(f.binding), checkpoint: f.host.store.checkpoint(f.binding, 'local'),
    intents: f.connections.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' ORDER BY rowid").all() }
  const entry = new URL('../dist/publication-store.js', import.meta.url).href
  const code = `import {DatabaseSync} from 'node:sqlite'; import {PublicationStore} from ${JSON.stringify(entry)}; const db=new DatabaseSync(process.argv[1]);const boundary=JSON.parse(process.argv[2]);const store=new PublicationStore(db);console.log(JSON.stringify({operations:store.list(boundary),coverage:store.coverage(boundary),checkpoint:store.checkpoint(boundary,'local'),intents:db.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind')='representation' ORDER BY rowid").all()}));db.close()`
  const reopened = JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, fileURLToPath(new URL('connections.sqlite', 'file://' + f.root + '/')), JSON.stringify(f.binding)])).stdout)
  expect(reopened).toEqual(expected)
  expect(reopened.operations[0]).toMatchObject({ state: 'unknown', attempt: 1 })
  expect(reopened.operations[1].payload.text).toContain('Original immutable unknown request')
  expect(reopened.operations[1].payload.text).toContain('Original late content retained across process restart')
  expect(reopened.coverage.gaps).toContainEqual(expect.objectContaining({ reason: 'resource-unavailable', part: expect.objectContaining({ record: expect.objectContaining({ source: expect.objectContaining({ recordId: 'reopened-original' }) }) }) }))
  expect(f.posts()).toHaveLength(0)
}, 20_000)

it('an unavailable complete text resource keeps its exact gap while adjacent content flows, then updates the retained mapping with verified complete bytes', async () => {
  const f = await fixture(), originalResource = f.port.resource.bind(f.port)
  let available = false
  vi.spyOn(f.port, 'resource').mockImplementation(async (reference, input, signal) => {
    if (!available) throw Error('Exact original resource is temporarily unreadable')
    return await originalResource(reference, input, signal)
  })
  // The original native reader defers physical string extents above 2 MiB.
  // JSON escaping reaches that real boundary without thousands of platform effects.
  const prefix = 'Original supported prefix', text = '\0'.repeat(360_000) + '完整原资源🙂'
  await appendFile(f.transcript, row('deferred-original', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: prefix }, { type: 'text', text }]) +
    row('unblocked-later', _historyFixtureEpoch(0, 0, 200), [{ type: 'text', text: 'Later supported original still flows' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.posts()).toHaveLength(2), { timeout: 10_000 })
  const gap = f.host.store.coverage(f.binding).gaps.find(gap => gap.reason === 'resource-unavailable')!, before = f.host.store.list(f.binding)
  expect(gap).toMatchObject({ part: { selector: { kind: 'native-part', partIndex: 1 } }, anchor: { revision: gap.part!.recordRevision } })
  const exact = vi.spyOn(f.port, 'inspect'), originalCut = structuredClone(f.host.store.checkpoint(f.binding, 'local'))
  const originalBinding = structuredClone(f.binding)
  // Release the temporary Reader view; recovery must reopen the original durable
  // publication cut and read the retained gap's exact original version.
  f.host.close()
  const resumed = new PublicationHost({ connections: f.connections, bindings: f.bindings, conversation: f.port })
  cleanup.push(() => resumed.close())
  expect(resumed.store.checkpoint(f.binding, 'local')).toEqual(originalCut)
  for (const operation of before) expect(resumed.store.inspect(operation.operationId)).toEqual(operation)
  available = true
  resumed.refresh()
  await vi.waitFor(() => expect(f.host.store.coverage(f.binding).gaps.filter(value => value.reason === 'resource-unavailable' || value.reason === 'version-unavailable')).toHaveLength(0), { timeout: 15_000 })
  await vi.waitFor(() => expect(allOperations(f.host.store, f.binding).every(operation => operation.state === 'confirmed')).toBe(true), { timeout: 20_000 })
  expect(exact.mock.calls.map(([input]) => input.anchor)).toContainEqual(gap.anchor)
  expect(f.binding).toEqual(originalBinding)
  for (const operation of before) expect(resumed.store.inspect(operation.operationId)).toEqual(operation)
  const projection = before.find(operation => originalRecordId(operation) === 'deferred-original')!.projectionId
  const versions = allOperations(f.host.store, f.binding).filter(operation => operation.projectionId === projection), latest = new Map(versions.map(operation => [operation.fragment.ordinal, operation]))
  const platform = [...latest.values()].sort((a, b) => a.fragment.ordinal - b.fragment.ordinal).map(operation => {
    const content = f.remote.records.get(operation.mapping!.messageId)!.body as { content: string }
    return JSON.parse(content.content).content[0][0].text as string
  }).join('')
  expect(platform).toBe(prefix + '\n\n' + text)
  expect(latest.get(0)!.mapping).toEqual(before.find(operation => operation.projectionId === projection)!.mapping)
  expect(new Set(versions.map(operation => operation.projectionId)).size).toBe(1)
  expect(f.remote.messageCalls().filter(call => call.method !== 'GET').every(call => Buffer.byteLength(call.body) <= 30 * 1024)).toBe(true)
}, 30_000)

it('the actual canonical saved question publishes complete original options; its unqualified native answer stays an exact public-content gap', async () => {
  const saved = await savedQuestionFixture([], { unifiedCapturedRead: true }); cleanup.push(saved.close)
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http }), connections = new ConnectionHost({ databasePath: join(saved.root, 'connections.sqlite'), secrets: { resolve: async () => 'isolated-credential' }, adapters: [adapter] }); cleanup.push(() => connections.close())
  await connections.configure({ operationId: 'question-connection', expectedRevision: null, connection: feishuConfig })
  const port = createPublicationConversationPort(() => [{ hostId: 'local', client: saved.client }]), signal = new AbortController().signal
  const ref = { hostId: 'local', agentSessionId: saved.session.agentSessionId }, start = await port.checkpoint(ref, signal)
  const boundary: PublicationBoundary = { bindingId: 'question-original', revision: 1, connectionId: feishuConfig.connectionId, application: feishuConfig.application,
    executionHostId: 'local', agentSessionId: saved.session.agentSessionId, externalConversationId: 'isolated-question-room', scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' },
    sourceFrontier: start.checkpoint, sourceCheckpoints: start.checkpoint.frontier.cuts.flatMap(cut => cut.kind === 'native' ? [cut.checkpoint] : []) }
  const store = new PublicationStore(connections.database)
  let after = store.checkpoint(boundary, start.sourceHostId)
  await appendFile(saved.transcriptPath, savedQuestionJsonl([savedQuestionEvent(), savedQuestionReply()]))
  const accepted: ConversationUnit[] = []
  for (let batch = 0; batch < 4; batch++) {
    const units: ConversationUnit[] = []; let cursor: string | undefined, pending: JsonReadAssembly | undefined
    let page: Awaited<ReturnType<typeof port.changes>>
    do {
      page = await port.changes({ ...ref, checkpoint: after, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }, signal)
      for (const entry of page.items) {
        const read = consumeJsonReadEntry({ entry, scopeKey: JSON.stringify(after), ...(pending ? { pending } : {}), maxTotalBytes: 32 * 1024 * 1024 })
        if (read.kind === 'pending') pending = read.pending
        else { pending = undefined; units.push(read.value) }
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(pending).toBeUndefined(); accepted.push(...units)
    store.commitPage(boundary, after, page!, () => true, { units: [...units].reverse(), resolvedText: new Map() }); after = page!.checkpoint
    if (!page!.more) break
  }
  for (let effects = 0; effects < 10; effects++) {
    const operation = store.claimNext(boundary, () => true, adapter.publication!)
    if (!operation) break
    const receipt = await adapter.publication!.dispatch(operation.prepared!, operation.target, 'isolated-credential', signal, operation.mapping)
    store.settle(operation.operationId, operation.attempt!, receipt)
  }
  const outgoing = remote.messageCalls().filter(call => call.method === 'POST').map(call => JSON.parse(JSON.parse(call.body).content).zh_cn.content[0][0].text).join('')
  expect(outgoing).toContain(savedQuestionPrompt)
  expect(outgoing).toContain('- Keep the original work'); expect(outgoing).toContain('- Review the direction'); expect(outgoing).toContain('Recorded question · read-only')
  const answer = accepted.flatMap(unit => unit.records).find(record => record.original.kind === 'native' && record.original.item.questionAnswers?.length)!
  expect(answer.original.kind === 'native' && answer.original.item.questionAnswers).toEqual([expect.objectContaining({ questionId: savedQuestionId, answer: savedQuestionAnswer })])
  expect(store.coverage(boundary).gaps).toContainEqual(expect.objectContaining({ reason: 'public-content-unconfirmed', part: expect.objectContaining({ record: answer.reference }) }))
  expect(store.list(boundary).some(operation => originalRecordId(operation) === answer.reference!.source.recordId)).toBe(false)
  expect(store.coverage(boundary).state).toBe('incomplete')
}, 20_000)

it('legacy native projection keys, confirmed mapping and advanced cut survive unified adoption; missing historical captured consent is never invented', async () => {
  const f = await fixture()
  await appendFile(f.transcript, row('legacy-original', _historyFixtureEpoch(0, 0, 100), [{ type: 'text', text: 'Original already confirmed platform speech' }]))
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding)[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  f.host.close()
  const first = f.host.store.list(f.binding)[0]!, advanced = f.host.store.checkpoint(f.binding, 'local').frontier.cuts.find(cut => cut.kind === 'native')!
  if (advanced.kind !== 'native') throw Error('Missing original native cut')
  const { sourceFrontier: _frontier, ...legacy } = f.binding
  const { event: _event, sourceRecords: _records, ...legacyOperation } = first
  // Exact pre-unification persisted shapes. Original effect/wire/mapping remain
  // byte-for-byte; no newer source fact is backfilled into those receipts.
  f.connections.database.prepare('UPDATE room_binding_revision SET snapshot_json=? WHERE binding_id=? AND revision=?').run(JSON.stringify(legacy), legacy.bindingId, legacy.revision)
  f.connections.database.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(legacyOperation), first.operationId)
  f.connections.database.prepare('DELETE FROM connector_publication_decision WHERE binding_id=? AND binding_revision=?').run(legacy.bindingId, legacy.revision)
  f.connections.database.prepare('DELETE FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=?').run(legacy.bindingId, legacy.revision)
  f.connections.database.prepare('INSERT INTO connector_publication_frontier VALUES(?,?,?,?)').run(legacy.bindingId, legacy.revision, JSON.stringify([advanced.checkpoint.source.providerId, advanced.checkpoint.source.nativeSessionId]), JSON.stringify(advanced.checkpoint))
  const restarted = new PublicationHost({ connections: f.connections, bindings: f.bindings, conversation: f.port }); cleanup.push(() => restarted.close())
  await vi.waitFor(() => expect(restarted.store.coverage(legacy).gaps).toContainEqual(expect.objectContaining({ reason: 'start-cut-unconfirmed' })), { timeout: 10_000 })
  const retained = restarted.store.checkpoint(legacy, 'local')
  expect(retained.frontier.cuts).toEqual([advanced]); expect(retained.frontier.scope.sources.every(source => source.kind === 'native')).toBe(true)
  expect(restarted.store.inspect(first.operationId)).toEqual(legacyOperation)
  expect(f.posts()).toHaveLength(1)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: captured(f.session.agentSessionId, 'no-captured-start', _historyFixtureEpoch(0, 0, 200),
    { kind: 'user_message', source: 'user', publicContent: 'confirmed', content: 'No authorized captured starting cut exists' }) })
  await appendFile(f.transcript, row('legacy-future-native', _historyFixtureEpoch(0, 0, 300), [{ type: 'text', text: 'Future original native still works' }]))
  restarted.refresh()
  await vi.waitFor(() => expect(f.posts()).toHaveLength(2), { timeout: 10_000 })
  expect(f.texts()).toEqual(['Original already confirmed platform speech', 'Future original native still works'])
  expect(restarted.store.inspect(first.operationId)).toEqual(legacyOperation)
  expect(restarted.store.coverage(legacy).state).toBe('incomplete')
}, 20_000)

it('the actual package route helpers keep outer selected Host separate from original refs, bound fragment bytes and reject another route or Session', async () => {
  const f = await fixture(), signal = new AbortController().signal, reference = { hostId: 'selected-route', agentSessionId: f.session.agentSessionId }
  const port = createPublicationConversationPort(() => [{ hostId: 'selected-route', client: f.client }, { hostId: 'another-route', client: f.client }])
  const start = await port.checkpoint(reference, signal)
  expect(start).toMatchObject({ hostId: 'selected-route', sourceHostId: 'local', checkpoint: { hostId: 'selected-route', sourceHostId: 'local', frontier: { hostId: 'local' } } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item: captured(reference.agentSessionId, 'routed-large', _historyFixtureEpoch(0, 0, 200), { content: '原始完整记录🙂'.repeat(3_000) }) })
  const units: ConversationUnit[] = []; let cursor: string | undefined, pending: JsonReadAssembly | undefined, fragments = 0
  do {
    const input = { ...reference, checkpoint: start.checkpoint, maxBytes: 64 * 1024, ...(cursor ? { cursor } : {}) }, page = await port.changes(input, signal)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024)
    expect(page.hostId).toBe(reference.hostId); expect(page.sourceHostId).toBe('local')
    for (const entry of page.items) {
      if (entry.kind === 'fragment') fragments++
      const read = consumeJsonReadEntry({ entry, scopeKey: JSON.stringify(start.checkpoint), ...(pending ? { pending } : {}), maxTotalBytes: 32 * 1024 * 1024 })
      if (read.kind === 'pending') pending = read.pending
      else { pending = undefined; units.push(read.value) }
    }
    if (!cursor && page.nextCursor) {
      await expect(port.changes({ ...input, hostId: 'another-route', checkpoint: { ...start.checkpoint, hostId: 'another-route' }, cursor: page.nextCursor }, signal)).rejects.toThrow()
      await expect(port.changes({ ...input, agentSessionId: 'foreign-session', cursor: page.nextCursor }, signal)).rejects.toThrow()
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(fragments).toBeGreaterThan(1); expect(pending).toBeUndefined()
  const original = units.flatMap(unit => unit.records).find(record => record.reference?.source.recordId === 'routed-large')!
  expect(original.reference?.hostId).toBe('local')
  expect(original.original.kind === 'captured' && original.original.item.content).toBe('原始完整记录🙂'.repeat(3_000))
  await expect(port.checkpoint({ ...reference, hostId: 'unknown-route' }, signal)).rejects.toThrow()
}, 20_000)
