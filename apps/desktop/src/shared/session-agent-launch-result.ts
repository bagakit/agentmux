import type { AgentLaunchInput, AgentLaunchResult, SessionAgentLaunchResult } from './contracts'

type Identity = Pick<AgentLaunchInput, 'agentSessionId' | 'createOperationId'>
type Failure = Extract<SessionAgentLaunchResult, { ok: false }>['error']
function failure(input: Identity, error: unknown, transport = false): Failure {
  const source = error instanceof Error ? error as Error & Partial<Failure> : undefined
  const agentSessionId = transport ? input?.agentSessionId : source?.agentSessionId ?? input?.agentSessionId
  const createOperationId = transport ? input?.createOperationId : source?.createOperationId ?? input?.createOperationId
  return {
    code: transport ? 'AGENT_CREATION_UNCONFIRMED' : source?.code ?? 'AGENT_CREATION_UNCONFIRMED',
    message: source?.message ?? String(error),
    ...(source?.detail === undefined ? {} : { detail: source.detail }),
    // A channel rejection may happen after start; only the structured owner outcome can be certain.
    controlFailure: !transport && source?.controlFailure ? source.controlFailure : { disposition: 'unknown', confirmedInputBytes: null },
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(createOperationId === undefined ? {} : { createOperationId })
  }
}

/** One launch attempt. Main reports facts as data instead of throwing across Electron. */
export async function sessionAgentLaunchResult(input: Identity, launch: () => Promise<AgentLaunchResult>): Promise<SessionAgentLaunchResult> {
  try { return { ok: true, result: await launch() } }
  catch (error) { return { ok: false, error: failure(input, error) } }
}

export function unwrapSessionAgentLaunchResult(result: SessionAgentLaunchResult): AgentLaunchResult {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.result
}

/** A missing carrier is unknown even when a transport Error claims not_applied. */
export function unconfirmedSessionAgentLaunch(input: Identity, error: unknown): Error & Failure {
  const detail = failure(input, error, true)
  return Object.assign(new Error(detail.message), detail)
}
