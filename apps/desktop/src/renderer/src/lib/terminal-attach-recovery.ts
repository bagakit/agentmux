/**
 * An Agent Session survives a Runtime restart even when its old CtxMux Run does not.
 * Keep this classification transport-agnostic because Electron serializes IPC errors and
 * different Runtime layers expose either a code or the original message.
 */
export function isVanishedAgentRunError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === 'string' ? candidate.code : ''
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return code === 'CTXMUX_run_not_found' || /\bRun\b[^\n]*\bdoes not exist\b/i.test(message)
}
