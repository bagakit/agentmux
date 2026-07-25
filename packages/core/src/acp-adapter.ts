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

export type AgentMuxAcpBinding = {
  readonly adapterId: string
  readonly sessionId: string
  onEvent(listener: (event: AgentMuxAcpEvent) => void): () => void
  respondPermission(requestId: string, decision: AgentMuxPermissionDecision): Promise<void>
  close(): Promise<void>
}

export type AgentMuxPermissionHandler = (
  request: AgentMuxPermissionRequest
) => Promise<AgentMuxPermissionDecision | undefined>

export type AgentMuxAcpBridgeCallbacks = {
  onEvent(agentSessionId: string, event: AgentMuxAcpEvent, evidence: AgentMuxEvidence): void | Promise<void>
  onNativeHandle(agentSessionId: string, handle: AgentNativeSessionHandle): void | Promise<void>
}

type BoundAcpSession = {
  binding: AgentMuxAcpBinding
  unsubscribe: () => void
  nativeSessionId: string
  pendingEvents: AgentMuxAcpEvent[] | null
  eventTail: Promise<void>
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
    private readonly callbacks: AgentMuxAcpBridgeCallbacks,
    private readonly permissionHandler?: AgentMuxPermissionHandler
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
      eventTail: Promise.resolve()
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
    await bound.binding.close()
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
      id: event.requestId,
      agentSessionId,
      title: event.title,
      options: event.options.map((option) => ({ ...option })),
      evidence,
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {})
    }
    await this.callbacks.onEvent(agentSessionId, event, evidence)
    let decision: AgentMuxPermissionDecision | null = null
    try {
      decision = explicitDecision(request, await this.permissionDecision(request))
    } catch {
      decision = null
    }
    await binding.respondPermission(event.requestId, decision ?? rejectDecision(request))
  }

  private async permissionDecision(
    request: AgentMuxPermissionRequest
  ): Promise<AgentMuxPermissionDecision | undefined> {
    if (!this.permissionHandler) return undefined
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.permissionHandler(request),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), PERMISSION_RESPONSE_TIMEOUT_MS)
          timer.unref()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
