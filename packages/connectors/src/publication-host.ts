import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { publicationMarkdown } from './publication-markdown.js'
import { AgentMuxError, parseProviderSessionHistoryResourceReadResult, readSessionHistoryTextResource, type AgentSessionHistoryContentPart, type AgentSessionHistoryResourceRequest, type AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import { consumeJsonReadEntry, consumeConversationWindowPage, parseConversationChangesPage, parseConversationCheckpointPage, parseConversationReadPage, parseConversationUnit, conversationRecordId, conversationSourceKey, CONVERSATION_MAX_UNIT_BYTES, type JsonReadAssembly, type ConversationWindowAssembly, type ConversationWatchInput, type ConversationObservation, type ConversationObservationHandle, type ConversationSourceRef, type ConversationCheckpointInput, type ConversationChangesInput, type ConversationChangesPage, type ConversationCheckpoint, type ConversationCheckpointPage, type ConversationTimelineReadInput, type AgentConversationReadPage, type ConversationUnit, type ConversationRef } from '@agentmux/core/conversation'
import { readRoomPublicationBinding, roomPublicationReference, connectionDiagnosisCheckpointKey, connectionDiagnosisSourceCode, type ConnectionDeliverySourceObservation, parseConnectionDeliveryParams, parseRoomBindingAuthority, type ConnectionDeliveryObservation, type ConnectionDeliveryPort, type ConnectionDeliveryListInput, type ConnectionDeliveryOperationInput, type RoomBinding, type RoomBindingCallContext, type RoomBindingReadPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { credentialLookupFailure } from './credential-observation.js'
import { parsePreparedPublication } from './publication-wire.js'
import type { PublicationAdapter } from './publication-adapter.js'
import { publicationEffectContext, publicationImage, publicationFile, type ResourceUploadReceipt, type ResolvedPublicationPart } from './publication-resource.js'
import { isConversationPublicationPart, publicationPartKey } from './publication-content.js'
import { PublicationStore, publicDelivery, type PublicationReceipt, type PublicationOperation, type QuestionPublicationPayload } from './publication-store.js'
import { readPublicationA2A, publicationMessageTargets, type PublicationA2A, type PublicationOriginalMessagePort } from './publication-a2a.js'
import { publicationSpeaker, type PublicationSpeaker, type PublicationSpeakerDetails, type PublicationSpeakerReader } from './publication-speaker.js'

/** Borrow original exact Core reads and the shared Provider observation. No transcript paths or second watcher. */
export interface PublicationConversationPort extends PublicationOriginalMessagePort {
  checkpoint(reference: ConversationCheckpointInput, signal: AbortSignal): Promise<ConversationCheckpointPage>
  changes(input: ConversationChangesInput, signal: AbortSignal): Promise<ConversationChangesPage>
  inspect(input: ConversationTimelineReadInput, signal: AbortSignal): Promise<AgentConversationReadPage>
  observe(reference: ConversationWatchInput, listener: (value: ConversationObservation) => void, signal: AbortSignal): Promise<ConversationObservationHandle>
  resource(reference: ConversationRef, input: AgentSessionHistoryResourceRequest, signal: AbortSignal): Promise<AgentSessionHistoryResourceReadResult>
}
export interface PublicationPermissionsPort {
  observe(binding: RoomBinding, wake: () => void): () => void
  project(binding: RoomBinding, store: PublicationStore, supported?: { permission: boolean; question: boolean }, unavailable?: () => void): string[]
  questions?(binding: RoomBinding, units: readonly ConversationUnit[]): ReadonlyMap<string, QuestionPublicationPayload>
  refreshQuestions?(binding: RoomBinding, store: PublicationStore): Promise<void>
  authorized(operation: PublicationOperation): boolean
}
export type PublicationObservation = ConnectionDeliveryObservation
type LaneWatch = { handle?: ConversationObservationHandle; viewId: string | undefined; failure?: { code?: string } }
type Lane = { binding: RoomBinding; abort: AbortController; dirty: boolean; notice?: PublicationOperation; work?: Promise<void> | undefined; inspection?: Promise<void> | undefined; originalReading?: Promise<void> | undefined; inspectionAfter?: string; watch?: LaneWatch | undefined; permissionStop?: (() => void) | undefined; observation: PublicationObservation; sourceObservation?: ConnectionDeliverySourceObservation; gapAfter?: number; view?: string | undefined; viewId?: string | undefined; read?: { after: ConversationCheckpoint; cursor?: string; pending?: ConversationWindowAssembly | undefined } | undefined }
export type PublicationHostOptions = { connections: ConnectionHost; bindings: RoomBindingReadPort; conversation: PublicationConversationPort; permissions?: PublicationPermissionsPort; store?: PublicationStore; queryFeedback?: true; speaker?: PublicationSpeakerReader }


/** Durable external publication. Each Binding has an independent read/effect lane, outside original Core input. */
export class PublicationHost implements ConnectionDeliveryPort {
  readonly store: PublicationStore
  private readonly lanes = new Map<string, Lane>()
  private readonly notices = new Map<string, Lane>()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: PublicationHostOptions) {
    this.store = options.store ?? new PublicationStore(options.connections.database, options.bindings)
    // Recovery probes only failed/closed/unconfirmed lanes. Healthy source reads are notification-driven.
    this.timer = setInterval(() => this.refresh(true), 5_000); this.timer.unref()
    this.refresh()
  }
  refresh(recoveryOnly = false): void {
    if (this.closed) return
    this.refreshNotices()
    let active: RoomBinding[]
    try { active = this.options.bindings.listActive().flatMap(current => { const original = readRoomPublicationBinding(this.options.bindings, current); return original ? [original] : [] }) } catch { for (const lane of this.lanes.values()) lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }; return }
    const current = new Map(active.map(binding => [binding.bindingId, binding]))
    for (const [id, lane] of this.lanes) {
      const authority = this.authority(lane.binding)
      if (authority === null) { lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }; continue }
      if (current.get(id)?.revision !== lane.binding.revision || !authority.authorized) {
        lane.abort.abort(); lane.permissionStop?.(); try { lane.watch?.handle?.dispose() } catch { /* Cancels only this original reader. */ }; this.lanes.delete(id)
      }
    }
    for (const binding of active) {
      if (!this.authorized(binding)) continue
      let lane = this.lanes.get(binding.bindingId)
      if (!lane) {
        lane = { binding, abort: new AbortController(), dirty: false, observation: { state: 'unknown', reason: 'not-started' } }
        this.lanes.set(binding.bindingId, lane)
        try {
          const current = lane, adapter = this.options.connections.publicationAdapter(binding.connectionId)
          lane.permissionStop = adapter?.permissionActions === true || adapter?.questionActions === true ? this.options.permissions?.observe(binding, () => this.wake(current)) : undefined
        } catch { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' } }
        this.wake(lane)
      } else if (!recoveryOnly || lane.observation.state !== 'ready' || !lane.watch?.handle || lane.watch.failure || lane.watch.handle.closed.aborted) this.wake(lane)
    }
  }
  /** Optional feedback has no network work on the ingress path; its durable effect wakes only this audience. */
  receiveQuery(binding: RoomBinding, record: import('@agentmux/core/connections').ConnectionIngressMessage): void {
    const lane = this.lanes.get(binding.bindingId)
    try {
      if (!this.authorized(binding) || this.options.connections.publicationAdapter(binding.connectionId)?.queryFeedback !== true) return
      const original = readRoomPublicationBinding(this.options.bindings, binding)
      if (!original) { if (lane) lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' }; return }
      this.store.queueQueryReceived(original, record)
      if (lane) this.wake(lane)
    } catch {
      if (lane) lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }
      // The captured input/native adoption window recovers this same effect; input remains usable.
    }
  }
  /** A member rule changes only existing lanes for that original application; receiver configuration is unchanged. */
  refreshAccess(adapterId: string, application: RoomBinding['application'], bindingId?: string): void {
    if (this.closed) return
    for (const lane of this.lanes.values()) {
      if (bindingId && lane.binding.bindingId !== bindingId || lane.binding.application.domain !== application.domain || lane.binding.application.appId !== application.appId) continue
      const config = this.options.connections.readConfiguration(lane.binding.connectionId)?.config
      if (config?.adapterId === adapterId) this.wake(lane)
    }
  }
  private authority(binding: Pick<RoomBinding, 'bindingId' | 'revision'>) {
    try { return this.options.bindings.publicationAuthority(binding.bindingId, binding.revision) }
    catch { return null }
  }
  private authorized(binding: RoomBinding): boolean { return !this.closed && this.authority(binding)?.authorized === true }
  /** Explicit lifecycle authority is narrower than ordinary publication and does not enable synchronization. */
  private noticeAuthorized(notice: PublicationOperation): boolean {
    if (this.closed || notice.payload.kind !== 'binding-lifecycle' || notice.reference.source.kind !== 'binding-operation') return false
    const source = notice.reference.source
    const original = this.options.bindings.readOperation?.(source.operationId)
    if (original?.state !== 'applied' || !original.notices?.some(item => item.deliveryOperationId === notice.operationId && item.event === source.event)) return false
    const binding = this.options.bindings.readExact(notice.bindingId, notice.bindingRevision)
    const connection = this.options.connections.readConfiguration(notice.target.connectionId)
    return !!binding && connection?.config.enabled === true && binding.connectionId === notice.target.connectionId &&
      binding.application.domain === notice.target.application.domain && binding.application.appId === notice.target.application.appId &&
      connection.config.application.domain === binding.application.domain && connection.config.application.appId === binding.application.appId &&
      binding.externalConversationId === notice.target.externalConversationId && binding.executionHostId === notice.reference.hostId && binding.agentSessionId === notice.reference.agentSessionId
  }
  private refreshNotices(): void {
    let pending: PublicationOperation[]
    try { pending = this.store.pendingBindingNotices() } catch { for (const lane of this.notices.values()) lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }; return }
    const ids = new Set(pending.map(item => item.operationId))
    for (const [id, lane] of this.notices) if (!ids.has(id)) { lane.abort.abort(); this.notices.delete(id) }
    for (const notice of pending) {
      let lane = this.notices.get(notice.operationId)
      if (!lane) {
        let binding: RoomBinding | null
        try { binding = this.options.bindings.readExact(notice.bindingId, notice.bindingRevision) } catch { continue /* Original pending notice survives this unavailable read. */ }
        if (!binding) continue
        lane = { binding, notice, abort: new AbortController(), dirty: false, observation: { state: 'unknown', reason: 'not-started' } }
        this.notices.set(notice.operationId, lane)
      }
      this.wake(lane)
    }
  }
  private wake(lane: Lane): void {
    if (this.closed || lane.abort.signal.aborted) return
    lane.dirty = true
    if (lane.work) return
    lane.work = Promise.resolve().then(async () => {
      while (lane.dirty && !lane.abort.signal.aborted && !this.closed) {
        lane.dirty = false
        try { await this.cycle(lane) }
        catch { if (!lane.abort.signal.aborted) lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' } }
      }
    }).finally(() => { lane.work = undefined; if (lane.dirty && !lane.abort.signal.aborted) this.wake(lane) })
  }
  private async cycle(lane: Lane): Promise<void> {
    if (lane.notice) {
      const adapter = this.options.connections.publicationAdapter(lane.notice.target.connectionId)
      if (!adapter) { lane.observation = { state: 'unavailable', reason: 'adapter-unavailable' }; return }
      if (!this.noticeAuthorized(lane.notice)) { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' }; return }
      this.reconcile(lane, adapter, lane.notice.projectionId)
      const observation = await this.drain(lane, adapter, lane.notice.projectionId)
      if (observation) lane.observation = observation
      return
    }
    const binding = lane.binding, signal = lane.abort.signal, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
    if (!this.authorized(binding)) return
    const adapter = this.options.connections.publicationAdapter(binding.connectionId)
    if (!adapter) { lane.observation = { state: 'unavailable', reason: 'adapter-unavailable' }; return }
    this.reconcile(lane, adapter)
    let permissionProjections: string[] = [], permissionsUnavailable = false, accessUnavailable = false
    try {
      if (adapter.permissionActions === true || adapter.questionActions === true) {
        lane.permissionStop ??= this.options.permissions?.observe(binding, () => this.wake(lane))
        permissionProjections = this.options.permissions?.project(binding, this.store, { permission: adapter.permissionActions === true, question: adapter.questionActions === true }, () => { permissionsUnavailable = true; accessUnavailable = true }) ?? []
        if (adapter.questionActions) await this.options.permissions?.refreshQuestions?.(binding, this.store)
      }
    } catch { permissionsUnavailable = true }
    for (const projection of permissionProjections) {
      try { await this.drain(lane, adapter, projection) } catch { permissionsUnavailable = true }
    }
    try { await this.catchUp(lane, adapter) }
    catch {
      // COMMIT may have succeeded before its acknowledgment was lost. Reload
      // the retained cut before retrying, without inventing another operation.
      lane.read = undefined; lane.view = undefined; lane.viewId = undefined
      if (!signal.aborted) {
        lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }
        lane.sourceObservation = { state: 'unavailable', reason: 'storage-unconfirmed', code: null, codeRecorded: false, checkpointKey: lane.sourceObservation?.checkpointKey ?? null }
      }
    }
    if (!signal.aborted && this.authorized(binding)) {
      let effectObservation: PublicationObservation | undefined
      try { effectObservation = await this.drain(lane, adapter) }
      catch (error) { effectObservation = { state: 'unavailable', reason: error instanceof AgentMuxError && ['PUBLICATION_ADAPTER_UNAVAILABLE', 'PUBLICATION_PREPARATION_UNCONFIRMED'].includes(error.code) ? 'adapter-unavailable' : 'storage-unconfirmed' } }
      // Original effects may still settle or dispatch; their observation cannot hide an unresolved content gap.
      if (effectObservation && lane.observation.state === 'ready') lane.observation = effectObservation
    }
    if (permissionsUnavailable && (lane.observation.state === 'ready' || accessUnavailable && lane.observation.reason === 'source-unconfirmed' && lane.sourceObservation?.state !== 'unavailable')) lane.observation = { state: 'unavailable', reason: accessUnavailable ? 'access-unconfirmed' : 'source-unconfirmed' }
  }
  private async observeLane(lane: Lane, sourceHostId?: string, acceptedSources?: readonly ConversationSourceRef[]): Promise<void> {
    if (lane.watch?.handle && !lane.watch.failure && !lane.watch.handle.closed.aborted && lane.watch.viewId === lane.viewId) return
    const reference = { hostId: lane.binding.executionHostId, agentSessionId: lane.binding.agentSessionId }, signal = lane.abort.signal
    const previous = lane.watch, watch: LaneWatch = { viewId: lane.viewId }
    lane.watch = watch // Fence callbacks before releasing the previous original subscription.
    previous?.handle?.dispose()
    const unavailable = (code?: string) => {
      if (signal.aborted || lane.watch !== watch) return
      watch.failure = { ...(code ? { code } : {}) }
      this.sourceUnavailable(lane, 'source-unconfirmed', code ? new AgentMuxError('The original publication subscription is unavailable.', code) : undefined)
    }
    let pending: ConversationObservation | undefined
    const onObservation = (observation: ConversationObservation): void => {
      if (signal.aborted || lane.watch !== watch) return
      // A notification can follow Core's opening snapshot but precede the port
      // returning its handle. Retain it until that owner and scope are known.
      if (!watch.handle) { if (!pending || pending.kind !== 'unavailable') pending = observation; return }
      if (observation.hostId !== reference.hostId || observation.agentSessionId !== reference.agentSessionId || observation.sourceHostId !== (sourceHostId ?? watch.handle.sourceHostId)) return
      const sources = acceptedSources ?? watch.handle.scope.sources.filter(source => source.kind === 'native')
      if (!sources.some(source => conversationSourceKey(source) === conversationSourceKey(observation.source))) return
      if (observation.kind === 'unavailable') { unavailable(observation.code); return }
      this.wake(lane)
    }
    try {
      const handle = await this.options.conversation.observe({ ...reference, ...(lane.view ? { view: lane.view } : {}) }, onObservation, signal)
      if (signal.aborted || lane.watch !== watch) { handle.dispose(); return }
      if (handle.hostId !== reference.hostId || handle.agentSessionId !== reference.agentSessionId || sourceHostId !== undefined && handle.sourceHostId !== sourceHostId) { handle.dispose(); throw Error('Foreign observation owner') }
      watch.handle = handle
      const sources = acceptedSources ?? handle.scope.sources.filter(source => source.kind === 'native')
      const failed = handle.coverage.find(value => (acceptedSources ? sources.some(source => conversationSourceKey(source) === conversationSourceKey(value.source)) : value.source.kind === 'native' || value.source.kind === 'native-unavailable') && ['unavailable', 'unsupported'].includes(value.current))
      if (failed) unavailable(failed.gaps[0]?.code)
      // A captured-only opening is useful to Core readers, but cannot establish
      // this dedicated native origin. The existing recovery lane may rediscover it.
      if (!acceptedSources && !sources.length) unavailable(failed?.gaps[0]?.code ?? 'AGENT_CONVERSATION_NATIVE_UNAVAILABLE')
      handle.closed.addEventListener('abort', () => unavailable(), { once: true })
      if (handle.closed.aborted) unavailable()
      if (pending) onObservation(pending)
    } catch (error) { unavailable(error instanceof AgentMuxError ? error.code : undefined) }
  }
  private async catchUp(lane: Lane, adapter: PublicationAdapter): Promise<void> {
    const binding = lane.binding, signal = lane.abort.signal, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
    let after = this.store.retainedCheckpoint(binding)
    let sourceHostId = after?.sourceHostId ?? binding.sourceFrontier?.sourceHostId
    if (!after && binding.publicationOrigin) await this.observeLane(lane)
    if (!after && binding.publicationOrigin) {
      try {
        const page = parseConversationCheckpointPage(await this.options.conversation.checkpoint({ ...reference, nativePosition: 'beginning' }, signal), reference)
        const native = page.checkpoint.frontier.cuts.filter(cut => cut.kind === 'native')
        if (native.length !== 1) {
          const failure = page.coverage.find(value => (value.source.kind === 'native' || value.source.kind === 'native-unavailable') && ['unavailable', 'unsupported'].includes(value.current))?.gaps[0]
          throw new AgentMuxError('The original native beginning is unavailable. Its first reply and input are retained.', failure?.code ?? 'AGENT_CONVERSATION_NATIVE_UNAVAILABLE')
        }
        const opening = lane.watch?.handle
        if (opening && (opening.sourceHostId !== page.sourceHostId || opening.scope.sources.some(source => source.kind === 'native' && (source.providerId !== native[0]!.checkpoint.source.providerId || source.nativeSessionId !== native[0]!.checkpoint.source.nativeSessionId)))) {
          if (lane.watch?.handle === opening) lane.watch.failure = { code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' }
          throw new AgentMuxError('The original native source changed while its beginning was established.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
        }
        sourceHostId = page.sourceHostId
        after = this.store.checkpoint(binding, sourceHostId, { ...page.checkpoint, frontier: { ...page.checkpoint.frontier,
          scope: { sources: native.map(cut => ({ kind: 'native' as const, ...cut.checkpoint.source })) }, cuts: native } })
      } catch (error) { this.sourceUnavailable(lane, 'source-unconfirmed', error); return }
    }
    try { sourceHostId ??= (await this.options.conversation.checkpoint(reference, signal)).sourceHostId }
    catch (error) { this.sourceUnavailable(lane, 'source-unconfirmed', error); return }
    after ??= this.store.checkpoint(binding, sourceHostId)
    const acceptedSources = after.frontier.scope.sources
    await this.observeLane(lane, sourceHostId, acceptedSources)
    // Transient fragment state is bounded to one original batch. A restart discards
    // it and resumes the original durable cut, preserving all unknown effects.
    lane.read ??= { after }
    let nativeFailure: { code?: string } | undefined
    for (let reads = 0; reads < 8; reads++) {
      if (signal.aborted || !this.authorized(binding)) return
      const state = lane.read, input = { ...reference, checkpoint: state.after, limit: 100, ...(state.cursor ? { cursor: state.cursor } : {}), ...(lane.view ? { view: lane.view } : {}) }
      let page: ConversationChangesPage
      try { page = parseConversationChangesPage(await this.options.conversation.changes(input, signal), input) }
      catch (error) { lane.read = undefined; lane.view = undefined; lane.viewId = undefined; this.sourceUnavailable(lane, 'source-gap', error, connectionDiagnosisCheckpointKey(state.after)); return }
      // Core may return captured records while the exact native changes read failed.
      // The current page, not an established cut or an open watch, owns that fact.
      const unavailable = page.coverage.find(value => (value.source.kind === 'native' || value.source.kind === 'native-unavailable') &&
        (value.current === 'unavailable' || value.current === 'unsupported' || value.gaps.length > 0))
      nativeFailure = unavailable ? { ...(unavailable.gaps[0]?.code ? { code: unavailable.gaps[0].code } : {}) } : undefined
      const consumed = consumeConversationWindowPage(page, state.pending)
      if (consumed.kind === 'pending') {
        state.pending = consumed.pending
        if (page.nextCursor === state.cursor) throw Error('Original continuation made no progress')
        state.cursor = page.nextCursor!
        if (reads === 7) lane.dirty = true
        continue
      }
      const ordered = [...consumed.snapshot.units].reverse() // The Core wire explicitly declares newest-first.
      const resolvedText = await this.resolve(reference, ordered, signal, binding, adapter)
      const speakers = await this.speakers(reference, ordered, signal)
      const originals = binding.scope.publication === 'future-shared-conversation'
        ? new Map(ordered.map(unit => [unit.event.id, publicationMessageTargets(unit, binding.sourceFrontier).map(target => ({ key: target.key, ...(target.notificationId ? { notificationId: target.notificationId } : {}), record: target.record, revision: target.revision, ...(target.startUnconfirmed ? { startUnconfirmed: true as const } : {}), ...(target.part ? { part: target.part } : {}), messages: [], unavailable: true }))])) : new Map()
      const questions = adapter.questionActions ? this.options.permissions?.questions?.(binding, ordered) : undefined
      this.store.commitPage(binding, state.after, page, () => this.authorized(binding), { units: ordered, resolvedText, speakers, originals, ...(this.options.queryFeedback && adapter.queryFeedback ? { queryFeedback: true } : {}), fragmentBytes: adapter.fragmentBytesFor?.(binding) ?? adapter.fragmentBytes, ...(adapter.fragmentText ? { fragmentText: (payload, speaker, originalMessage) => adapter.fragmentText!(payload, binding, speaker, originalMessage) } : {}), ...(questions ? { questions } : {}) })
      after = page.checkpoint; lane.view = page.window.view!; lane.viewId = page.window.id; lane.read = { after }
      if (lane.watch?.viewId !== lane.viewId) lane.dirty = true
      if (!page.more) { lane.read = undefined; break }
      if (reads === 7) lane.dirty = true
    }
    const failure = nativeFailure ?? lane.watch?.failure
    if (failure) this.sourceUnavailable(lane, nativeFailure ? 'source-gap' : 'source-unconfirmed', failure.code ? new AgentMuxError('The original publication source is unavailable.', failure.code) : undefined, connectionDiagnosisCheckpointKey(after))
    else lane.sourceObservation = { state: 'ready', code: null, codeRecorded: false, checkpointKey: connectionDiagnosisCheckpointKey(after) }
    await this.recoverContent(lane, adapter)
    lane.observation = this.store.coverage(binding).state === 'incomplete' ? { state: 'unavailable', reason: 'content-unconfirmed' }
      : lane.sourceObservation?.state === 'ready' && lane.watch?.handle && !lane.watch.failure && !lane.watch.handle.closed.aborted ? { state: 'ready' } : { state: 'unavailable', reason: 'source-unconfirmed' }
  }
  private sourceUnavailable(lane: Lane, reason: 'source-unconfirmed' | 'source-gap', error: unknown, checkpointKey = lane.sourceObservation?.checkpointKey ?? null): void {
    const code = error instanceof AgentMuxError ? error.code : undefined
    lane.observation = { state: 'unavailable', reason }
    lane.sourceObservation = { state: 'unavailable', reason, code: connectionDiagnosisSourceCode(code), codeRecorded: code !== undefined, checkpointKey }
  }
  private async originalMessages(binding: RoomBinding, units: readonly ConversationUnit[], signal: AbortSignal): Promise<Map<string, PublicationA2A[]>> {
    if (binding.scope.publication !== 'future-shared-conversation') return new Map()
    const reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
    const originals = await readPublicationA2A(reference, units, {
      notification: (...input) => this.until(this.options.conversation.notification(...input), signal),
      message: (...input) => this.until(this.options.conversation.message(...input), signal)
    }, signal, binding.sourceFrontier)
    const details = new Map<string, Promise<PublicationSpeakerDetails>>()
    for (const rows of originals.values()) for (const row of rows) for (const message of row.messages) {
      const target = message.speaker!.reference!, key = JSON.stringify(target)
      if (this.options.speaker && !details.has(key)) details.set(key, this.until(this.options.speaker(target, signal), signal).catch(() => { signal.throwIfAborted(); return {} }))
      if (details.has(key)) {
        const observed = await details.get(key)!, speaker = message.speaker!
        if (observed.name !== undefined) speaker.name = observed.name
        if (observed.nameRevision !== undefined) speaker.nameRevision = observed.nameRevision
        if (observed.mote !== undefined) speaker.mote = observed.mote
        if (observed.avatar !== undefined) speaker.avatar = observed.avatar
      }
    }
    return originals
  }
  private async speakers(reference: ConversationRef, units: readonly ConversationUnit[], signal: AbortSignal): Promise<Map<string, PublicationSpeaker>> {
    const result = new Map<string, PublicationSpeaker>(), details = new Map<string, Promise<PublicationSpeakerDetails>>()
    for (const unit of units) {
      const speaker = publicationSpeaker(unit, reference)
      if (speaker.kind === 'agent' && speaker.reference && this.options.speaker) {
        const target = speaker.reference, key = JSON.stringify(target)
        if (!details.has(key)) details.set(key, this.until(this.options.speaker(target, signal), signal).catch(() => { signal.throwIfAborted(); return {} }))
        const observed = await details.get(key)!
        if (observed.name !== undefined) speaker.name = observed.name
        if (observed.nameRevision !== undefined) speaker.nameRevision = observed.nameRevision
        if (observed.mote !== undefined) speaker.mote = observed.mote
        if (observed.avatar !== undefined) speaker.avatar = observed.avatar
      }
      result.set(unit.event.id, speaker)
    }
    return result
  }
  private async resolve(reference: ConversationRef, units: readonly ConversationUnit[], signal: AbortSignal, binding: RoomBinding, adapter: PublicationAdapter): Promise<Map<string, ResolvedPublicationPart>> {
    const result = new Map<string, ResolvedPublicationPart>()
    for (const unit of units) for (const slot of unit.event.content) {
      const record = unit.records.find(record => record.id === slot.recordId)!
      if (!isCompleteConversationRecord(record) || record.original.kind !== 'native' || record.reference!.source.kind !== 'native' || slot.selector.kind !== 'native-part') continue
      const item = record.original.item, part = item.contentParts[slot.selector.partIndex]!
      if (!isConversationPublicationPart(record, slot.selector, unit.event.author) || part.contentEligibility !== 'public') continue
      const nativeSource = record.reference!.source, partIndex = slot.selector.partIndex
      const markdown = async (text: string) => item.kind !== 'assistant-message' ? undefined : publicationMarkdown(text, {
        source: { providerId: nativeSource.providerId, nativeSessionId: nativeSource.nativeSessionId },
        recordId: item.id, ...(item.turnId ? { turnId: item.turnId } : {}), partIndex,
        ...(part.kind === 'resource' ? { expectedReference: part.reference } : {})
      }, async input => {
        const response = await this.options.conversation.resource(reference, input, signal)
        if (response.agentSessionId !== reference.agentSessionId) throw Error('Foreign Markdown resource Session')
        return response
      }, adapter.images, signal, (textSha256, start, end) => this.store.retainedDiagram(binding,
        { record: record.reference!, recordRevision: record.revision, selector: slot.selector }, text, textSha256, start, end))
      if (part.kind === 'text') {
        const value = await markdown(part.text)
        if (value) result.set(publicationPartKey({ record: record.reference!, selector: slot.selector }), value)
        continue
      }
      if (part.kind !== 'resource') continue
      const deferred = part.resourceType === 'text' && part.content?.kind === 'resource'
      if (binding.scope.publication === 'future-shared-conversation' &&
        ((part.resourceType === 'image' || deferred) && adapter.images || (part.resourceType === 'file' || deferred) && adapter.files)) {
        const key = publicationPartKey({ record: record.reference!, selector: slot.selector })
        result.set(key, { kind: part.resourceType === 'file' ? 'file-unavailable' : 'image-unavailable' })
        const input = { source: { providerId: record.reference!.source.providerId, nativeSessionId: record.reference!.source.nativeSessionId }, recordId: item.id,
          ...(item.turnId ? { turnId: item.turnId } : {}), partIndex: slot.selector.partIndex, expectedReference: part.reference }
        if ((part.resourceType === 'image' || deferred) && adapter.images) try {
          const request = { ...input, maxBytes: adapter.images.maxBytes, representation: 'image' as const }
          const response = await this.options.conversation.resource(reference, request, signal)
          if (response.agentSessionId !== reference.agentSessionId) throw Error('Foreign image resource Session')
          const { agentSessionId: _session, ...original } = response
          const read = parseProviderSessionHistoryResourceReadResult(original, request).result
          if (read.status === 'read') {
            const image = publicationImage(read)
            if (adapter.images.accepts(image)) { result.set(key, { kind: 'image', image }); continue }
          }
        } catch { signal.throwIfAborted() /* Keep this exact part as a recoverable gap. */ }
        if ((part.resourceType === 'file' || deferred) && adapter.files) try {
          const request = { ...input, maxBytes: adapter.files.maxBytes, representation: 'file' as const }
          const response = await this.options.conversation.resource(reference, request, signal)
          if (response.agentSessionId !== reference.agentSessionId) throw Error('Foreign file resource Session')
          const { agentSessionId: _session, ...original } = response
          const read = parseProviderSessionHistoryResourceReadResult(original, request).result
          if (read.status === 'file') {
            const file = publicationFile(read)
            if (adapter.files.accepts(file)) result.set(key, { kind: 'file', file })
          }
        } catch { signal.throwIfAborted() /* Independent text is retained. */ }
        continue
      }
      if (part.resourceType !== 'text' || !part.content || part.content.kind === 'resource' || binding.scope.publication === 'future-native-user-facing' && part.content.kind !== 'text') continue
      try {
        const value = await readSessionHistoryTextResource(part, slot.selector.partIndex,
          { source: { providerId: record.reference!.source.providerId, nativeSessionId: record.reference!.source.nativeSessionId }, recordId: item.id, ...(item.turnId ? { turnId: item.turnId } : {}) },
          async input => {
            const response = await this.options.conversation.resource(reference, input, signal)
            if (response.agentSessionId !== reference.agentSessionId) throw Error('Foreign resource Session')
            return response
          }, signal)
        result.set(publicationPartKey({ record: record.reference!, selector: slot.selector }), value.kind === 'text' ? await markdown(value.text) ?? value : value)
      } catch { signal.throwIfAborted() /* Exact unresolved part is durably accounted; other contents keep flowing. */ }
    }
    return result
  }
  private async gapUnits(lane: Lane, gap: import('@agentmux/core/connections').ConnectionDeliveryGap): Promise<ConversationUnit[]> {
    const binding = lane.binding, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }, signal = lane.abort.signal
    let cursor: string | undefined, pending: JsonReadAssembly | undefined
    const units: ConversationUnit[] = []
    for (let reads = 0; reads < 1024; reads++) {
      signal.throwIfAborted()
      const input = { ...reference, anchor: gap.anchor!, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }
      const page = parseConversationReadPage(await this.until(this.options.conversation.inspect(input, signal), signal), input)
      for (const entry of page.items) {
        const value = consumeJsonReadEntry({ entry, scopeKey: JSON.stringify(gap.anchor), ...(pending ? { pending } : {}), maxTotalBytes: CONVERSATION_MAX_UNIT_BYTES })
        if (value.kind === 'pending') { pending = value.pending; continue }
        pending = undefined; units.push(parseConversationUnit(value.value, { hostId: page.sourceHostId, agentSessionId: binding.agentSessionId }, page.scope))
      }
      if (!page.nextCursor) {
        if (pending) throw Error('Original part fragments are incomplete')
        if (!units.length) {
          const failure = page.coverage.flatMap(c => c.gaps).find(g => g.code === 'AGENT_CONVERSATION_VERSION_UNAVAILABLE')
          if (failure) this.store.versionUnavailable(binding, gap, failure.code)
        }
        return units
      }
      if (cursor === page.nextCursor) throw Error('Original part continuation made no progress')
      cursor = page.nextCursor
    }
    return units
  }
  /** One cancellable related journal read cannot hold this Binding's ordinary speech lane. */
  private recoverOriginalMessages(lane: Lane, adapter: PublicationAdapter, gap: import('@agentmux/core/connections').ConnectionDeliveryGap): void {
    if (lane.originalReading) return
    const binding = lane.binding, signal = lane.abort.signal
    let recovered = false
    lane.originalReading = Promise.resolve().then(async () => {
      for (const unit of await this.gapUnits(lane, gap)) {
        const originals = await this.originalMessages(binding, [unit], signal)
        signal.throwIfAborted()
        this.store.recoverOriginalMessages(binding, gap, unit, originals.get(unit.event.id) ?? [], () => this.authorized(binding), adapter.fragmentBytesFor?.(binding) ?? adapter.fragmentBytes, adapter.fragmentText ? (payload, speaker, originalMessage) => adapter.fragmentText!(payload, binding, speaker, originalMessage) : undefined)
        if ([...originals.values()].flat().some(value => !value.unavailable)) recovered = true
      }
    }).catch(() => { /* The exact durable gap retains its original target; ordinary publication stays usable. */ })
      .finally(() => { lane.originalReading = undefined; if (recovered && !signal.aborted && this.authorized(binding)) this.wake(lane) })
  }
  private async recoverContent(lane: Lane, adapter: PublicationAdapter): Promise<void> {
    const binding = lane.binding, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }, signal = lane.abort.signal
    const gaps = this.store.recoverableGaps(binding, lane.gapAfter ?? 0)
    if (!gaps.length) { delete lane.gapAfter; return }
    for (const { ordinal, gap } of gaps) {
      if (!gap.anchor || signal.aborted || !this.authorized(binding)) continue
      if (gap.code === 'PUBLICATION_A2A_ORIGINAL_UNAVAILABLE') {
        if (!lane.originalReading) { lane.gapAfter = ordinal; this.recoverOriginalMessages(lane, adapter, gap) }
        continue
      }
      lane.gapAfter = ordinal
      if (!gap.part) continue
      try {
        for (const unit of await this.gapUnits(lane, gap)) {
          const speakers = await this.speakers(reference, [unit], signal)
          this.store.recoverPart(binding, gap, unit, await this.resolve(reference, [unit], signal, binding, adapter), () => this.authorized(binding), adapter.fragmentBytesFor?.(binding) ?? adapter.fragmentBytes, adapter.fragmentText ? (payload, speaker, originalMessage) => adapter.fragmentText!(payload, binding, speaker, originalMessage) : undefined, speakers.get(unit.event.id))
        }
      } catch { signal.throwIfAborted() /* Original exact gap remains durable and other contents continue. */ }
    }
  }
  private effectObservation(binding: RoomBinding, projectionId?: string): PublicationObservation | undefined {
    const state = this.store.unresolvedState(binding, projectionId)
    return state === 'unknown' ? { state: 'unknown', reason: 'effect-unconfirmed' }
      : state === 'not-applied' ? { state: 'unavailable', reason: 'effect-unconfirmed' } : undefined
  }
  /** Optional observation has one in-flight read on the existing lane; it never gates new independent effects. */
  private reconcile(lane: Lane, adapter: PublicationAdapter, projectionId?: string): void {
    if (lane.inspection || lane.abort.signal.aborted || this.closed) return
    let original = this.store.nextUnconfirmed(lane.binding, lane.inspectionAfter, projectionId)
    if (!original && lane.inspectionAfter) { delete lane.inspectionAfter; original = this.store.nextUnconfirmed(lane.binding, undefined, projectionId) }
    if (!original) return
    lane.inspectionAfter = original.operationId
    if (original.state === 'dispatching') original = this.store.settle(original.operationId, original.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
    const retained = original
    if (!adapter.inspect || !retained.prepared) return
    const authorized = () => lane.notice ? this.noticeAuthorized(lane.notice) : this.authorized(lane.binding)
    lane.inspection = Promise.resolve().then(async () => {
      if (!authorized() || lane.abort.signal.aborted) return
      let credential: string | null
      try { credential = await this.options.connections.resolveCredential(lane.binding.connectionId) } catch { credential = null }
      if (!credential || !authorized() || lane.abort.signal.aborted) return
      const signal = AbortSignal.any([lane.abort.signal, AbortSignal.timeout(30_000)])
      const observation = Promise.resolve(adapter.inspect!(parsePreparedPublication(retained.prepared, adapter), retained.target, credential, signal, retained.mapping))
      observation.then(receipt => {
        if (!receipt || this.closed) return
        try {
          const before = this.store.inspect(retained.operationId), settled = this.store.settle(retained.operationId, retained.attempt!, receipt)
          // Null/unchanged uncertainty must not create a self-sustaining recovery loop.
          if (before?.state !== settled.state) this.wake(lane)
        } catch { /* A stale/contradictory read cannot rewrite an authoritative original attempt. */ }
      }, () => {})
      // An adapter that ignores abort cannot occupy the lane's observation slot forever.
      // Its genuinely late receipt still belongs to the retained attempt above.
      await this.until(observation, signal)
    }).catch(() => { /* Only this exact observation remains unconfirmed; input and independent publication continue. */ })
      .finally(() => { lane.inspection = undefined })
  }
  private async drain(lane: Lane, adapter: PublicationAdapter, projectionId?: string): Promise<PublicationObservation | undefined> {
    const binding = lane.binding, signal = lane.abort.signal
    const authorized = () => lane.notice ? this.noticeAuthorized(lane.notice) : this.authorized(binding)
    const accepted = new Map<string, { unit: ConversationUnit; frontier: ConversationCheckpoint; resolved: ReadonlyMap<string, ResolvedPublicationPart> }>()
    const qualified = new Set<string>() // One frozen representation is verified once in this bounded drain.
    for (let count = 0; count < 16; count++) {
      if (signal.aborted || !authorized()) return
      let original = this.store.next(binding, projectionId)
      if (!original) return this.effectObservation(binding, projectionId)
      let credential: string | null
      try { credential = await this.options.connections.resolveCredential(binding.connectionId) }
      catch (error) { return { state: 'unavailable', reason: credentialLookupFailure(error) ?? 'storage-unconfirmed' } }
      if (!credential) return { state: 'unavailable', reason: 'credential-missing' }
      if (signal.aborted || !authorized()) return
      const frozen = JSON.stringify([original.projectionId, original.sourceRevision])
      const relevant = qualified.has(frozen) ? [] : this.store.pendingRecords(original)
      if (!qualified.has(frozen) && !original.originalMessage && ['speech', 'image', 'file', 'question'].includes(original.payload.kind) && original.effect === 'upsert' && ['native', 'captured'].includes(original.reference.source.kind)) {
        const reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
        try {
          for (const record of relevant) {
            const key = conversationRecordId(record)
            if (accepted.has(key)) continue
            let cursor: string | undefined, pending: ConversationWindowAssembly | undefined, complete = false
            while (!complete) {
              signal.throwIfAborted()
              const input = { ...reference, record, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }
              const page = parseConversationReadPage(await this.options.conversation.inspect(input, signal), input)
              const before = (pending?.bytes ?? 0) + (pending?.fragment?.receivedBytes ?? 0)
              const consumed = consumeConversationWindowPage(page, pending)
              if (consumed.kind === 'complete') {
                const unit = consumed.snapshot.units.find(unit => unit.records.some(value => conversationRecordId(value.reference!) === key))
                if (!unit) throw Error('The exact pending conversation record is unavailable')
                accepted.set(key, { unit, frontier: page.window.checkpoint, resolved: await this.resolve(reference, [unit], signal, binding, adapter) }); complete = true; break
              }
              pending = consumed.pending
              if (!page.items.length || !page.nextCursor || cursor === page.nextCursor || pending.bytes + (pending.fragment?.receivedBytes ?? 0) <= before) throw Error('The exact pending record made no progress')
              cursor = page.nextCursor
            }
          }
        } catch { signal.throwIfAborted() /* The exact missing observation becomes a durable gap below. */ }
        const qualification = this.store.qualifyPending(binding, original, accepted, this.store.checkpoint(binding, binding.sourceFrontier?.sourceHostId ?? original.reference.hostId))
        if (qualification === 'cancelled') continue
        if (qualification !== 'qualified') return { state: 'unavailable', reason: 'source-unconfirmed' }
        qualified.add(frozen)
      }
      if (original.effect === 'upsert' && original.speaker?.avatar?.image && !original.prepared && original.attempt === undefined) {
        const last = original.avatarUploads?.at(-1)
        if (last?.state === 'dispatching') this.store.settleResourceUpload(original.operationId, original.avatarUploads!.length, { state: 'unknown' }, 'avatar')
        else if (!last && !original.avatarSource && adapter.images?.upload && adapter.images.accepts(original.speaker.avatar.image)) {
          const upload = this.store.claimResourceUpload(original.operationId, authorized, 'avatar')
          if (upload?.speaker?.avatar?.image && !upload.avatarSource) {
            const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            let effect: Promise<ResourceUploadReceipt>
            try { effect = Promise.resolve(adapter.images.upload(upload.speaker.avatar.image, upload.target, credential, uploadSignal)) }
            catch { effect = Promise.reject(new Error('Unconfirmed original avatar upload.')) }
            const settle = (receipt: ResourceUploadReceipt) => { if (!this.closed) this.store.settleResourceUpload(upload.operationId, upload.avatarUploads!.length, receipt, 'avatar') }
            effect.then(receipt => { try { settle(receipt) } catch { try { settle({ state: 'unknown' }) } catch { /* Keep this same optional attempt. */ } } }, () => {
              try { settle({ state: 'unknown' }) } catch { /* Original bytes and receipt stay retained. */ }
            })
            // Optional presentation never delays the original body or replaces its frozen wire.
            uploadSignal.addEventListener('abort', () => { try { settle({ state: 'unknown' }) } catch { /* Retain the original optional claim. */ } }, { once: true })
          }
        }
        original = this.store.inspect(original.operationId)!
        if (signal.aborted || !authorized()) return
      }
      if (!adapter.directResources && (original.payload.kind === 'image' || original.payload.kind === 'file') && original.effect === 'upsert' && !original.prepared) {
        const last = original.uploads?.at(-1)
        if (last?.state === 'dispatching') { this.store.settleResourceUpload(original.operationId, original.uploads!.length, { state: 'unknown' }); continue }
        if (last?.state !== 'confirmed') {
          if (original.payload.kind === 'image' ? !adapter.images?.upload || !adapter.images.accepts(original.payload.image) : !adapter.files?.upload || !adapter.files.accepts(original.payload.file)) return { state: 'unavailable', reason: 'adapter-unavailable' }
          const upload = this.store.claimResourceUpload(original.operationId, () => authorized())
          if (!upload || (upload.payload.kind !== 'image' && upload.payload.kind !== 'file')) return
          if (signal.aborted || !authorized()) { this.store.settleResourceUpload(upload.operationId, upload.uploads!.length, { state: 'unknown' }); return }
          const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          let effect: Promise<ResourceUploadReceipt>
          try { effect = Promise.resolve(upload.payload.kind === 'image'
            ? adapter.images!.upload!(upload.payload.image, upload.target, credential, uploadSignal)
            : adapter.files!.upload!(upload.payload.file, upload.target, credential, uploadSignal)) }
          catch { effect = Promise.reject(new Error('Unconfirmed original resource upload.')) }
          const settle = (receipt: ResourceUploadReceipt) => { if (!this.closed) this.store.settleResourceUpload(upload.operationId, upload.uploads!.length, receipt) }
          effect.then(receipt => {
            try { settle(receipt) } catch { try { settle({ state: 'unknown' }) } catch { /* Preserve the same unconfirmed upload attempt. */ } }
            this.wake(lane)
          }, () => {})
          try { await this.until(effect, uploadSignal) } catch { try { settle({ state: 'unknown' }) } catch { /* Preserve its authoritative receipt or unconfirmed storage. */ } }
          if (signal.aborted || !authorized()) return
          original = this.store.inspect(upload.operationId)!
          if (original.uploads?.at(-1)?.state !== 'confirmed') continue
        }
      }
      if (['permission', 'question'].includes(original.payload.kind) && !this.options.permissions?.authorized(original)) return { state: 'unavailable', reason: 'source-unconfirmed' }
      const claimed = this.store.claimNext(binding, original.operationId, () => authorized() && (!['permission', 'question'].includes(original!.payload.kind) || this.options.permissions?.authorized(original!) === true), adapter, projectionId)
      if (!claimed) {
        // A concurrent original claim may expose another candidate. Re-enter qualification
        // on the existing lane, but never spin on the same unchanged pending operation.
        const next = this.store.next(binding, projectionId)
        if (next && next.operationId !== original.operationId) lane.dirty = true
        return this.effectObservation(binding, projectionId)
      }
      if (signal.aborted || !authorized() || ['permission', 'question'].includes(claimed.payload.kind) && !this.options.permissions?.authorized(claimed)) { this.store.settle(claimed.operationId, claimed.attempt!, { state: 'not-applied', reason: 'adapter-unavailable' }); return }
      const timeout = AbortSignal.timeout(30_000), dispatchSignal = AbortSignal.any([signal, timeout])
      let effect: Promise<PublicationReceipt>
      try { effect = Promise.resolve(adapter.dispatch(claimed.prepared!, claimed.target, credential, dispatchSignal, claimed.mapping, publicationEffectContext(claimed))) }
      catch { effect = Promise.reject(new Error('Unconfirmed original platform effect.')) }
      const settle = (receipt: PublicationReceipt) => { if (!this.closed) this.store.settle(claimed.operationId, claimed.attempt!, receipt) }
      // A late authoritative receipt can settle this same identity after timeout, never launch another effect.
      effect.then(receipt => {
        try { settle(receipt) } catch { try { settle({ state: 'unknown', reason: 'effect-unconfirmed' }) } catch { /* Retain an authoritative outcome or unconfirmed storage. */ } }
        this.wake(lane)
      }, () => {})
      try { await this.until(effect, dispatchSignal); if (signal.aborted) return }
      catch { try { settle({ state: 'unknown', reason: 'effect-unconfirmed' }) } catch { /* Retain already confirmed outcome or unconfirmed storage. */ } }
    }
    // Only real dispatchable work continues immediately. Old unknown reads wait for an original wake/recovery.
    if (this.store.next(binding, projectionId)) lane.dirty = true
    return this.effectObservation(binding, projectionId)
  }
  private until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('External effect observation ended.'))
    return new Promise((resolve, reject) => {
      const stop = () => reject(new Error('External effect observation ended.'))
      signal.addEventListener('abort', stop, { once: true })
      work.then(value => { signal.removeEventListener('abort', stop); resolve(value) }, error => { signal.removeEventListener('abort', stop); reject(error) })
    })
  }
  observation(bindingId: string, revision: number): PublicationObservation {
    const lane = this.lanes.get(bindingId)
    const requested = this.options.bindings.readExact(bindingId, revision)
    if (requested && lane?.binding.revision === roomPublicationReference(requested).revision) return lane.observation.state === 'ready' || lane.observation.reason === 'effect-unconfirmed'
      ? this.effectObservation(lane.binding) ?? { ...lane.observation } : { ...lane.observation }
    if (this.closed) return { state: 'unknown', reason: 'not-started' }
    const authority = this.authority({ bindingId, revision })
    return authority === null ? { state: 'unavailable', reason: 'storage-unconfirmed' } : authority.authorized ? { state: 'unknown', reason: 'not-started' } : { state: 'disabled' }
  }
  async inspect(value: ConnectionDeliveryOperationInput) {
    const input = parseConnectionDeliveryParams('connection.delivery.inspect', value), original = this.store.inspect(input.operationId)
    return { delivery: original ? publicDelivery(original) : null }
  }
  async list(value: ConnectionDeliveryListInput) {
    const input = parseConnectionDeliveryParams('connection.delivery.ls', value), binding = this.options.bindings.readExact(input.bindingId, input.bindingRevision)
    if (!binding || binding.connectionId !== input.connectionId) throw new AgentMuxError('The delivery audience does not match this exact Binding.', 'PUBLICATION_SOURCE_CONFLICT')
    const deliveries = this.store.list(binding, input.limit ?? 30, input.after, input.order).map(publicDelivery)
    const lane = this.lanes.get(binding.bindingId), sourceObservation = lane?.binding.revision === binding.revision ? lane.sourceObservation : undefined
    const effectObservation = this.effectObservation(binding)
    return { ...(sourceObservation ? { sourceObservation: { ...sourceObservation } } : {}), ...(effectObservation ? { effectObservation } : {}), deliveries, next: deliveries.length === (input.limit ?? 30) ? deliveries.at(-1)!.operationId : null, observation: this.observation(binding.bindingId, binding.revision), coverage: this.store.coverage(binding, input.limit ?? 30, input.afterContent) }
  }
  async retry(value: ConnectionDeliveryOperationInput, context: RoomBindingCallContext) {
    if (this.closed) throw new AgentMuxError('The original publication owner is closed. Inspect the retained operation through its current Host.', 'PUBLICATION_OWNER_UNAVAILABLE')
    const input = parseConnectionDeliveryParams('connection.delivery.retry', value)
    parseRoomBindingAuthority(context.actor); await context.assertCurrent?.()
    if (this.closed) throw new AgentMuxError('The original publication owner closed during authorization. Its original outcome is retained.', 'PUBLICATION_OWNER_UNAVAILABLE')
    const original = this.store.inspect(input.operationId)
    if (!original) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
    const delivery = publicDelivery(this.store.retry(original.operationId, () => !this.closed && (original.payload.kind === 'binding-lifecycle' ? this.noticeAuthorized(original) : this.options.bindings.publicationAuthority(original.bindingId, original.bindingRevision).authorized)))
    this.refresh(); return { delivery }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    for (const lane of this.lanes.values()) { lane.abort.abort(); lane.permissionStop?.(); try { lane.watch?.handle?.dispose() } catch { /* Release failure cannot change an Agent lifecycle. */ } }
    this.lanes.clear()
    for (const lane of this.notices.values()) lane.abort.abort()
    this.notices.clear()
  }
}
