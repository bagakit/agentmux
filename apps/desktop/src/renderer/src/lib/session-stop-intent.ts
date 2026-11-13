import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxAgentStopReceipt } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'

/**
 * One user Stop intent: the exact Run it names and the operation id Core records for it. "Continue
 * Stop" sends this same pair again, so Core continues that Stop and `amux agent stop inspect`
 * reads it. A changed Run is a new intent with a new id, never a retry of the old one.
 */
export type SessionStopIntent = { control: AgentSessionControl; operationId: string }

export function mintSessionStopIntent(control: AgentSessionControl): SessionStopIntent {
  return { control: { ...control, run: { ...control.run } }, operationId: mintObjectId() }
}

/** Core's code for a Stop whose Session now holds another Run than the one named. */
export const STALE_STOP_CODE = 'STALE_AGENT_SESSION'

export function sessionStopErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/** The stage Core recorded as failed for this Stop, when Main could read it. */
export function sessionStopFailedStage(error: unknown): string | undefined {
  const stage = error && typeof error === 'object' ? (error as { stage?: unknown }).stage : undefined
  return typeof stage === 'string' ? stage : undefined
}

/** The read-only command that inspects this same Stop. */
export function sessionStopInspectCommand(intent: SessionStopIntent): string {
  return `amux agent stop inspect --session ${intent.control.agentSessionId} --run ${intent.control.run.runId} --operation-id ${intent.operationId}`
}

/**
 * What a store-level Stop answers. Every result that is not `stopped` names what happened and the
 * one action that works from here, so its caller renders it instead of the Stop disappearing.
 */
export type SessionStopOutcome =
  | { status: 'stopped'; receipt?: AgentMuxAgentStopReceipt }
  | { status: 'not-sent'; reason: 'view-closing' | 'session-missing'; message: string; action: string }
  | { status: 'run-changed'; message: string; action: string; operationId: string }
  | { status: 'unconfirmed'; message: string; action: string; operationId?: string; stage?: string }

/**
 * Stops sent but not confirmed, by exact host/Session/Run. Retrying the same Run (closing its View
 * again, or Stop from another entry) resends this intent, so Core continues that Stop and the id the
 * user was shown stays the one inspect reads. Entries leave on Core's receipt or when Core says the
 * Run is stale; a different Run never matches.
 */
const unconfirmedStops = new Map<string, SessionStopIntent>()
const runKey = (control: AgentSessionControl) => JSON.stringify([control.hostId, control.agentSessionId, control.run.runId])

export function sessionStopIntentFor(control: AgentSessionControl): SessionStopIntent {
  return unconfirmedStops.get(runKey(control)) ?? mintSessionStopIntent(control)
}
export function retainUnconfirmedStop(intent: SessionStopIntent): void { unconfirmedStops.set(runKey(intent.control), intent) }
export function settleSessionStop(intent: SessionStopIntent): void {
  if (unconfirmedStops.get(runKey(intent.control))?.operationId === intent.operationId) unconfirmedStops.delete(runKey(intent.control))
}

/** The original failure, with the operation the user can continue and inspect. */
export function sessionStopFailure(error: unknown, intent: SessionStopIntent): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const stage = sessionStopFailedStage(source), code = sessionStopErrorCode(source)
  return Object.assign(new Error(`${source.message} Stop ${intent.operationId}${stage ? ` failed at ${stage}` : ''} is kept; ` +
    `stopping this Run again continues it. Inspect it with: ${sessionStopInspectCommand(intent)}`),
  { ...(code ? { code } : {}), cause: source, operationId: intent.operationId, ...(stage ? { stage } : {}) })
}

/** The unconfirmed Stop already sent for this exact Run, without minting one. */
export function unconfirmedStopFor(control: AgentSessionControl): SessionStopIntent | undefined {
  return unconfirmedStops.get(runKey(control))
}
