import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { projectConversationTimeline, conversationTailComesAfter, conversationRecordId, conversationRevision, conversationSourceKey,
  type ConversationSourceRecord, type ConversationSourceRef, type ConversationSourceCoverage } from './conversation-timeline.js'
import { parseConversationTimelineReadInput, parseConversationChangesInput, parseConversationFrontier, parseConversationReadPage, parseConversationChangesPage,
  CONVERSATION_DEFAULT_READ_BYTES, CONVERSATION_MAX_UNIT_BYTES, type ConversationTimelineReadInput, type ConversationChangesInput, type ConversationFrontier,
  type ConversationCheckpointPage, type AgentConversationReadPage, type ConversationChangesPage, type ConversationUnit, type ConversationUnitEntry, type ConversationVersionedAnchor } from './conversation-changes.js'
import type { NativeConversationCheckpoint, NativeConversationChangesPage } from './session-history-changes.js'
import type { ConversationRef, ConversationItemRef } from './conversation.js'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryPage, AgentSessionHistoryItem, AgentCapturedTimelineRead, AgentCapturedTimelinePage } from './types.js'

export type ConversationReaderPort = {
  descriptor: AgentSessionHistoryDescriptor
  /** Already selected SDK route; changes only the result envelope, never source refs. */
  readHostId?: string
  captured(input: AgentCapturedTimelineRead): Promise<AgentCapturedTimelinePage>
  nativePage(cursor?: string): Promise<AgentSessionHistoryPage>
  nativeCheckpoint(): Promise<NativeConversationCheckpoint>
  nativeChanges(checkpoint: NativeConversationCheckpoint): Promise<NativeConversationChangesPage>
  nativeRecord(source: { providerId: string; nativeSessionId: string }, id: string): Promise<AgentSessionHistoryItem>
  signal?: AbortSignal
}
type Position = { native?: string | null; nativeHead?: { record: Locator; after: string | null };  capturedBefore?: number | null; capturedCut?: { epoch: string; sequence: number }; unavailable?: ConversationSourceCoverage[] }
type Locator = { id: string; reference: ConversationItemRef; revision: string; order: ConversationSourceRecord['order']; source: 'native' | 'captured' }
type Batch = { records: Locator[]; events?: string[]; index: number; offset: number; digests: { id: string; sha256: string }[];
  after: Position; coverage: ConversationSourceCoverage[]; end?: ConversationFrontier; more: boolean }
type Cursor = ConversationRef & { version: 1; mode: 'inspect' | 'changes'; scope: ConversationFrontier['scope']; position: Position;
  batch?: Batch; checkpoint?: ConversationFrontier; anchor?: ConversationVersionedAnchor }
const key = randomBytes(32)
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fail = (message: string, code = 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'): never => { throw new AgentMuxError(message, code) }
const same = (a: unknown, b: unknown) => conversationRevision(a) === conversationRevision(b)
function encode(value: Cursor): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url')
}
function decode(cursor: string, expected: ConversationRef, mode: Cursor['mode']): Cursor {
  try {
    const [body, signature, extra] = cursor.split('.'); if (!body || !signature || extra) throw Error()
    const digest = createHmac('sha256', key).update(body).digest(), actual = Buffer.from(signature, 'base64url')
    if (digest.length !== actual.length || !timingSafeEqual(digest, actual)) throw Error()
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor
    if (value.version !== 1 || value.mode !== mode || value.hostId !== expected.hostId || value.agentSessionId !== expected.agentSessionId) throw Error()
    return value
  } catch { return fail('Conversation continuation expired, changed source or belongs to another exact read. Retain its original checkpoint.') }
}
const nativeSource = (port: ConversationReaderPort): ConversationSourceRef => {
  const history = port.descriptor.history, providerId = history?.providerId
  if (!providerId) return fail('The retained Session has no original Provider identity.', 'UNKNOWN_AGENT_SESSION')
  return history?.nativeHandle?.kind === 'provider' ? { kind: 'native', providerId, nativeSessionId: history.nativeHandle.sessionId }
    : { kind: 'native-unavailable', providerId }
}
function initialCoverage(source: ConversationSourceRef): ConversationSourceCoverage {
  return { source, origin: 'unknown', readExtent: { through: 'unread' }, earlier: 'unknown-before', current: 'partial', gaps: [] }
}
function unavailable(source: ConversationSourceRef, error: unknown, from?: string): ConversationSourceCoverage {
  const code = error instanceof AgentMuxError ? error.code : 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'
  const message = error instanceof Error ? error.message : 'The original source is unavailable; its read boundary is retained.'
  return { ...initialCoverage(source), current: code.includes('UNSUPPORTED') ? 'unsupported' : 'unavailable',
    readExtent: { ...(from ? { from } : {}), through: from ?? 'unread' }, gaps: [{ code, message }] }
}
const rejectedCut = (error: unknown) => error instanceof AgentMuxError && ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'AGENT_SESSION_HISTORY_INVALID_CURSOR', 'CONTROL_PROTOCOL_ERROR'].includes(error.code)
async function discover(ref: ConversationRef, port: ConversationReaderPort): Promise<{ scope: ConversationFrontier['scope']; coverage: ConversationSourceCoverage[]; position: Position }> {
  const native = nativeSource(port), coverage = [native.kind === 'native' ? initialCoverage(native) : unavailable(native, new AgentMuxError('The original native Session ID is not accepted. Captured reading remains available.', 'AGENT_CONVERSATION_NATIVE_UNAVAILABLE'))]
  try {
    const page = await port.captured({ limit: 1 }), source = { kind: 'captured' as const, epoch: page.stream.epoch }
    coverage.push({ source, origin: page.stream.origin, readExtent: { through: String(page.stream.sequence) }, earlier: page.records.length ? 'more' : page.stream.origin === 'beginning' ? 'complete' : 'unknown-before', current: 'partial', gaps: page.stream.gaps })
    return { scope: { sources: coverage.map(c => c.source) }, coverage, position: { capturedCut: { epoch: page.stream.epoch, sequence: page.stream.sequence } } }
  } catch (error) {
    port.signal?.throwIfAborted(); coverage.push(unavailable({ kind: 'captured' }, error))
    return { scope: { sources: coverage.map(c => c.source) }, coverage, position: { capturedBefore: null } }
  }
}
export async function conversationCheckpoint(ref: ConversationRef, port: ConversationReaderPort): Promise<ConversationCheckpointPage> {
  port.signal?.throwIfAborted()
  const found = await discover(ref, port), cuts: ConversationFrontier['cuts'][number][] = []
  if (found.position.capturedCut) cuts.push({ kind: 'captured', ...found.position.capturedCut })
  const native = found.scope.sources.find(s => s.kind === 'native')
  if (native) {
    try {
      const checkpoint = await port.nativeCheckpoint()
      if (checkpoint.source.providerId !== native.providerId || checkpoint.source.nativeSessionId !== native.nativeSessionId) return fail('The original native source changed before its checkpoint.')
      cuts.unshift({ kind: 'native', checkpoint })
      const c = found.coverage.find(c => c.source.kind === 'native')!; c.current = 'complete-through-cut'; c.readExtent = { through: checkpoint.cursor }
    } catch (error) { port.signal?.throwIfAborted(); found.coverage[found.coverage.findIndex(c => c.source.kind === 'native')] = unavailable(native, error) }
  }
  const checkpoint: ConversationFrontier = { ...ref, scope: found.scope, cuts }
  const target = { ...ref, hostId: port.readHostId ?? ref.hostId }
  return { ...target, sourceHostId: ref.hostId, scope: found.scope, checkpoint: { ...target, sourceHostId: ref.hostId, frontier: checkpoint }, coverage: found.coverage }
}
function projection(ref: ConversationRef, accepted: ConversationFrontier['scope'], rows: ConversationSourceRecord[], coverage: ConversationSourceCoverage[]) {
  const native = rows.filter(r => r.original.kind === 'native'), captured = rows.filter(r => r.original.kind === 'captured')
  const source = accepted.sources.find((s): s is Extract<ConversationSourceRef, { kind: 'native' }> => s.kind === 'native')
  const stream = accepted.sources.find((s): s is Extract<ConversationSourceRef, { kind: 'captured' }> => s.kind === 'captured')
  const timeline = projectConversationTimeline({ agentSessionId: ref.agentSessionId, executionHostId: ref.hostId,
    ...(native.length && source ? { historyPage: { agentSessionId: ref.agentSessionId, source, items: native.map(r => (r.original as { kind: 'native'; item: AgentSessionHistoryItem }).item), nextCursor: null } } : {}),
    ...(captured.length ? { timeline: { agentSessionId: ref.agentSessionId, revision: 0, items: captured.map(r => (r.original as Extract<ConversationSourceRecord['original'], { kind: 'captured' }>).item) } } : {}),
    sourceOrders: new Map(rows.map(r => [r.id, r.order])), coverage })
  const records = new Map(timeline.records.map(record => [record.id, record]))
  // The original committed revision is retained; the normal form uses the same Core version hash.
  for (const row of rows) if (records.get(row.id)?.revision !== row.revision) return fail('An original record version changed during the frozen read.')
  const units = timeline.events.map(event => ({ event, records: event.recordIds.map(id => records.get(id)!) }))
  if (units.some(unit => Buffer.byteLength(JSON.stringify(unit)) > CONVERSATION_MAX_UNIT_BYTES)) return fail('The original conversation unit exceeds its assembly bound. Its source and cut are retained.', 'AGENT_SESSION_HISTORY_BUDGET')
  return { units, coverage: timeline.coverage as ConversationSourceCoverage[], order: timeline.order }
}
function row(ref: ConversationRef, original: ConversationSourceRecord['original'], order: ConversationSourceRecord['order'], version?: string): ConversationSourceRecord {
  if (order.kind === 'native-page') order = { ...order, source: { providerId: order.source.providerId, nativeSessionId: order.source.nativeSessionId } }
  const source = original.kind === 'native' && order.kind === 'native-page' ? { kind: 'native' as const, ...order.source, recordId: original.item.id } : { kind: 'captured' as const, recordId: original.item.id }
  const reference = { hostId: ref.hostId, agentSessionId: ref.agentSessionId, source }
  return { id: conversationRecordId(reference), reference, revision: version ?? conversationRevision(original.item), order, original }
}
async function recover(ref: ConversationRef, port: ConversationReaderPort, state: Cursor): Promise<ConversationSourceRecord[]> {
  const batch = state.batch!, rows: ConversationSourceRecord[] = []
  for (const locator of batch.records) {
    port.signal?.throwIfAborted()
    if (locator.source === 'native' && locator.order.kind === 'native-page') {
      const record = await port.nativeRecord(locator.order.source, locator.reference.source.recordId)
      const value = row(ref, { kind: 'native', item: record }, locator.order)
      if (value.id !== locator.id || value.revision !== locator.revision) return fail('The exact native version is unavailable. Retain the original cursor/anchor; latest content cannot replace it.')
      rows.push(value)
    } else if (locator.order.kind === 'captured-stream') {
      const through = batch.end?.cuts.find(c => c.kind === 'captured') ?? state.position.capturedCut
      const page = await port.captured({ epoch: locator.order.epoch, ...(through ? { throughSequence: 'sequence' in through ? through.sequence : 0 } : {}), recordId: locator.reference.source.recordId, recordRevision: locator.revision, limit: 1 })
      const record = page.records[0]
      if (!record || record.revision !== locator.revision) return fail('The exact captured version is unavailable. Retain the original anchor and cut.')
      rows.push(row(ref, { kind: 'captured', item: record.item }, locator.order, record.revision))
    } else return fail('The original record has no accurate source order.')
  }
  return rows
}
async function inspectBatch(ref: ConversationRef, port: ConversationReaderPort, state: Cursor): Promise<{ rows: ConversationSourceRecord[]; batch: Batch }> {
  const candidates: ConversationSourceRecord[] = [], after: Position = { ...state.position }, coverage = state.scope.sources.map(source => state.position.unavailable?.find(c => conversationSourceKey(c.source) === conversationSourceKey(source)) ?? initialCoverage(source))
  const native = state.scope.sources.find((s): s is Extract<ConversationSourceRef, { kind: 'native' }> => s.kind === 'native')
  let nativeAfter: string | null = state.position.native ?? null, capturedAfter: number | null = state.position.capturedBefore ?? null
  if (native && state.position.native !== null) {
    try {
      if (state.position.nativeHead) {
        const saved = state.position.nativeHead.record
        const item = await port.nativeRecord(native, saved.reference.source.recordId)
        const value = row(ref, { kind: 'native', item }, saved.order)
        if (value.revision !== saved.revision) return fail('The original native tail candidate changed; retain this continuation.')
        candidates.push(value); nativeAfter = state.position.nativeHead.after
      } else {
        const page = await port.nativePage(state.position.native)
        if (page.source.providerId !== native.providerId || page.source.nativeSessionId !== native.nativeSessionId || page.agentSessionId !== ref.agentSessionId || page.items.length > 1) return fail('Native history left its frozen source window.')
        const item = page.items[0]
        if (item) candidates.push(row(ref, { kind: 'native', item }, { kind: 'native-page', source: page.source, indexInPage: 0 }))
        nativeAfter = page.nextCursor
      }
      if (!candidates.length) after.native = nativeAfter
      const c = coverage.find(c => c.source.kind === 'native')!; c.earlier = nativeAfter ? 'more' : 'unknown-before'; c.readExtent = { ...(state.position.native ? { from: state.position.native } : {}), through: nativeAfter ?? 'source-page-end' }
    } catch (error) { port.signal?.throwIfAborted(); const failure = unavailable(native, error, state.position.native ?? undefined); failure.gaps = failure.gaps.map(gap => ({ ...gap, continuation: encode({ ...ref, version: 1, mode: 'inspect', scope: { sources: [native] }, position: { ...(state.position.native === undefined ? {} : { native: state.position.native }), ...(state.position.nativeHead ? { nativeHead: state.position.nativeHead } : {}), capturedBefore: null } }) })); coverage[coverage.findIndex(c => c.source.kind === 'native')] = failure; after.unavailable = [...(after.unavailable ?? []).filter(c => c.source.kind !== 'native'), failure]; after.native = null; delete after.nativeHead }
  }
  const captured = state.scope.sources.find(s => s.kind === 'captured')
  if (captured && state.position.capturedCut && state.position.capturedBefore !== null) {
    try {
      const page = await port.captured({ epoch: state.position.capturedCut.epoch, throughSequence: state.position.capturedCut.sequence, ...(state.position.capturedBefore === undefined ? {} : { beforeFirstSequence: state.position.capturedBefore }), limit: 1 })
      const record = page.records[0]
      if (record) candidates.push(row(ref, { kind: 'captured', item: record.item }, { kind: 'captured-stream', epoch: page.stream.epoch, firstSequence: record.firstSequence }, record.revision))
      else after.capturedBefore = page.nextBeforeFirstSequence
      capturedAfter = page.nextBeforeFirstSequence
      const c = coverage.find(c => c.source.kind === 'captured')!; c.origin = page.stream.origin; c.gaps = page.stream.gaps; c.earlier = page.more ? 'more' : page.stream.origin === 'beginning' ? 'complete' : 'unknown-before'; c.readExtent = { through: String(page.stream.sequence) }
    } catch (error) { port.signal?.throwIfAborted(); const failure = unavailable(captured, error); failure.gaps = failure.gaps.map(gap => ({ ...gap, continuation: encode({ ...ref, version: 1, mode: 'inspect', scope: { sources: [captured] }, position: { native: null, ...(state.position.capturedCut ? { capturedCut: state.position.capturedCut } : {}), ...(state.position.capturedBefore === undefined ? {} : { capturedBefore: state.position.capturedBefore }) } }) })); coverage[coverage.findIndex(c => c.source.kind === 'captured')] = failure; after.unavailable = [...(after.unavailable ?? []).filter(c => c.source.kind !== 'captured'), failure]; after.capturedBefore = null }
  }
  for (let i = 0; i < coverage.length; i++) if (coverage[i]!.source.kind === 'native-unavailable' || coverage[i]!.source.kind === 'captured' && !state.position.capturedCut) coverage[i] = unavailable(coverage[i]!.source, new AgentMuxError('This original scope has no accepted source identity. Read a new explicit scope to discover one.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'))
  // The same pure tail policy orders both API traversal and the browser's complete
  // accepted fact set. A typed same-event pair is one unit; other candidates wait.
  const projected = projection(ref, state.scope, candidates, coverage), selected = projected.units.at(-1)
  const selectedIds = new Set(selected?.event.recordIds ?? [])
  for (const candidate of candidates) {
    if (candidate.original.kind === 'native') {
      if (selectedIds.has(candidate.id)) { after.native = nativeAfter; delete after.nativeHead }
      else after.nativeHead = { record: { id: candidate.id, reference: candidate.reference!, revision: candidate.revision, order: candidate.order, source: 'native' }, after: nativeAfter }
    } else if (selectedIds.has(candidate.id)) after.capturedBefore = capturedAfter
  }
  const rows = candidates
  return { rows, batch: { records: rows.map(r => ({ id: r.id, reference: r.reference!, revision: r.revision, order: r.order, source: r.original.kind })), index: 0, offset: 0, digests: [], after,
    events: selected ? [selected.event.id] : [], coverage: projected.coverage, more: !!after.nativeHead || native !== undefined && after.native !== null || !!state.position.capturedCut && after.capturedBefore !== null } }
}
async function changesBatch(ref: ConversationRef, port: ConversationReaderPort, state: Cursor): Promise<{ rows: ConversationSourceRecord[]; batch: Batch }> {
  const checkpoint = state.checkpoint!, rows: ConversationSourceRecord[] = [], coverage = state.scope.sources.map(initialCoverage), cuts = [...checkpoint.cuts]
  let more = false
  for (const source of state.scope.sources) {
    const at = coverage.findIndex(c => conversationSourceKey(c.source) === conversationSourceKey(source))
    if (source.kind === 'native') {
      const cut = cuts.find(c => c.kind === 'native' && c.checkpoint.source.providerId === source.providerId && c.checkpoint.source.nativeSessionId === source.nativeSessionId)
      if (!cut || cut.kind !== 'native') { coverage[at] = unavailable(source, new AgentMuxError('This frontier has no accepted native changes cut; an explicit new checkpoint is required.', 'AGENT_CONVERSATION_CHANGES_UNSUPPORTED')); continue }
      try {
        const page = await port.nativeChanges(cut.checkpoint)
        rows.push(...page.items.map((item, indexInPage) => row(ref, { kind: 'native', item }, { kind: 'native-page', source, indexInPage })))
        cuts[cuts.indexOf(cut)] = { kind: 'native', checkpoint: page.checkpoint }; more ||= page.more
        coverage[at] = { ...initialCoverage(source), current: page.more ? 'partial' : 'complete-through-cut', readExtent: { from: cut.checkpoint.cursor, through: page.checkpoint.cursor } }
      } catch (error) { port.signal?.throwIfAborted(); if (rejectedCut(error)) throw error; coverage[at] = unavailable(source, error, cut.checkpoint.cursor) }
    } else if (source.kind === 'captured' && source.epoch) {
      const cut = cuts.find(c => c.kind === 'captured' && c.epoch === source.epoch)
      if (!cut || cut.kind !== 'captured') { coverage[at] = unavailable(source, new AgentMuxError('This frontier has no committed captured cut; retain it and establish a new explicit scope.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE')); continue }
      try {
        const current = await port.captured({ limit: 1 })
        // afterSequence is a query lower bound, not proof the caller's old cut exists.
        if (current.stream.epoch !== cut.epoch || cut.sequence > current.stream.sequence) return fail('Captured checkpoint is from another epoch or the future. The original frontier is retained.')
        const page = await port.captured({ epoch: cut.epoch, afterSequence: cut.sequence, throughSequence: current.stream.sequence, limit: 1 })
        const record = page.records[0]
        if (!record && current.stream.sequence !== cut.sequence) return fail('The captured committed range is unavailable; an empty query cannot advance it.', 'AGENT_CONVERSATION_CAPTURED_GAP')
        if (record) rows.push(row(ref, { kind: 'captured', item: record.item }, { kind: 'captured-stream', epoch: cut.epoch, firstSequence: record.firstSequence }, record.revision))
        const sequence = record?.sequence ?? cut.sequence
        cuts[cuts.indexOf(cut)] = { kind: 'captured', epoch: cut.epoch, sequence }; more ||= sequence < current.stream.sequence
        coverage[at] = { source, origin: page.stream.origin, readExtent: { from: String(cut.sequence), through: String(sequence) }, earlier: page.stream.origin === 'beginning' ? 'complete' : 'unknown-before', current: sequence < current.stream.sequence ? 'partial' : 'complete-through-cut', gaps: page.stream.gaps }
      } catch (error) { port.signal?.throwIfAborted(); if (rejectedCut(error)) throw error; coverage[at] = unavailable(source, error, String(cut.sequence)) }
    } else coverage[at] = unavailable(source, new AgentMuxError('The original frontier has no resolved source identity. Later discovery requires a new explicit checkpoint.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'))
  }
  return { rows, batch: { records: rows.map(r => ({ id: r.id, reference: r.reference!, revision: r.revision, order: r.order, source: r.original.kind })), index: 0, offset: 0, digests: [], after: state.position, coverage, end: { ...ref, scope: state.scope, cuts }, more } }
}
async function anchorBatch(input: ConversationTimelineReadInput, port: ConversationReaderPort, state: Cursor) {
  const anchor = input.anchor!, rows: ConversationSourceRecord[] = [], source = anchor.record.source, coverage = state.scope.sources.map(initialCoverage)
  try {
    if (source.kind === 'native') {
      const item = await port.nativeRecord(source, source.recordId), value = row(input, { kind: 'native', item }, { kind: 'native-page', source, indexInPage: 0 })
      if (value.revision !== anchor.revision) return fail('This original native version is unavailable; latest content cannot replace the anchor.')
      rows.push(value)
    } else {
      const cut = anchor.frontier.frontier.cuts.find(c => c.kind === 'captured')
      if (!cut || cut.kind !== 'captured') return fail('The original captured anchor has no accepted cut.')
      const page = await port.captured({ epoch: cut.epoch, throughSequence: cut.sequence, recordId: source.recordId, recordRevision: anchor.revision, limit: 1 }), record = page.records[0]
      if (!record) return fail('The original captured version is unavailable; latest content cannot replace it.')
      rows.push(row(input, { kind: 'captured', item: record.item }, { kind: 'captured-stream', epoch: cut.epoch, firstSequence: record.firstSequence }, record.revision))
    }
  } catch (error) {
    port.signal?.throwIfAborted()
    const kind = source.kind, index = coverage.findIndex(c => c.source.kind === kind)
    if (index >= 0) coverage[index] = { ...unavailable(coverage[index]!.source, error), gaps: [{ code: 'AGENT_CONVERSATION_VERSION_UNAVAILABLE', message: error instanceof Error ? error.message : 'The original version is unavailable.', record: anchor.record }] }
  }
  return { rows, batch: { records: rows.map(r => ({ id: r.id, reference: r.reference!, revision: r.revision, order: r.order, source: r.original.kind })), index: 0, offset: 0, digests: [], after: { native: null, capturedBefore: null }, coverage, more: false } as Batch }
}
async function read(input: ConversationTimelineReadInput | ConversationChangesInput, port: ConversationReaderPort, mode: Cursor['mode']): Promise<AgentConversationReadPage | ConversationChangesPage> {
  port.signal?.throwIfAborted()
  const ref = { hostId: input.hostId, agentSessionId: input.agentSessionId }
  let state: Cursor
  if (input.cursor) {
    state = decode(input.cursor, ref, mode)
    if (mode === 'changes' && !same(state.checkpoint, (input as ConversationChangesInput).checkpoint.frontier) || !same(state.anchor, 'anchor' in input ? input.anchor : undefined)) return fail('The continuation belongs to another original frontier or anchor.')
  } else if (mode === 'changes') {
    const checkpoint = (input as ConversationChangesInput).checkpoint.frontier
    state = { ...ref, version: 1, mode, scope: checkpoint.scope, checkpoint, position: {} }
  } else if ('anchor' in input && input.anchor) state = { ...ref, version: 1, mode, scope: input.anchor.frontier.frontier.scope, anchor: input.anchor, position: {} }
  else { const found = await discover(ref, port); state = { ...ref, version: 1, mode, scope: found.scope, position: found.position } }
  let rows: ConversationSourceRecord[], batch: Batch
  if (state.batch) { batch = state.batch; rows = await recover(ref, port, state) }
  else { const loaded = mode === 'changes' ? await changesBatch(ref, port, state) : 'anchor' in input && input.anchor ? await anchorBatch(input, port, state) : await inspectBatch(ref, port, state); rows = loaded.rows; batch = loaded.batch; state.batch = batch }
  const projected = projection(ref, state.scope, rows, batch.coverage), units = projected.units.filter(unit => !batch.events || batch.events.includes(unit.event.id)).reverse()
  const digests = units.map(unit => ({ id: unit.event.id, sha256: hash(JSON.stringify(unit)) }))
  if (batch.digests.length && !same(batch.digests, digests)) return fail('The frozen semantic unit changed before its complete bytes were read.')
  batch.digests = digests
  const budgetBytes = input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES, items: ConversationUnitEntry[] = []
  const next = (index: number, offset: number): string | null => {
    if (index < units.length) return encode({ ...state, batch: { ...batch, index, offset } })
    return mode === 'inspect' && batch.more ? encode({ ...state, position: batch.after, batch: undefined } as unknown as Cursor) : null
  }
  const target = { ...ref, hostId: port.readHostId ?? ref.hostId }
  const result = (index: number, offset: number, entries = items) => ({ ...target, sourceHostId: ref.hostId, scope: state.scope, coverage: projected.coverage, order: { ...projected.order, direction: 'newest-first' as const }, items: entries, nextCursor: next(index, offset), budgetBytes,
    ...(mode === 'changes' ? { checkpoint: { ...target, sourceHostId: ref.hostId, frontier: index < units.length ? state.checkpoint! : batch.end! }, more: index < units.length || batch.more } : {}) })
  const fits = (entry: ConversationUnitEntry, index: number, offset: number) => Buffer.byteLength(JSON.stringify(result(index, offset, [...items, entry]))) <= budgetBytes
  let index = batch.index, offset = batch.offset
  while (index < units.length && items.length < (input.limit ?? 30)) {
    const unit = units[index]!, buffer = Buffer.from(JSON.stringify(unit)), whole: ConversationUnitEntry = { kind: 'item', item: unit }
    if (!offset && fits(whole, index + 1, 0)) { items.push(whole); index++; continue }
    const fragment = (length: number): ConversationUnitEntry => ({ kind: 'fragment', itemId: unit.event.id, encoding: 'json-utf8-base64', sha256: digests[index]!.sha256, offsetBytes: offset, totalBytes: buffer.length, dataBase64: buffer.subarray(offset, offset + length).toString('base64') })
    let low = 0, high = buffer.length - offset
    while (low < high) { const middle = Math.ceil((low + high) / 2), complete = offset + middle === buffer.length; if (fits(fragment(middle), complete ? index + 1 : index, complete ? 0 : offset + middle)) low = middle; else high = middle - 1 }
    if (!low) break
    items.push(fragment(low)); offset += low; if (offset === buffer.length) { index++; offset = 0 }; break
  }
  const page = result(index, offset)
  if (Buffer.byteLength(JSON.stringify(page)) > budgetBytes || index < units.length && !items.length) return fail('The original unit and continuation cannot fit this budget. Increase maxBytes; no record or cut was skipped.', 'AGENT_SESSION_HISTORY_BUDGET')
  return mode === 'changes' ? parseConversationChangesPage(page, { ...input, ...target, checkpoint: { ...(input as ConversationChangesInput).checkpoint, ...target } } as ConversationChangesInput) : parseConversationReadPage(page, { ...input, ...target })
}
export async function readAgentConversation(input: ConversationTimelineReadInput, port: ConversationReaderPort): Promise<AgentConversationReadPage> {
  return await read(parseConversationTimelineReadInput(input), port, 'inspect') as AgentConversationReadPage
}
export async function readConversationChanges(input: ConversationChangesInput, port: ConversationReaderPort): Promise<ConversationChangesPage> {
  return await read(parseConversationChangesInput(input), port, 'changes') as ConversationChangesPage
}

type RouteCursor = { version: 'conversation-route.v1'; routeHostId: string; agentSessionId: string; sourceHostId: string; cursor: string }
function routeCursor(value: RouteCursor): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update('conversation-route\0').update(body).digest('base64url')
}
function originalRouteCursor(cursor: string, input: ConversationRef): RouteCursor {
  try {
    const [body, signature, extra] = cursor.split('.'); if (!body || !signature || extra) throw Error()
    const expected = createHmac('sha256', key).update('conversation-route\0').update(body).digest(), actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error()
    const p = rpcRecord(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), ['version', 'routeHostId', 'agentSessionId', 'sourceHostId', 'cursor'])
    if (p.version !== 'conversation-route.v1' || p.routeHostId !== input.hostId || p.agentSessionId !== input.agentSessionId ||
      typeof p.sourceHostId !== 'string' || !p.sourceHostId || typeof p.cursor !== 'string' || !p.cursor) throw Error()
    return p as RouteCursor
  } catch { return fail('This conversation continuation belongs to another original route, Session or source. Retain its checkpoint.') }
}
/** The selected route owner unwraps only its own envelope. Original source bytes,
 * frontier refs, anchors and opaque source cursors are never relabelled. */
export function forwardConversationInput<T extends ConversationTimelineReadInput | ConversationChangesInput>(input: T): { input: T; sourceHostId?: string } {
  const continuation = input.cursor ? originalRouteCursor(input.cursor, input) : undefined
  const checkpoint = 'checkpoint' in input ? input.checkpoint : input.anchor?.frontier
  const sourceHostId = checkpoint?.sourceHostId ?? continuation?.sourceHostId
  if (checkpoint && checkpoint.hostId !== input.hostId || continuation && sourceHostId !== continuation.sourceHostId) return fail('Conversation route, anchor or frontier changed its original source.')
  return { input: { ...input, hostId: 'local', ...(continuation ? { cursor: continuation.cursor } : {}),
    ...('checkpoint' in input ? { checkpoint: { ...input.checkpoint, hostId: 'local' } } : {}),
    ...('anchor' in input && input.anchor ? { anchor: { ...input.anchor, frontier: { ...input.anchor.frontier, hostId: 'local' } } } : {}) },
    ...(sourceHostId ? { sourceHostId } : {}) }
}
export function forwardConversationPage<T extends AgentConversationReadPage>(page: T, input: ConversationTimelineReadInput, expectedSourceHostId?: string): T {
  if (page.hostId !== 'local' || page.agentSessionId !== input.agentSessionId || expectedSourceHostId !== undefined && expectedSourceHostId !== page.sourceHostId) return fail('The selected original route returned another conversation source.')
  const wrap = (cursor: string) => routeCursor({ version: 'conversation-route.v1', routeHostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: page.sourceHostId, cursor })
  return { ...page, hostId: input.hostId, budgetBytes: input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES,
    nextCursor: page.nextCursor === null ? null : wrap(page.nextCursor),
    coverage: page.coverage.map(source => ({ ...source, gaps: source.gaps.map(gap => gap.continuation ? { ...gap, continuation: wrap(gap.continuation) } : gap) })),
    ...('checkpoint' in page ? { checkpoint: { ...(page as unknown as ConversationChangesPage).checkpoint, hostId: input.hostId } } : {}) }
}
/** The same original read is reduced to fit its exact final route envelope. No
 * fragments are reassembled, re-encoded or acknowledged by this transport step. */
export async function readRoutedConversation<T extends AgentConversationReadPage>(input: ConversationTimelineReadInput,
  readOriginal: (input: ConversationTimelineReadInput) => Promise<T>, expectedSourceHostId?: string): Promise<T> {
  const budget = input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES
  let sourceBudget = budget
  for (let attempt = 0; attempt < 4; attempt++) {
    if (sourceBudget < 4096) break
    const page = await readOriginal({ ...input, maxBytes: sourceBudget }), result = forwardConversationPage(page, input, expectedSourceHostId)
    const overflow = Buffer.byteLength(JSON.stringify(result)) - budget
    if (overflow <= 0) return result
    sourceBudget -= overflow + 32
  }
  return fail('The original source unit and complete route envelope cannot fit this byte budget. Increase maxBytes; its original input and cut remain valid.', 'AGENT_SESSION_HISTORY_BUDGET')
}
