import type { AgentMuxControlFailure } from '@agentmux/core'
import type { SessionSnapshot } from './contracts'

export type SessionLaunchFailure = {
  code: string
  message: string
  detail?: string
  controlFailure: AgentMuxControlFailure
}
type SessionLaunchResult = { ok: true; session: SessionSnapshot } | { ok: false; error: SessionLaunchFailure }

export function sessionLaunchFailure(error: unknown): SessionLaunchFailure {
  const source = error instanceof Error ? error as Error & Partial<SessionLaunchFailure> : null
  return {
    code: source?.code ?? 'TERMINAL_CREATE_UNCONFIRMED',
    message: source?.message ?? String(error),
    ...(source?.detail === undefined ? {} : { detail: source.detail }),
    controlFailure: source?.controlFailure ?? { disposition: 'unknown', confirmedInputBytes: null }
  }
}

/** Electron rejection does not retain the creation code or its unknown outcome. */
export async function sessionLaunchResult(launch: () => Promise<SessionSnapshot>): Promise<SessionLaunchResult> {
  try { return { ok: true, session: await launch() } }
  catch (error) { return { ok: false, error: sessionLaunchFailure(error) } }
}

export function unwrapSessionLaunchResult(result: SessionLaunchResult): SessionSnapshot {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.session
}
