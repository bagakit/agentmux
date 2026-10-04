/** Provider-neutral facts for a temporarily unavailable, complete native composer. */
export type AgentPromptPreparationWaitReason = 'context-compaction' | 'native-busy'

/** Retry observes this original input/source fence; it grants no replacement intent. */
export type AgentPromptPreparationRetryFence = { inputByte: number; nativeSourceId: string }
export type AgentPromptPreparationWait = AgentPromptPreparationRetryFence & {
  reason: AgentPromptPreparationWaitReason
  retrySafe: boolean
  agentSessionId: string
  runId: string
  operationId: string
}

/** Read the typed public error detail across SDK, RPC and IPC, never Provider text. */
export function readAgentPromptPreparationWait(error: unknown): AgentPromptPreparationWait | undefined {
  const original = error && typeof error === 'object' ? error as { code?: unknown; detail?: unknown } : undefined
  if (original?.code !== 'AGENT_PROMPT_PREPARATION_FAILED' || typeof original.detail !== 'string') return undefined
  let detail: unknown = original.detail
  for (let depth = 0; depth < 6; depth++) {
    if (typeof detail === 'string') { try { detail = JSON.parse(detail) } catch { return undefined } }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined
    const value = detail as { preparationWait?: unknown; detail?: unknown }
    if (value.preparationWait !== undefined) {
      const w = value.preparationWait as AgentPromptPreparationWait
      if (!w || typeof w !== 'object' || Array.isArray(w) ||
          !['context-compaction', 'native-busy'].includes(w.reason) || typeof w.retrySafe !== 'boolean' ||
          !Number.isSafeInteger(w.inputByte) || w.inputByte < 0 ||
          ![w.nativeSourceId, w.agentSessionId, w.runId, w.operationId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096)) return undefined
      return { reason: w.reason, retrySafe: w.retrySafe, inputByte: w.inputByte, nativeSourceId: w.nativeSourceId,
        agentSessionId: w.agentSessionId, runId: w.runId, operationId: w.operationId }
    }
    detail = value.detail
  }
  return undefined
}

/** Client-owned visible retry progress; this does not survive as execution permission. */
export type AgentPromptPreparationRetryProgress = {
  reason: AgentPromptPreparationWaitReason
  state: 'waiting' | 'preparing' | 'stopped' | 'exhausted'
  attempt: number
  maxAttempts: 3
  nextAttemptAt: number | null
}
