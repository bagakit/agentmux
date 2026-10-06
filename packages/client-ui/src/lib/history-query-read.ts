import type { AgentSessionHistoryReadInput, AgentSessionHistoryReadPage } from '@agentmux/core'
import { sessionHistoryQueryBudgetRecovery } from '@agentmux/core/session-history-query-budget'

type Query = Omit<AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'>
type Read = (input: Query, signal: AbortSignal) => Promise<AgentSessionHistoryReadPage>

/** A read-only retry follows the original owner's exact budget and query position. */
export async function readHistoryQuery(input: Query, read: Read, signal: AbortSignal, current: () => boolean): Promise<AgentSessionHistoryReadPage> {
 try { return await read(input, signal) }
 catch (error) {
  const recovery = sessionHistoryQueryBudgetRecovery(error, input.maxBytes)
  if (!current() || signal.aborted || !recovery) throw error
  return await read({ ...input, ...recovery }, signal)
 }
}
