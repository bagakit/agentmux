import type { WorkbenchRendererStartupFailure, WorkbenchStartupError } from '../../../shared/workbench-startup-failure'

/** Runs before the application module graph. Capturing an observation never suppresses the original event. */
export function beginWorkbenchBootstrap(input: {
  host: Pick<Window, 'addEventListener' | 'removeEventListener'>
  attemptId: string | null
  load(): Promise<unknown>
  report(failure: WorkbenchRendererStartupFailure): Promise<boolean>
}): void {
  let recorded = false
  const dispose = (): void => {
    input.host.removeEventListener('error', onError as EventListener)
    input.host.removeEventListener('unhandledrejection', onRejection as EventListener)
  }
  const report = (event: WorkbenchRendererStartupFailure['event'], error: unknown): void => {
    if (recorded) return
    recorded = true
    dispose()
    if (!input.attemptId) return
    try { void input.report({ attemptId: input.attemptId, event, error: errorFields(error) }).catch(() => {}) }
    catch { /* The original import/exception still reports through the browser's own event. */ }
  }
  const onError = (event: ErrorEvent): void => { report('renderer-error', event.error) }
  const onRejection = (event: PromiseRejectionEvent): void => { report('renderer-unhandled-rejection', event.reason) }
  input.host.addEventListener('error', onError as EventListener)
  input.host.addEventListener('unhandledrejection', onRejection as EventListener)
  void input.load().catch(error => { report('renderer-import-error', error); throw error })
}

function errorFields(value: unknown): WorkbenchStartupError {
  if (!(value instanceof Error)) return { name: 'UnknownError', message: `Non-Error startup failure (${typeof value})` }
  const code = 'code' in value && typeof value.code === 'string' ? value.code.slice(0, 256) : undefined
  return { name: value.name.slice(0, 256), message: value.message.slice(0, 4096),
    ...(typeof value.stack === 'string' ? { stack: value.stack.slice(0, 128 * 1024) } : {}), ...(code ? { code } : {}) }
}
