import { AgentMuxError } from './errors.js'
import type {
  AgentMuxAcpEvent,
  AgentMuxEvidence,
  AgentMuxPermissionDecision,
  AgentMuxPermissionRequest,
  AgentNativeSessionHandle
} from './types.js'

const MAX_ACP_EVENT_BYTES = 128 * 1024
const PERMISSION_RESPONSE_TIMEOUT_MS = 30_000
const PERMISSION_DELIVERY_TIMEOUT_MS = 30_000

export type AgentMuxAcpBinding = {
  readonly adapterId: string
  readonly sessionId: string
  onEvent(listener: (event: AgentMuxAcpEvent) => void): () => void
  respondPermission(
    requestId: string,
    decision: AgentMuxPermissionDecision,
    signal: AbortSignal
  ): Promise<void>
  close(): Promise<void>
}

export type AgentMuxAcpBridgeCallbacks = {
  onEvent(agentSessionId: string, event: AgentMuxAcpEvent, evidence: AgentMuxEvidence): void | Promise<void>
  onNativeHandle(agentSessionId: string, handle: AgentNativeSessionHandle): void | Promise<void>
  onInteraction(request: AgentMuxPermissionRequest): void | Promise<void>
  onInteractionSettled(request: AgentMuxPermissionRequest): void | Promise<void>
}

type PendingAcpPermission = {
  request: AgentMuxPermissionRequest
  resolveDecision: (decision: AgentMuxPermissionDecision | undefined) => void
  completion: Promise<void>
  resolveCompletion: () => void
  rejectCompletion: (error: unknown) => void
  responded: boolean
}

type BoundAcpSession = {
  binding: AgentMuxAcpBinding
  unsubscribe: () => void
  nativeSessionId: string
  pendingEvents: AgentMuxAcpEvent[] | null
  eventTail: Promise<void>
  pendingPermission: PendingAcpPermission | null
}

function rejectDecision(request: AgentMuxPermissionRequest): AgentMuxPermissionDecision {
  const option = request.options.find(
    (candidate) => candidate.kind === 'reject-once' || candidate.kind === 'reject-always'
  )
  return option ? { outcome: 'selected', optionId: option.id } : { outcome: 'cancelled' }
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

  async bind(agentSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    if (this.bindings.has(agentSessionId)) {
      throw new AgentMuxError('Agent Session already has an ACP binding.', 'ACP_ALREADY_BOUND')
    }
    const nativeHandle: AgentNativeSessionHandle = {
      kind: 'acp',
      adapterId: binding.adapterId,
      sessionId: binding.sessionId
    }
    const bound: BoundAcpSession = {
      binding,
      unsubscribe: () => {},
      nativeSessionId: binding.sessionId,
      pendingEvents: [],
      eventTail: Promise.resolve(),
      pendingPermission: null
    }
    this.bindings.set(agentSessionId, bound)
    try {
      const unsubscribe = binding.onEvent((event) => {
        if (bound.pendingEvents) {
          assertBoundedEvent(event)
          bound.pendingEvents.push(event)
          return
        }
        this.enqueueEvent(agentSessionId, bound, event)
      })
      bound.unsubscribe = unsubscribe
      await this.callbacks.onNativeHandle(agentSessionId, nativeHandle)
      const pendingEvents = bound.pendingEvents ?? []
      while (pendingEvents.length > 0) await this.accept(agentSessionId, bound, pendingEvents.shift()!)
      bound.pendingEvents = null
    } catch (error) {
      this.bindings.delete(agentSessionId)
      bound.pendingEvents = null
      bound.unsubscribe()
      await binding.close().catch(() => {})
      throw error
    }
  }

  async unbind(agentSessionId: string): Promise<void> {
    const bound = this.bindings.get(agentSessionId)
    if (!bound) return
    this.bindings.delete(agentSessionId)
    bound.unsubscribe()
    bound.pendingPermission?.resolveDecision(undefined)
    let eventError: unknown
    try {
      await bound.eventTail
    } catch (error) {
      eventError = error
    }
    bound.pendingPermission = null
    try {
      await bound.binding.close()
    } catch (error) {
      if (eventError === undefined) eventError = error
      else eventError = new AggregateError([eventError, error], 'ACP event drain and binding close both failed.')
    }
    if (eventError !== undefined) throw eventError
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
    pending.resolveDecision(explicit)
    return pending.completion
  }

  hasPendingPermission(agentSessionId: string, requestId: string): boolean {
    return this.bindings.get(agentSessionId)?.pendingPermission?.request.id === requestId
  }

  async dispose(): Promise<void> {
    const ids = [...this.bindings.keys()]
    const results = await Promise.allSettled(ids.map(async (id) => await this.unbind(id)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close ACP bindings.')
  }

  private enqueueEvent(
    agentSessionId: string,
    bound: BoundAcpSession,
    event: AgentMuxAcpEvent
  ): void {
    const accepted = bound.eventTail.then(async () => await this.accept(agentSessionId, bound, event))
    bound.eventTail = accepted
    void accepted.catch(() => {
      // If a rejecting Permission response cannot be delivered, close the ACP
      // binding instead of leaving the Agent waiting on an ambiguous approval.
      void this.unbind(agentSessionId).catch(() => {})
    })
  }

  private async accept(
    agentSessionId: string,
    bound: BoundAcpSession,
    event: AgentMuxAcpEvent
  ): Promise<void> {
    if (this.bindings.get(agentSessionId) !== bound) return
    assertBoundedEvent(event)
    const previousNativeSessionId = bound.nativeSessionId
    if (event.type === 'native-session') bound.nativeSessionId = event.sessionId
    const binding = bound.binding
    const evidence: AgentMuxEvidence = {
      source: 'acp',
      observedAt: Date.now(),
      acpAdapterId: binding.adapterId,
      acpSessionId: bound.nativeSessionId
    }
    if (event.type !== 'permission') {
      await this.callbacks.onEvent(agentSessionId, event, evidence)
      if (event.type === 'native-session' && event.sessionId !== previousNativeSessionId) {
        await this.callbacks.onNativeHandle(agentSessionId, {
          kind: 'acp',
          adapterId: binding.adapterId,
          sessionId: event.sessionId
        })
      }
      return
    }

    const request: AgentMuxPermissionRequest = {
      kind: 'permission',
      id: event.requestId,
      agentSessionId,
      title: event.title,
      options: event.options.map((option) => ({ ...option })),
      evidence,
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {})
    }
    const pending = this.permissionDecision(bound, request)
    try {
      await this.callbacks.onEvent(agentSessionId, event, evidence)
      await this.callbacks.onInteraction(request)
      let decision: AgentMuxPermissionDecision | null = null
      try {
        decision = explicitDecision(request, await pending.decision)
      } catch {
        decision = null
      }
      try {
        await this.deliverPermission(
          binding,
          event.requestId,
          decision ?? rejectDecision(request)
        )
      } finally {
        await this.callbacks.onInteractionSettled(request)
      }
      pending.state.resolveCompletion()
    } catch (error) {
      pending.state.rejectCompletion(error)
      throw error
    } finally {
      if (bound.pendingPermission === pending.state) bound.pendingPermission = null
    }
  }

  private async deliverPermission(
    binding: AgentMuxAcpBinding,
    requestId: string,
    decision: AgentMuxPermissionDecision
  ): Promise<void> {
    const controller = new AbortController()
    const timeoutError = new AgentMuxError(
      'ACP permission response delivery timed out.',
      'ACP_PERMISSION_RESPONSE_TIMEOUT'
    )
    let timer: NodeJS.Timeout | undefined
    const delivery = binding.respondPermission(requestId, decision, controller.signal)
    void delivery.catch(() => {})
    try {
      await Promise.race([
        delivery,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(timeoutError), PERMISSION_DELIVERY_TIMEOUT_MS)
          timer.unref()
        })
      ])
    } catch (error) {
      if (error === timeoutError) controller.abort(timeoutError)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private permissionDecision(
    bound: BoundAcpSession,
    request: AgentMuxPermissionRequest
  ): {
    state: PendingAcpPermission
    decision: Promise<AgentMuxPermissionDecision | undefined>
  } {
    if (bound.pendingPermission) {
      throw new AgentMuxError('ACP session already has a pending permission.', 'AGENT_INTERACTION_BUSY')
    }
    let timer: NodeJS.Timeout | undefined
    let resolveDecision!: (decision: AgentMuxPermissionDecision | undefined) => void
    const decision = new Promise<AgentMuxPermissionDecision | undefined>((resolve) => {
      resolveDecision = resolve
    })
    let resolveCompletion!: () => void
    let rejectCompletion!: (error: unknown) => void
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    void completion.catch(() => {})
    const state: PendingAcpPermission = {
      request,
      resolveDecision,
      completion,
      resolveCompletion,
      rejectCompletion,
      responded: false
    }
    bound.pendingPermission = state
    const boundedDecision = (async () => {
      try {
        return await Promise.race([
          decision,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), PERMISSION_RESPONSE_TIMEOUT_MS)
            timer.unref()
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    return { state, decision: boundedDecision }
  }
}
