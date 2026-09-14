import { AgentMuxError } from './errors.js'

/**
 * Preserve the daemon's bounded stderr beside readiness failures. A daemon that reaches
 * SQLITE_FULL (or another startup error) can exit before publishing readiness; dropping stderr
 * turns that concrete failure into an opaque timeout.
 */
export function withCtxmuxStartupDiagnostic(error: unknown, stderr: string): AgentMuxError | unknown {
  const diagnostic = stderr.trim()
  if (!diagnostic) return error
  if (error instanceof AgentMuxError) {
    return new AgentMuxError(`${error.message} CtxMux daemon diagnostic: ${diagnostic}`, error.code, error.detail)
  }
  return new AgentMuxError(
    `CtxMux daemon startup failed: ${error instanceof Error ? error.message : String(error)} CtxMux daemon diagnostic: ${diagnostic}`,
    'CTXMUX_UNAVAILABLE'
  )
}
