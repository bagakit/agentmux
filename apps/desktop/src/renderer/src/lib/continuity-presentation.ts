import type { AgentMuxContinuityOperation } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

/** A display-only join; an older attempt cannot explain the current Run. */
export function currentRunRecoveryOperation(session: {
  id?: string
  control?: { run: { runId: string } }
  continuity?: AgentMuxContinuityOperation | undefined
}): AgentMuxContinuityOperation | undefined {
  const operation = session.continuity
  return operation?.agentSessionId === session.id && operation?.newRun && operation.newRun.runId === session.control?.run.runId
    ? operation : undefined
}

/** A current Core operation supplies copy only; it never changes recovery eligibility. */
export function agentContinuityPresentation(session: Extract<SessionSnapshot, { kind: 'agent' }>): {
  kind: 'restoring' | 'unconfirmed' | 'pending'
  title: string
  detail: string
} | null {
  const operation = session.continuity
  const decision = operation?.agentSessionId === session.id &&
    (operation.newRun ?? operation.previousRun).runId === session.control.run.runId ? operation : undefined
  if (decision?.kind === 'starting') return {
    kind: 'restoring', title: 'Restoring your session',
    detail: 'Core is restoring the original Session. Your saved conversation and draft are kept.'
  }
  // A running process does not finish a matching Core restore, but an old operation
  // must not put a healthy newer Run back into a retained-session stage.
  if (session.processState === 'running') return null
  if (session.runUnobserved || decision?.reason === 'runtime-unverified' ||
    decision?.reason === 'provider-unverified' || decision?.reason === 'operation-unconfirmed') return {
    kind: 'unconfirmed', title: 'Session state unconfirmed',
    detail: session.status.detail ?? (decision ? agentContinuityDetail(decision) : 'The saved Session is retained. Its process state is not yet confirmed.')
  }
  if (decision?.kind === 'pending') return {
    kind: 'pending', title: 'Waiting to restore', detail: agentContinuityDetail(decision)
  }
  return null
}

/** Presents a Core decision; never grants or denies recovery. */
export function agentContinuityDetail(decision?: AgentMuxContinuityOperation): string {
  if (!decision) return 'The original Session is kept. Core will check its exact Run before restoring; you can send your next request or use Resume.'
  switch (decision.reason) {
    case 'runtime-unverified': return 'The original Run is unverified. Keep this Session and check the original Host again.'
    case 'active-manual': return 'Automatic recovery of interrupted work is disabled. Use Resume or send your next request.'
    case 'active-delay': return 'Interrupted work is waiting for the configured recovery delay. You can restore it now.'
    case 'idle-window-expired': return 'The confirmed idle window has expired. Your next request or Resume restores this Session.'
    case 'idle-unknown': return 'Idle time is unknown. Your next request or Resume restores this Session.'
    case 'not-active': return 'No interrupted work or recent idle completion is confirmed. Use Resume or send your next request.'
    case 'resume-disabled': return 'Automatic resume after an ended Run is disabled. Use Resume or send your next request.'
    case 'provider-unverified': return 'The Provider recovery check is unconfirmed. The original Session is kept; check it again or restore manually.'
    case 'operation-unconfirmed': return 'The original recovery result is unconfirmed. Check the same Session again; no new start or unknown input is replayed.'
    default: return decision.error ?? 'The original Session is kept. Use Resume or send your next request.'
  }
}
