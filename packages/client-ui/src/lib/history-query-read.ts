import type { AgentSessionHistoryReadInput, AgentSessionHistoryReadPage } from '@agentmux/core'

type Query = Omit<AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'>
type Read = (input: Query, signal: AbortSignal) => Promise<AgentSessionHistoryReadPage>

/** A read-only retry follows the original owner's exact budget and query position. */
export async function readHistoryQuery(input: Query, read: Read, signal: AbortSignal, current: () => boolean): Promise<AgentSessionHistoryReadPage> {
 try { return await read(input, signal) }
 catch (error) {
  const failure = error as { code?: unknown; detail?: unknown }
  let budget: { phase?: unknown; requiredBytes?: number; maxBytes?: number; cursor?: string } = {}
  if (failure?.code === 'AGENT_SESSION_HISTORY_BUDGET' && typeof failure.detail === 'string') {
   try { budget = JSON.parse(failure.detail) } catch { /* Keep the original readable failure. */ }
  }
  if (!current() || signal.aborted || budget.phase !== 'query-result' || !Number.isSafeInteger(budget.requiredBytes) || !Number.isSafeInteger(budget.maxBytes) ||
   budget.requiredBytes! <= (input.maxBytes ?? 1024 * 1024) || budget.requiredBytes! > budget.maxBytes! || budget.maxBytes! > 16 * 1024 * 1024 ||
   typeof budget.cursor !== 'string' || !budget.cursor) throw error
  return await read({ ...input, cursor: budget.cursor, maxBytes: budget.requiredBytes! }, signal)
 }
}
