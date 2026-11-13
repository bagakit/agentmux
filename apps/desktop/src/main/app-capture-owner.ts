import type { AppCapturePort, AppCaptureMethod, AppCaptureParamsMap, AppCaptureResultMap, AppCaptureContext } from '@agentmux/core/control'
import type { AppCaptureSource } from './app-capture.js'
import type { AppRecordingOwner } from './app-recording.js'

/** Both public entries consume the same original Desktop pixel source. */
export function createAppCapturePort(source: AppCaptureSource, recordings: AppRecordingOwner): AppCapturePort {
  return { async call<M extends AppCaptureMethod>(method: M, input: AppCaptureParamsMap[M], context: AppCaptureContext): Promise<AppCaptureResultMap[M]> {
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (method === 'app.capture') return await source.capture((input as AppCaptureParamsMap['app.capture']).target) as AppCaptureResultMap[M]
    return await recordings.call(method as Exclude<AppCaptureMethod, 'app.capture'>,
      input as AppCaptureParamsMap[Exclude<AppCaptureMethod, 'app.capture'>], context) as AppCaptureResultMap[M]
  } }
}
