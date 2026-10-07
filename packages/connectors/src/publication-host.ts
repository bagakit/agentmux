import { AgentMuxError, readSessionHistoryTextResource, type AgentSessionHistoryObservation, type AgentSessionHistoryObservationHandle, type AgentSessionHistoryResourceRequest, type AgentSessionHistoryResourceReadResult } from '@agentmux/core'
import { parseConversationChangesPage, type ConversationChangesInput, type ConversationChangesPage, type ConversationRef } from '@agentmux/core/conversation'
import { parseConnectionDeliveryParams, parseRoomBindingAuthority, type ConnectionDeliveryObservation, type ConnectionDeliveryPort, type ConnectionDeliveryListInput, type ConnectionDeliveryOperationInput, type RoomBinding, type RoomBindingCallContext, type RoomBindingReadPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { parsePreparedPublication } from './publication-wire.js'
import type { PublicationAdapter } from './publication-adapter.js'
import { PublicationStore, publicDelivery, type PublicationReceipt } from './publication-store.js'

/** Borrow original exact Core reads and the shared Provider observation. No transcript paths or second watcher. */
export interface PublicationConversationPort {
  changes(input: ConversationChangesInput, signal: AbortSignal): Promise<ConversationChangesPage>
  observe(reference: ConversationRef, listener: (value: AgentSessionHistoryObservation) => void, signal: AbortSignal): Promise<AgentSessionHistoryObservationHandle>
  resource(reference: ConversationRef, input: AgentSessionHistoryResourceRequest, signal: AbortSignal): Promise<AgentSessionHistoryResourceReadResult>
}
export type PublicationObservation = ConnectionDeliveryObservation
type Lane = { binding: RoomBinding; abort: AbortController; dirty: boolean; work?: Promise<void> | undefined; watch?: AgentSessionHistoryObservationHandle | undefined; observation: PublicationObservation }
export type PublicationHostOptions = { connections: ConnectionHost; bindings: RoomBindingReadPort; conversation: PublicationConversationPort }
const sameSource = (a: { providerId: string; nativeSessionId: string }, b: { providerId: string; nativeSessionId: string }) => a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId

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
        lane.abort.abort(); try { lane.watch?.dispose() } catch { /* Cancels only this original reader. */ }; this.lanes.delete(id)
      }
    }
    for (const binding of active) {
      if (!this.authorized(binding)) continue
      let lane = this.lanes.get(binding.bindingId)
      if (!lane) {
        lane = { binding, abort: new AbortController(), dirty: false, observation: { state: 'unknown', reason: 'not-started' } }
        this.lanes.set(binding.bindingId, lane); this.wake(lane)
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
    try { await this.catchUp(lane, adapter) }
    catch { if (!signal.aborted) lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' } }
    if (!signal.aborted && this.authorized(binding)) {
      try { await this.drain(lane, adapter) }
      catch (error) { lane.observation = { state: 'unavailable', reason: error instanceof AgentMuxError && ['PUBLICATION_ADAPTER_UNAVAILABLE', 'PUBLICATION_PREPARATION_UNCONFIRMED'].includes(error.code) ? 'adapter-unavailable' : 'storage-unconfirmed' } }
    }
  }
  private async catchUp(lane: Lane, adapter: PublicationAdapter): Promise<void> {
    const binding = lane.binding, signal = lane.abort.signal, reference = { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId }
    if (!lane.watch || lane.watch.closed?.aborted) {
      lane.watch?.dispose(); lane.watch = undefined
      try {
        const watch = await this.options.conversation.observe(reference, observation => {
          if (signal.aborted) return
          if (observation.agentSessionId !== binding.agentSessionId || observation.source && !binding.sourceCheckpoints.some(c => sameSource(c.source, observation.source!))) {
            lane.observation = { state: 'unavailable', reason: 'source-gap' }; return
          }
          if (observation.kind === 'unavailable') { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' }; return }
          this.wake(lane)
        }, signal)
        if (signal.aborted) { watch.dispose(); return }
        if (!binding.sourceCheckpoints.some(c => sameSource(c.source, watch.source))) { watch.dispose(); lane.observation = { state: 'unavailable', reason: 'source-gap' }; return }
        lane.watch = watch
        watch.closed?.addEventListener('abort', () => { if (!signal.aborted) { lane.observation = { state: 'unknown', reason: 'source-unconfirmed' } } }, { once: true })
      } catch { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' } }
    }
    // A watcher failure does not invalidate a healthy original durable reader.
    for (const initial of binding.sourceCheckpoints) {
      let after = this.store.checkpoint(binding, initial)
      for (let reads = 0; reads < 8; reads++) {
        if (signal.aborted || !this.authorized(binding)) return
        let page: ConversationChangesPage
        try { page = parseConversationChangesPage(await this.options.conversation.changes({ ...reference, checkpoint: after, limit: 100 }, signal), { ...reference, checkpoint: after, limit: 100 }) }
        catch (error) {
          lane.observation = { state: 'unavailable', reason: error instanceof AgentMuxError && ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'AGENT_SESSION_HISTORY_CURSOR_INVALID', 'AGENT_CONVERSATION_SOURCE_CHANGED'].includes(error.code) ? 'source-gap' : 'source-unconfirmed' }
          return
        }
        const resolvedText = new Map()
        try {
          for (const item of page.items) if (item.kind === 'assistant-message') {
            const parts = new Map()
            for (const [index, part] of item.contentParts.entries()) if (part.kind === 'resource' && part.content?.kind === 'text') {
              const text = await readSessionHistoryTextResource(part, index, { source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }, async input => {
                const result = await this.options.conversation.resource(reference, input, signal)
                if (result.agentSessionId !== binding.agentSessionId) throw new Error('Foreign original resource.')
                return result
              }, signal)
              if (text.kind !== 'text') throw new Error('Original speech resource is unconfirmed.')
              parts.set(index, text)
            }
            if (parts.size) resolvedText.set(item.id, parts)
          }
        } catch { lane.observation = { state: 'unavailable', reason: 'source-unconfirmed' }; return }
        if (signal.aborted) return
        try { this.store.commitPage(binding, after, page, () => this.authorized(binding), { resolvedText, fragmentBytes: adapter.fragmentBytes }) }
        catch { lane.observation = { state: 'unavailable', reason: 'storage-unconfirmed' }; return }
        after = page.checkpoint
        if (!page.more) break
        if (reads === 7) lane.dirty = true
      }
    }
    lane.observation = lane.watch ? { state: 'ready' } : { state: 'unavailable', reason: 'source-unconfirmed' }
  }
  private async drain(lane: Lane, adapter: PublicationAdapter): Promise<void> {
    const binding = lane.binding, signal = lane.abort.signal
    for (let count = 0; count < 16; count++) {
      if (signal.aborted || !this.authorized(binding)) return
      let original = this.store.next(binding)
      if (!original) return
      let credential: string | null
      try { credential = await this.options.connections.resolvePublicationCredential(binding.connectionId) } catch { credential = null }
      if (!credential) { lane.observation = { state: 'unavailable', reason: 'credential-missing' }; return }
      if (signal.aborted || !this.authorized(binding)) return
      if (original.state === 'not-applied') { lane.observation = { state: 'unavailable', reason: 'effect-unconfirmed' }; return }
      if (original.state === 'dispatching' || original.state === 'unknown') {
        // Recovery is read-only even when no platform lookup can establish the effect.
        if (original.state === 'dispatching') original = this.store.settle(original.operationId, original.attempt!, { state: 'unknown', reason: 'effect-unconfirmed' })
        if (adapter.inspect && original.prepared) {
          try { const receipt = await adapter.inspect(parsePreparedPublication(original.prepared, adapter), original.target, credential, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), original.mapping); if (receipt) this.store.settle(original.operationId, original.attempt!, receipt) } catch { /* Unknown original effect is retained without replay or changing its audience. */ }
        }
        if (this.store.inspect(original.operationId)?.state === 'confirmed') continue
        lane.observation = { state: 'unknown', reason: 'effect-unconfirmed' }; return
      }
      const claimed = this.store.claimNext(binding, () => this.authorized(binding), adapter)
      if (!claimed) return
      if (signal.aborted || !this.authorized(binding)) { this.store.settle(claimed.operationId, claimed.attempt!, { state: 'not-applied', reason: 'adapter-unavailable' }); return }
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
      catch { try { settle({ state: 'unknown', reason: 'effect-unconfirmed' }) } catch { /* Retain already confirmed outcome or unconfirmed storage. */ } lane.observation = { state: 'unknown', reason: 'effect-unconfirmed' }; return }
      const state = this.store.inspect(claimed.operationId)?.state
      if (state !== 'confirmed') { lane.observation = { state: 'unknown', reason: 'effect-unconfirmed' }; return }
      if (count === 15) lane.dirty = true
    }
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
    return { deliveries, next: deliveries.length === (input.limit ?? 30) ? deliveries.at(-1)!.operationId : null, observation: this.observation(binding.bindingId, binding.revision) }
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
    for (const lane of this.lanes.values()) { lane.abort.abort(); try { lane.watch?.dispose() } catch { /* Release failure cannot change an Agent lifecycle. */ } }
    this.lanes.clear()
  }
}
