import { deferConversationProcessRecord } from './conversation-process-detail.js'
import { mintObjectId } from './object-id.js'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { projectConversationStream, conversationRecordRole, conversationRecordId, conversationRevision, conversationSourceKey, conversationInputAdoptionEdges,
  type ConversationSourceRecord, type ConversationSourceRef, type ConversationSourceCoverage, type ConversationInputAdoptionContext } from './conversation-stream.js'
import { parseConversationTimelineReadInput, parseConversationChangesInput, parseConversationFrontier, parseConversationReadPage, parseConversationChangesPage,
  CONVERSATION_DEFAULT_READ_BYTES, CONVERSATION_MAX_UNIT_BYTES, CONVERSATION_MAX_WINDOW_RECORDS, type ConversationTimelineReadInput, type ConversationChangesInput, type ConversationFrontier,
  type ConversationCheckpointPage, type AgentConversationReadPage, type ConversationChangesPage, type ConversationUnit, type ConversationUnitEntry, type ConversationVersionedAnchor, type ConversationReadWindow } from './conversation-changes.js'
import type { NativeConversationCheckpoint, NativeConversationChangesPage } from './session-history-changes.js'
import type { ConversationRef, ConversationItemRef } from './conversation.js'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryPage, AgentSessionHistoryItem, AgentCapturedTimelineRead, AgentCapturedTimelinePage } from './types.js'

export type ConversationReaderPort = {
  state: ConversationReaderState
  descriptor: AgentSessionHistoryDescriptor
  /** Already selected SDK route; changes only the result envelope, never source refs. */
  readHostId?: string
  captured(input: AgentCapturedTimelineRead): Promise<AgentCapturedTimelinePage>
  nativePage(cursor: string | undefined, limit: number): Promise<AgentSessionHistoryPage>
  nativeCheckpoint(position?: 'beginning'): Promise<NativeConversationCheckpoint>
  nativeChanges(checkpoint: NativeConversationCheckpoint, limit: number): Promise<NativeConversationChangesPage>
  /** Original Provider interface fact. Unsupported sources retain complete process bodies. */
  nativeRecordAvailable?: boolean
  nativeRecord(source: { providerId: string; nativeSessionId: string }, id: string): Promise<AgentSessionHistoryItem>
  signal?: AbortSignal
}
type Position = { native?: string | null; capturedBefore?: number | null; capturedCut?: { epoch: string; sequence: number; inputJournal?: import('./agent-input-conversation.js').AgentInputJournalCut }; unavailable?: ConversationSourceCoverage[] }
type Batch = { index: number; offset: number; digests: { id: string; sha256: string }[];
  after: Position; coverage: ConversationSourceCoverage[]; end?: ConversationFrontier; more: boolean }
type Cursor = ConversationRef & { processDetails?: 'deferred'; version: 1; mode: 'inspect' | 'changes'; scope: ConversationFrontier['scope']; position: Position;
  batch?: Pick<Batch, 'index' | 'offset'>; checkpoint?: ConversationFrontier; anchor?: ConversationVersionedAnchor; viewId?: string; viewRevision?: number; snapshotId?: string; pageIndex?: number; direction?: 'newer'; preserveCurrent?: true }
type HistoryPosition = { position: Position; after: Position; checkpoint: ConversationFrontier; limit: number; more: boolean;
  native?: { witness: string; first: string; last: string; count: number };
  captured?: { first: number; last: number; count: number };
  head?: { page: AgentSessionHistoryPage; rows: ConversationSourceRecord[] } }
type CompleteUnit = ReturnType<typeof projection>['units'][number]
type Snapshot = { rows: ConversationSourceRecord[]; batch: Batch; units: CompleteUnit[]; deferredUnits?: ConversationUnit[]; coverage: ConversationSourceCoverage[];
  order: ReturnType<typeof projection>['order']; revision: number; checkpoint: ConversationFrontier; committed: boolean; requestKey: string; outside: ConversationReadWindow['outside']; history: HistoryPosition[]; anchor?: ConversationReadWindow['anchor']; inputAdoption: ConversationInputAdoptionContext; navigation?: ReturnType<typeof historyNavigation> }
type ReadingView = ConversationRef & { processDetails?: 'deferred'; id: string; scope: ConversationFrontier['scope']; revision: number; rows: ConversationSourceRecord[];
  checkpoint: ConversationFrontier; snapshots: Map<string, Snapshot>; observers: number; readers: number; outside: ConversationReadWindow['outside']; history: HistoryPosition[]; anchor?: ConversationReadWindow['anchor']; inputAdoption: ConversationInputAdoptionContext }
const MAX_UNOBSERVED_VIEWS = 16
/** Temporary state of this original Reader. Durable originals remain in their original owners. */
export class ConversationReaderState {
  private readonly views = new Map<string, ReadingView>()
  private trimParked(limit = MAX_UNOBSERVED_VIEWS): void {
    const parked = [...this.views.values()].filter(view => view.observers === 0 && view.readers === 0)
    for (const view of parked.slice(0, Math.max(0, parked.length - limit))) this.views.delete(view.id)
  }
  create(ref: ConversationRef, checkpoint: ConversationFrontier, processDetails?: 'deferred'): ReadingView {
    this.trimParked(MAX_UNOBSERVED_VIEWS - 1)
    const view: ReadingView = { ...ref, ...(processDetails ? { processDetails } : {}), id: mintObjectId(), scope: checkpoint.scope, revision: 0, rows: [], history: [], checkpoint, snapshots: new Map(), observers: 0, readers: 0, outside: { older: null, newer: null }, inputAdoption: { witnesses: [] } }
    this.views.set(view.id, view); return view
  }
  get(id: string, ref: ConversationRef, scope: ConversationFrontier['scope']): ReadingView {
    const view = this.views.get(id)
    if (!view) return fail('The original temporary reading window expired. Retain its displayed originals and exact source references for a new read.', 'AGENT_CONVERSATION_VIEW_EXPIRED')
    if (view.hostId !== ref.hostId || view.agentSessionId !== ref.agentSessionId || !same(view.scope, scope)) return fail('The original temporary reading window changed scope. Retain its displayed originals and exact anchor.')
    this.views.delete(id); this.views.set(id, view); return view
  }
  holdRead(view: ReadingView): () => void {
    view.readers++
    return () => {
      view.readers--
      // Explicit release/disposal owns removal; finishing IO cannot revive it.
      if (this.views.get(view.id) !== view) return
      this.views.delete(view.id); this.views.set(view.id, view)
      this.trimParked()
    }
  }
  observe(token: string, ref: ConversationRef, scope: ConversationFrontier['scope']): { scope: ConversationFrontier['scope']; dispose(): void } {
    const cursor = decode(token, ref, 'inspect')
    if (!cursor.viewId || !cursor.scope.sources.every(source => scope.sources.some(available => same(source, available)))) return fail('The observation names another original reading scope.')
    const view = this.get(cursor.viewId, ref, cursor.scope); view.observers++
    let closed = false
    return { scope: view.scope, dispose: () => { if (!closed) { closed = true; view.observers--; this.trimParked() } } }
  }
  release(token: string, ref: ConversationRef): { viewId: string; released: boolean } {
    const cursor = decode(token, ref, 'inspect')
    if (!cursor.viewId) return fail('The release does not name an original reading window.')
    const view = this.views.get(cursor.viewId)
    if (view) this.get(view.id, ref, cursor.scope)
    return { viewId: cursor.viewId, released: this.views.delete(cursor.viewId) }
  }
  dispose(): void { this.views.clear() }
}
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
/** Resolve only Core's signed continuation or an explicit original source intent.
 * Clients never inspect Provider cursors to select current/previous bindings. */
export function conversationReadNativeSource(input: ConversationTimelineReadInput | ConversationChangesInput, ref: ConversationRef) {
  const checkpoint = 'checkpoint' in input ? input.checkpoint.frontier : input.anchor?.frontier.frontier
  const continuation = input.cursor ? decode(input.cursor, ref, 'checkpoint' in input ? 'changes' : 'inspect') : undefined
  const view = input.view ? decode(input.view, ref, 'inspect') : undefined
  const record = 'record' in input ? input.record : undefined
  if (record && (record.hostId !== ref.hostId || record.agentSessionId !== ref.agentSessionId)) return fail('The exact record belongs to another original conversation.')
  const selected = [record?.source.kind === 'native' ? { providerId: record.source.providerId, nativeSessionId: record.source.nativeSessionId } : undefined, !('checkpoint' in input) ? input.nativeSource : undefined,
    ...[checkpoint?.scope, continuation?.scope, view?.scope].map(scope => {
      const source = scope?.sources.find(source => source.kind === 'native')
      return source?.kind === 'native' ? { providerId: source.providerId, nativeSessionId: source.nativeSessionId } : undefined
    })].filter(value => value !== undefined)
  if (selected.some(source => !same(source, selected[0]))) return fail('The read names different original native sources.')
  return selected[0]
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
async function discover(ref: ConversationRef, port: ConversationReaderPort): Promise<{ scope: ConversationFrontier['scope']; coverage: ConversationSourceCoverage[]; position: Position }> {
  const native = nativeSource(port), coverage = [native.kind === 'native' ? initialCoverage(native) : unavailable(native, new AgentMuxError('The original native Session ID is not accepted. Captured reading remains available.', 'AGENT_CONVERSATION_NATIVE_UNAVAILABLE'))]
  try {
    const page = await port.captured({ limit: 1 }), source = { kind: 'captured' as const, epoch: page.stream.epoch }
    coverage.push({ source, origin: page.stream.origin, readExtent: { through: String(page.stream.sequence) }, earlier: page.records.length ? 'more' : page.stream.origin === 'beginning' ? 'complete' : 'unknown-before', current: 'partial', gaps: page.stream.gaps })
    return { scope: { sources: coverage.map(c => c.source) }, coverage, position: { capturedCut: { epoch: page.stream.epoch, sequence: page.stream.sequence, ...(page.stream.inputJournal ? { inputJournal: page.stream.inputJournal } : {}) } } }
  } catch (error) {
    port.signal?.throwIfAborted(); coverage.push(unavailable({ kind: 'captured' }, error))
    return { scope: { sources: coverage.map(c => c.source) }, coverage, position: { capturedBefore: null } }
  }
}
export async function conversationCheckpoint(ref: ConversationRef, port: ConversationReaderPort, nativePosition?: 'beginning'): Promise<ConversationCheckpointPage> {
  port.signal?.throwIfAborted()
  const found = await discover(ref, port), cuts: ConversationFrontier['cuts'][number][] = []
  if (found.position.capturedCut) cuts.push({ kind: 'captured', ...found.position.capturedCut })
  const native = found.scope.sources.find(s => s.kind === 'native')
  if (native) {
    try {
      const checkpoint = await port.nativeCheckpoint(nativePosition)
      if (checkpoint.source.providerId !== native.providerId || checkpoint.source.nativeSessionId !== native.nativeSessionId) return fail('The original native source changed before its checkpoint.')
      cuts.unshift({ kind: 'native', checkpoint })
      const c = found.coverage.find(c => c.source.kind === 'native')!; c.current = 'complete-through-cut'; c.readExtent = { through: checkpoint.cursor }
    } catch (error) { port.signal?.throwIfAborted(); found.coverage[found.coverage.findIndex(c => c.source.kind === 'native')] = unavailable(native, error) }
  }
  const checkpoint: ConversationFrontier = { ...ref, scope: found.scope, cuts }
  const target = { ...ref, hostId: port.readHostId ?? ref.hostId }
  return { ...target, sourceHostId: ref.hostId, scope: found.scope, checkpoint: { ...target, sourceHostId: ref.hostId, frontier: checkpoint }, coverage: found.coverage }
}
function projection(ref: ConversationRef, accepted: ConversationFrontier['scope'], rows: ConversationSourceRecord[], coverage: ConversationSourceCoverage[], inputAdoption: ConversationInputAdoptionContext, preserveCurrent = false) {
  const source = accepted.sources.find((value): value is Extract<ConversationSourceRef, { kind: 'native' }> => value.kind === 'native')
  const timeline = projectConversationStream({ agentSessionId: ref.agentSessionId, reference: ref, records: rows,
    scope: accepted, coverage, inputAdoption, ...(source ? { nativeSource: source } : {}) })
  const records = new Map(timeline.records.map(record => [record.id, record]))
  const units = timeline.events.map(event => ({ event, records: event.recordIds.map(id => records.get(id)!) }))
  if (units.some(unit => Buffer.byteLength(JSON.stringify(unit)) > CONVERSATION_MAX_UNIT_BYTES)) return fail('The original conversation unit exceeds its assembly bound. Its source and cut are retained.', preserveCurrent ? 'AGENT_CONVERSATION_WINDOW_FULL' : 'AGENT_SESSION_HISTORY_BUDGET')
  return { units, coverage: timeline.coverage as ConversationSourceCoverage[], order: timeline.order }
}
function row(ref: ConversationRef, original: ConversationSourceRecord['original'], order: ConversationSourceRecord['order'], version?: string): ConversationSourceRecord {
  if (order.kind === 'native-page') order = { ...order, source: { providerId: order.source.providerId, nativeSessionId: order.source.nativeSessionId } }
  const source = original.kind === 'native' && order.kind === 'native-page' ? { kind: 'native' as const, ...order.source, recordId: original.item.id } : { kind: 'captured' as const, recordId: original.item.id }
  const reference = { hostId: ref.hostId, agentSessionId: ref.agentSessionId, source }
  return { id: conversationRecordId(reference), reference, revision: version ?? conversationRevision(original.item), order, original }
}
async function inspectBatch(ref: ConversationRef, port: ConversationReaderPort, state: Cursor, limit: number): Promise<{ rows: ConversationSourceRecord[]; batch: Batch; nativePage?: AgentSessionHistoryPage }> {
  let nativePage: AgentSessionHistoryPage | undefined
  const rows: ConversationSourceRecord[] = [], after: Position = { ...state.position }
  let checkpoint = state.checkpoint!
  const coverage = state.scope.sources.map(source => state.position.unavailable?.find(c => conversationSourceKey(c.source) === conversationSourceKey(source)) ?? initialCoverage(source))
  const native = state.scope.sources.find((source): source is Extract<ConversationSourceRef, { kind: 'native' }> => source.kind === 'native')
  if (native && state.position.native !== null) {
    try {
      const page = await port.nativePage(state.position.native, limit)
      nativePage = page
      if (page.source.providerId !== native.providerId || page.source.nativeSessionId !== native.nativeSessionId || page.agentSessionId !== ref.agentSessionId || page.items.length > limit) return fail('Native history left its frozen source window.')
      // This witness identifies one original page operation. Only its declared
      // cursor adjacency and ordered items establish sequence; hashes never sort.
      const pageWitness = hash(JSON.stringify([state.position.native ?? null, page.nextCursor]))
      rows.push(...page.items.map((item, indexInPage) => row(ref, { kind: 'native', item }, { kind: 'native-page', source: page.source, pageWitness, indexInPage })))
      after.native = page.nextCursor
      const current = initialCoverage(native)
      coverage[coverage.findIndex(value => value.source.kind === 'native')] = current
      if (after.unavailable) after.unavailable = after.unavailable.filter(value => value.source.kind !== 'native')
      current.earlier = page.nextCursor ? 'more' : 'unknown-before'
      current.readExtent = { ...(state.position.native ? { from: state.position.native } : {}), through: page.nextCursor ?? 'source-page-end' }
      const cut = checkpoint.cuts.find(cut => cut.kind === 'native')
      if (page.changesCursor) {
        if (state.position.native !== undefined && cut?.kind === 'native' && cut.checkpoint.cursor !== page.changesCursor) return fail('The original native page changed its frozen changes boundary.')
        checkpoint = { ...checkpoint, cuts: [...checkpoint.cuts.filter(cut => cut.kind !== 'native'),
          { kind: 'native', checkpoint: { agentSessionId: ref.agentSessionId, source: page.source, cursor: page.changesCursor } }] }
      } else {
        checkpoint = { ...checkpoint, cuts: checkpoint.cuts.filter(cut => cut.kind !== 'native') }
        current.gaps = [{ code: 'AGENT_CONVERSATION_READ_CUT_UNAVAILABLE', message: 'This native history page does not establish its changes boundary. The original history remains readable; its changes join is unknown.' }]
      }
    } catch (error) {
      port.signal?.throwIfAborted()
      rows.length = 0
      nativePage = undefined; checkpoint = state.checkpoint!
      if (state.position.native === undefined) delete after.native; else after.native = state.position.native
      const failure = unavailable(native, error, state.position.native ?? undefined)
      failure.gaps = failure.gaps.map(gap => ({ ...gap, continuation: encode({ ...ref, version: 1, mode: 'inspect', scope: { sources: [native] },
        checkpoint: { ...ref, scope: { sources: [native] }, cuts: state.checkpoint?.cuts.filter(cut => cut.kind === 'native') ?? [] },
        position: { ...(state.position.native === undefined ? {} : { native: state.position.native }), capturedBefore: null } }) }))
      coverage[coverage.findIndex(c => c.source.kind === 'native')] = failure;
      after.unavailable = [...(after.unavailable ?? []).filter(value => value.source.kind !== 'native'), failure]
    }
  }
  const captured = state.scope.sources.find(source => source.kind === 'captured')
  if (captured && state.position.capturedCut && state.position.capturedBefore !== null) {
    try {
      const page = await port.captured({ epoch: state.position.capturedCut.epoch, throughSequence: state.position.capturedCut.sequence,
        ...(state.position.capturedBefore === undefined ? {} : { beforeFirstSequence: state.position.capturedBefore }), limit })
      rows.push(...page.records.map(record => row(ref, { kind: 'captured', item: record.item }, { kind: 'captured-stream', epoch: page.stream.epoch, firstSequence: record.firstSequence }, record.revision)))
      after.capturedBefore = page.nextBeforeFirstSequence
      const current = initialCoverage(captured)
      coverage[coverage.findIndex(value => value.source.kind === 'captured')] = current
      if (after.unavailable) after.unavailable = after.unavailable.filter(value => value.source.kind !== 'captured')
      current.origin = page.stream.origin; current.gaps = page.stream.gaps
      current.earlier = page.more ? 'more' : page.stream.origin === 'beginning' ? 'complete' : 'unknown-before'
      current.readExtent = { through: String(page.stream.sequence) }
    } catch (error) {
      port.signal?.throwIfAborted()
      const failure = unavailable(captured, error)
      failure.gaps = failure.gaps.map(gap => ({ ...gap, continuation: encode({ ...ref, version: 1, mode: 'inspect', scope: { sources: [captured] },
        checkpoint: { ...ref, scope: { sources: [captured] }, cuts: state.checkpoint?.cuts.filter(cut => cut.kind === 'captured') ?? [] },
        position: { native: null, ...(state.position.capturedCut ? { capturedCut: state.position.capturedCut } : {}), ...(state.position.capturedBefore === undefined ? {} : { capturedBefore: state.position.capturedBefore }) } }) }))
      coverage[coverage.findIndex(value => value.source.kind === 'captured')] = failure
      after.unavailable = [...(after.unavailable ?? []).filter(value => value.source.kind !== 'captured'), failure]
    }
  }
  for (let index = 0; index < coverage.length; index++) if (coverage[index]!.source.kind === 'native-unavailable' || coverage[index]!.source.kind === 'captured' && !state.position.capturedCut)
    coverage[index] = unavailable(coverage[index]!.source, new AgentMuxError('This original scope has no accepted source identity. Read a new explicit scope to discover one.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'))
  return { rows, ...(nativePage ? { nativePage } : {}), batch: { index: 0, offset: 0, digests: [], after, coverage, end: checkpoint,
    more: native !== undefined && after.native !== null || !!state.position.capturedCut && after.capturedBefore !== null } }
}
async function changesBatch(ref: ConversationRef, port: ConversationReaderPort, state: Cursor, limit: number, originals: ReadonlyMap<string, ConversationSourceRecord>): Promise<{ rows: ConversationSourceRecord[]; batch: Batch }> {
  const checkpoint = state.checkpoint!, rows: ConversationSourceRecord[] = [], coverage = state.scope.sources.map(initialCoverage), cuts = [...checkpoint.cuts]
  let more = false
  for (const source of state.scope.sources) {
    const at = coverage.findIndex(c => conversationSourceKey(c.source) === conversationSourceKey(source))
    if (source.kind === 'native') {
      const cut = cuts.find(c => c.kind === 'native' && c.checkpoint.source.providerId === source.providerId && c.checkpoint.source.nativeSessionId === source.nativeSessionId)
      if (!cut || cut.kind !== 'native') { coverage[at] = unavailable(source, new AgentMuxError('This frontier has no accepted native changes cut; an explicit new checkpoint is required.', 'AGENT_CONVERSATION_CHANGES_UNSUPPORTED')); continue }
      try {
        const page = await port.nativeChanges(cut.checkpoint, limit)
        if (page.agentSessionId !== ref.agentSessionId || page.hostId !== ref.hostId ||
          page.source.providerId !== source.providerId || page.source.nativeSessionId !== source.nativeSessionId ||
          page.checkpoint.agentSessionId !== ref.agentSessionId || page.checkpoint.source.providerId !== source.providerId || page.checkpoint.source.nativeSessionId !== source.nativeSessionId)
          return fail('The native primitive returned another original source. Its prior cut is retained.')
        const sourceRows = page.items.map((item, indexInPage) => row(ref, { kind: 'native', item }, { kind: 'native-page' as const, source, indexInPage,
          pageWitness: hash(JSON.stringify([cut.checkpoint.cursor, page.checkpoint.cursor])) }))
        const nextCoverage: ConversationSourceCoverage = { ...initialCoverage(source), current: page.more ? 'partial' : 'complete-through-cut', readExtent: { from: cut.checkpoint.cursor, through: page.checkpoint.cursor } }
        rows.push(...sourceRows); cuts[cuts.indexOf(cut)] = { kind: 'native', checkpoint: page.checkpoint }
        more ||= page.more; coverage[at] = nextCoverage
      } catch (error) { port.signal?.throwIfAborted(); coverage[at] = unavailable(source, error, cut.checkpoint.cursor) }
    } else if (source.kind === 'captured' && source.epoch) {
      const cut = cuts.find(c => c.kind === 'captured' && c.epoch === source.epoch)
      if (!cut || cut.kind !== 'captured') { coverage[at] = unavailable(source, new AgentMuxError('This frontier has no committed captured cut; retain it and establish a new explicit scope.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE')); continue }
      try {
        const current = await port.captured({ limit: 1 })
        // afterSequence is a query lower bound, not proof the caller's old cut exists.
        if (current.agentSessionId !== ref.agentSessionId || current.stream.epoch !== cut.epoch || !Number.isSafeInteger(current.stream.sequence) || cut.sequence > current.stream.sequence) return fail('Captured checkpoint is from another epoch or the future. The original frontier is retained.')
        const page = await port.captured({ epoch: cut.epoch, afterSequence: cut.sequence, throughSequence: current.stream.sequence, limit })
        const record = page.records.at(-1)
        if (!record && current.stream.sequence !== cut.sequence) return fail('The captured committed range is unavailable; an empty query cannot advance it.', 'AGENT_CONVERSATION_CAPTURED_GAP')
        if (page.agentSessionId !== ref.agentSessionId || page.stream.epoch !== cut.epoch ||
          page.records.some((record, index) => record.item.agentSessionId !== ref.agentSessionId || !Number.isSafeInteger(record.sequence) ||
            record.sequence <= cut.sequence || record.sequence > current.stream.sequence || !Number.isSafeInteger(record.firstSequence) || record.firstSequence < 1 || record.firstSequence > record.sequence ||
            index > 0 && record.sequence <= page.records[index - 1]!.sequence))
          return fail('The captured primitive returned records outside its accepted original ordered range. Its prior cut is retained.')
        const sourceRows = page.records.map(record => row(ref, { kind: 'captured', item: record.item }, { kind: 'captured-stream' as const, epoch: cut.epoch, firstSequence: record.firstSequence }, record.revision))
        const positions = new Map<string, ConversationSourceRecord['order']>()
        for (const record of sourceRows) {
          const prior = positions.get(record.id) ?? originals.get(record.id)?.order
          if (prior?.kind === 'captured-stream' && record.order.kind === 'captured-stream' &&
            (prior.epoch !== record.order.epoch || prior.firstSequence !== record.order.firstSequence))
            return fail('The captured primitive changed an accepted original record position. Its prior cut is retained.')
          positions.set(record.id, record.order)
        }
        const sequence = record?.sequence ?? cut.sequence
        const nextCoverage: ConversationSourceCoverage = { source, origin: page.stream.origin, readExtent: { from: String(cut.sequence), through: String(sequence) }, earlier: page.stream.origin === 'beginning' ? 'complete' : 'unknown-before', current: sequence < current.stream.sequence ? 'partial' : 'complete-through-cut', gaps: page.stream.gaps }
        rows.push(...sourceRows); cuts[cuts.indexOf(cut)] = { kind: 'captured', epoch: cut.epoch, sequence, ...(current.stream.inputJournal ? { inputJournal: current.stream.inputJournal } : {}) }
        more ||= sequence < current.stream.sequence; coverage[at] = nextCoverage
      } catch (error) { port.signal?.throwIfAborted(); coverage[at] = unavailable(source, error, String(cut.sequence)) }
    } else coverage[at] = unavailable(source, new AgentMuxError('The original frontier has no resolved source identity. Later discovery requires a new explicit checkpoint.', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'))
  }
  return { rows, batch: { index: 0, offset: 0, digests: [], after: state.position, coverage, end: { ...ref, scope: state.scope, cuts }, more } }
}
async function anchorBatch(input: ConversationTimelineReadInput, port: ConversationReaderPort, state: Cursor) {
  const anchor = input.anchor, reference = input.record ?? anchor!.record, rows: ConversationSourceRecord[] = [], source = reference.source, coverage = state.scope.sources.map(initialCoverage)
  try {
    if (source.kind === 'native') {
      const item = await port.nativeRecord(source, source.recordId), value = row(input, { kind: 'native', item }, { kind: 'native-page', source, indexInPage: 0 })
      if (anchor && value.revision !== anchor.revision) return fail('This original native version is unavailable; latest content cannot replace the anchor.')
      if (input.record) {
        // The opening cut cannot certify a record created while this exact read was pending.
        // A later original cut includes that observation; unrelated appends do not invalidate it.
        const checkpoint = await port.nativeCheckpoint()
        if (checkpoint.agentSessionId !== input.agentSessionId || checkpoint.source.providerId !== source.providerId || checkpoint.source.nativeSessionId !== source.nativeSessionId) return fail('The exact record read left its original native source.')
        state.checkpoint = { ...state.checkpoint!, cuts: [...state.checkpoint!.cuts.filter(cut => cut.kind !== 'native'), { kind: 'native', checkpoint }] }
      }
      rows.push(value)
    } else {
      const cut = (anchor?.frontier.frontier ?? state.checkpoint!).cuts.find(c => c.kind === 'captured')
      if (!cut || cut.kind !== 'captured') return fail('The original captured anchor has no accepted cut.')
      const page = await port.captured({ epoch: cut.epoch, throughSequence: cut.sequence, recordId: source.recordId, ...(anchor ? { recordRevision: anchor.revision } : {}), limit: 1 }), record = page.records[0]
      if (!record) return fail('The original captured version is unavailable; latest content cannot replace it.')
      rows.push(row(input, { kind: 'captured', item: record.item }, { kind: 'captured-stream', epoch: cut.epoch, firstSequence: record.firstSequence }, record.revision))
    }
    if (input.record && rows[0]) state.anchor = { record: input.record, revision: rows[0].revision, frontier: { hostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: input.hostId, frontier: state.checkpoint! } }
  } catch (error) {
    port.signal?.throwIfAborted()
    const kind = source.kind, index = coverage.findIndex(c => c.source.kind === kind)
    if (index >= 0) coverage[index] = { ...unavailable(coverage[index]!.source, error), gaps: [{ code: 'AGENT_CONVERSATION_VERSION_UNAVAILABLE', message: error instanceof Error ? error.message : 'The original version is unavailable.', record: reference }] }
  }
  return { rows, batch: { index: 0, offset: 0, digests: [], after: { native: null, capturedBefore: null }, coverage, more: false } as Batch }
}
/** Original accepted page adjacency, never timestamps or opaque-cursor ordering. */
function historyNavigation(rows: readonly ConversationSourceRecord[], history: readonly HistoryPosition[]) {
  // One short-lived inventory of the bounded accepted frame. Original page
  // adjacency metadata never causes a rescan of every row for every old page.
  const native = new Map<string, Set<string>>(), captured: number[] = []
  for (const row of rows) {
    if (row.order.kind === 'captured-stream') captured.push(row.order.firstSequence)
    else if (row.order.kind === 'native-page' && row.order.pageWitness) {
      const ids = native.get(row.order.pageWitness) ?? new Set<string>(); ids.add(row.id); native.set(row.order.pageWitness, ids)
    }
  }
  captured.sort((a, b) => a - b)
  const lower = (value: number) => { let from = 0, to = captured.length; while (from < to) { const mid = (from + to) >>> 1; if (captured[mid]! < value) from = mid + 1; else to = mid }; return from }
  const present = history.map(page => {
    const ids = page.native ? native.get(page.native.witness) : undefined
    const from = page.captured ? lower(page.captured.first) : 0, to = page.captured ? lower(page.captured.last + 1) : 0
    return {
      native: page.native ? { count: ids?.size ?? 0, earlier: !ids?.has(page.native.first), newer: !ids?.has(page.native.last) } : null,
      captured: page.captured ? { count: to - from, earlier: captured[from] !== page.captured.first, newer: captured[to - 1] !== page.captured.last } : null
    }
  })
  // Skip positions without this source's original contribution. A surviving
  // captured record cannot stand in for the native frontier of a mixed page.
  const adjacent = (start: number, direction: 1 | -1, source?: 'native' | 'captured'): number | null => {
    let index = start
    while (index >= 0 && index < history.length && (source ? !history[index]![source] : !history[index]!.native && !history[index]!.captured)) index += direction
    return index < 0 ? null : index < history.length ? index : history.at(-1)?.more ? history.length : null
  }
  if (!present.some(page => page.native?.count || page.captured?.count)) return { older: adjacent(0, 1), newer: null }
  const edges = (['native', 'captured'] as const).flatMap(source => {
    if (!history.some(page => page[source])) return []
    const first = present.findIndex(page => page[source]?.count)
    const last = present.length - 1 - [...present].reverse().findIndex(page => page[source]?.count)
    // If this entire source left the bounded window, its known originals
    // remain reachable from either direction through their original pages.
    if (first < 0) return [{ older: adjacent(0, 1, source), newer: adjacent(history.length - 1, -1, source) }]
    return [{ older: present[last]![source]!.earlier ? last : adjacent(last + 1, 1, source),
      newer: present[first]![source]!.newer ? first : adjacent(first - 1, -1, source) }]
  })
  const older = edges.flatMap(edge => edge.older === null ? [] : [edge.older])
  const newer = edges.flatMap(edge => edge.newer === null ? [] : [edge.newer])
  return { older: older.length ? Math.min(...older) : null, newer: newer.length ? Math.max(...newer) : null }
}
async function read(input: ConversationTimelineReadInput | ConversationChangesInput, port: ConversationReaderPort, mode: Cursor['mode']): Promise<AgentConversationReadPage | ConversationChangesPage> {
  port.signal?.throwIfAborted()
  const ref = { hostId: input.hostId, agentSessionId: input.agentSessionId }
  let state: Cursor
  if (input.cursor) {
    state = decode(input.cursor, ref, mode)
    if (mode === 'changes' && !same(state.checkpoint, (input as ConversationChangesInput).checkpoint.frontier) || ('record' in input && input.record ? !same(state.anchor?.record, input.record) : !same(state.anchor, 'anchor' in input ? input.anchor : undefined))) return fail('The continuation belongs to another original frontier or anchor.')
  } else if (mode === 'inspect' && input.view && !('anchor' in input && input.anchor) && !('record' in input && input.record) && !('nativeSource' in input && input.nativeSource)) {
    state = decode(input.view, ref, 'inspect')
    if (!state.viewId) return fail('This read does not name an original accepted view.')
    const retained = port.state.get(state.viewId, ref, state.scope)
    const frame = [...retained.snapshots].find(([, snapshot]) => snapshot.committed && snapshot.revision === retained.revision)
    if (!frame) return fail('The original accepted view frame is unavailable. Its source and displayed originals are retained.')
    state = { ...state, checkpoint: frame[1].checkpoint, snapshotId: frame[0], batch: { index: 0, offset: 0 } }
  } else if (mode === 'changes') {
    const checkpoint = (input as ConversationChangesInput).checkpoint.frontier
    state = { ...ref, version: 1, mode, scope: checkpoint.scope, checkpoint, position: {} }
  } else if ('anchor' in input && input.anchor) state = { ...ref, version: 1, mode, scope: input.anchor.frontier.frontier.scope, checkpoint: input.anchor.frontier.frontier, anchor: input.anchor, position: {} }
  else {
    const opening = await conversationCheckpoint(ref, port), checkpoint = opening.checkpoint.frontier
    const captured = checkpoint.cuts.find(cut => cut.kind === 'captured')
    state = { ...ref, version: 1, mode, scope: checkpoint.scope, checkpoint, position: captured?.kind === 'captured'
      ? { capturedCut: { epoch: captured.epoch, sequence: captured.sequence } } : { capturedBefore: null } }
  }
  if (input.cursor || input.view) {
    const prior = input.cursor ? state : decode(input.view!, ref, 'inspect')
    if (prior.processDetails !== input.processDetails) return fail('The continuation changed its original process detail representation.')
  }
  if (input.processDetails) state.processDetails = input.processDetails
  const requestedPreservation = mode === 'inspect' && 'preserveCurrent' in input && input.preserveCurrent === true
  if (state.snapshotId) {
    if (Boolean(state.preserveCurrent) !== requestedPreservation) return fail('The wire continuation changed its original window preservation policy.')
  } else if (requestedPreservation) {
    if (!state.viewId || state.pageIndex === undefined || state.direction || state.batch || state.anchor) return fail('Window preservation requires the original older-page adjacency.')
    state.preserveCurrent = true
  }
  const preserveCurrent = state.preserveCurrent === true
  if (input.view) {
    const token = decode(input.view, ref, 'inspect')
    if (!token.viewId || !Number.isSafeInteger(token.viewRevision) || token.snapshotId || !same(token.scope, state.scope) || state.viewId && state.viewId !== token.viewId) return fail('The view belongs to another original accepted scope.')
    if (!state.viewId) { state.viewId = token.viewId; state.viewRevision = token.viewRevision! }
  }
  const view = state.viewId ? port.state.get(state.viewId, ref, state.scope) : port.state.create(ref, state.checkpoint!, state.processDetails)
  if (view.processDetails !== state.processDetails) return fail('The accepted view changed its original process detail representation.')
  const releaseRead = port.state.holdRead(view)
  try {
    state.viewId = view.id
    if (mode === 'changes' && view.anchor) return fail('This view inspects one exact original version. Reopen history explicitly to follow later changes.')
    const requestKey = hash(JSON.stringify([mode, state.viewRevision ?? view.revision, state.checkpoint, state.position, state.anchor, state.pageIndex, state.direction, preserveCurrent, state.processDetails]))
    if (!state.snapshotId) {
      const repeated = [...view.snapshots].find(([, snapshot]) => snapshot.requestKey === requestKey)
      if (repeated) { state.snapshotId = repeated[0]; state.batch = { index: 0, offset: 0 } }
    }
    let snapshot: Snapshot
    if (state.snapshotId) {
      const retained = view.snapshots.get(state.snapshotId)
      if (!retained || !state.batch) return fail('The original frozen window expired. Retain its exact anchor and displayed originals.')
      snapshot = retained
    } else {
      if (state.viewRevision !== undefined && state.viewRevision !== view.revision || mode === 'changes' && view.revision > 0 && !same(view.checkpoint, state.checkpoint)) return fail('This operation does not continue the accepted window revision and original source cut.')
      const history = [...view.history], pageIndex = state.pageIndex ?? history.length, previousPosition = history[pageIndex]
      const originalPort = previousPosition?.head ? { ...port, nativePage: async () => previousPosition.head!.page } : port
      const records = new Map(view.rows.map(record => [record.id, record]))
      const loaded: { rows: ConversationSourceRecord[]; batch: Batch; nativePage?: AgentSessionHistoryPage } = mode === 'changes' ? await changesBatch(ref, port, state, input.limit ?? 30, records)
        : ('anchor' in input && input.anchor || 'record' in input && input.record) ? await anchorBatch(input, port, state) : await inspectBatch(ref, originalPort, state, previousPosition?.limit ?? input.limit ?? 30)
      if (mode === 'inspect' && !state.anchor) {
        if (pageIndex > history.length) return fail('The original page position is not adjacent to this window.')
        const page = 'nativePage' in loaded ? loaded.nativePage : undefined
        const native = loaded.rows.filter(row => row.original.kind === 'native'), captured = loaded.rows.filter(row => row.order.kind === 'captured-stream')
        if (previousPosition?.native) for (const row of native) if (row.order.kind === 'native-page') row.order = { ...row.order, pageWitness: previousPosition.native.witness }
        const capturedPositions = captured.flatMap(row => row.order.kind === 'captured-stream' ? [row.order.firstSequence] : [])
        const position: HistoryPosition = { position: { ...state.position, ...(page?.replayCursor ? { native: page.replayCursor } : {}) },
          after: loaded.batch.after, checkpoint: loaded.batch.end ?? state.checkpoint!, limit: previousPosition?.limit ?? input.limit ?? 30, more: loaded.batch.more,
          ...(native.length && native[0]!.order.kind === 'native-page' ? { native: { witness: native[0]!.order.pageWitness!, first: native[0]!.id, last: native.at(-1)!.id, count: native.length } } : {}),
          ...(capturedPositions.length ? { captured: { first: Math.min(...capturedPositions), last: Math.max(...capturedPositions), count: captured.length } } : {}),
          ...(previousPosition?.head ? { head: previousPosition.head } : page && !page.replayCursor && state.position.native === undefined ? { head: { page, rows: native } } : {}) }
        if (previousPosition && (!same(previousPosition.native, position.native) || !same(previousPosition.captured, position.captured) || !same(previousPosition.after, position.after))) return fail('The original page no longer has its accepted record boundaries. Its displayed originals remain available.')
        history[pageIndex] = position
      }
      const accepted = loaded.rows
      const native = view.rows.filter(record => record.original.kind === 'native').map(record => record.id)
      const additions: string[] = []
      for (const record of accepted) {
        const prior = records.get(record.id)
        // A hash verifies bytes only. The declared changes cut, never a hash comparison,
        // permits a newer original version; frozen history cannot silently replace one.
        if (prior && prior.revision !== record.revision && mode !== 'changes') return fail('An original record changed inside this frozen history window. Retain the original version and explicitly refresh its source.')
        if (prior && prior.order.kind === 'captured-stream' && record.order.kind === 'captured-stream' &&
            (prior.order.epoch !== record.order.epoch || prior.order.firstSequence !== record.order.firstSequence)) return fail('An accepted captured record changed its original source position.')
        if (!prior && record.original.kind === 'native') additions.push(record.id)
        records.set(record.id, prior ? { ...record, order: prior.order } : record)
      }
      let nativeIds = mode === 'changes' || state.direction === 'newer' ? [...native, ...additions] : [...additions, ...native]
      if (mode === 'inspect' && history.length) {
        const order = new Map(history.flatMap((page, index) => page.native ? [[page.native.witness, index] as const] : []))
        const known: string[] = [], appended: string[] = []
        for (const id of nativeIds) { const position = records.get(id)!.order; (position.kind === 'native-page' && order.has(position.pageWitness ?? '') ? known : appended).push(id) }
        known.sort((a, b) => {
          const left = records.get(a)!.order, right = records.get(b)!.order
          return left.kind === 'native-page' && right.kind === 'native-page' ? order.get(right.pageWitness!)! - order.get(left.pageWitness!)! || left.indexInPage - right.indexInPage : 0
        })
        nativeIds = [...known, ...appended]
      }
      const captured = [...records.values()].filter(record => record.original.kind === 'captured').sort((a, b) =>
        a.order.kind === 'captured-stream' && b.order.kind === 'captured-stream' ? a.order.firstSequence - b.order.firstSequence : 0)
      let rows = [...nativeIds.map(id => records.get(id)!), ...captured]
      const knownInputs = conversationInputAdoptionEdges(rows, view.inputAdoption)
      const witnesses = knownInputs.witnesses
      // Retain only bounded identity witnesses in this original temporary view. An
      // overflow preserves known counterevidence and makes adoption unknown, never first-wins.
      const inputAdoption: ConversationInputAdoptionContext = knownInputs.unconfirmed || witnesses.length > CONVERSATION_MAX_WINDOW_RECORDS || Buffer.byteLength(JSON.stringify(witnesses)) > CONVERSATION_MAX_UNIT_BYTES
        ? { ...view.inputAdoption, unconfirmed: true } : { witnesses }
      // Bound the temporary accepted window before duplicating bodies into a projection.
      // Whole existing event groups leave the window; their original owners and exact
      // versioned anchors remain available. Incoming originals never disappear here.
      const previous = [...view.snapshots.values()].find(value => value.committed && value.revision === view.revision)
      const protectedIds = new Set(accepted.flatMap(record => [record.id,
        ...(knownInputs.targets.get(record.id) ? [conversationRecordId(knownInputs.targets.get(record.id)!)] : []),
        ...(record.original.item.conversation?.sameEvent ? [conversationRecordId(record.original.item.conversation.sameEvent)] : [])]))
      const outside = { ...view.outside }, sizes = new Map(rows.map(record => [record.id, Buffer.byteLength(JSON.stringify(record))]))
      const heads = new Map(history.flatMap(position => position.head?.rows ?? []).map(row => [row.id, row]))
      const positionBytes = Buffer.byteLength(JSON.stringify(history.map(({ head: _head, ...position }) => position)))
      let retainedCount = new Set([...sizes.keys(), ...heads.keys()]).size
      let retainedBytes = positionBytes + [...sizes.values()].reduce((sum, size) => sum + size, 0) +
        [...heads.values()].filter(row => !sizes.has(row.id) || records.get(row.id)?.revision !== row.revision)
          .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)
      if (preserveCurrent && (retainedCount > CONVERSATION_MAX_WINDOW_RECORDS || retainedBytes > CONVERSATION_MAX_UNIT_BYTES)) return fail('This older expansion cannot retain the accepted window within its record and byte budgets. Continue explicit history navigation or retain the current live view.', 'AGENT_CONVERSATION_WINDOW_FULL')
      const removed = new Set<string>(), boundary = (unit: CompleteUnit) => {
        const record = unit.records.find(record => record.id === unit.event.anchorId) ?? unit.records[0]!
        return { record: record.reference!, revision: record.revision }
      }
      const evict = (unit: CompleteUnit) => {
        for (const record of unit.records) if (!removed.has(record.id)) {
          removed.add(record.id)
          const head = heads.get(record.id)
          if (!head) retainedCount--
          // A retained unrepeatable head may hold an older immutable body for this
          // identity. Removing its live version frees only that version's bytes.
          if (!head || head.revision !== record.revision) retainedBytes -= sizes.get(record.id) ?? 0
        }
        outside[mode === 'changes' || state.direction === 'newer' ? 'older' : 'newer'] = boundary(unit)
      }
      const candidates = previous ? mode === 'changes' || state.direction === 'newer' ? [...previous.units].reverse() : previous.units : []
      for (const unit of candidates) {
        if (retainedCount <= CONVERSATION_MAX_WINDOW_RECORDS && retainedBytes <= CONVERSATION_MAX_UNIT_BYTES) break
        if (!unit.records.some(record => protectedIds.has(record.id))) evict(unit)
      }
      rows = rows.filter(record => !removed.has(record.id))
      if (retainedCount > CONVERSATION_MAX_WINDOW_RECORDS || retainedBytes > CONVERSATION_MAX_UNIT_BYTES) return fail('This exact event contribution exceeds the temporary window assembly bound. Its original source and continuation are retained.', 'AGENT_SESSION_HISTORY_BUDGET')
      let projected = projection(ref, state.scope, rows, loaded.batch.coverage, inputAdoption, preserveCurrent)
      let unitBytes = projected.units.reduce((sum, unit) => sum + Buffer.byteLength(JSON.stringify(unit)), 0)
      if (preserveCurrent && unitBytes > CONVERSATION_MAX_UNIT_BYTES) return fail('This older expansion cannot retain the accepted canonical contributions within its assembly budget. The original live view and continuation remain available.', 'AGENT_CONVERSATION_WINDOW_FULL')
      for (const unit of mode === 'changes' || state.direction === 'newer' ? projected.units : [...projected.units].reverse()) {
        if (unitBytes <= CONVERSATION_MAX_UNIT_BYTES) break
        if (unit.records.some(record => protectedIds.has(record.id))) continue
        unitBytes -= Buffer.byteLength(JSON.stringify(unit)); evict(unit)
      }
      if (unitBytes > CONVERSATION_MAX_UNIT_BYTES) return fail('This exact event exceeds its wire assembly bound. Its original source and continuation are retained.', 'AGENT_SESSION_HISTORY_BUDGET')
      if (removed.size) { rows = rows.filter(record => !removed.has(record.id)); projected = projection(ref, state.scope, rows, loaded.batch.coverage, inputAdoption) }
      const batch: Batch = { ...loaded.batch, index: 0, offset: 0, digests: [] }
      snapshot = { rows, batch, units: projected.units.reverse(), coverage: projected.coverage, order: projected.order,
        ...(state.anchor ? { anchor: state.anchor } : {}), revision: view.revision + 1, checkpoint: loaded.batch.end ?? state.checkpoint!, committed: false, requestKey, outside, history, inputAdoption }
      state.viewRevision = view.revision; state.snapshotId = mintObjectId(); state.batch = { index: 0, offset: 0 }
      view.snapshots.set(state.snapshotId, snapshot)
      while (view.snapshots.size > 3) view.snapshots.delete(view.snapshots.keys().next().value!)
    }
    const batch = snapshot.batch, units: ConversationUnit[] = state.processDetails === 'deferred'
      ? snapshot.deferredUnits ??= snapshot.units.map(unit => unit.event.role === 'process' && unit.records.every(record => conversationRecordRole(record) === 'process' && (record.original.kind === 'captured' || port.nativeRecordAvailable === true))
        ? { event: unit.event, records: unit.records.map(deferConversationProcessRecord) } : unit) : snapshot.units
    const digests = batch.digests.length ? batch.digests : units.map(unit => ({ id: unit.event.id, sha256: hash(JSON.stringify(unit)) }))
    batch.digests = digests
    const budgetBytes = input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES, items: ConversationUnitEntry[] = []
    const navigation = snapshot.navigation ??= historyNavigation(snapshot.rows, snapshot.history)
    const historyCursor = (index: number | null, direction?: 'newer'): string | null => {
      if (index === null) return null
      const position = snapshot.history[index], tail = snapshot.history.at(-1)
      if (!position && !tail) return null
      return encode({ ...ref, ...(state.processDetails ? { processDetails: state.processDetails } : {}), version: 1, mode: 'inspect', scope: state.scope, position: position?.position ?? tail!.after,
        checkpoint: position?.checkpoint ?? tail!.checkpoint, viewId: view.id, viewRevision: snapshot.revision, pageIndex: index, ...(direction ? { direction } : {}) })
    }
    const next = (index: number, offset: number): string | null => {
      if (index < units.length) return encode({ ...state, position: {}, batch: { index, offset } })
      return mode === 'inspect' ? historyCursor(navigation.older) : null
    }
    const target = { ...ref, hostId: port.readHostId ?? ref.hostId }
    const result = (index: number, offset: number, entries = items) => {
      const complete = index >= units.length
      const checkpoint = { ...target, sourceHostId: ref.hostId, frontier: complete ? snapshot.checkpoint : state.checkpoint! }
      return { ...target, ...(state.processDetails ? { processDetails: state.processDetails } : {}), sourceHostId: ref.hostId, scope: state.scope, coverage: snapshot.coverage, order: { ...snapshot.order, direction: 'newest-first' as const }, items: entries, nextCursor: next(index, offset), budgetBytes,
        window: { id: view.id, revision: snapshot.revision, itemCount: units.length, complete,
          ...(snapshot.anchor ? { anchor: { ...snapshot.anchor, frontier: checkpoint } } : {}),
          view: complete ? encode({ ...ref, ...(state.processDetails ? { processDetails: state.processDetails } : {}), version: 1, mode: 'inspect', scope: state.scope, position: {}, viewId: view.id, viewRevision: snapshot.revision }) : null,
          replay: encode({ ...state, position: {}, batch: state.batch! }), checkpoint, outside: snapshot.outside, navigation: { older: complete ? historyCursor(navigation.older) : null, newer: complete ? historyCursor(navigation.newer, 'newer') : null } },
        ...(mode === 'changes' ? { checkpoint, more: !complete || batch.more } : {}) }
    }
    const fits = (entry: ConversationUnitEntry, index: number, offset: number) => Buffer.byteLength(JSON.stringify(result(index, offset, [...items, entry]))) <= budgetBytes
    let index = state.batch!.index, offset = state.batch!.offset
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
    const parsed = mode === 'changes' ? parseConversationChangesPage(page, { ...input, ...target, checkpoint: { ...(input as ConversationChangesInput).checkpoint, ...target } } as ConversationChangesInput) : parseConversationReadPage(page, { ...input, ...target })
    port.signal?.throwIfAborted()
    if (page.window.complete && !snapshot.committed) {
      if (view.revision !== state.viewRevision) return fail('Another read already advanced this accepted window. Retain this response as uncommitted and read the current view.')
      view.rows = snapshot.rows; view.revision = snapshot.revision; view.checkpoint = snapshot.checkpoint; view.outside = snapshot.outside; view.history = snapshot.history; if (snapshot.anchor) view.anchor = snapshot.anchor; view.inputAdoption = snapshot.inputAdoption; snapshot.committed = true
    }
    return parsed
  } finally { releaseRead() }
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
  const view = input.view ? originalRouteCursor(input.view, input) : undefined
  const checkpoint = 'checkpoint' in input ? input.checkpoint : input.anchor?.frontier
  const recordHostId = 'record' in input ? input.record?.hostId : undefined
  const sourceHostId = checkpoint?.sourceHostId ?? recordHostId ?? continuation?.sourceHostId ?? view?.sourceHostId
  if (checkpoint && checkpoint.hostId !== input.hostId || recordHostId && sourceHostId !== recordHostId || continuation && sourceHostId !== continuation.sourceHostId || view && sourceHostId !== view.sourceHostId) return fail('Conversation route, anchor or frontier changed its original source.')
  return { input: { ...input, hostId: 'local', ...(continuation ? { cursor: continuation.cursor } : {}), ...(view ? { view: view.cursor } : {}),
    ...('checkpoint' in input ? { checkpoint: { ...input.checkpoint, hostId: 'local' } } : {}),
    ...('anchor' in input && input.anchor ? { anchor: { ...input.anchor, frontier: { ...input.anchor.frontier, hostId: 'local' } } } : {}) },
    ...(sourceHostId ? { sourceHostId } : {}) }
}
export function forwardConversationPage<T extends AgentConversationReadPage>(page: T, input: ConversationTimelineReadInput, expectedSourceHostId?: string): T {
  if (page.hostId !== 'local' || page.agentSessionId !== input.agentSessionId || expectedSourceHostId !== undefined && expectedSourceHostId !== page.sourceHostId) return fail('The selected original route returned another conversation source.')
  const wrap = (cursor: string) => routeCursor({ version: 'conversation-route.v1', routeHostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: page.sourceHostId, cursor })
  return { ...page, hostId: input.hostId, budgetBytes: input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES,
    nextCursor: page.nextCursor === null ? null : wrap(page.nextCursor),
    window: { ...page.window, ...(page.window.anchor ? { anchor: { ...page.window.anchor, frontier: { ...page.window.anchor.frontier, hostId: input.hostId } } } : {}), view: page.window.view === null ? null : wrap(page.window.view), replay: wrap(page.window.replay), navigation: { older: page.window.navigation.older ? wrap(page.window.navigation.older) : null, newer: page.window.navigation.newer ? wrap(page.window.navigation.newer) : null }, checkpoint: { ...page.window.checkpoint, hostId: input.hostId } },
    coverage: page.coverage.map(source => ({ ...source, gaps: source.gaps.map(gap => gap.continuation ? { ...gap, continuation: wrap(gap.continuation) } : gap) })),
    ...('checkpoint' in page ? { checkpoint: { ...(page as unknown as ConversationChangesPage).checkpoint, hostId: input.hostId } } : {}) }
}
/** The same original read is reduced to fit its exact final route envelope. No
 * fragments are reassembled, re-encoded or acknowledged by this transport step. */
export async function readRoutedConversation<T extends AgentConversationReadPage>(input: ConversationTimelineReadInput,
  readOriginal: (maxBytes: number, replay?: string) => Promise<T>, expectedSourceHostId?: string): Promise<T> {
  const budget = input.maxBytes ?? CONVERSATION_DEFAULT_READ_BYTES
  let sourceBudget = budget, replay: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    if (sourceBudget < 4096) break
    const page = await readOriginal(sourceBudget, replay), result = forwardConversationPage(page, input, expectedSourceHostId)
    const overflow = Buffer.byteLength(JSON.stringify(result)) - budget
    if (overflow <= 0) return result
    sourceBudget -= overflow + 32; replay = page.window.replay
  }
  return fail('The original source unit and complete route envelope cannot fit this byte budget. Increase maxBytes; its original input and cut remain valid.', 'AGENT_SESSION_HISTORY_BUDGET')
}
