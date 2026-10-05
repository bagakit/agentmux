/**
 * An Agent Session survives a Runtime restart even when its old CtxMux Run does not.
 * Only the original Runtime's typed missing result authorizes this recovery path.
 * The Session observation IPC carries that code as data; display text cannot replace it.
 */
export function isVanishedAgentRunError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'CTXMUX_run_not_found'
}
