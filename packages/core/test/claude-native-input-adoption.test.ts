import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { createNativeInputCorrelation, nativeInputSourceId } from '../src/native-input-correlation.js'
import { confirmNativeInputAdoption } from '../src/native-input-adoption.js'
import { consumeConversationWindowPage, isCompleteConversationRecord, parseConversationUnit, type ConversationWindowAssembly } from '../src/conversation-changes.js'
import { conversationNativeInputWitness, conversationInputWitnessGroup } from '../src/conversation-stream.js'
import { parseConversationProvenance } from '../src/conversation-provenance.js'
import { projectConversationWindow } from '../src/conversation.js'
import type { AgentPromptSubmissionRecord, AgentTimelineItem } from '../src/types.js'

const source = { providerId: 'claude', nativeSessionId: 'native-main' }
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture() {
  const f = await nativeHistoryFixture('claude', '', { compiled: process.env.AGENTMUX_CLAUDE_ADOPTION_COMPILED === '1' })
  const project = process.env.AGENTMUX_CLAUDE_ADOPTION_COMPILED === '1'
    ? (await import('../dist/conversation.js')).projectConversationWindow : projectConversationWindow
  closes.push(f.close)
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'original-input' }
  const correlation = createNativeInputCorrelation(key)
  const plan = { kind: 'native-rpc' as const, protocolId: 'native-queue', actorId: 'original-native-process', sourceId: nativeInputSourceId(source),
    threadId: source.nativeSessionId, clientCorrelation: correlation, operation: 'start-or-steer' as const, interactionQueue: true as const }
  const admission: NonNullable<AgentPromptSubmissionRecord['admission']> = {
    submissionId: key.submissionId, operationId: key.submissionId, inputKey: key, transport: 'native', acknowledged: false,
    intent: { run: key.expectedRun, ownerInstanceId: 'original-owner', prompt: 'Original Core context\nOriginal human input', plan, execution: 'immediate',
      message: { userContent: 'Original human input', systemContext: 'Original Core context', authorHuman: true },
      admissionIntent: { kind: 'session-conversation', expectedRun: key.expectedRun } },
    native: { plan, outcome: 'unknown' }
  }
  const next = { ...f.session, promptCompletionAdmission: admission }
  await f.store.compareAndSwap(f.session, next); Object.assign(f.session, next)
  const captured: AgentTimelineItem = { id: 'original-captured', agentSessionId: key.agentSessionId, kind: 'user_message', status: 'complete',
    source: 'user', createdAt: 1, updatedAt: 1, title: 'Original input', content: 'Original human input', publicContent: 'confirmed', inputRef: key, authorHuman: true }
  const queued = (id = 'native-consumer', patch: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) => ({
    type: 'attachment', uuid: id, parentUuid: 'original-parent', sessionId: source.nativeSessionId,
    attachment: { type: 'queued_command', prompt: admission.intent!.prompt, source_uuid: correlation, delivery_id: 'native-delivery', commandMode: 'prompt',
      origin: { kind: 'peer', peerId: 'original-peer' }, humanTurn: false, ...patch }, ...outer
  })
  return { ...f, key, plan, admission, captured, correlation, queued, project,
    capture: () => f.store.applyTimelineMutation({ type: 'append', agentSessionId: key.agentSessionId, item: captured }),
    async read(cursor?: string, limit = 100) {
      let page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: key.agentSessionId, limit, ...(cursor ? { cursor } : {}) })
      let pending: ConversationWindowAssembly | undefined
      for (;;) {
        const read = consumeConversationWindowPage(page, pending)
        if (read.kind === 'complete') return { page, snapshot: read.snapshot }
        pending = read.pending
        page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: key.agentSessionId, cursor: page.nextCursor!, limit })
      }
    }
  }
}

it('reads the exact native queued consumer as adoption of the original human input, preserving the unknown transport receipt and original author', async () => {
  const f = await fixture(); await f.capture(); await appendFile(f.path, jsonl([f.queued()]))
  const before = await f.bytes(), raw = await f.client.sessionHistoryPage(f.key.agentSessionId), item = raw.items[0]!
  expect(item).toMatchObject({ id: 'native-consumer', kind: 'activity', conversation: {
    nativeInput: { source, semanticItemId: 'native-consumer', queuedSubmissionId: f.correlation, clientCorrelation: f.correlation }, adoptedInput: { key: f.key }
  } })
  expect(item.turnId).toBeUndefined(); expect(item.conversation!.nativeInput!.turnId).toBeUndefined()
  const { page, snapshot } = await f.read()
  expect(snapshot.units).toHaveLength(1)
  const unit = snapshot.units[0]!
  expect(unit.records).toHaveLength(2); expect(unit.event.role).toBe('message'); expect(unit.event.author).toEqual({ kind: 'human' })
  const original = unit.records.find(record => record.original.kind === 'captured')!
  const native = unit.records.find(record => record.original.kind === 'native')!
  if (!isCompleteConversationRecord(native)) throw new Error('Expected the complete original native activity')
  expect(original.original.item).toEqual(f.captured)
  expect(unit.event.content).toEqual([
    { recordId: original.id, recordRevision: original.revision, selector: { kind: 'captured-field', field: 'content' }, placement: 'body' },
    { recordId: native.id, recordRevision: native.revision, selector: { kind: 'native-part', partIndex: 0 }, placement: 'detail' }
  ])
  expect(conversationNativeInputWitness(native)).toMatchObject({ queuedSubmissionId: f.correlation, key: f.key })
  expect(parseConversationUnit(unit, { hostId: 'local', agentSessionId: f.key.agentSessionId }, page.scope)).toEqual(unit)
  const reading = f.project(snapshot)
  expect(reading.records).toHaveLength(1)
  expect(reading.records[0]).toMatchObject({ rawId: f.captured.id, kind: 'user-message', source: { kind: 'captured', recordId: f.captured.id },
    content: f.captured.content, role: 'message', author: { kind: 'human' } })
  expect(reading.inputs).toHaveLength(1)
  expect(reading.inputs[0]).toMatchObject({ source: { kind: 'captured', submissionId: f.captured.id }, content: f.captured.content,
    author: { kind: 'human' }, inputRef: f.key })
  expect(reading.inputs[0]!.records).toHaveLength(2)
  expect(await f.bytes()).toEqual(before)
  const claim = await f.client.inspectAgentPromptSubmission(f.key)
  expect(claim?.admission).toEqual(f.admission)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('a native peer/meta consumer alone remains an activity with unknown author, and only the exact Core record supplies speech', async () => {
  const f = await fixture(); await appendFile(f.path, jsonl([f.queued('meta-consumer', { isMeta: true }, { isMeta: true })]))
  const nativeOnly = await f.read()
  expect(nativeOnly.snapshot.units).toHaveLength(1)
  expect(nativeOnly.snapshot.units[0]!.event).toMatchObject({ role: 'process', author: { kind: 'unknown' } })
  expect(nativeOnly.snapshot.units[0]!.records[0]!.original.item.kind).toBe('activity')
  await f.capture()
  const joined = await f.read()
  expect(joined.snapshot.units).toHaveLength(1)
  expect(joined.snapshot.units[0]!.event).toMatchObject({ role: 'message', author: { kind: 'human' } })
  expect(joined.snapshot.units[0]!.records).toHaveLength(2)
})

it('requires the complete frozen claim, correlation, source and exact prompt without settling or replaying the input', async () => {
  const f = await fixture(); await appendFile(f.path, jsonl([f.queued()]))
  const item = (await f.client.sessionHistoryPage(f.key.agentSessionId)).items[0]!
  const claim = () => ({ agentSessionId: f.key.agentSessionId, run: f.key.expectedRun, admission: structuredClone(f.admission) })
  const ref = { hostId: 'local', agentSessionId: f.key.agentSessionId }
  for (const mutation of [
    (record: AgentPromptSubmissionRecord) => { record.agentSessionId = 'foreign' },
    (record: AgentPromptSubmissionRecord) => { record.run = { runId: 'foreign' } },
    (record: AgentPromptSubmissionRecord) => { record.admission!.intent!.prompt += ' edited' },
    (record: AgentPromptSubmissionRecord) => { record.admission!.intent!.run = { runId: 'foreign' } },
    (record: AgentPromptSubmissionRecord) => { record.admission!.inputKey = { ...f.key, submissionId: 'different-input' } },
    (record: AgentPromptSubmissionRecord) => { record.admission!.intent!.plan = { ...f.plan, actorId: 'different-process' } },
    (record: AgentPromptSubmissionRecord) => { if (record.admission?.transport === 'native') record.admission.native.outcome = 'not-applied' },
    (record: AgentPromptSubmissionRecord) => { if (record.admission?.transport === 'native') {
      const { interactionQueue: _, ...plan } = f.plan
      record.admission.native.plan = plan
      record.admission.intent!.plan = record.admission.native.plan
    } }
  ]) {
    const record = claim(); mutation(record)
    const result = await confirmNativeInputAdoption(item, ref, source, async () => record)
    expect(result.conversation?.adoptedInput).toBeUndefined(); expect(result.contentParts).toEqual(item.contentParts)
    expect(result.conversationDiagnostic?.code).toBe('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
  }
  for (const changed of [
    { ...item, turnId: 'fabricated-turn' },
    { ...item, contentParts: [{ kind: 'text' as const, text: 'edited input' }] },
    { ...item, conversation: { ...item.conversation, nativeInput: { ...item.conversation!.nativeInput!, source: { ...source, nativeSessionId: 'foreign' } } } },
    { ...item, conversation: { ...item.conversation, nativeInput: { ...item.conversation!.nativeInput!, clientCorrelation: createNativeInputCorrelation(f.key) } } }
  ]) {
    const result = await confirmNativeInputAdoption(changed, ref, source, async () => claim())
    expect(result.conversation?.adoptedInput).toBeUndefined()
  }
  expect(f.admission).toEqual(claim().admission)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('uses only queued_command source_uuid, keeping wrong fields, generated records and edited bodies unconfirmed', async () => {
  const f = await fixture(); await f.capture()
  await appendFile(f.path, jsonl([
    f.queued('edited', { prompt: 'edited native queue content' }),
    f.queued('wrong-field', { source_uuid: 'foreign', delivery_id: f.correlation }),
    f.queued('wrong-mode', { commandMode: 'bash' }),
    f.queued('synthetic', {}, { isSynthetic: true }),
    f.queued('compact', {}, { isCompactSummary: true }),
    f.queued('child', {}, { isSidechain: true }),
    { sessionId: source.nativeSessionId, type: 'queue-operation', operation: 'enqueue', source_uuid: f.correlation, content: f.admission.intent!.prompt }
  ]))
  const raw = await f.client.sessionHistoryPage(f.key.agentSessionId)
  expect(raw.items).toHaveLength(6)
  expect(raw.items.every(item => item.conversation?.adoptedInput === undefined)).toBe(true)
  expect(raw.items.filter(item => item.conversation?.nativeInput).map(item => item.id)).toEqual(['edited'])
  expect(raw.items[0]!.conversationDiagnostic?.code).toBe('CONVERSATION_INPUT_ADOPTION_UNCONFIRMED')
  const result = await f.read()
  expect(result.snapshot.units.every(unit => unit.records.length === 1)).toBe(true)
})

it('keeps duplicate native consumers ambiguous rather than selecting one by order, text or delivery id', async () => {
  const f = await fixture(); await f.capture()
  await appendFile(f.path, jsonl([f.queued('first'), f.queued('second', { delivery_id: 'different-delivery' })]))
  const result = await f.read()
  expect(result.snapshot.units).toHaveLength(3)
  expect(result.snapshot.units.every(unit => unit.records.length === 1)).toBe(true)
  expect(result.snapshot.coverage.flatMap(coverage => coverage.gaps).map(gap => gap.code)).toContain('CONVERSATION_INPUT_ADOPTION_AMBIGUOUS')
})

it('preserves strict turn and queued target alternatives through provenance and wire identities', async () => {
  const f = await fixture()
  const nativeInput = { source, semanticItemId: 'native-consumer', queuedSubmissionId: f.correlation, clientCorrelation: f.correlation }
  expect(parseConversationProvenance({ nativeInput })).toEqual({ nativeInput })
  for (const target of [{}, { turnId: 'turn', queuedSubmissionId: f.correlation }]) {
    const { queuedSubmissionId: _, ...base } = nativeInput
    expect(() => parseConversationProvenance({ nativeInput: { ...base, ...target } })).toThrow()
  }
  const record = { hostId: 'local', agentSessionId: f.key.agentSessionId, source: { kind: 'native' as const, ...source, recordId: 'physical-record' } }
  const common = { record, recordRevision: 'revision', semanticItemId: 'native-consumer', clientCorrelation: f.correlation }
  expect(conversationInputWitnessGroup({ ...common, queuedSubmissionId: f.correlation })).not.toBe(conversationInputWitnessGroup({ ...common, turnId: f.correlation }))
})
