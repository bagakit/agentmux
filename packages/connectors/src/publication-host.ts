import { AgentMuxError, parseProviderSessionHistoryResourceReadResult, readSessionHistoryTextResource, type AgentSessionHistoryContentPart, type AgentSessionHistoryResourceRequest, type AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import { consumeJsonReadEntry, consumeConversationWindowPage, parseConversationChangesPage, parseConversationReadPage, parseConversationUnit, conversationRecordId, conversationSourceKey, CONVERSATION_MAX_UNIT_BYTES, type JsonReadAssembly, type ConversationWindowAssembly, type ConversationWatchInput, type ConversationObservation, type ConversationObservationHandle, type ConversationChangesInput, type ConversationChangesPage, type ConversationCheckpoint, type ConversationCheckpointPage, type ConversationTimelineReadInput, type AgentConversationReadPage, type ConversationUnit, type ConversationRef } from '@agentmux/core/conversation'
import { parseConnectionDeliveryParams, parseRoomBindingAuthority, type ConnectionDeliveryObservation, type ConnectionDeliveryPort, type ConnectionDeliveryListInput, type ConnectionDeliveryOperationInput, type RoomBinding, type RoomBindingCallContext, type RoomBindingReadPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { parsePreparedPublication } from './publication-wire.js'
import type { PublicationAdapter } from './publication-adapter.js'
import { publicationImage, publicationFile, type ResourceUploadReceipt, type ResolvedPublicationPart } from './publication-resource.js'
import { publicationPartKey } from './publication-content.js'
import { PublicationStore, publicDelivery, type PublicationReceipt, type PublicationOperation } from './publication-store.js'

/** Borrow original exact Core reads and the shared Provider observation. No transcript paths or second watcher. */
export interface PublicationConversationPort {
  checkpoint(reference: ConversationRef, signal: AbortSignal): Promise<ConversationCheckpointPage>
  changes(input: ConversationChangesInput, signal: AbortSignal): Promise<ConversationChangesPage>
  inspect(input: ConversationTimelineReadInput, signal: AbortSignal): Promise<AgentConversationReadPage>
  observe(reference: ConversationWatchInput, listener: (value: ConversationObservation) => void, signal: AbortSignal): Promise<ConversationObservationHandle>
  resource(reference: ConversationRef, input: AgentSessionHistoryResourceRequest, signal: AbortSignal): Promise<AgentSessionHistoryResourceReadResult>
}
export interface PublicationPermissionsPort {
  observe(binding: RoomBinding, wake: () => void): () => void
  project(binding: RoomBinding, store: PublicationStore): string[]
  authorized(operation: PublicationOperation): boolean
}
export type PublicationObservation = ConnectionDeliveryObservation
type Lane = { binding: RoomBinding; abort: AbortController; dirty: boolean; work?: Promise<void> | undefined; watch?: ConversationObservationHandle | undefined; watchViewId?: string | undefined; permissionStop?: (() => void) | undefined; observation: PublicationObservation; gapAfter?: number; view?: string | undefined; viewId?: string | undefined; read?: { after: ConversationCheckpoint; cursor?: string; pending?: ConversationWindowAssembly | undefined } | undefined }
export type PublicationHostOptions = { connections: ConnectionHost; bindings: RoomBindingReadPort; conversation: PublicationConversationPort; permissions?: PublicationPermissionsPort }


/** Durable external publication. Each Binding has an independent read/effect lane, outside original Core input. */
export class PublicationHost implements ConnectionDeliveryPort {
  readonly store: PublicationStore
  private readonly lanes = new Map<string, Lane>()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly options: PublicationHostOptions) {
    this.store = new PublicationStore(options.connections.database)
    // Recovery probes only failed/closed/unconfirmed lanes. Healthy source reads are notification-driven.
    this.timer = setInterval(() => this.refresh(true), 5_000); this.timer.unref()
    this.refresh()
  }
  refresh(recoveryOnly = false): void {
    if (this.closed) return
    let active: RoomBinding[]
    try { active = this.options.bindings.listActive() } catch { for (const lane of this.lanes.values()) lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }; return }
    const current = new Map(active.map(binding => [binding.bindingId, binding]))
    for (const [id, lane] of this.lanes) {
      const authority = this.authority(lane.binding)
      if (authority === null) { lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }; continue }
      if (current.get(id)?.revision !== lane.binding.revision || !authority.authorized) {
        lane.abort.abort(); lane.permissionStop?.(); try { lane.watch?.dispose() } catch { /* Cancels only this original reader. */ }; this.lanes.delete(id)
      }
    }
    for (const binding of active) {
      if (!this.authorized(binding)) continue
      let lane = this.lanes.get(binding.bindingId)
      if (!lane) {
        lane = { binding, abort: new AbortController(), dirty: false, observation: { state: 'unknown', reason: 'not-started' } }
        this.lanes.set(binding.bindingId, lane)
        try { const current = lane; lane.permissionStop = this.options.connections.publicationAdapter(binding.connectionId)?.permissionActions === true ? this.options.permissions?.observe(binding, () => this.wake(current)) : undefined } catch { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' } }
        this.wake(lane)
      } else if (!recoveryOnly || lane.observation.state !== 'ready' || !lane.watch || lane.watch.closed?.aborted) this.wake(lane)
    }
  }
  private authority(binding: Pick<RoomBinding, 'bindingId' | 'revision'>) {
    try { return this.options.bindings.publicationAuthority(binding.bindingId, binding.revision) }
    catch { return null }
  }
  private authorized(binding: RoomBinding): boolean { return !this.closed && this.authority(binding)?.authorized === true }
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
    const binding = lane.binding, signal = lane.abort.signal, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
    if (!this.authorized(binding)) return
    const adapter = this.options.connections.publicationAdapter(binding.connectionId)
    if (!adapter) { lane.observation = { state: 'unavailable', reason: 'adapter-unavailable' }; return }
    let permissionProjections: string[] = [], permissionsUnavailable = false
    try {
      if (adapter.permissionActions === true) {
        lane.permissionStop ??= this.options.permissions?.observe(binding, () => this.wake(lane))
        permissionProjections = this.options.permissions?.project(binding, this.store) ?? []
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
      if (!signal.aborted) lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }
    }
    if (!signal.aborted && this.authorized(binding)) {
      let effectObservation: PublicationObservation | undefined
      try { effectObservation = await this.drain(lane, adapter) }
      catch (error) { effectObservation = { state: 'unavailable', reason: error instanceof AgentMuxError && ['PUBLICATION_ADAPTER_UNAVAILABLE', 'PUBLICATION_PREPARATION_UNCONFIRMED'].includes(error.code) ? 'adapter-unavailable' : 'storage-unconfirmed' } }
      // Original effects may still settle or dispatch; their observation cannot hide an unresolved content gap.
      if (effectObservation && lane.observation.reason !== 'content-unconfirmed') lane.observation = effectObservation
    }
    if (permissionsUnavailable && lane.observation.state === 'ready') lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' }
  }
  private async catchUp(lane: Lane, adapter: PublicationAdapter): Promise<void> {
    const binding = lane.binding, signal = lane.abort.signal, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
    const sourceHostId = binding.sourceFrontier?.sourceHostId ?? (await this.options.conversation.checkpoint(reference, signal)).sourceHostId
    let after = this.store.checkpoint(binding, sourceHostId)
    if (!lane.watch || lane.watch.closed.aborted || lane.watchViewId !== lane.viewId) {
      lane.watch?.dispose(); lane.watch = undefined
      try {
        const watch = await this.options.conversation.observe({ ...reference, ...(lane.view ? { view: lane.view } : {}) }, observation => {
          if (signal.aborted) return
          if (observation.hostId !== reference.hostId || observation.agentSessionId !== reference.agentSessionId || observation.sourceHostId !== sourceHostId) { lane.observation = { state: 'unavailable', reason: 'source-gap' }; return }
          if (!after.frontier.scope.sources.some(source => conversationSourceKey(source) === conversationSourceKey(observation.source))) return
          if (observation.kind === 'unavailable') { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' }; return }
          this.wake(lane)
        }, signal)
        if (signal.aborted) { watch.dispose(); return }
        if (watch.hostId !== reference.hostId || watch.agentSessionId !== reference.agentSessionId || watch.sourceHostId !== sourceHostId) { watch.dispose(); throw Error('Foreign observation owner') }
        lane.watch = watch; lane.watchViewId = lane.viewId
        watch.closed.addEventListener('abort', () => { if (!signal.aborted) lane.observation = { state: 'unknown', reason: 'source-unconfirmed' } }, { once: true })
      } catch { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' } }
    }
    // Transient fragment state is bounded to one original batch. A restart discards
    // it and resumes the original durable cut, preserving all unknown effects.
    lane.read ??= { after }
    for (let reads = 0; reads < 8; reads++) {
      if (signal.aborted || !this.authorized(binding)) return
      const state = lane.read, input = { ...reference, checkpoint: state.after, limit: 100, ...(state.cursor ? { cursor: state.cursor } : {}), ...(lane.view ? { view: lane.view } : {}) }
      let page: ConversationChangesPage
      try { page = parseConversationChangesPage(await this.options.conversation.changes(input, signal), input) }
      catch { lane.read = undefined; lane.view = undefined; lane.viewId = undefined; lane.observation = { state: 'unavailable', reason: 'source-gap' }; return }
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
      this.store.commitPage(binding, state.after, page, () => this.authorized(binding), { units: ordered, resolvedText, fragmentBytes: adapter.fragmentBytesFor?.(binding) ?? adapter.fragmentBytes })
      after = page.checkpoint; lane.view = page.window.view!; lane.viewId = page.window.id; lane.read = { after }
      if (lane.watchViewId !== lane.viewId) lane.dirty = true
      if (!page.more) { lane.read = undefined; break }
      if (reads === 7) lane.dirty = true
    }
    await this.recoverContent(lane, adapter)
    lane.observation = this.store.coverage(binding).state === 'incomplete' ? { state: 'unavailable', reason: 'content-unconfirmed' }
      : lane.watch ? { state: 'ready' } : { state: 'unavailable', reason: 'source-unconfirmed' }
  }
  private async resolve(reference: ConversationRef, units: readonly ConversationUnit[], signal: AbortSignal, binding: RoomBinding, adapter: PublicationAdapter): Promise<Map<string, ResolvedPublicationPart>> {
    const result = new Map<string, ResolvedPublicationPart>()
    for (const unit of units) for (const slot of unit.event.content) {
      const record = unit.records.find(record => record.id === slot.recordId)!
      if (record.original.kind !== 'native' || record.reference!.source.kind !== 'native' || slot.selector.kind !== 'native-part') continue
      const item = record.original.item, part = item.contentParts[slot.selector.partIndex]!
      if (part.contentEligibility !== 'public' || part.kind !== 'resource') continue
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
        result.set(publicationPartKey({ record: record.reference!, selector: slot.selector }), value)
      } catch { signal.throwIfAborted() /* Exact unresolved part is durably accounted; other contents keep flowing. */ }
    }
    return result
  }
  private async recoverContent(lane: Lane, adapter: PublicationAdapter): Promise<void> {
    const binding = lane.binding, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }, signal = lane.abort.signal
    const gaps = this.store.recoverableGaps(binding, lane.gapAfter ?? 0)
    if (!gaps.length) { lane.gapAfter = 0; return }
    for (const { ordinal, gap } of gaps) {
      lane.gapAfter = ordinal
      if (!gap.anchor || !gap.part || signal.aborted || !this.authorized(binding)) continue
      try {
        let cursor: string | undefined, pending: JsonReadAssembly | undefined
        const units: ConversationUnit[] = []
        for (let reads = 0; reads < 1024; reads++) {
          const input = { ...reference, anchor: gap.anchor, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }
          const page = parseConversationReadPage(await this.options.conversation.inspect(input, signal), input)
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
            break
          }
          if (cursor === page.nextCursor) throw Error('Original part continuation made no progress')
          cursor = page.nextCursor
        }
        for (const unit of units) this.store.recoverPart(binding, gap, unit, await this.resolve(reference, [unit], signal, binding, adapter), () => this.authorized(binding), adapter.fragmentBytesFor?.(binding) ?? adapter.fragmentBytes)
      } catch { signal.throwIfAborted() /* Original exact gap remains durable and other contents continue. */ }
    }
  }
  private async drain(lane: Lane, adapter: PublicationAdapter, projectionId?: string): Promise<PublicationObservation | undefined> {
    const binding = lane.binding, signal = lane.abort.signal
    const accepted = new Map<string, { unit: ConversationUnit; frontier: ConversationCheckpoint; resolved: ReadonlyMap<string, ResolvedPublicationPart> }>()
    const qualified = new Set<string>() // One frozen representation is verified once in this bounded drain.
    for (let count = 0; count < 16; count++) {
      if (signal.aborted || !this.authorized(binding)) return
      let original = this.store.next(binding, projectionId)
      if (!original) return
      let credential: string | null
      try { credential = await this.options.connections.resolveCredential(binding.connectionId) } catch { credential = null }
      if (!credential) return { state: 'unavailable', reason: 'credential-missing' }
      if (signal.aborted || !this.authorized(binding)) return
      if (original.state === 'not-applied') return { state: 'unavailable', reason: 'effect-unconfirmed' }
      if (original.state === 'dispatching' || original.state === 'unknown') {
        // Recovery is read-only even when no platform lookup can establish the effect.
        if (original.state === 'dispatching') original = this.store.settle(original.operationId, original.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
        if (adapter.inspect && original.prepared) {
          try { const receipt = await adapter.inspect(parsePreparedPublication(original.prepared, adapter), original.target, credential, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), original.mapping); if (receipt) this.store.settle(original.operationId, original.attempt!, receipt) } catch { /* Unknown original effect is retained without replay or changing its audience. */ }
        }
        if (this.store.inspect(original.operationId)?.state === 'confirmed') continue
        return { state: 'unknown', reason: 'effect-unconfirmed' }
      }
      const frozen = JSON.stringify([original.projectionId, original.sourceRevision])
      const relevant = qualified.has(frozen) ? [] : this.store.pendingNativeRecords(original)
      if (!qualified.has(frozen) && ['speech', 'image', 'file'].includes(original.payload.kind) && original.effect === 'upsert' && (relevant.length || (original.sourceRecords ?? [original.reference]).some(record => record.source.kind === 'native'))) {
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
                if (!unit) throw Error('The exact pending native record is unavailable')
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
      if ((original.payload.kind === 'image' || original.payload.kind === 'file') && original.effect === 'upsert' && !original.prepared) {
        const last = original.uploads?.at(-1)
        if (last?.state === 'dispatching') { this.store.settleResourceUpload(original.operationId, original.uploads!.length, { state: 'unknown' }); continue }
        if (last?.state !== 'confirmed') {
          if (original.payload.kind === 'image' ? !adapter.images || !adapter.images.accepts(original.payload.image) : !adapter.files || !adapter.files.accepts(original.payload.file)) return { state: 'unavailable', reason: 'adapter-unavailable' }
          const upload = this.store.claimResourceUpload(original.operationId, () => this.authorized(binding))
          if (!upload || (upload.payload.kind !== 'image' && upload.payload.kind !== 'file')) return
          if (signal.aborted || !this.authorized(binding)) { this.store.settleResourceUpload(upload.operationId, upload.uploads!.length, { state: 'unknown' }); return }
          const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          let effect: Promise<ResourceUploadReceipt>
          try { effect = Promise.resolve(upload.payload.kind === 'image'
            ? adapter.images!.upload(upload.payload.image, upload.target, credential, uploadSignal)
            : adapter.files!.upload(upload.payload.file, upload.target, credential, uploadSignal)) }
          catch { effect = Promise.reject(new Error('Unconfirmed original resource upload.')) }
          const settle = (receipt: ResourceUploadReceipt) => { if (!this.closed) this.store.settleResourceUpload(upload.operationId, upload.uploads!.length, receipt) }
          effect.then(receipt => {
            try { settle(receipt) } catch { try { settle({ state: 'unknown' }) } catch { /* Preserve the same unconfirmed upload attempt. */ } }
            this.wake(lane)
          }, () => {})
          try { await this.until(effect, uploadSignal) } catch { try { settle({ state: 'unknown' }) } catch { /* Preserve its authoritative receipt or unconfirmed storage. */ } }
          if (signal.aborted || !this.authorized(binding)) return
          original = this.store.inspect(upload.operationId)!
          if (original.uploads?.at(-1)?.state !== 'confirmed') continue
        }
      }
      if (original.payload.kind === 'permission' && !this.options.permissions?.authorized(original)) return { state: 'unavailable', reason: 'source-unconfirmed' }
      const claimed = this.store.claimNext(binding, () => this.authorized(binding) && (original!.payload.kind !== 'permission' || this.options.permissions?.authorized(original!) === true), adapter, projectionId)
      if (!claimed) return
      if (signal.aborted || !this.authorized(binding) || claimed.payload.kind === 'permission' && !this.options.permissions?.authorized(claimed)) { this.store.settle(claimed.operationId, claimed.attempt!, { state: 'not-applied', reason: 'adapter-unavailable' }); return }
      const timeout = AbortSignal.timeout(30_000), dispatchSignal = AbortSignal.any([signal, timeout])
      let effect: Promise<PublicationReceipt>
      try { effect = Promise.resolve(adapter.dispatch(claimed.prepared!, claimed.target, credential, dispatchSignal, claimed.mapping)) }
      catch { effect = Promise.reject(new Error('Unconfirmed original platform effect.')) }
      const settle = (receipt: PublicationReceipt) => { if (!this.closed) this.store.settle(claimed.operationId, claimed.attempt!, receipt) }
      // A late authoritative receipt can settle this same identity after timeout, never launch another effect.
      effect.then(receipt => {
        try { settle(receipt) } catch { try { settle({ state: 'unknown', reason: 'effect-unconfirmed' }) } catch { /* Retain an authoritative outcome or unconfirmed storage. */ } }
        this.wake(lane)
      }, () => {})
      try { await this.until(effect, dispatchSignal); if (signal.aborted) return }
      catch { try { settle({ state: 'unknown', reason: 'effect-unconfirmed' }) } catch { /* Retain already confirmed outcome or unconfirmed storage. */ } return { state: 'unknown', reason: 'effect-unconfirmed' } }
      const state = this.store.inspect(claimed.operationId)?.state
      if (state !== 'confirmed') return { state: 'unknown', reason: 'effect-unconfirmed' }
    }
    lane.dirty = true // More retained work may remain after any bounded outcome.
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
    if (lane?.binding.revision === revision) return { ...lane.observation }
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
    const deliveries = this.store.list(binding, input.limit ?? 30, input.after).map(publicDelivery)
    return { deliveries, next: deliveries.length === (input.limit ?? 30) ? deliveries.at(-1)!.operationId : null, observation: this.observation(binding.bindingId, binding.revision), coverage: this.store.coverage(binding, input.limit ?? 30, input.afterContent) }
  }
  async retry(value: ConnectionDeliveryOperationInput, context: RoomBindingCallContext) {
    if (this.closed) throw new AgentMuxError('The original publication owner is closed. Inspect the retained operation through its current Host.', 'PUBLICATION_OWNER_UNAVAILABLE')
    const input = parseConnectionDeliveryParams('connection.delivery.retry', value)
    parseRoomBindingAuthority(context.actor); await context.assertCurrent?.()
    if (this.closed) throw new AgentMuxError('The original publication owner closed during authorization. Its original outcome is retained.', 'PUBLICATION_OWNER_UNAVAILABLE')
    const original = this.store.inspect(input.operationId)
    if (!original) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
    const delivery = publicDelivery(this.store.retry(original.operationId, () => !this.closed && this.options.bindings.publicationAuthority(original.bindingId, original.bindingRevision).authorized))
    this.refresh(); return { delivery }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    for (const lane of this.lanes.values()) { lane.abort.abort(); lane.permissionStop?.(); try { lane.watch?.dispose() } catch { /* Release failure cannot change an Agent lifecycle. */ } }
    this.lanes.clear()
  }
}
