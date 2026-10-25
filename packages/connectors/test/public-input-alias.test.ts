import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createNativeInputCorrelation } from '../../core/src/native-input-correlation.js'
import { conversationNativeInputWitness, conversationRevision, projectConversationTimeline, type ConversationInputAdoptionContext, type ConversationCheckpoint, type ConversationChangesPage } from '@agentmux/core/conversation'
import type { AgentSessionHistoryItem, AgentTimelineItem } from '@agentmux/core'
import type { RoomBinding } from '@agentmux/core/connections'
import { PublicationStore } from '../src/publication-store.js'
import { publicationContent, publicationPartKey } from '../src/publication-content.js'
import type { ResolvedPublicationPart } from '../src/publication-resource.js'

const source = { providerId: 'codex', nativeSessionId: 'original-native' }
const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'original-input' }
const start: ConversationCheckpoint = { hostId: 'local', agentSessionId: 'recipient', sourceHostId: 'local', frontier: {
  hostId: 'local', agentSessionId: 'recipient', scope: { sources: [{ kind: 'captured', epoch: 'original-capture' }, { kind: 'native', ...source }] },
  cuts: [{ kind: 'captured', epoch: 'original-capture', sequence: 10, inputJournal: { queueId: 'original-queue', incarnation: 'original-incarnation', sequence: 10 } },
    { kind: 'native', checkpoint: { agentSessionId: 'recipient', source, cursor: 'original-start' } }]
} }
const binding = { bindingId: 'original-binding', revision: 1, connectionId: 'original-connection', application: { domain: 'chat.example', appId: 'original-app' },
  executionHostId: 'local', agentSessionId: 'recipient', externalConversationId: 'original-room', sourceFrontier: start,
  sourceCheckpoints: [{ agentSessionId: 'recipient', source, cursor: 'original-start' }], scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } } as RoomBinding
const capture = (input = key): AgentTimelineItem => ({ id: 'original-capture', agentSessionId: 'recipient', kind: 'user_message', source: 'user', title: 'User input', status: 'recorded',
  createdAt: 1, updatedAt: 1, content: 'Public body', authorHuman: true, publicContent: 'confirmed', inputRef: input,
  inputOrigin: { queueId: 'original-queue', incarnation: 'original-incarnation', sequence: 11 }, inputSubmission: { status: 'admitted', observation: 'owned' } })
const native = (id = 'original-native-input', input = key): AgentSessionHistoryItem => ({ id, kind: 'user-message', turnId: 'original-turn', conversation: {
  nativeInput: { source, semanticItemId: id, turnId: 'original-turn', clientCorrelation: createNativeInputCorrelation(input) }, adoptedInput: { key: input }
}, contentParts: [{ kind: 'text', text: 'Public body\nPrivate generated note', contentEligibility: 'unconfirmed' }] })

function fixture(mixed?: { imageFirst: boolean; attributed: boolean; trailingText?: boolean }) {
  const db = new DatabaseSync(':memory:'); let store = new PublicationStore(db), sequence = 10
  const commit = (captured: AgentTimelineItem[], items: AgentSessionHistoryItem[], context?: ConversationInputAdoptionContext, before = false) => {
    sequence++
    const timeline = projectConversationTimeline({ agentSessionId: 'recipient', executionHostId: 'local', historyPage: { agentSessionId: 'recipient', source, items, nextCursor: null },
      timeline: { agentSessionId: 'recipient', revision: sequence, items: captured, stream: { epoch: 'original-capture', sequence, revision: sequence, origin: 'beginning', gaps: [],
        positions: captured.map(item => ({ id: item.id, firstSequence: before ? 10 : sequence, sequence, revision: conversationRevision(item) })) } }, ...(context ? { inputAdoption: context } : {}) })
    const checkpoint: ConversationCheckpoint = { ...start, frontier: { ...start.frontier, cuts: [{ kind: 'captured', epoch: 'original-capture', sequence, inputJournal: { queueId: 'original-queue', incarnation: 'original-incarnation', sequence: 11 } },
      { kind: 'native', checkpoint: { agentSessionId: 'recipient', source, cursor: 'page-' + sequence } }] } }
    const units = timeline.events.map(event => ({ event, records: timeline.records.filter(record => event.recordIds.includes(record.id)) }))
    const page: ConversationChangesPage = { hostId: 'local', agentSessionId: 'recipient', sourceHostId: 'local', scope: start.frontier.scope, coverage: timeline.coverage,
      order: { ...timeline.order, direction: 'newest-first' }, items: [...units].reverse().map(item => ({ kind: 'item', item })), nextCursor: null, budgetBytes: 4 * 1024 * 1024, checkpoint, more: false,
      window: { id: 'original-window', revision: sequence, itemCount: units.length, complete: true, view: 'original-view', replay: 'original-replay', checkpoint, outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }
    const resolvedText = new Map<string, ResolvedPublicationPart>()
    if (mixed) {
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
      const image = { mimeType: 'image/png' as const, dataBase64: bytes.toString('base64'), byteLength: bytes.length, width: 1, height: 1, sha256: createHash('sha256').update(bytes).digest('hex') }
      for (const unit of units) for (const slot of unit.event.content) {
        const record = unit.records.find(record => record.id === slot.recordId)!
        const segments = mixed.imageFirst ? [{ text: '', image }, { text: 'Public body' }] : [{ text: 'Public body' }, { text: '', image }]
        if (mixed.trailingText) segments.push({ text: 'Trailing body' })
        resolvedText.set(publicationPartKey({ record: record.reference!, selector: slot.selector }), { kind: 'markdown', text: 'Public body', segments, complete: true })
      }
    }
    const speakers = mixed?.attributed ? new Map(units.map(unit => [unit.event.id, { kind: 'human' as const, name: 'Original user' }])) : undefined
    store.commitPage(binding, store.checkpoint(binding, 'local'), page, () => true, { units, resolvedText, ...(speakers ? { speakers } : {}) })
    return timeline
  }
  return { db, commit, get store() { return store }, reopen() { store = new PublicationStore(db) }, gaps: () => store.coverage(binding).gaps, operations: () => store.list(binding) }
}

it.each([[false, false], [false, true], [true, false], [true, true]])('qualifies mixed input with imageFirst=%s and attributed=%s', (imageFirst, attributed) => {
  const f = fixture({ imageFirst, attributed })
  try {
    f.commit([capture()], [])
    expect(f.operations().length).toBeGreaterThan(1)
    expect(f.store.qualifyPending(binding, f.operations()[0]!, new Map(), start)).toBe('qualified')
    expect(f.gaps()).toEqual([])
  } finally { f.db.close() }
})

it('qualifies mixed input across an observation change while retaining its uploaded pending image', () => {
  const f = fixture({ imageFirst: true, attributed: true })
  try {
    f.commit([capture()], [])
    const image = f.operations()[0]!
    expect(image.payload.kind).toBe('image')
    expect(f.store.claimResourceUpload(image.operationId, () => true)).toBeTruthy()
    const original = f.store.settleResourceUpload(image.operationId, 1, { state: 'confirmed', imageKey: 'original-image-key' })
    f.reopen()
    f.commit([{ ...capture(), inputSubmission: { status: 'admitted', observation: 'rejoin-needed' } }], [])
    expect(f.operations().filter(op => op.payload.kind === 'image')).toEqual([original])
    expect(f.store.qualifyPending(binding, original, new Map(), start)).toBe('qualified')
    const updated = f.operations().find(op => op.payload.kind === 'speech' && op.payload.inputSubmission?.observation === 'rejoin-needed')!
    expect(updated.sourceRevision).not.toBe(original.sourceRevision)
    expect(f.store.qualifyPending(binding, updated, new Map(), start)).toBe('qualified')
    expect(f.store.inspect(original.operationId)).toEqual(original)
  } finally { f.db.close() }
})

it.each(['text', 'observation', 'absent-observation'] as const)('rejects mixed input with altered %s in a retained speech fragment', change => {
  const f = fixture({ imageFirst: false, attributed: true, trailingText: true })
  try {
    f.commit([capture()], [])
    const speech = f.operations().filter(op => op.payload.kind === 'speech')
    expect(speech).toHaveLength(2)
    const altered = structuredClone(speech[1]!)
    if (altered.payload.kind !== 'speech') throw Error('The actual trailing speech is missing')
    if (change === 'text') altered.payload.text = 'Different unqualified text'
    else if (change === 'observation') altered.payload.inputSubmission = { status: 'admitted', observation: 'rejoin-needed' }
    else delete altered.payload.inputSubmission
    f.db.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(altered), altered.operationId)
    expect(f.store.qualifyPending(binding, f.operations()[1]!, new Map(), start)).toBe('cancelled')
    expect(f.operations().every(op => op.state === 'cancelled' && op.attempt === undefined)).toBe(true)
  } finally { f.db.close() }
})

it.each(['co-resident', 'captured-first', 'native-first'] as const)('retains the exact public span for %s aliases, version changes and reopen', order => {
  const f = fixture()
  try {
    const originalNative = native()
    if (order === 'co-resident') f.commit([capture()], [originalNative])
    if (order === 'captured-first') { f.commit([capture()], []); f.reopen(); f.commit([], [originalNative]) }
    if (order === 'native-first') {
      const timeline = f.commit([], [originalNative]); expect(f.gaps()).toHaveLength(1)
      const witness = conversationNativeInputWitness(timeline.records.find(record => record.original.kind === 'native')!)!
      f.reopen(); f.commit([capture()], [], { witnesses: [witness] })
    }
    expect(f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed'), JSON.stringify(f.db.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind') IN ('representation','gap')").all())).toEqual([]); expect(f.operations()).toHaveLength(1)
    expect(JSON.stringify(f.operations()[0]!.payload)).toContain('Public body'); expect(JSON.stringify(f.operations())).not.toContain('Private generated note')
    const operation = f.operations()[0]!, before = { operationId: operation.operationId, payload: operation.payload }
    const changed = structuredClone(originalNative); changed.contentParts = [{ kind: 'text', text: 'New private wrapper observation', contentEligibility: 'unconfirmed' }]
    f.commit([], [changed]); f.reopen(); f.commit([], [changed])
    expect(f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed'), JSON.stringify(f.db.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.kind') IN ('representation','gap')").all())).toEqual([]); expect(f.operations()).toHaveLength(1)
    expect({ operationId: f.operations()[0]!.operationId, payload: f.operations()[0]!.payload }).toEqual(before)
  } finally { f.db.close() }
})

it('does not turn a public non-input source declaration into an accepted captured input', () => {
  const item = { ...capture(), source: 'native-hook' as const }, timeline = projectConversationTimeline({ agentSessionId: 'recipient', executionHostId: 'local',
    timeline: { agentSessionId: 'recipient', revision: 1, items: [item], stream: { epoch: 'original-capture', sequence: 11, revision: 1, origin: 'beginning', gaps: [],
      positions: [{ id: item.id, firstSequence: 11, sequence: 11, revision: conversationRevision(item) }] } } })
  const plans = timeline.events.map(event => publicationContent({ event, records: timeline.records.filter(record => event.recordIds.includes(record.id)) }, binding, start, { resolved: new Map(), origin: () => undefined }))
  expect(plans.flatMap(plan => plan.pieces)).toHaveLength(1)
  expect(plans.flatMap(plan => plan.pieces).some(piece => piece.publicInputKey)).toBe(false)
})

it('keeps the wire unconfirmed when multiple captured public slots claim the same input', () => {
  const f = fixture()
  try {
    f.commit([capture(), { ...capture(), id: 'other-captured-claim' }], [native()])
    expect(f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed')).toHaveLength(1)
  } finally { f.db.close() }
})

it('retains the new gap when a previously observed native record changes semantic source facts', () => {
  const f = fixture()
  try {
    const original = native(); f.commit([capture()], [original]); expect(f.gaps()).toEqual([])
    const before = f.operations().map(operation => ({ operationId: operation.operationId, payload: operation.payload }))
    const changed = structuredClone(original); changed.conversation!.nativeInput!.semanticItemId = 'conflicting-semantic-source'
    f.commit([], [changed]); f.reopen()
    expect(f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed')).toHaveLength(1)
    expect(f.operations().map(operation => ({ operationId: operation.operationId, payload: operation.payload }))).toEqual(before)
  } finally { f.db.close() }
})

it('keeps a native text gap when the public input key belongs to another original', () => {
  const f = fixture()
  try {
    f.commit([capture()], [])
    f.commit([], [native('other-native', { ...key, submissionId: 'other-original' })])
    expect(f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed')).toHaveLength(1)
    expect(f.operations()).toHaveLength(1)
  } finally { f.db.close() }
})

it.each(['equal-text', 'no-public-span', 'before-cut', 'unconfirmed', 'ambiguous', 'resource'] as const)('does not suppress the independent %s gap', kind => {
  const f = fixture()
  try {
    const item = native(), captured = kind === 'no-public-span' ? [] : [capture()]
    if (kind === 'equal-text') { delete item.conversation; item.contentParts = [{ kind: 'text', text: 'Public body', contentEligibility: 'unconfirmed' }] }
    if (kind === 'resource') item.contentParts = [...item.contentParts, { kind: 'resource', resourceType: 'file', reference: 'independent-resource', contentEligibility: 'unconfirmed' }]
    if (kind === 'ambiguous') { f.commit(captured, []); captured.length = 0 }
    f.commit(captured, kind === 'ambiguous' ? [item, native('conflicting-native')] : [item], kind === 'unconfirmed' ? { unconfirmed: true, witnesses: [] } : undefined, kind === 'before-cut')
    const gaps = f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed')
    expect(gaps).toHaveLength(kind === 'ambiguous' ? 2 : 1)
    if (kind === 'resource') {
      expect(gaps[0]!.part?.selector).toEqual({ kind: 'native-part', partIndex: 1 })
      const before = f.operations().map(operation => ({ operationId: operation.operationId, payload: operation.payload }))
      f.commit([], [item])
      const retained = f.gaps().filter(gap => gap.reason === 'public-content-unconfirmed')
      expect(retained).toHaveLength(1); expect(retained[0]!.part?.selector).toEqual({ kind: 'native-part', partIndex: 1 })
      expect(f.operations().map(operation => ({ operationId: operation.operationId, payload: operation.payload }))).toEqual(before)
    }
  } finally { f.db.close() }
})
