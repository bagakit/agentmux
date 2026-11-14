import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import type {
  AgentMuxAcpEvent,
  AgentMuxEvidence,
  AgentMuxPermissionDecision,
  AgentMuxPermissionRequest,
  AgentNativeSessionHandle,
  AgentMuxRunRef
} from './types.js'

const MAX_ACP_EVENT_BYTES = 128 * 1024

export type AgentMuxAcpBinding = {
  readonly adapterId: string
  readonly sessionId: string
  readonly nativeTranscriptPath?: string
  onEvent(listener: (event: AgentMuxAcpEvent, observedAt?: number) => void, onError?: (error: Error) => void): () => void
  respondPermission(
    requestId: string,
    decision: AgentMuxPermissionDecision,
    signal: AbortSignal
  ): Promise<void>
  close(): Promise<void>
}

export type AgentMuxAcpBridgeCallbacks = {
  /** Permission IDs are Core-qualified; native IDs remain only on the original binding. */
  onEvent(agentSessionId: string, event: AgentMuxAcpEvent, evidence: AgentMuxEvidence, signal: AbortSignal): void | Promise<void>
  onNativeHandle(agentSessionId: string, handle: AgentNativeSessionHandle, evidence: AgentMuxEvidence, signal: AbortSignal): void | Promise<void>
  onInteraction(request: AgentMuxPermissionRequest, signal: AbortSignal): void | Promise<void>
  onInteractionSettled(request: AgentMuxPermissionRequest): void | Promise<void>
  onRetainedPermissionSettled?(agentSessionId: string, requestId: string, evidence: AgentMuxEvidence): void | Promise<void>
  /** Report an exact failed observation or unknown delivery; never closes the binding. */
  onError(agentSessionId: string, error: unknown, evidence: AgentMuxEvidence): void | Promise<void>
}

type PendingAcpPermission = {
  request: AgentMuxPermissionRequest
  event: Extract<AgentMuxAcpEvent, { type: 'permission' }>
  completion: Promise<void>
  resolveCompletion: () => void
  rejectCompletion: (error: unknown) => void
  responded: boolean
  ready: boolean
  publicationFailed: boolean
  decision?: AgentMuxPermissionDecision
  settlement?: Promise<void>
  delivery?: { controller: AbortController; finished: Promise<void> }
}

type BoundAcpSession = {
  id: string
  run?: AgentMuxRunRef
  lifetime: AbortController
  binding: AgentMuxAcpBinding
  unsubscribe: () => void
  nativeSessionId: string
  nativeProviderId?: string
  pendingEvents: { event: AgentMuxAcpEvent; observedAt?: number }[] | null
  eventTail: Promise<void>
  pendingPermission: PendingAcpPermission | null
  permissionQueue: PendingAcpPermission[]
}

function permissionCompletion(): Pick<PendingAcpPermission, 'completion' | 'resolveCompletion' | 'rejectCompletion'> {
  let resolveCompletion!: () => void
  let rejectCompletion!: (error: unknown) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  void completion.catch(() => {})
  return { completion, resolveCompletion, rejectCompletion }
}

function explicitDecision(
  request: AgentMuxPermissionRequest,
  decision: AgentMuxPermissionDecision | undefined
): AgentMuxPermissionDecision | null {
  if (!decision) return null
  if (decision.outcome === 'cancelled') return decision
  return request.options.some((option) => option.id === decision.optionId) ? decision : null
}

function assertBoundedEvent(event: AgentMuxAcpEvent): void {
  if (Buffer.byteLength(JSON.stringify(event)) > MAX_ACP_EVENT_BYTES) {
    throw new AgentMuxError('ACP event exceeds the maximum size.', 'ACP_EVENT_TOO_LARGE')
  }
  if (event.type === 'activity' && Object.hasOwn(event, 'contentDelta')) {
    throw new AgentMuxError(
      'ACP activity updates require complete content.',
      'INVALID_AGENT_TIMELINE'
    )
  }
}

export class AgentMuxAcpBridge {
  private readonly bindings = new Map<string, BoundAcpSession>()

  constructor(
    private readonly callbacks: AgentMuxAcpBridgeCallbacks
  ) {}

  async bind(agentSessionId: string, binding: AgentMuxAcpBinding, run?: Readonly<AgentMuxRunRef>, managed?: { providerId: string; actorId: string }): Promise<void> {
    if (this.bindings.has(agentSessionId)) {
      throw new AgentMuxError('Agent Session already has an ACP binding.', 'ACP_ALREADY_BOUND')
    }
    const bound: BoundAcpSession = {
      id: managed?.actorId ?? mintObjectId(),
      ...(run ? { run: { ...run } } : {}),
      lifetime: new AbortController(),
      binding,
      unsubscribe: () => {},
      nativeSessionId: binding.sessionId,
      ...(managed ? { nativeProviderId: managed.providerId } : {}),
      pendingEvents: [],
      eventTail: Promise.resolve(),
      pendingPermission: null,
      permissionQueue: []
    }
    this.bindings.set(agentSessionId, bound)
    try {
      const unsubscribe = binding.onEvent((event, originalObservedAt) => {
        const observedAt = managed ? originalObservedAt : undefined
        if (bound.pendingEvents) {
          assertBoundedEvent(event)
          bound.pendingEvents.push({ event, ...(observedAt === undefined ? {} : { observedAt }) })
          return
        }
        this.enqueueEvent(agentSessionId, bound, event, observedAt)
      }, error => { void Promise.resolve().then(() => this.callbacks.onError(agentSessionId, error, this.evidence(bound))).catch(() => {}) })
      bound.unsubscribe = unsubscribe
      await this.callbacks.onNativeHandle(agentSessionId, this.nativeHandle(bound), this.evidence(bound), bound.lifetime.signal)
      const pendingEvents = bound.pendingEvents ?? []
      while (pendingEvents.length > 0) {
        const { event, observedAt } = pendingEvents.shift()!
        await this.accept(agentSessionId, bound, event, observedAt)
      }
      bound.pendingEvents = null
    } catch (error) {
      bound.lifetime.abort(error)
      if (this.bindings.get(agentSessionId) === bound) this.bindings.delete(agentSessionId)
      bound.pendingEvents = null
      bound.unsubscribe()
      await binding.close().catch(() => {})
      throw error
    }
  }

  hasBinding(agentSessionId: string, run: Readonly<AgentMuxRunRef>): boolean {
    return this.bindings.get(agentSessionId)?.run?.runId === run.runId
  }

  async unbind(agentSessionId: string): Promise<void> {
    const bound = this.bindings.get(agentSessionId)
    if (!bound) return
    if (bound.nativeProviderId !== undefined) { await this.detachManaged(agentSessionId, bound); return }
    this.bindings.delete(agentSessionId)
    bound.lifetime.abort(new AgentMuxError('The original ACP binding was explicitly closed.', 'CONTROL_CANCELLED'))
    bound.unsubscribe()
    let eventError: unknown
    try {
      await bound.eventTail
    } catch (error) {
      eventError = error
    }
    const permissions = [bound.pendingPermission, ...bound.permissionQueue].filter((pending): pending is PendingAcpPermission => pending !== null)
    for (const pending of permissions) {
      // Closing this exact binding is a cancellation, never a permission choice.
      if (!pending.responded) {
        pending.responded = true
        pending.decision = { outcome: 'cancelled' }
      }
      pending.ready = true
      this.dispatchPermission(agentSessionId, bound, pending)
      pending.delivery?.controller.abort(new AgentMuxError('The original ACP binding was explicitly closed.', 'CONTROL_CANCELLED'))
    }
    try {
      await bound.binding.close()
    } catch (error) {
      if (eventError === undefined) eventError = error
      else eventError = new AggregateError([eventError, error], 'ACP event drain and binding close both failed.')
    }
    await Promise.all(permissions.map(pending => pending.delivery?.finished))
    bound.pendingPermission = null
    bound.permissionQueue = []
    if (eventError !== undefined) throw eventError
  }

  private async detachManaged(agentSessionId: string, bound: BoundAcpSession): Promise<void> {
    this.bindings.delete(agentSessionId)
    const detached = new AgentMuxError('The ACP observer detached from its original Run.', 'CONTROL_CANCELLED')
    bound.lifetime.abort(detached)
    bound.unsubscribe()
    const permissions = [bound.pendingPermission, ...bound.permissionQueue]
    for (const pending of permissions) {
      pending?.delivery?.controller.abort(detached)
      pending?.rejectCompletion(detached)
    }
    try { await bound.eventTail }
    finally { await bound.binding.close() }
  }

  respondPermission(
    agentSessionId: string,
    requestId: string,
    decision: AgentMuxPermissionDecision
  ): Promise<void> {
    const bound = this.bindings.get(agentSessionId)
    const pending = bound?.pendingPermission
    if (!bound || !pending || pending.request.id !== requestId) {
      throw new AgentMuxError('ACP permission request is not pending.', 'UNKNOWN_AGENT_INTERACTION')
    }
    const explicit = explicitDecision(pending.request, decision)
    if (!explicit) {
      throw new AgentMuxError('ACP permission response is invalid.', 'INVALID_AGENT_INTERACTION_RESPONSE')
    }
    if (pending.responded) {
      throw new AgentMuxError('ACP permission request was already answered.', 'UNKNOWN_AGENT_INTERACTION')
    }
    pending.responded = true
    pending.decision = explicit
    if (pending.publicationFailed) {
      // Only a new explicit response retries publication of this unsent request.
      // Unknown adapter delivery remains under its original custody below.
      return this.publishPermission(agentSessionId, bound, pending).then(() => pending.completion, async error => {
        await this.callbacks.onError(agentSessionId, error, pending.request.evidence)
        throw error
      })
    }
    this.dispatchPermission(agentSessionId, bound!, pending)
    return pending.completion
  }

  hasPendingPermission(agentSessionId: string, requestId: string): boolean {
    return this.bindings.get(agentSessionId)?.pendingPermission?.request.id === requestId
  }

  /** Retry only publication of this original unanswered request on an explicit exact read. */
  async refreshPendingPermission(agentSessionId: string, run: Readonly<AgentMuxRunRef>): Promise<boolean> {
    const bound = this.bindings.get(agentSessionId)
    if (!bound || bound.run?.runId !== run.runId) return false
    const pending = bound.pendingPermission
    if (!pending?.publicationFailed || pending.responded || pending.delivery) return false
    const recovered = bound.eventTail.catch(() => {}).then(async () => {
      if (this.bindings.get(agentSessionId) !== bound || bound.lifetime.signal.aborted ||
          bound.pendingPermission !== pending || !pending.publicationFailed || pending.responded || pending.delivery) return false
      try {
        await this.publishPermission(agentSessionId, bound, pending)
        return true
      } catch (error) {
        await this.callbacks.onError(agentSessionId, error, pending.request.evidence)
        return false
      }
    })
    bound.eventTail = recovered.then(() => {})
    void bound.eventTail.catch(() => {})
    return await recovered
  }

  async dispose(): Promise<void> {
    const ids = [...this.bindings.keys()]
    const results = await Promise.allSettled(ids.map(id => this.unbind(id)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close ACP bindings.')
  }

  private enqueueEvent(
    agentSessionId: string,
    bound: BoundAcpSession,
    event: AgentMuxAcpEvent,
    observedAt?: number
  ): void {
    const accepted = bound.eventTail.catch(() => {}).then(async () => await this.accept(agentSessionId, bound, event, observedAt))
    bound.eventTail = accepted.catch(error => this.callbacks.onError(agentSessionId, error, this.evidence(bound)))
    // The required error callback owns diagnostics; a failed callback is retained
    // on eventTail for explicit unbind, without poisoning later observations.
    void bound.eventTail.catch(() => {})
  }

  private nativeHandle(bound: BoundAcpSession): AgentNativeSessionHandle {
    const transcriptPath = bound.nativeSessionId === bound.binding.sessionId ? bound.binding.nativeTranscriptPath : undefined
    return bound.nativeProviderId === undefined ? { kind: 'acp', adapterId: bound.binding.adapterId, sessionId: bound.nativeSessionId }
      : { kind: 'provider', providerId: bound.nativeProviderId, sessionId: bound.nativeSessionId,
          ...(transcriptPath === undefined ? {} : { transcriptPath }) }
  }

  private evidence(bound: BoundAcpSession, observedAt = Date.now()): AgentMuxEvidence {
    return { source: 'acp', observedAt, acpAdapterId: bound.binding.adapterId,
      acpSessionId: bound.nativeSessionId, acpBindingId: bound.id, ...(bound.run ? { run: { ...bound.run } } : {}) }
  }

  private async accept(
    agentSessionId: string,
    bound: BoundAcpSession,
    event: AgentMuxAcpEvent,
    observedAt?: number
  ): Promise<void> {
    if (this.bindings.get(agentSessionId) !== bound) return
    assertBoundedEvent(event)
    const previousNativeSessionId = bound.nativeSessionId
    if (event.type === 'native-session') bound.nativeSessionId = event.sessionId
    const evidence = this.evidence(bound, observedAt)
    if (event.type === 'observation-gap') {
      if (bound.nativeProviderId !== undefined) await this.callbacks.onError(agentSessionId,
        new AgentMuxError('The ACP Activity observation exceeded its retained window.', 'AGENT_ACP_OBSERVATION_GAP'), evidence)
      return
    }
    if (event.type === 'permission-settled') {
      if (bound.nativeProviderId === undefined) return
      const pending = bound.pendingPermission
      if (pending?.request.id === event.requestId) {
        await this.settlePermission(agentSessionId, bound, pending)
      } else {
        const queued = bound.permissionQueue.findIndex(item => item.request.id === event.requestId)
        if (queued !== -1) bound.permissionQueue.splice(queued, 1)
        else await this.callbacks.onRetainedPermissionSettled?.(agentSessionId, event.requestId, evidence)
      }
      return
    }
    if (event.type !== 'permission') {
      await this.callbacks.onEvent(agentSessionId, event, evidence, bound.lifetime.signal)
      if (event.type === 'native-session' && event.sessionId !== previousNativeSessionId) {
        await this.callbacks.onNativeHandle(agentSessionId, this.nativeHandle(bound), evidence, bound.lifetime.signal)
      }
      return
    }

    const managedId = bound.nativeProviderId === undefined ? undefined : event.requestId
    if (managedId && (bound.pendingPermission?.request.id === managedId || bound.permissionQueue.some(pending => pending.request.id === managedId))) return
    const request: AgentMuxPermissionRequest = {
      kind: 'permission',
      id: managedId ?? mintObjectId(),
      agentSessionId,
      title: event.title,
      options: event.options.map((option) => ({ ...option })),
      evidence,
      ...(event.nativeToolCallId === undefined ? {} : { nativeToolCallId: event.nativeToolCallId }),
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {})
    }
    const pending = this.permissionDecision(bound, request, event)
    if (bound.pendingPermission === pending) await this.publishPermission(agentSessionId, bound, pending)
  }

  private async publishPermission(agentSessionId: string, bound: BoundAcpSession, pending: PendingAcpPermission): Promise<void> {
    pending.publicationFailed = false
    try {
      await this.callbacks.onEvent(agentSessionId, { ...pending.event, requestId: pending.request.id }, pending.request.evidence, bound.lifetime.signal)
      await this.callbacks.onInteraction(pending.request, bound.lifetime.signal)
      pending.ready = true
      this.dispatchPermission(agentSessionId, bound, pending)
    } catch (error) {
      pending.publicationFailed = true
      if (pending.responded && !pending.delivery) {
        pending.responded = false
        delete pending.decision
        pending.rejectCompletion(error)
        Object.assign(pending, permissionCompletion())
      }
      throw error
    }
  }

  private dispatchPermission(agentSessionId: string, bound: BoundAcpSession, pending: PendingAcpPermission): void {
    if (!pending.ready || !pending.decision || pending.delivery) return
    const controller = new AbortController()
    // Install custody before invoking the adapter, which may synchronously emit.
    const custody = { controller, finished: Promise.resolve() }
    pending.delivery = custody
    custody.finished = (async () => {
      let abort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
      })
      try {
        await Promise.race([bound.binding.respondPermission(pending.event.requestId, pending.decision!, controller.signal), cancelled])
        await this.settlePermission(agentSessionId, bound, pending)
      } catch (error) {
        // The original decision may have applied. Keep its request and unknown
        // completion; neither an observer failure nor another event retries it.
        pending.rejectCompletion(error)
        if (bound.nativeProviderId !== undefined && bound.lifetime.signal.aborted) return
        await this.callbacks.onError(agentSessionId, error, { ...pending.request.evidence, observedAt: Date.now() })
      } finally {
        controller.signal.removeEventListener('abort', abort)
      }
    })()
    void custody.finished.catch(() => {})
  }

  private async settlePermission(agentSessionId: string, bound: BoundAcpSession, pending: PendingAcpPermission): Promise<void> {
    pending.settlement ??= (async () => {
      await this.callbacks.onInteractionSettled(pending.request)
      pending.resolveCompletion()
      if (bound.pendingPermission !== pending) return
      const next = bound.permissionQueue.shift()
      bound.pendingPermission = next ?? null
      if (next && this.bindings.get(agentSessionId) === bound) {
        const published = bound.eventTail.catch(() => {}).then(() => this.publishPermission(agentSessionId, bound, next))
        bound.eventTail = published.catch(error => this.callbacks.onError(agentSessionId, error, next.request.evidence))
        void bound.eventTail.catch(() => {})
      }
    })()
    await pending.settlement
  }

  private permissionDecision(
    bound: BoundAcpSession,
    request: AgentMuxPermissionRequest,
    event: Extract<AgentMuxAcpEvent, { type: 'permission' }>
  ): PendingAcpPermission {
    const state: PendingAcpPermission = {
      request,
      event: { ...event, options: event.options.map(option => ({ ...option })) },
      ...permissionCompletion(),
      responded: false,
      ready: false,
      publicationFailed: false
    }
    if (bound.pendingPermission) bound.permissionQueue.push(state)
    else bound.pendingPermission = state
    return state
  }
}
