import type { AgentMuxAgentStopReceipt, AgentMuxAgentStopStageName } from '@agentmux/core'

/**
 * A Stop crosses IPC and contextBridge as a plain envelope so its Core code, operation identity and
 * failed stage survive Electron's Error boundary. An Agent Stop answers with the Core receipt; a
 * Terminal Stop has no receipt and answers `undefined`.
 */
export type SessionStopReply = { ok: true; result: AgentMuxAgentStopReceipt | undefined } | { ok: false; error: {
  code: string; message: string; operationId?: string; stage?: AgentMuxAgentStopStageName
} }

/** Main attaches these to a failed Agent Stop: the caller's operation and the stage Core recorded as failed. */
export type SessionStopFailureFacts = { stopOperationId?: string; stopStage?: AgentMuxAgentStopStageName }

export async function sessionStopReply(stop: () => Promise<AgentMuxAgentStopReceipt | undefined>): Promise<SessionStopReply> {
  try { return { ok: true, result: await stop() } }
  catch (error) {
    const source = error instanceof Error ? error as Error & { code?: unknown } & SessionStopFailureFacts : null
    return { ok: false, error: {
      code: typeof source?.code === 'string' ? source.code : 'AGENT_STOP_FAILED',
      message: source?.message ?? String(error),
      ...(typeof source?.stopOperationId === 'string' ? { operationId: source.stopOperationId } : {}),
      ...(typeof source?.stopStage === 'string' ? { stage: source.stopStage } : {})
    } }
  }
}

export function unwrapSessionStopReply(reply: SessionStopReply): AgentMuxAgentStopReceipt | undefined {
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error)
  return reply.result
}
