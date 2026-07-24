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
  onEvent(semanticSessionId: string, event: AgentMuxAcpEvent, evidence: AgentMuxEvidence): void
  onNativeHandle(semanticSessionId: string, handle: AgentNativeSessionHandle): void | Promise<void>
}

type BoundAcpSession = {
  binding: AgentMuxAcpBinding
  unsubscribe: () => void
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
}

export class AgentMuxAcpBridge {
  private readonly bindings = new Map<string, BoundAcpSession>()

  constructor(
    private readonly callbacks: AgentMuxAcpBridgeCallbacks,
    private readonly permissionHandler?: AgentMuxPermissionHandler
  ) {}

  async bind(semanticSessionId: string, binding: AgentMuxAcpBinding): Promise<void> {
    if (this.bindings.has(semanticSessionId)) {
      throw new AgentMuxError('Semantic session already has an ACP binding.', 'ACP_ALREADY_BOUND')
    }
    const nativeHandle: AgentNativeSessionHandle = {
      kind: 'acp',
      adapterId: binding.adapterId,
      sessionId: binding.sessionId
    }
    const unsubscribe = binding.onEvent((event) => {
      void this.accept(semanticSessionId, binding, event).catch(() => {
        // If a rejecting Permission response cannot be delivered, close the ACP
        // binding instead of leaving the Agent waiting on an ambiguous approval.
        void this.unbind(semanticSessionId).catch(() => {})
      })
    })
    this.bindings.set(semanticSessionId, { binding, unsubscribe })
    try {
      await this.callbacks.onNativeHandle(semanticSessionId, nativeHandle)
    } catch (error) {
      this.bindings.delete(semanticSessionId)
      unsubscribe()
      await binding.close().catch(() => {})
      throw error
    }
  }

  async unbind(semanticSessionId: string): Promise<void> {
    const bound = this.bindings.get(semanticSessionId)
    if (!bound) return
    this.bindings.delete(semanticSessionId)
    bound.unsubscribe()
    await bound.binding.close()
  }

  async dispose(): Promise<void> {
    const ids = [...this.bindings.keys()]
    const results = await Promise.allSettled(ids.map(async (id) => await this.unbind(id)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close ACP bindings.')
  }

  private async accept(
    semanticSessionId: string,
    binding: AgentMuxAcpBinding,
    event: AgentMuxAcpEvent
  ): Promise<void> {
    assertBoundedEvent(event)
    const evidence: AgentMuxEvidence = {
      source: 'acp',
      observedAt: Date.now(),
      acpSessionId: binding.sessionId
    }
    if (event.type !== 'permission') {
      this.callbacks.onEvent(semanticSessionId, event, evidence)
      if (event.type === 'native-session' && event.sessionId !== binding.sessionId) {
        await this.callbacks.onNativeHandle(semanticSessionId, {
          kind: 'acp',
          adapterId: binding.adapterId,
          sessionId: event.sessionId
        })
      }
      return
    }

    const request: AgentMuxPermissionRequest = {
      id: event.requestId,
      semanticSessionId,
      title: event.title,
      options: event.options.map((option) => ({ ...option })),
      evidence,
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {})
    }
    this.callbacks.onEvent(semanticSessionId, event, evidence)
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
