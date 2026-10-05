import { crashRecordFrom, serializeCrashRecord, type CrashRecord } from './crash-capture.js'
import { isAllowedTopFrameNavigation, type TopFrameOrigin } from './top-frame-navigation.js'
import type { DesktopPackageIdentity } from '../shared/client-observation.js'
import type { WorkbenchRendererStartupFailure, WorkbenchStartupError } from '../shared/workbench-startup-failure.js'

type Contents = {
  on(event: 'preload-error', listener: (event: unknown, path: string, error: Error) => void): unknown
  on(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void): unknown
  off(event: 'preload-error', listener: (event: unknown, path: string, error: Error) => void): unknown
  off(event: 'did-fail-load', listener: (event: unknown, code: number, description: string, url: string, mainFrame: boolean) => void): unknown
  getOSProcessId(): number
}

/** One original Window and active loader token. Recording never changes startup or Runtime decisions. */
export function registerWorkbenchStartupCapture(deps: {
  contents: Contents
  preloadPath: string
  origin(): TopFrameOrigin
  activeAttempt(): string | null
  startupAttemptId: string
  pid: number
  appVersion: string
  packageIdentity: DesktopPackageIdentity | null
  sink(record: CrashRecord): void | Promise<void>
  stderr?(line: string): void
  now?(): number
}): { recordRenderer(input: unknown): boolean; ready(token: string): void; dispose(): void } {
  let disposed = false
  let attemptId: string | null = null
  let completedAttempt: string | null = null
  const recorded = new Set<'preload' | 'document' | 'renderer-bootstrap'>()
  const stderr = (line: string): void => {
    try { (deps.stderr ?? (text => { process.stderr.write(`${text}\n`) }))(line) }
    catch { /* A failed diagnostic output cannot take down the original Window. */ }
  }
  const currentAttempt = (): string | null => {
    if (disposed) return null
    const active = deps.activeAttempt()
    if (!active || active === completedAttempt) return null
    if (attemptId !== active) { attemptId = active; recorded.clear() }
    return active
  }
  const capture = (phase: 'preload' | 'document' | 'renderer-bootstrap', event: string, error: WorkbenchStartupError): boolean => {
    const active = currentAttempt()
    if (!active) return false
    if (recorded.has(phase)) return true
    recorded.add(phase)
    let rendererPid: number | null = null
    try { const observed = deps.contents.getOSProcessId(); if (Number.isInteger(observed) && observed > 0) rendererPid = observed }
    catch { /* Unknown stays unknown. */ }
    const record = crashRecordFrom({ kind: 'workbench-startup-failure', event, error, phase,
      attemptId: active, startupAttemptId: deps.startupAttemptId, pid: deps.pid, rendererPid,
      appVersion: deps.appVersion, packageIdentity: deps.packageIdentity }, (deps.now ?? Date.now)())
    // Retain the original record in local stderr even if disk publication is unavailable.
    stderr(`workbench startup failure: ${serializeCrashRecord(record)}`)
    const failed = (cause: unknown): void => {
      const detail = cause instanceof Error ? cause.message : 'Unknown diagnostic sink failure'
      const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code.slice(0, 256) : 'UNKNOWN'
      stderr(`workbench startup diagnostic sink failed: ${JSON.stringify({ attemptId: active, code, message: detail.slice(0, 4096) })}`)
    }
    try { void Promise.resolve(deps.sink(record)).catch(failed) }
    catch (error) { failed(error) }
    return true
  }
  const onPreloadError = (_event: unknown, path: string, error: Error): void => {
    if (path !== deps.preloadPath) return
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    capture('preload', 'preload-error', { name: error.name, message: error.message,
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}), ...(code ? { code } : {}) })
  }
  const onLoadError = (_event: unknown, code: number, description: string, url: string, mainFrame: boolean): void => {
    if (!mainFrame || !isAllowedTopFrameNavigation(deps.origin(), url)) return
    const tokens = new URL(url).searchParams.getAll('renderer-update')
    const active = currentAttempt()
    if (!active || tokens.length !== 1 || tokens[0] !== active) return
    capture('document', 'did-fail-load', { name: 'DocumentLoadError', message: description, code: String(code) })
  }
  deps.contents.on('preload-error', onPreloadError)
  deps.contents.on('did-fail-load', onLoadError)
  return {
    recordRenderer(input) {
      if (!validFailure(input) || input.attemptId !== currentAttempt()) return false
      return capture('renderer-bootstrap', input.event, input.error)
    },
    ready(token) { if (token === deps.activeAttempt()) completedAttempt = token },
    dispose() {
      disposed = true
      deps.contents.off('preload-error', onPreloadError)
      deps.contents.off('did-fail-load', onLoadError)
      recorded.clear()
    }
  }
}

function validFailure(input: unknown): input is WorkbenchRendererStartupFailure {
  if (!input || typeof input !== 'object') return false
  const failure = input as Partial<WorkbenchRendererStartupFailure>
  if (Object.keys(input).some(key => !['attemptId', 'event', 'error'].includes(key))) return false
  if (typeof failure.attemptId !== 'string' || failure.attemptId.length > 128 ||
    !['renderer-import-error', 'renderer-error', 'renderer-unhandled-rejection'].includes(failure.event ?? '')) return false
  const error = failure.error
  return !!error && typeof error === 'object' &&
    Object.keys(error).every(key => ['name', 'message', 'stack', 'code'].includes(key)) &&
    typeof error.name === 'string' && error.name.length <= 256 &&
    typeof error.message === 'string' && error.message.length <= 4096 &&
    (error.stack === undefined || typeof error.stack === 'string' && error.stack.length <= 128 * 1024) &&
    (error.code === undefined || typeof error.code === 'string' && error.code.length <= 256)
}
