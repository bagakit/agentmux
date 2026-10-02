import type { AgentMuxControlFailure } from '@agentmux/core'
import type { SessionSnapshot } from './contracts'

type SessionReopenResult = { ok: true; session: SessionSnapshot } | { ok: false; error: {
  code: string; message: string; detail?: string; controlFailure: AgentMuxControlFailure
} }

/** One explicit lifecycle attempt; Electron rejection alone does not preserve its outcome. */
export async function sessionReopenResult(reopen: () => Promise<SessionSnapshot>): Promise<SessionReopenResult> {
  try { return { ok: true, session: await reopen() } }
  catch (error) {
    const source = error instanceof Error ? error as Error & { code?: string; detail?: string; controlFailure?: AgentMuxControlFailure } : null
    return { ok: false, error: {
      code: source?.code ?? 'SESSION_REOPEN_UNCONFIRMED', message: source?.message ?? String(error),
      ...(source?.detail === undefined ? {} : { detail: source.detail }),
      controlFailure: source?.controlFailure ?? { disposition: 'unknown', confirmedInputBytes: null }
    } }
  }
}

export function unwrapSessionReopenResult(result: SessionReopenResult): SessionSnapshot {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.session
}
