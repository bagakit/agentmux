import { projectConversationTimeline } from '../src/conversation-timeline.js'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paginatedFixture, user, source, turn, jsonl } from './helpers/codex-paginated.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'
import { confirmNativeInputAdoption } from '../src/native-input-adoption.js'
import { consumeConversationWindowPage, parseConversationUnit, type ConversationWindowAssembly } from '../src/conversation-changes.js'
import { conversationRevision, conversationNativeInputWitness } from '../src/conversation-stream.js'
import type { AgentPromptSubmissionRecord, AgentTimelineItem } from '../src/types.js'
import { DatabaseSync } from 'node:sqlite'
import { PublicationStore, type PublicationOperation } from '../../connectors/src/publication-store.js'
import type { RoomBinding } from '../src/room-binding-contract.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { ConversationReaderState, readAgentConversation as readOriginalWindow, type ConversationReaderPort } from '../src/conversation-reader.js'
import type { AgentSessionHistoryItem } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(kind: 'prompt' | 'message' = 'prompt') {
  const f = await paginatedFixture([], 'paginated', process.env.AGENTMUX_NATIVE_ADOPTION_COMPILED === '1'), key = kind === 'prompt' ? { kind, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'original-submission' } : { kind, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, messageId: 'original-submission' }
  closes.push(f.close)
  const token = createNativeInputCorrelation(key), plan = { kind: 'native-rpc' as const, protocolId: 'original-protocol', actorId: 'original-actor', sourceId: JSON.stringify(['codex', source.nativeSessionId]), threadId: source.nativeSessionId, operation: 'start-or-steer' as const, clientCorrelation: token }
  const admission: NonNullable<AgentPromptSubmissionRecord['admission']> = { submissionId: 'original-submission', operationId: 'original-submission', inputKey: key, transport: 'native', acknowledged: true,
    intent: { run: f.session.run, ownerInstanceId: 'original-daemon', prompt: 'Private Core system context\nOriginal user content', plan, execution: kind === 'prompt' ? 'immediate' : 'default',
      message: { userContent: 'Original user content', systemContext: 'Private Core system context', authorHuman: true },
      admissionIntent: kind === 'prompt' ? { kind: 'native-conversation', source, expectedRun: f.session.run } : { kind: 'exact-condition', condition: { expectedRun: f.session.run, afterSubmissionId: null } } }, native: { plan, outcome: 'admitted', turnId: turn } }
  const next = { ...f.session, promptCompletionAdmission: admission }
  await f.store.compareAndSwap(f.session, next); Object.assign(f.session, next)
  const checkpoint = (await f.client.conversationCheckpoint({ hostId: 'local', agentSessionId: key.agentSessionId })).checkpoint
  const captured: AgentTimelineItem = { id: 'original-captured', agentSessionId: key.agentSessionId, kind: 'user_message', status: 'complete', source: 'user', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    title: 'Prompt', content: 'Original user content', publicContent: 'confirmed', inputRef: key, authorHuman: true }
  const native = (id = 'canonical-user') => { const row = user(id, [{ type: 'text', text: admission.intent!.prompt }]); row.payload.item.client_id = token; return row }
  return { ...f, key, admission, captured, native, checkpoint, async capture() { await f.store.applyTimelineMutation({ type: 'append', agentSessionId: key.agentSessionId, item: captured }) },
    async read(cursor?: string, limit = 100) { let page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: key.agentSessionId, limit, ...(cursor ? { cursor } : {}) }), pending: ConversationWindowAssembly | undefined
      for (;;) { const read = consumeConversationWindowPage(page, pending); if (read.kind === 'complete') return { page, snapshot: read.snapshot }; pending = read.pending
        page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: key.agentSessionId, cursor: page.nextCursor!, limit }) } } }
}

it('confirms canonical native metadata against the original durable claim and makes one native event with complete immutable submission detail', async () => {
  const f = await fixture(); await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native()]))
  const raw = await f.client.sessionHistoryPage(f.key.agentSessionId)
  expect(raw.items[0]).toMatchObject({ id: f.recordId(0), conversation: { nativeInput: { source, semanticItemId: 'canonical-user', turnId: turn }, adoptedInput: { key: f.key } } })
  expect(raw.items[0]!.id).not.toBe('canonical-user')
  const result = await f.read(), units = result.snapshot.units
  expect(units).toHaveLength(1); expect(units[0]!.records).toHaveLength(2)
  expect(units[0]!.records.find(record => record.id === units[0]!.event.anchorId)?.original.kind).toBe('native')
  expect(units[0]!.event.author).toEqual({ kind: 'human' })
  expect(units[0]!.event.content.map(slot => slot.placement)).toEqual(['body', 'detail'])
  const original = units[0]!.records.find(record => record.original.kind === 'captured')!
  expect(original.original.item).toEqual(f.captured); expect(original.revision).toBe(conversationRevision(f.captured))
  expect(parseConversationUnit(units[0], { hostId: 'local', agentSessionId: f.key.agentSessionId }, result.page.scope)).toEqual(units[0])
})

it('rejects foreign canonical threads and source/Run/token/turn mismatches without replay or losing original body', async () => {
  const f = await fixture(), foreign = f.native(); foreign.payload.thread_id = 'foreign-thread'
  await appendFile(f.transcriptPath, jsonl([foreign, f.native()]))
  const raw = await f.client.sessionHistoryPage(f.key.agentSessionId), item = raw.items[1]!
  expect(raw.items[0]!.conversation?.nativeInput).toBeUndefined(); expect(raw.items[0]!.contentParts).toHaveLength(1)
  const read = vi.fn(async () => ({ agentSessionId: f.key.agentSessionId, run: f.key.expectedRun, admission: f.admission }))
  for (const changed of [
    { ...item, turnId: 'another-turn' },
    { ...item, conversation: { ...item.conversation, nativeInput: { ...item.conversation!.nativeInput!, source: { ...source, nativeSessionId: 'foreign' } } } },
    { ...item, conversation: { ...item.conversation, nativeInput: { ...item.conversation!.nativeInput!, clientCorrelation: createNativeInputCorrelation(f.key) } } }
  ]) {
    const result = await confirmNativeInputAdoption(changed, { hostId: 'local', agentSessionId: f.key.agentSessionId }, source, read)
    expect(result.conversation?.adoptedInput).toBeUndefined(); expect(result.contentParts).toEqual(item.contentParts); expect(result.conversationDiagnostic?.code).toBe('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
  }
  const unknown = structuredClone(f.admission); unknown.acknowledged = false; if (unknown.transport === 'native') unknown.native = { plan: unknown.native.plan, outcome: 'unknown' }
  expect((await confirmNativeInputAdoption(item, { hostId: 'local', agentSessionId: f.key.agentSessionId }, source,
    async () => ({ agentSessionId: f.key.agentSessionId, run: f.key.expectedRun, admission: unknown }))).conversation?.adoptedInput).toEqual({ key: f.key })
  expect(unknown.native).toEqual({ plan: f.admission.transport === 'native' ? f.admission.native.plan : undefined, outcome: 'unknown' })
  for (const changed of [
    { agentSessionId: f.key.agentSessionId, run: { runId: 'different-run' }, admission: f.admission },
    { agentSessionId: 'foreign-session', run: f.key.expectedRun, admission: f.admission },
    { agentSessionId: f.key.agentSessionId, run: f.key.expectedRun, admission: { ...f.admission, intent: { ...f.admission.intent!, plan: { ...f.admission.intent!.plan, actorId: 'different-actor' } } } }
  ]) expect((await confirmNativeInputAdoption(item, { hostId: 'local', agentSessionId: f.key.agentSessionId }, source,
    async () => changed as AgentPromptSubmissionRecord)).conversation?.adoptedInput).toBeUndefined()
  const noNative = { ...item, conversation: { adoptedInput: { key: f.key } } }
  expect((await confirmNativeInputAdoption(noNative, { hostId: 'local', agentSessionId: f.key.agentSessionId }, source, read)).conversation?.adoptedInput).toBeUndefined()
})

it('revokes a newest-page join when an older page reveals another original semantic item', async () => {
  const f = await fixture(); await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native('older-native'), user('unrelated'), f.native('newer-native')]))
  const first = await f.read(undefined, 1)
  expect(first.snapshot.units.some(unit => unit.records.length === 2)).toBe(true)
  const second = await f.read(first.page.nextCursor!, 1)
  const third = await f.read(second.page.nextCursor!, 1)
  expect(third.snapshot.units).toHaveLength(4)
  expect(third.snapshot.units.every(unit => unit.records.length === 1)).toBe(true)
  expect(third.snapshot.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
})

it.each([1, 2])('keeps already accepted unconfirmed canonical candidates when a later same-token item becomes qualified (count=%s)', async count => {
  const f = await fixture(); await f.capture(); await appendFile(f.transcriptPath, jsonl(Array.from({ length: count }, (_, index) => f.native('accepted-before-claim-readable-' + index))))
  const unavailable = vi.spyOn(f.client, 'inspectAgentPromptSubmission').mockResolvedValue(null)
  const before = await f.read(); unavailable.mockRestore()
  expect(before.snapshot.units).toHaveLength(count + 1)
  const candidate = before.snapshot.units.flatMap(unit => unit.records).find(record => record.original.kind === 'native')!
  expect(candidate.original.item.conversation?.adoptedInput).toBeUndefined()
  expect(candidate.original.item.conversationDiagnostic?.code).toBe('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
  expect(before.snapshot.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
  await appendFile(f.transcriptPath, jsonl([f.native('later-qualified-original')]))
  const page = await f.client.readConversationChanges({ hostId: 'local', agentSessionId: f.key.agentSessionId,
    checkpoint: before.page.window.checkpoint, view: before.page.window.view!, limit: 100 })
  const read = consumeConversationWindowPage(page)
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Expected small complete window')
  expect(read.snapshot.units).toHaveLength(count + 2)
  expect(read.snapshot.units.every(unit => unit.records.length === 1)).toBe(true)
  expect(read.snapshot.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
})

it.each([true, false])('retains known adoption counterevidence after the original bounded reading window trims native records (initially confirmed=%s)', async confirmed => {
  const f = await fixture(); await f.capture()
  await appendFile(f.transcriptPath, jsonl([...Array.from({ length: 1205 }, (_, i) => user('unrelated-' + i)), f.native('conflicting-first'), ...(confirmed ? [f.native('conflicting-second')] : [])]))
  const unavailable = confirmed ? undefined : vi.spyOn(f.client, 'inspectAgentPromptSubmission').mockResolvedValue(null)
  let result = await f.read(), reads = 1
  const nativeIds = result.snapshot.units.flatMap(unit => unit.records.filter(r => r.original.kind === 'native' && r.original.item.conversation?.nativeInput?.semanticItemId.startsWith('conflicting-')).map(r => r.id))
  expect(nativeIds).toHaveLength(confirmed ? 2 : 1)
  while (result.page.nextCursor) { result = await f.read(result.page.nextCursor); expect(++reads).toBeLessThan(25) }
  expect(result.snapshot.units.flatMap(unit => unit.records).some(record => nativeIds.includes(record.id))).toBe(false)
  expect(result.snapshot.units.length).toBeLessThanOrEqual(1200)
  unavailable?.mockRestore()
  if (!confirmed) await appendFile(f.transcriptPath, jsonl([f.native('late-qualified-original')]))
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.key.agentSessionId, item: { ...f.captured, id: 'late-original-capture' } })
  const input = { hostId: 'local', agentSessionId: f.key.agentSessionId,
    checkpoint: result.page.window.checkpoint, view: result.page.window.view!, limit: 100, maxBytes: 4 * 1024 * 1024 }
  let changed = await f.client.readConversationChanges(input), pending: ConversationWindowAssembly | undefined, read = consumeConversationWindowPage(changed)
  for (let i = 0; read.kind === 'pending' && i < 15; i++) {
    pending = read.pending; changed = await f.client.readConversationChanges({ ...input, cursor: changed.nextCursor! }); read = consumeConversationWindowPage(changed, pending)
  }
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Expected bounded complete window')
  const late = read.snapshot.units.find(unit => unit.records.some(record => record.original.item.id === 'late-original-capture'))!
  expect(late.records).toHaveLength(1); expect(late.event.inputAdoption?.witnesses).toHaveLength(2)
  expect(read.snapshot.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
})

it('retains two genuine semantic items for one token as ambiguous originals and never picks a page-order winner', async () => {
  const f = await fixture(); await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native('first-native'), f.native('second-native')]))
  const declared = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.key.agentSessionId, limit: 100 })
  expect(declared.window.itemCount).toBe(3)
  const result = await f.read()
  expect(result.snapshot.units).toHaveLength(3)
  expect(result.snapshot.units.map(unit => unit.records.length)).toEqual([1, 1, 1])
  expect(result.snapshot.coverage.flatMap(source => source.gaps).map(gap => gap.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
  for (const unit of result.snapshot.units) expect(parseConversationUnit(unit, { hostId: 'local', agentSessionId: f.key.agentSessionId }, result.page.scope)).toEqual(unit)
})

it('adopted page, exact physical anchor, original deferred resource and durable changes retain identical canonical parts and versions', async () => {
  const f = await fixture(), cut = await f.client.sessionHistoryCheckpoint(f.key.agentSessionId)
  const text = 'Original full native body 中🙂\n'.repeat(90000), original = f.native()
  original.payload.item.content = [{ type: 'text', text }, { type: 'future', value: 'retain opaque native content' }]
  await appendFile(f.transcriptPath, jsonl([original]))
  const page = await f.client.sessionHistoryPage(f.key.agentSessionId), item = page.items[0]!, part = item.contentParts[0]!
  expect(item.conversation?.adoptedInput).toEqual({ key: f.key })
  expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'text' } })
  if (part.kind !== 'resource' || part.resourceType !== 'text') throw Error('Expected original deferred text resource')
  expect(await readSessionHistoryTextResource(part, 0, { source, recordId: item.id, turnId: turn }, input => f.client.sessionHistoryResource(f.key.agentSessionId, input))).toEqual({ kind: 'text', text, contentEligibility: 'unconfirmed' })
  expect((await f.client.readSessionHistoryChanges(f.key.agentSessionId, { checkpoint: cut })).items).toEqual([item])
  const opened = await f.read(), native = opened.snapshot.units[0]!.records[0]!
  const exact = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: f.key.agentSessionId,
    anchor: { record: native.reference!, revision: native.revision, frontier: opened.page.window.checkpoint } })
  expect(exact.items[0]).toMatchObject({ kind: 'item', item: { records: [{ revision: native.revision, original: native.original }] } })
})

it('replaces a late native/captured join with original utterances when a different semantic item arrives on the same accepted view', async () => {
  const f = await fixture(); await f.capture()
  const before = await f.read()
  expect(before.snapshot.units).toHaveLength(1); expect(before.snapshot.units[0]!.records[0]!.original.kind).toBe('captured')
  await appendFile(f.transcriptPath, jsonl([f.native('first-native')]))
  const first = await f.client.readConversationChanges({ hostId: 'local', agentSessionId: f.key.agentSessionId, checkpoint: before.page.window.checkpoint, view: before.page.window.view!, limit: 100 })
  const joined = consumeConversationWindowPage(first)
  expect(joined.kind).toBe('complete'); if (joined.kind !== 'complete') throw Error('Expected the small exact joined window')
  expect(joined.snapshot.units).toHaveLength(1); expect(joined.snapshot.units[0]!.records).toHaveLength(2)
  expect(joined.snapshot.units[0]!.event.coalesces).toHaveLength(1)
  await appendFile(f.transcriptPath, jsonl([f.native('second-native')]))
  const second = await f.client.readConversationChanges({ hostId: 'local', agentSessionId: f.key.agentSessionId, checkpoint: first.checkpoint, view: first.window.view!, limit: 100 })
  const separate = consumeConversationWindowPage(second)
  expect(separate.kind).toBe('complete'); if (separate.kind !== 'complete') throw Error('Expected the small ambiguous window')
  expect(separate.snapshot.units).toHaveLength(3)
  expect(separate.snapshot.units.every(unit => unit.records.length === 1)).toBe(true)
  expect(separate.snapshot.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
  // Each old joined unit still validates in isolation. Only the complete accepted
  // window can see the second original, so transport assembly must reject first-wins.
  const other = separate.snapshot.units.find(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.conversation?.nativeInput?.semanticItemId === 'second-native'))!
  const forged = { ...second, items: [{ kind: 'item' as const, item: joined.snapshot.units[0]! }, { kind: 'item' as const, item: other }], window: { ...second.window, itemCount: 2, complete: true } }
  expect(() => consumeConversationWindowPage(forged)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})

it('does not let an old witness adopt a changed original version, and preserves ordinary reading when witness coverage is unknown', async () => {
  const f = await fixture(); await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native()]))
  const raw = await f.client.sessionHistoryPage(f.key.agentSessionId), timeline = await f.client.sessionTimeline(f.key.agentSessionId)
  const input = { agentSessionId: f.key.agentSessionId, executionHostId: 'local', historyPage: raw, timeline }
  const accepted = projectConversationTimeline(input), native = accepted.records.find(record => record.original.kind === 'native')!
  const witness = conversationNativeInputWitness(native)!
  const changed = structuredClone(raw)
  delete changed.items[0]!.conversation!.adoptedInput
  changed.items[0]!.contentParts = [{ kind: 'text', text: 'An accurately replaced original version' }]
  const projected = projectConversationTimeline({ ...input, historyPage: changed, inputAdoption: { witnesses: [witness] } })
  expect(projected.events).toHaveLength(2)
  expect(projected.records.find(record => record.original.kind === 'native')!.original.item).toEqual(changed.items[0])
  expect(projected.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_COVERAGE_UNKNOWN')
  const unknown = projectConversationTimeline({ ...input, inputAdoption: { unconfirmed: true, witnesses: [witness] } })
  expect(unknown.events).toHaveLength(2); expect(unknown.records).toHaveLength(2)
  expect(unknown.coverage.flatMap(c => c.gaps).map(g => g.code)).toContain('CONVERSATION_INPUT_ADOPTION_COVERAGE_UNKNOWN')
  const foreign = projectConversationTimeline({ ...input, timeline: { ...timeline, sourceHostId: 'foreign-host' } })
  expect(foreign.events).toHaveLength(2)
  const candidate = structuredClone(raw.items[0]!)
  candidate.id = 'other-physical-original'; delete candidate.conversation!.adoptedInput
  candidate.conversation!.nativeInput!.semanticItemId = 'other-semantic-original'
  expect(projectConversationTimeline({ ...input, historyPage: { ...raw, items: [candidate] } }).events).toHaveLength(2)
  for (const changed of [
    { ...candidate, turnId: 'other-turn', conversation: { nativeInput: { ...candidate.conversation!.nativeInput!, turnId: 'other-turn' } } },
    { ...candidate, conversation: { nativeInput: { ...candidate.conversation!.nativeInput!, clientCorrelation: createNativeInputCorrelation(f.key) } } },
    { ...candidate, conversation: { nativeInput: { ...candidate.conversation!.nativeInput!, source: { ...source, nativeSessionId: 'foreign-native' } } } }
  ]) {
    const scoped = projectConversationTimeline({ ...input, historyPage: { ...raw, items: [...raw.items, changed] } })
    expect(scoped.events).toHaveLength(2)
    expect(scoped.events.some(event => event.recordIds.length === 2)).toBe(true)
  }
})

it('the original Reader preserves exact adoption through normal witness growth and bounded body eviction', async () => {
  const f = await fixture(); await f.capture()
  // Controlled typed Reader port: original-claim qualification is independently
  // exercised above. This case isolates the existing view's exact retention bound.
  const native: AgentSessionHistoryItem[] = Array.from({ length: 1201 }, (_, index) => {
    const key = index === 0 ? f.key : { ...f.key, submissionId: 'independent-input-' + index }
    return { id: 'physical-original-' + index, turnId: turn, kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original body ' + index }],
      conversation: { nativeInput: { source, turnId: turn, semanticItemId: 'semantic-original-' + index, clientCorrelation: createNativeInputCorrelation(key) }, adoptedInput: { key } } }
  })
  const state = new ConversationReaderState(); closes.push(async () => state.dispose())
  const checkpoint = { agentSessionId: f.key.agentSessionId, source, cursor: 'original-qualified-cut' }
  const port: ConversationReaderPort = { state, descriptor: { agentSessionId: f.key.agentSessionId, hostId: 'local', state: 'active', history: f.session },
    captured: input => f.store.readCapturedHistory(f.key.agentSessionId, input), nativeCheckpoint: async () => checkpoint,
    nativeChanges: vi.fn(async () => { throw Error('This read cannot dispatch or change a source') }), nativeRecord: async (_source, id) => native.find(item => item.id === id)!,
    nativePage: async (cursor, limit) => { const before = native.length - Number(cursor ?? 0), start = Math.max(0, before - limit)
      return { agentSessionId: f.key.agentSessionId, source, items: native.slice(start, before), nextCursor: start ? String(native.length - start) : null, changesCursor: checkpoint.cursor } } }
  const ref = { hostId: 'local', agentSessionId: f.key.agentSessionId }
  let page = await readOriginalWindow({ ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }, port), pending: ConversationWindowAssembly | undefined, last
  for (let count = 0; count < 200; count++) {
    const result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') { last = result.snapshot; pending = undefined } else pending = result.pending
    if (!page.nextCursor) break
    page = await readOriginalWindow({ ...ref, limit: 100, maxBytes: 4 * 1024 * 1024, cursor: page.nextCursor }, port)
  }
  expect(page.nextCursor).toBeNull(); expect(last).toBeDefined(); expect(last!.units.length).toBeLessThanOrEqual(1200)
  expect(last!.coverage.flatMap(c => c.gaps).map(g => g.code)).not.toContain('CONVERSATION_INPUT_ADOPTION_COVERAGE_UNKNOWN')
  const original = last!.units.find(unit => unit.records.some(record => record.original.kind === 'captured'))!
  expect(original.records).toHaveLength(2); expect(original.event.inputAdoption?.unconfirmed).toBeUndefined()
  expect(last!.units.flatMap(unit => unit.records).every(record => record.original.kind === 'captured' || record.original.item.contentParts.length > 0)).toBe(true)
  expect(port.nativeChanges).not.toHaveBeenCalled()
})

function publicationFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const database = new DatabaseSync(':memory:'); closes.push(async () => database.close())
  const store = new PublicationStore(database), binding: RoomBinding = { bindingId: 'original-publication-binding', revision: 1, state: 'active', connectionId: 'original-connection',
    application: { domain: 'chat.example', appId: 'original-app' }, externalConversationId: 'original-room', scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' },
    executionHostId: 'local', agentSessionId: f.key.agentSessionId, regionAnchor: { regionId: 'original-region' }, authorizedBy: { kind: 'user', id: 'original-author' },
    sourceFrontier: f.checkpoint, sourceCheckpoints: f.checkpoint.frontier.cuts.flatMap(c => c.kind === 'native' ? [c.checkpoint] : []) }
  expect(store.checkpoint(binding, 'local')).toEqual(f.checkpoint)
  return { store, binding }
}

it('keeps the captured public span and accounts its exact native transport alias without publishing system context', async () => {
  const f = await fixture(), { store, binding } = publicationFixture(f)
  await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native()]))
  const page = await f.client.readConversationChanges({ hostId: 'local', agentSessionId: f.key.agentSessionId, checkpoint: f.checkpoint, limit: 100 })
  const read = consumeConversationWindowPage(page); expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Expected complete small original publication window')
  store.commitPage(binding, f.checkpoint, page, () => true, { units: read.snapshot.units, resolvedText: new Map() })
  const operations = store.list(binding), coverage = store.coverage(binding)
  expect(operations).toHaveLength(1); expect(operations[0]!.payload).toMatchObject({ kind: 'speech', text: expect.stringContaining(f.captured.content!) })
  expect(JSON.stringify(operations)).not.toContain('Private Core system context')
  expect(coverage.state).toBe('complete'); expect(coverage.gaps).toEqual([])
  expect(operations[0]!.reference.source.kind).toBe('native')
  expect(operations[0]!.relay?.sources.some(source => source.part.record.source.kind === 'captured')).toBe(true)
  expect(binding.sourceFrontier).toEqual(f.checkpoint)
})

it('late captured input joins its accepted native event without rewriting or replaying an unknown original publication effect', async () => {
  const f = await fixture(), { store, binding } = publicationFixture(f), ref = { hostId: 'local', agentSessionId: f.key.agentSessionId }
  await f.capture()
  const first = await f.client.readConversationChanges({ ...ref, checkpoint: f.checkpoint, limit: 100 })
  const original = consumeConversationWindowPage(first)
  if (original.kind !== 'complete') throw Error('Expected original captured window')
  store.commitPage(binding, f.checkpoint, first, () => true, { units: original.snapshot.units, resolvedText: new Map() })
  const prepare = vi.fn((operation: Readonly<PublicationOperation>) => ({ adapterId: 'private-adapter', renderVersion: 'original-render', requestKey: operation.operationId,
    request: { method: 'POST' as const, path: '/private/messages', body: JSON.stringify(operation.payload), contentType: 'application/json' as const } }))
  const adapter = { adapterId: 'private-adapter', renderVersion: 'original-render', supportedRenderVersions: ['original-render'], prepare }
  const dispatched = store.claimNext(binding, store.next(binding)!.operationId, () => true, adapter)!
  store.settle(dispatched.operationId, dispatched.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
  const unknown = structuredClone(store.inspect(dispatched.operationId))
  await appendFile(f.transcriptPath, jsonl([f.native()]))
  const changed = await f.client.readConversationChanges({ ...ref, checkpoint: first.checkpoint, view: first.window.view!, limit: 100 })
  const joined = consumeConversationWindowPage(changed)
  if (joined.kind !== 'complete') throw Error('Expected joined native window')
  expect(joined.snapshot.units).toHaveLength(1)
  store.commitPage(binding, first.checkpoint, changed, () => true, { units: joined.snapshot.units, resolvedText: new Map() })
  expect(store.inspect(dispatched.operationId)).toEqual(unknown)
  expect(store.claimNext(binding, dispatched.operationId, () => true, adapter)).toBeNull()
  expect(prepare).toHaveBeenCalledTimes(1)
  const nativeFirst = await fixture(); await appendFile(nativeFirst.transcriptPath, jsonl([nativeFirst.native()]))
  const opened = await nativeFirst.read(); await nativeFirst.capture()
  const late = await nativeFirst.client.readConversationChanges({ hostId: 'local', agentSessionId: nativeFirst.key.agentSessionId,
    checkpoint: opened.page.window.checkpoint, view: opened.page.window.view!, limit: 100 })
  const accepted = consumeConversationWindowPage(late)
  expect(accepted.kind).toBe('complete'); if (accepted.kind !== 'complete') throw Error('Expected late captured complete window')
  expect(accepted.snapshot.units).toHaveLength(1); expect(accepted.snapshot.units[0]!.event.anchorId).toBe(opened.snapshot.units[0]!.event.anchorId)
  expect(accepted.snapshot.units[0]!.records).toHaveLength(2)
})

it('real RPC and compiled CLI preserve the Core-native primary, original submission version and exact physical anchor without native control', async () => {
  const f = await fixture(); await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native()]))
  const core = process.env.AGENTMUX_NATIVE_ADOPTION_COMPILED === '1' ? await import('../dist/index.js') : await import('../src/index.js')
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const ref = { hostId: 'local', agentSessionId: f.key.agentSessionId }, sdk = await f.read()
  const page = await rpc.call('agent.conversation.inspect', { ...ref, limit: 100 })
  const read = consumeConversationWindowPage(page)
  expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw Error('Expected small complete public window')
  expect(read.snapshot.units).toEqual(sdk.snapshot.units)
  const native = read.snapshot.units[0]!.records.find(r => r.original.kind === 'native')!
  const anchor = { record: native.reference!, revision: native.revision, frontier: page.window.checkpoint }
  const exact = await rpc.call('agent.conversation.inspect', { ...ref, anchor })
  expect(exact.items[0]).toMatchObject({ kind: 'item', item: { records: [{ revision: native.revision, original: native.original }] } })
  await expect(rpc.call('agent.conversation.inspect', { ...ref, anchor: { ...anchor, record: { ...anchor.record, hostId: 'foreign-host' } } })).rejects.toThrow()
  if (process.env.AGENTMUX_NATIVE_ADOPTION_COMPILED === '1') {
    const env = objectCliEnvironment(f.root), result = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--input', '-'], env, JSON.stringify({ ...ref, limit: 100 }))
    expect(result.code, result.stderr).toBe(0)
    const cli = consumeConversationWindowPage(JSON.parse(result.stdout).result)
    expect(cli.kind).toBe('complete'); if (cli.kind !== 'complete') throw Error('Expected full compiled CLI window')
    expect(cli.snapshot.units).toEqual(sdk.snapshot.units)
  }
})


it('adopts a default semantic message only from its complete frozen native plan and preserves the original submission contribution', async () => {
  const f = await fixture('message'); await f.capture(); await appendFile(f.transcriptPath, jsonl([f.native()]))
  const { snapshot } = await f.read()
  expect(snapshot.units).toHaveLength(1)
  expect(snapshot.units[0]!.records).toHaveLength(2)
  expect(snapshot.units[0]!.event.content.map(slot => slot.placement)).toEqual(['body', 'detail'])
  const native = snapshot.units[0]!.records.find(record => record.original.kind === 'native')!
  if (native.original.kind !== 'native') throw Error('Expected original native contribution')
  expect(native.original.item.conversation?.adoptedInput).toEqual({ key: f.key })
  const wrong = structuredClone(f.admission)
  if (wrong.transport !== 'native' || !wrong.intent || wrong.intent.plan.kind !== 'native-rpc') throw Error('Expected native original claim')
  wrong.native.plan = { ...wrong.native.plan, sourceId: JSON.stringify(['codex', 'foreign-thread']) }
  wrong.intent.plan = wrong.native.plan
  const claim = { agentSessionId: f.key.agentSessionId, run: f.key.expectedRun, admission: wrong }
  const refused = await confirmNativeInputAdoption(native.original.item, { hostId: 'local', agentSessionId: f.key.agentSessionId }, source, async () => claim)
  expect(refused.conversation?.adoptedInput).toBeUndefined()
  expect(refused.conversationDiagnostic?.code).toBe('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
})
