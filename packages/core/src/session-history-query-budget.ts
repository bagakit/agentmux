/** A recovery receipt is valid only for the original query-result byte failure. */
export function sessionHistoryQueryBudgetRecovery(error: unknown, currentBudget = 1024 * 1024): { cursor: string; maxBytes: number } | null {
  const failure = error as { code?: unknown; detail?: unknown }
  if (failure?.code !== 'AGENT_SESSION_HISTORY_BUDGET' || typeof failure.detail !== 'string') return null
  let value: { phase?: unknown; requiredBytes?: number; maxBytes?: number; cursor?: string }
  try { value = JSON.parse(failure.detail) } catch { return null }
  if (value.phase !== 'query-result' || !Number.isSafeInteger(value.requiredBytes) || !Number.isSafeInteger(value.maxBytes) ||
    value.requiredBytes! <= currentBudget || value.requiredBytes! > value.maxBytes! || value.maxBytes! > 16 * 1024 * 1024 ||
    typeof value.cursor !== 'string' || !value.cursor) return null
  return { cursor: value.cursor, maxBytes: value.requiredBytes! }
}
