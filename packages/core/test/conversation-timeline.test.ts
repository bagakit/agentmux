import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { projectConversationTimeline, conversationRecordId, type ConversationSourceRecord } from '../src/conversation.js'
import { projectSessionUserMessages } from '../src/session-user-messages.js'
import { normalizeAgentTimeline } from '../src/session-timeline.js'
import { normalizeSessionHistoryPage, SESSION_HISTORY_MAX_PAGE_BYTES } from '../src/session-history.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { savedQuestionFixture, savedQuestionEvent, savedQuestionTool, savedQuestionReply, savedQuestionId } from './helpers/codex-saved-question.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryPage, AgentTimelineItem } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const sid = 'private-agent', source = { providerId: 'claude', nativeSessionId: 'native-main' }
const captured = (id: string, kind: AgentTimelineItem['kind'], fields: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({ id, agentSessionId: sid, kind, source: 'native-hook', status: 'complete', title: 'Original', createdAt: _historyFixtureEpoch(0, 0, 10), updatedAt: _historyFixtureEpoch(0, 0, 10), ...fields })
const snapshot = (items: AgentTimelineItem[]) => ({ agentSessionId: sid, revision: 1, items })
const page = (items: AgentSessionHistoryPage['items']): AgentSessionHistoryPage => ({ agentSessionId: sid, source, items, nextCursor: null })
const ref = (recordId: string) => ({ hostId: 'local', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId } })
const readAtoms = (records: readonly ConversationSourceRecord[]) => records.flatMap<string | AgentSessionHistoryContentPart>(record => record.original.kind === 'native' ? record.original.item.contentParts
  : [record.original.item.content, record.original.item.toolInput, record.original.item.toolOutput].filter(value => value !== undefined))

it('keeps the exact bounded zhQg public originals as one reply and an independent observation, not two utterances', async () => {
  const original = JSON.parse(await readFile(new URL('../../../apps/desktop/test/fixtures/conversation-source-roles.json', import.meta.url), 'utf8'))
  const input = { agentSessionId: original.agentSessionId, executionHostId: 'local', historyPage: { agentSessionId: original.agentSessionId, source: original.source, items: [original.native], nextCursor: null }, timeline: { agentSessionId: original.agentSessionId, revision: 1, items: [original.captured] } }
  const projected = projectConversationTimeline(input)
  expect(projected.records.map(record => record.original.item)).toEqual([original.native, original.captured])
  expect(projected.events.map(event => event.role)).toEqual(['message', 'observation'])
  expect(projected.events[1]?.author).toEqual({ kind: 'unknown' })
  expect(projected.events.flatMap(event => event.coalesces ?? [])).toEqual([])
  expect(projected.order.crossSource).toBe('partial')
  expect(projectConversationTimeline(input)).toEqual(projected)
})

it('accounts for every captured kind, explicit human/Agent/external authors and all native mixed parts without inferring adoption', () => {
  const external = { kind: 'external' as const, connectionId: 'connection', actor: { application: { domain: 'private-domain', appId: 'app' }, idType: 'opaque-id', userId: 'actor' }, externalConversationId: 'room', externalMessageId: 'message', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 }
  const items = [captured('human', 'assistant_message', { authorHuman: true, content: 'Explicit human' }), captured('agent', 'assistant_message', { authorAgentSessionId: 'other', content: 'Explicit Agent' }), captured('external', 'assistant_message', { authorExternal: external, content: 'Explicit external' }),
    captured('user', 'user_message', { authorHuman: true, content: 'Manual input' }), captured('system', 'system_message', { content: 'Original notice' }), captured('tool', 'tool_call', { toolInput: '', toolOutput: 'Original output' }), captured('permission', 'permission'), captured('life', 'lifecycle')]
  const native = page([{ id: 'mixed', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 1), contentParts: [{ kind: 'text', text: 'Before' }, { kind: 'tool-call', name: 'Read', input: '{}', callId: 'call' }, { kind: 'reasoning', text: 'Original reasoning' }, { kind: 'resource', resourceType: 'image', reference: 'opaque:image' }, { kind: 'text', text: 'After' }] }])
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, timeline: snapshot(items) })
  expect(result.records).toHaveLength(9)
  expect(readAtoms(result.records)).toEqual([...native.items[0]!.contentParts, ...items.flatMap(item => [item.content, item.toolInput, item.toolOutput].filter(value => value !== undefined))])
  expect(result.events.find(event => event.reference?.source.recordId === 'human')?.author).toEqual({ kind: 'human' })
  expect(result.events.find(event => event.reference?.source.recordId === 'agent')?.author).toEqual({ kind: 'agent', agentSessionId: 'other' })
  expect(result.events.find(event => event.reference?.source.recordId === 'external')?.author).toEqual(external)
  expect(result.events.map(event => event.role)).toEqual(['message', 'message', 'message', 'message', 'message', 'notice', 'process', 'interaction', 'process'])
  expect(result.events.flatMap(event => event.content)).toHaveLength(12)
  expect(result.events[0]!.content.map(slot => slot.selector)).toEqual(native.items[0]!.contentParts.map((_, partIndex) => ({ kind: 'native-part', partIndex })))
  expect(projectSessionUserMessages({ agentSessionId: sid, timeline: snapshot(items) })[0]?.author).toEqual(result.events.find(event => event.reference?.source.recordId === 'user')?.author)
})

it('keeps readable content without Host and with an unread canonical anchor, preserving explicit coalescence and raw refs', () => {
  const item = captured('observed', 'assistant_message', { content: 'Complete accepted body', conversation: { sameEvent: ref('unread') } })
  const hostless = projectConversationTimeline({ agentSessionId: sid, timeline: snapshot([item]) })
  expect(hostless.reference).toBeNull(); expect(hostless.records[0]?.reference).toBeNull(); expect(hostless.events[0]?.content).toHaveLength(1)
  expect(hostless.events[0]?.coalesces).toBeUndefined()
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', timeline: snapshot([item]) })
  expect(result.events[0]?.anchorId).toBe(conversationRecordId(ref('unread')))
  expect(result.events[0]?.recordIds).toEqual([result.records[0]!.id])
  expect(result.events[0]?.content[0]?.recordId).toBe(result.records[0]!.id)
  expect(result.events[0]?.coalesces?.[0]?.fromEventIds).toEqual([result.records[0]!.id])
  expect(result.coverage[0]?.gaps).toContainEqual(expect.objectContaining({ code: 'CONVERSATION_ANCHOR_UNREAD', record: ref('unread') }))
  expect(readAtoms(result.records)).toEqual(['Complete accepted body'])
})

it('uses real Claude native tool IDs and verified Hook subject fields for exact part relations without coalescing mixed parent messages', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ sessionId: source.nativeSessionId, uuid: 'mixed', type: 'assistant', timestamp: new Date(_historyFixtureEpoch(0, 0, 10)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Speech before tools' }, { type: 'tool_use', id: 'toolu_exact', name: 'Read', input: { path: 'original' } }, { type: 'tool_use', id: 'toolu_other', name: 'Read', input: { path: 'other' } }, { type: 'text', text: 'Speech after tools' }] } }])); close.push(f.close)
  const native = await f.client.sessionHistoryPage(sid)
  const hook = new AgentProviderRegistry().get('claude').normalizeHook({ receiptId: 'receipt', agentSessionId: sid, runId: 'original-run', providerId: 'claude', eventName: 'PreToolUse', payload: { session_id: source.nativeSessionId, tool_name: 'Read', tool_input: { path: 'original' }, tool_use_id: 'toolu_exact' } }, { nativeHandle: f.session.nativeHandle! })
  const tool = hook.timeline[0]!
  if (tool.type === 'update') throw Error('The original Hook must provide a complete item.')
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, timeline: snapshot([tool.item]) })
  expect(result.events).toHaveLength(2)
  const links = result.events[0]!.relations.filter(relation => relation.kind === 'same-invocation')
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ from: { selector: { kind: 'native-part', partIndex: 1 } }, to: { selector: { kind: 'captured-field', field: 'toolInput' } }, invocation: { source, subject: 'main', scope: { kind: 'session' }, callId: 'toolu_exact' } })
  expect(result.events[0]!.content).toHaveLength(4); expect(result.events[0]!.coalesces).toBeUndefined()
  const foreign = structuredClone(tool.item); foreign.conversation!.invocations![0]!.invocation.source.nativeSessionId = 'another-native'
  const wrongActor = structuredClone(tool.item); wrongActor.conversation!.invocations![0]!.invocation.subject = { kind: 'child', nativeActorId: 'different-child' }
  for (const candidate of [foreign, wrongActor]) expect(projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, timeline: snapshot([candidate]) }).events.flatMap(event => event.relations)).toEqual([])
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('reuses real saved Codex canonical questions, original function call IDs and same-source recorded answers', async () => {
  const f = await savedQuestionFixture([savedQuestionTool(), savedQuestionEvent(), savedQuestionReply()]); close.push(f.close)
  const native = await f.client.sessionHistoryPage(f.session.agentSessionId)
  const result = projectConversationTimeline({ agentSessionId: f.session.agentSessionId, executionHostId: 'local', historyPage: native })
  expect(result.events.map(event => event.role)).toEqual(['process', 'interaction', 'message'])
  expect(result.records[0]?.original.item.conversation?.nativeInvocationScope).toMatchObject({ source: native.source, subject: 'main', scope: { kind: 'session' } })
  expect(result.events[1]?.relations).toContainEqual(expect.objectContaining({ kind: 'answers', question: expect.objectContaining({ questionId: savedQuestionId }) }))
  expect(result.records.map(record => record.original.item)).toEqual(native.items)
  await f.unchanged()
})

it('preserves original source order under backward/missing clocks and keeps same text/bare IDs separate', () => {
  const native = page([{ id: 'same', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 30), contentParts: [{ kind: 'text', text: 'Same body' }] }, { id: 'earlier-clock', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 1), contentParts: [{ kind: 'text', text: 'Second original row' }] }])
  const items = [captured('same', 'assistant_message', { content: 'Same body', createdAt: _historyFixtureEpoch(0, 0, 20), updatedAt: _historyFixtureEpoch(0, 0, 20) }), captured('backward', 'user_message', { content: 'Manual', createdAt: _historyFixtureEpoch(0, 0, 2), updatedAt: _historyFixtureEpoch(0, 0, 2) })]
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, timeline: snapshot(items) })
  expect(result.records.filter(record => record.original.kind === 'native').map(record => record.original.item.id)).toEqual(native.items.map(item => item.id))
  expect(result.records.filter(record => record.original.kind === 'captured').map(record => record.original.item.id)).toEqual(items.map(item => item.id))
  expect(new Set(result.events.map(event => event.id)).size).toBe(4)
  expect(result.events.flatMap(event => event.coalesces ?? [])).toEqual([])
})

it('positions a canonical event after its original native predecessor, even when the linked observation arrived earlier', () => {
  const native = page([{ id: 'n1', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 100), contentParts: [{ kind: 'text', text: 'First original message' }] }, { id: 'n2', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 200), contentParts: [{ kind: 'text', text: 'Second original message' }] }])
  const observed = captured('early', 'assistant_message', { createdAt: _historyFixtureEpoch(0, 0, 50), updatedAt: _historyFixtureEpoch(0, 0, 50), content: 'Original observation', conversation: { sameEvent: ref('n2') } })
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, timeline: snapshot([observed]) })
  expect(result.events.map(event => event.reference?.source.recordId)).toEqual(['n1', 'n2'])
  expect(result.records).toHaveLength(3)
  expect(result.events[1]?.content).toHaveLength(2)
})

it('resolves chained canonical references to their final unread target and preserves every accepted body', () => {
  const native = page([{ id: 'middle', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 100), contentParts: [{ kind: 'text', text: 'Accepted native contribution' }], conversation: { sameEvent: ref('final') } }])
  const observed = captured('c', 'assistant_message', { content: 'Accepted observation', conversation: { sameEvent: ref('middle') } })
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, timeline: snapshot([observed]) })
  expect(result.events).toHaveLength(1)
  expect(result.events[0]?.reference).toEqual(ref('final'))
  expect(result.events[0]?.anchorId).toBe(conversationRecordId(ref('final')))
  expect(result.events[0]?.content).toHaveLength(2)
})

it('matches coverage by typed source identity regardless of object property order', () => {
  const native = page([{ id: 'observed', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Accepted body' }], conversation: { sameEvent: ref('unread') } }])
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native,
    coverage: [{ source: { providerId: source.providerId, nativeSessionId: source.nativeSessionId, kind: 'native' }, origin: 'beginning', readExtent: { through: 'accepted-cut' }, earlier: 'complete', current: 'complete-through-cut', gaps: [] }] })
  expect(result.coverage[0]?.current).toBe('partial')
  expect(result.coverage[0]?.gaps).toContainEqual(expect.objectContaining({ code: 'CONVERSATION_ANCHOR_UNREAD' }))
})

it('adds coverage for accepted sources when an optional caller coverage list omits them', () => {
  const native = page([{ id: 'observed', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Accepted body' }], conversation: { sameEvent: ref('unread') } }])
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native, coverage: [] })
  expect(result.scope.sources).toHaveLength(1)
  expect(result.coverage).toHaveLength(1)
  expect(result.coverage[0]?.gaps).toContainEqual(expect.objectContaining({ code: 'CONVERSATION_ANCHOR_UNREAD' }))
})

it('retains explicitly empty Hook input as a real field and accurate invocation selector', () => {
  const normalized = new AgentProviderRegistry().get('claude').normalizeHook({ receiptId: 'empty-receipt', agentSessionId: sid, runId: 'original-run', providerId: 'claude', eventName: 'PreToolUse', payload: { session_id: source.nativeSessionId, tool_name: 'Read', tool_input: '', tool_use_id: 'toolu_empty' } }, {})
  const tool = normalized.timeline[0]!
  if (tool.type === 'update') throw Error('Expected complete original item')
  expect(tool.item.toolInput).toBe('')
  const result = projectConversationTimeline({ agentSessionId: sid, timeline: snapshot([tool.item]) })
  expect(result.events[0]?.content).toHaveLength(1)
  expect(result.events[0]?.content[0]?.selector).toEqual({ kind: 'captured-field', field: 'toolInput' })
})

it('keeps relation storage linear on a nonempty large invocation page and preserves all original parts', () => {
  const total = 1000
  const native = page(Array.from({ length: total }, (_, index) => ({ id: `row-${index}`, kind: 'activity' as const,
    contentParts: [{ kind: 'tool-result' as const, callId: 'same-exact-invocation', output: String(index) }], conversation: {
      nativeInvocationScope: { source, subject: 'main' as const, scope: { kind: 'session' as const } } } })))
  const result = projectConversationTimeline({ agentSessionId: sid, executionHostId: 'local', historyPage: native })
  expect(result.records).toHaveLength(total); expect(result.events).toHaveLength(total)
  expect(result.events.flatMap(event => event.relations)).toHaveLength(2 * (total - 1))
  expect(result.events.flatMap(event => event.content)).toHaveLength(total)
  expect(result.events.flatMap(event => event.coalesces ?? [])).toEqual([])
})

it('uses the original optional captured stream positions/revisions without treating a recent window as full history', () => {
  const item = captured('retained', 'user_message', { content: 'Original retained input' }), timeline = { ...snapshot([item]), stream: { epoch: 'real-owner-epoch', sequence: 900, revision: 900, origin: 'retained-prefix' as const, gaps: [{ code: 'OLD_PREFIX_UNKNOWN', message: 'Original earlier prefix is unknown.' }], positions: [{ id: item.id, firstSequence: 1, sequence: 800, revision: 'original-accepted-version' }] } }
  const result = projectConversationTimeline({ agentSessionId: sid, timeline })
  expect(result.records[0]?.order).toEqual({ kind: 'captured-stream', epoch: timeline.stream.epoch, firstSequence: 1 })
  expect(result.records[0]?.revision).toBe('original-accepted-version')
  expect(result.coverage[0]).toMatchObject({ source: { kind: 'captured', epoch: timeline.stream.epoch }, origin: 'retained-prefix', earlier: 'unknown-before', current: 'partial', gaps: timeline.stream.gaps })
})

it('keeps malformed optional provenance and the full body readable with a local diagnostic', () => {
  const item = captured('malformed', 'assistant_message', { content: 'Full original body' })
  const original = { ...item, conversation: { sameEvent: { source: 'unqualified' } } }
  const normalized = normalizeAgentTimeline(sid, [original])
  expect(normalized[0]?.conversation).toBeUndefined()
  expect(normalized[0]?.conversationDiagnostic?.original).toEqual(original.conversation)
  expect(readAtoms(projectConversationTimeline({ agentSessionId: sid, timeline: snapshot(normalized) }).records)).toEqual(['Full original body'])
})

it('optional provenance cannot make an originally readable native page exceed its existing byte budget', () => {
  const original = page([{ id: 'near-budget', kind: 'activity', contentParts: [{ kind: 'text', text: '' }] }])
  const overhead = new TextEncoder().encode(JSON.stringify(original)).byteLength
  const body = 'x'.repeat(SESSION_HISTORY_MAX_PAGE_BYTES - overhead - 2)
  original.items[0]!.contentParts = [{ kind: 'text', text: body }]
  expect(normalizeSessionHistoryPage(source, original, 1).items[0]!.contentParts).toEqual([{ kind: 'text', text: body }])
  original.items[0]!.conversation = { nativeInvocationScope: { source, subject: 'main', scope: { kind: 'session' } } }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const result = normalizeSessionHistoryPage(source, original, 1)
  expect(result.items[0]!.contentParts).toEqual([{ kind: 'text', text: body }])
  expect(result.items[0]!.conversation).toBeUndefined()
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('provenance'), expect.objectContaining({ recordId: 'near-budget' }))
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(SESSION_HISTORY_MAX_PAGE_BYTES)
})

it('bundles and executes the actual browser-safe entry with nonempty records and no Node runtime dependencies', async () => {
  const bundle = await build({ absWorkingDir: new URL('../../../', import.meta.url).pathname, stdin: { contents: "export { projectConversationTimeline } from './packages/core/src/conversation.js'", resolveDir: new URL('../../../', import.meta.url).pathname }, bundle: true, platform: 'browser', format: 'iife', globalName: 'Timeline', write: false, metafile: true })
  expect(Object.keys(bundle.metafile!.inputs).some(name => name.endsWith('conversation-timeline.ts'))).toBe(true)
  const runtime = runInNewContext(bundle.outputFiles[0]!.text + '; Timeline', { TextEncoder })
  expect(runtime.projectConversationTimeline({ agentSessionId: sid, timeline: snapshot([captured('original', 'assistant_message', { content: 'Browser body' })]) }).events[0].role).toBe('observation')
})
