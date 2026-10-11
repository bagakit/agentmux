import { AgentMuxError } from './errors.js'
import type { AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentInputJournalIntent, AgentInputSubmissionReceipt } from './agent-input-wait.js'
import type { AgentMuxMessageEnvelope } from './agent-global-message-queue.js'
import type { JsonReadEntry } from './json-read-fragments.js'
import type { DeliveryFailure } from './delivery-attempt.js'
import type { AgentMessageChannel, AgentOperationDevice, AgentPromptSubmissionRecord } from './types.js'
import { rpcRecord } from './rpc-data.js'

/** A read of the original input journal; neither a dispatch request nor a consumer ACK. */
export type AgentInputMailboxRead = { agentSessionId: string; limit?: number; cursor?: string; maxBytes?: number }
export type AgentInputMailboxItem = {
  sequence: number
  recordedAt: number
} & (
  | { kind: 'controlled'; intent: Omit<AgentInputJournalIntent, 'environment'>; message?: AgentMuxMessageEnvelope; sourceChannel?: AgentMessageChannel; sourceDevice?: AgentOperationDevice; receipt: AgentInputSubmissionReceipt | null; failure?: DeliveryFailure }
  | { kind: 'submission'; key: AgentPromptInputKey; record: AgentPromptSubmissionRecord | null; failure?: DeliveryFailure }
)
export type AgentInputMailboxPage = {
  agentSessionId: string
  queueId: string
  cut: { incarnation: string; throughSequence: number }
  budgetBytes: number
  items: readonly JsonReadEntry<AgentInputMailboxItem>[]
  nextCursor: string | null
  /** Only journaled membership is complete. Earlier claims/launches may have no journal row. */
  coverage: { kind: 'recorded-inputs'; unrecorded: 'unconfirmed' }
}
export function parseAgentInputMailboxRead(value: unknown): AgentInputMailboxRead {
  const p = rpcRecord(value, ['agentSessionId', 'limit', 'cursor', 'maxBytes'])
  if (typeof p.agentSessionId !== 'string' || !p.agentSessionId.trim() || /[\0\r\n]/u.test(p.agentSessionId) ||
    p.limit !== undefined && (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 100) ||
    p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || (p.maxBytes as number) < 4096 || (p.maxBytes as number) > 4 * 1024 * 1024) ||
    p.cursor !== undefined && (typeof p.cursor !== 'string' || !p.cursor || p.cursor.length > 131072)) {
    throw new AgentMuxError('The original input mailbox scope or continuation is invalid.', 'INVALID_AGENT_INPUT_READ')
  }
  return value as AgentInputMailboxRead
}
