import type { AgentTurnUsage } from './types.js'

/** Optional accounting is independent: a malformed total must not discard a valid response/context. */
export function parseCumulativeUsage(value: unknown): NonNullable<AgentTurnUsage['cumulative']> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const { inputTokens, outputTokens, totalTokens } = source
  if (source.scope !== 'native-session' || ![inputTokens, outputTokens, totalTokens].every(
    count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return null
  return { scope: 'native-session', inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number }
}
