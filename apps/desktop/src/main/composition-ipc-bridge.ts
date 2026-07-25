import type {
  AgentMuxCompositionRequest,
  AgentMuxCompositionResult
} from '@agentmux/core'
import type {
  DesktopCompositionCancellation,
  DesktopCompositionResponse
} from '../shared/contracts.js'

const REQUEST_TIMEOUT_MS = 2_000
const LAUNCH_REQUEST_TIMEOUT_MS = 60_000

type PendingComposition = {
  resolve(value: AgentMuxCompositionResult): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

type DesktopCompositionTransport = {
  isAvailable(): boolean
  sendRequest(request: AgentMuxCompositionRequest): void
  sendCancellation(cancellation: DesktopCompositionCancellation): void
}

function compositionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

export class DesktopCompositionIpcBridge {
  private readonly pending = new Map<string, PendingComposition>()

  constructor(private readonly transport: DesktopCompositionTransport) {}

  async execute(request: AgentMuxCompositionRequest): Promise<AgentMuxCompositionResult> {
    if (!this.transport.isAvailable()) {
      throw compositionError('COMPOSITION_UNAVAILABLE', 'Desktop Composition owner is unavailable.')
    }
    if (this.pending.has(request.requestId)) {
      throw compositionError('COMPOSITION_REQUEST_CONFLICT', 'Desktop Composition request ID is already pending.')
    }
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cancel(
          request.requestId,
          compositionError('COMPOSITION_TIMEOUT', 'Desktop Composition request timed out.')
        )
      }, request.operation === 'launch' ? LAUNCH_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
      this.pending.set(request.requestId, { resolve, reject, timeout })
      try {
        this.transport.sendRequest(request)
      } catch (error) {
        this.pending.delete(request.requestId)
        clearTimeout(timeout)
        reject(Object.assign(
          compositionError('COMPOSITION_UNAVAILABLE', 'Desktop Composition owner is unavailable.'),
          { cause: error }
        ))
      }
    })
  }

  accept(response: DesktopCompositionResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending) return false
    this.pending.delete(response.requestId)
    clearTimeout(pending.timeout)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(compositionError(response.code, response.message))
    return true
  }

  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(
        requestId,
        compositionError('COMPOSITION_UNAVAILABLE', 'Desktop Composition owner was disposed.')
      )
    }
  }

  private cancel(requestId: string, error: Error & { code: string }): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timeout)
    try {
      if (this.transport.isAvailable()) {
        this.transport.sendCancellation({
          requestId,
          code: error.code,
          message: error.message
        })
      }
    } catch {
      // The timeout/disposal error remains primary even if the Renderer vanished mid-send.
    } finally {
      pending.reject(error)
    }
  }
}
