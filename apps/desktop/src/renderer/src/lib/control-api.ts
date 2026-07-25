import {
  AGENTMUX_CONTROL_ERROR_CODES,
  type AgentMuxControlError,
  type AgentMuxControlErrorCode,
  type AgentMuxMessageTargetCandidate
} from '@agentmux/core/control'
import type {
  AgentMuxDesktopApi,
  AgentMuxPreloadApi,
  DesktopControlResponse
} from '../../../shared/contracts'

function cancellationError(code: AgentMuxControlErrorCode, message: string): Error & { code: AgentMuxControlErrorCode } {
  return Object.assign(new Error(message), { code })
}

const CONTROL_ERROR_CODES: ReadonlySet<string> = new Set(AGENTMUX_CONTROL_ERROR_CODES)

function controlErrorCode(value: unknown): value is AgentMuxControlErrorCode {
  return typeof value === 'string' && CONTROL_ERROR_CODES.has(value)
}

function messageTargetCandidates(value: unknown): AgentMuxMessageTargetCandidate[] | null {
  if (!Array.isArray(value) || value.length > 64) return null
  const candidates: AgentMuxMessageTargetCandidate[] = []
  const sessionIds = new Set<string>()
  for (const valueCandidate of value) {
    if (!valueCandidate || typeof valueCandidate !== 'object' || Array.isArray(valueCandidate)) return null
    const candidate = valueCandidate as Record<string, unknown>
    if (
      typeof candidate.agentSessionId !== 'string' ||
      !candidate.agentSessionId ||
      candidate.agentSessionId === 'self' ||
      /[\0\r\n]/u.test(candidate.agentSessionId) ||
      sessionIds.has(candidate.agentSessionId) ||
      !Array.isArray(candidate.regionIds) ||
      candidate.regionIds.length === 0 ||
      candidate.regionIds.length > 64
    ) return null
    const regionIds: string[] = []
    const seenRegionIds = new Set<string>()
    for (const regionId of candidate.regionIds) {
      if (
        typeof regionId !== 'string' ||
        !regionId ||
        regionId === 'self' ||
        /[\0\r\n]/u.test(regionId) ||
        seenRegionIds.has(regionId)
      ) return null
      seenRegionIds.add(regionId)
      regionIds.push(regionId)
    }
    sessionIds.add(candidate.agentSessionId)
    candidates.push({ agentSessionId: candidate.agentSessionId, regionIds })
  }
  return candidates
}

function responseError(error: unknown): AgentMuxControlError {
  const source = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null
  const message = error instanceof Error ? error.message : String(error)
  const code = controlErrorCode(source?.code) ? source.code : 'CONTROL_FAILED'
  if (code === 'MESSAGE_TARGET_NOT_UNIQUE') {
    const candidates = messageTargetCandidates(source?.candidates)
    if (!candidates) return { code: 'CONTROL_FAILED', message: 'Desktop Control owner returned invalid message target candidates.' }
    return {
      code,
      message,
      candidates
    }
  }
  if (source?.candidates !== undefined) {
    return { code: 'CONTROL_FAILED', message: 'Desktop Control owner returned unexpected message target candidates.' }
  }
  return {
    code,
    message
  }
}

export function createRendererControlApi(
  preload: AgentMuxPreloadApi['control']
): AgentMuxDesktopApi['control'] {
  return {
    onRequest(listener) {
      const controllers = new Map<string, AbortController>()
      const settle = (
        requestId: string,
        controller: AbortController,
        response: DesktopControlResponse
      ): void => {
        if (controllers.get(requestId) !== controller) return
        controllers.delete(requestId)
        preload.respond(response)
      }
      const disposeRequest = preload.onRequest((request) => {
        const conflict = controllers.get(request.requestId)
        if (conflict) {
          controllers.delete(request.requestId)
          conflict.abort(cancellationError(
            'CONTROL_REQUEST_CONFLICT',
            'Desktop Control request ID was reused.'
          ))
          preload.respond({
            requestId: request.requestId,
            ok: false,
            error: { code: 'CONTROL_REQUEST_CONFLICT', message: 'Desktop Control request ID was reused.' }
          })
          return
        }
        const controller = new AbortController()
        controllers.set(request.requestId, controller)
        void Promise.resolve().then(() => listener(request, controller.signal)).then(
          (result) => settle(request.requestId, controller, { requestId: request.requestId, ok: true, result }),
          (error) => settle(request.requestId, controller, { requestId: request.requestId, ok: false, error: responseError(error) })
        )
      })
      const disposeCancellation = preload.onCancellation((cancellation) => {
        const controller = controllers.get(cancellation.requestId)
        if (!controller) return
        controllers.delete(cancellation.requestId)
        controller.abort(cancellationError(cancellation.code, cancellation.message))
      })
      return () => {
        disposeRequest()
        disposeCancellation()
        for (const controller of controllers.values()) {
          controller.abort(cancellationError('CONTROL_UNAVAILABLE', 'Desktop Control owner was disposed.'))
        }
        controllers.clear()
      }
    }
  }
}
