import type {
  AgentMuxDesktopApi,
  AgentMuxPreloadApi,
  DesktopCompositionResponse
} from '../../../shared/contracts'

function cancellationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

export function createRendererCompositionApi(
  preload: AgentMuxPreloadApi['composition']
): AgentMuxDesktopApi['composition'] {
  return {
    onRequest(listener) {
      const controllers = new Map<string, AbortController>()
      const settle = (
        requestId: string,
        controller: AbortController,
        response: DesktopCompositionResponse
      ): void => {
        if (controllers.get(requestId) !== controller) return
        controllers.delete(requestId)
        preload.respond(response)
      }
      const disposeRequests = preload.onRequest((request) => {
        const conflict = controllers.get(request.requestId)
        if (conflict) {
          controllers.delete(request.requestId)
          conflict.abort(cancellationError(
            'COMPOSITION_REQUEST_CONFLICT',
            'Desktop Composition request ID was reused.'
          ))
          preload.respond({
            requestId: request.requestId,
            ok: false,
            code: 'COMPOSITION_REQUEST_CONFLICT',
            message: 'Desktop Composition request ID was reused.'
          })
          return
        }
        const controller = new AbortController()
        controllers.set(request.requestId, controller)
        void Promise.resolve().then(() => listener(request, controller.signal)).then(
          (result) => settle(request.requestId, controller, {
            requestId: request.requestId,
            ok: true,
            result
          }),
          (error) => settle(request.requestId, controller, {
            requestId: request.requestId,
            ok: false,
            code: typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'COMPOSITION_FAILED',
            message: error instanceof Error ? error.message : String(error)
          })
        )
      })
      const disposeCancellations = preload.onCancellation((cancellation) => {
        const controller = controllers.get(cancellation.requestId)
        if (!controller) return
        controllers.delete(cancellation.requestId)
        controller.abort(cancellationError(cancellation.code, cancellation.message))
      })
      return () => {
        disposeRequests()
        disposeCancellations()
        for (const controller of controllers.values()) {
          controller.abort(cancellationError(
            'COMPOSITION_UNAVAILABLE',
            'Desktop Composition owner was disposed.'
          ))
        }
        controllers.clear()
      }
    }
  }
}
