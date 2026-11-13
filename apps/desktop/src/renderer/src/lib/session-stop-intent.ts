import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxAgentStopReceipt } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { agentOperationKey } from './agent-operation'

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
 * Retained original intent lives in the same durable client projection used by cards and Regions.
 * A restored reference is unconfirmed, never permission to replay it. An explicit Stop for the
 * same exact Host/Session/Run retains that operation; a different Run is a different intent.
 */
export function sessionStopIntentFor(control: AgentSessionControl): SessionStopIntent {
  return unconfirmedStopFor(control) ?? mintSessionStopIntent(control)
}
export function retainUnconfirmedStop(intent: SessionStopIntent) {
  const operation = { kind: 'stop' as const, operationId: intent.operationId,
    control: { ...intent.control, run: { ...intent.control.run } },
    subject: { hostId: intent.control.hostId, agentSessionId: intent.control.agentSessionId },
    phase: 'pending' as const, startedAt: Date.now() }
  const key = agentOperationKey(operation)
  useAppStore.setState(state => state.agentOperations[key] ? state : {
    agentOperations: { ...state.agentOperations, [key]: operation }
  })
  return operation
}
export function settleSessionStop(intent: SessionStopIntent): void {
  const key = agentOperationKey({ kind: 'stop', operationId: intent.operationId,
    subject: { hostId: intent.control.hostId, agentSessionId: intent.control.agentSessionId } })
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    if (held?.kind !== 'stop' || held.control.agentSessionId !== intent.control.agentSessionId ||
      held.control.run.runId !== intent.control.run.runId) return state
    const { [key]: _settled, ...agentOperations } = state.agentOperations
    return { agentOperations }
  })
}

/** The original failure, with the operation the user can continue and inspect. */
export function sessionStopFailure(error: unknown, intent: SessionStopIntent): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const stage = sessionStopFailedStage(source), code = sessionStopErrorCode(source)
  const key = agentOperationKey({ kind: 'stop', operationId: intent.operationId,
    subject: { hostId: intent.control.hostId, agentSessionId: intent.control.agentSessionId } })
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    if (held?.kind !== 'stop' || held.control.agentSessionId !== intent.control.agentSessionId ||
      held.control.run.runId !== intent.control.run.runId || held.phase === 'succeeded') return state
    const message = `${stage ? `Failed stage: ${stage}` : 'Stop result unconfirmed'}${code ? ` (${code})` : ''}. ${source.message}`
    return { agentOperations: { ...state.agentOperations, [key]: { ...held, phase: 'unconfirmed', canContinue: false, message } } }
  })
  return Object.assign(new Error(`${source.message} Stop ${intent.operationId}${stage ? ` failed at ${stage}` : ''} is kept; ` +
    `stopping this Run again continues it. Inspect it with: ${sessionStopInspectCommand(intent)}`),
  { ...(code ? { code } : {}), cause: source, operationId: intent.operationId, ...(stage ? { stage } : {}) })
}

/** The unconfirmed Stop already sent for this exact Run, without minting one. */
export function unconfirmedStopFor(control: AgentSessionControl): SessionStopIntent | undefined {
  const operation = Object.values(useAppStore.getState().agentOperations).find(operation => operation.kind === 'stop' &&
    operation.control.hostId === control.hostId && operation.control.agentSessionId === control.agentSessionId &&
    operation.control.run.runId === control.run.runId &&
    (operation.phase === 'pending' || operation.phase === 'unconfirmed' || operation.phase === 'partial'))
  return operation?.kind === 'stop' ? { control: operation.control, operationId: operation.operationId } : undefined
}
