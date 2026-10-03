import type { SessionInputWriteResult } from './contracts'
import type { AgentMuxControlFailure } from '@agentmux/core'

/** One write attempt; uncertain input is reported, never replayed at the IPC boundary. */
export async function sessionInputWriteResult(write: () => Promise<void>): Promise<SessionInputWriteResult> {
  try {
    await write()
    return { ok: true }
  } catch (error) {
    const source = error instanceof Error ? error as Error & { code?: string; detail?: string; controlFailure?: AgentMuxControlFailure } : null
    return { ok: false, error: {
      code: typeof source?.code === 'string' ? source.code : 'SESSION_INPUT_FAILED',
      message: source?.message ?? String(error),
      ...(source?.detail === undefined ? {} : { detail: source.detail }),
      ...(source?.controlFailure === undefined ? {} : { controlFailure: source.controlFailure })
    } }
  }
}

/** Restore the original typed failure in Renderer after IPC and contextBridge copy the envelope. */
export function unwrapSessionInputWriteResult(result: SessionInputWriteResult): void {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
}
