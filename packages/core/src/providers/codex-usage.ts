import { parseTurnUsage, type AgentUsageTranscriptDecoder } from '../agent-usage-transcript.js'

export const CODEX_USAGE_CAPABILITY = { kind: 'native-transcript', transcriptFormat: 'codex-rollout' } as const

/** A rollout supplies last-response and native-session totals independently, never whole-turn usage. */
export const decodeCodexUsage: AgentUsageTranscriptDecoder = (record, observedAt) => {
  if (!record || typeof record !== 'object') return null
  const payload = (record as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'token_count') return null
  const info = (payload as { info?: unknown }).info
  if (!info || typeof info !== 'object') return null
  const { last_token_usage: last, total_token_usage: cumulative, model_context_window: capacity } = info as Record<string, unknown>
  if (!last || typeof last !== 'object') return null
  const { input_tokens: input, output_tokens: output, total_tokens: total } = last as Record<string, unknown>
  if (typeof input !== 'number' || typeof output !== 'number') return null
  const nativeTotal = cumulative && typeof cumulative === 'object' ? cumulative as Record<string, unknown> : undefined
  const explicitTotal = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : undefined
  return parseTurnUsage({ scope: 'response', inputTokens: input, outputTokens: output,
    totalTokens: explicitTotal ?? input + output, observedAt,
    ...(nativeTotal ? { cumulative: { scope: 'native-session', inputTokens: nativeTotal.input_tokens,
      outputTokens: nativeTotal.output_tokens, totalTokens: nativeTotal.total_tokens } } : {}),
    context: { capacityTokens: capacity, usedTokens: explicitTotal } })
}
