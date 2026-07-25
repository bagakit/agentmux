import type {
  AgentMuxControlError,
  AgentMuxControlErrorCode,
  AgentMuxControlRequest,
  AgentMuxControlResult
} from '@agentmux/core'
import type {
  DesktopControlCancellation,
  DesktopControlResponse
} from '../shared/contracts.js'

const REQUEST_TIMEOUT_MS = 2_000
const LONG_REQUEST_TIMEOUT_MS = 60_000

type PendingControl = {
  resolve(value: AgentMuxControlResult): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

type DesktopControlTransport = {
  isAvailable(): boolean
  sendRequest(request: AgentMuxControlRequest): void
  sendCancellation(cancellation: DesktopControlCancellation): void
}

function controlError(error: AgentMuxControlError): Error & { code: AgentMuxControlErrorCode } {
  return Object.assign(new Error(error.message), {
    code: error.code,
    ...(error.code === 'MESSAGE_TARGET_NOT_UNIQUE' ? { candidates: error.candidates } : {})
  })
}

function bridgeError(
  code: 'CONTROL_UNAVAILABLE' | 'CONTROL_REQUEST_CONFLICT' | 'CONTROL_TIMEOUT',
  message: string
): Error & { code: AgentMuxControlErrorCode } {
  return Object.assign(new Error(message), { code })
}

export class DesktopControlIpcBridge {
  private readonly pending = new Map<string, PendingControl>()

  constructor(private readonly transport: DesktopControlTransport) {}

  async execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult> {
    if (!this.transport.isAvailable()) {
      throw bridgeError('CONTROL_UNAVAILABLE', 'Desktop Control owner is unavailable.')
    }
    if (this.pending.has(request.requestId)) {
      throw bridgeError('CONTROL_REQUEST_CONFLICT', 'Desktop Control request ID is already pending.')
    }
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cancel(
          request.requestId,
          bridgeError('CONTROL_TIMEOUT', 'Desktop Control request timed out.')
        )
      }, request.operation.startsWith('open.') || request.operation === 'send' || request.operation === 'resume' || request.operation === 'stop'
        ? LONG_REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS)
      this.pending.set(request.requestId, { resolve, reject, timeout })
      try {
        this.transport.sendRequest(request)
      } catch (error) {
        this.pending.delete(request.requestId)
        clearTimeout(timeout)
        reject(Object.assign(
          bridgeError('CONTROL_UNAVAILABLE', 'Desktop Control owner is unavailable.'),
          { cause: error }
        ))
      }
    })
  }

  accept(response: DesktopControlResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending) return false
    this.pending.delete(response.requestId)
    clearTimeout(pending.timeout)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(controlError(response.error))
    return true
  }

  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(
        requestId,
        bridgeError('CONTROL_UNAVAILABLE', 'Desktop Control owner was disposed.')
      )
    }
  }

  private cancel(requestId: string, error: Error & { code: AgentMuxControlErrorCode }): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    try {
      if (this.transport.isAvailable()) {
        this.transport.sendCancellation({ requestId, code: error.code, message: error.message })
      }
    } catch {
      // The timeout/disposal error remains primary if the Renderer vanishes mid-send.
    } finally {
      pending.reject(error)
    }
  }
}
