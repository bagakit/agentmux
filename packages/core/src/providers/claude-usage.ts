import { parseTurnUsage, type AgentUsageTranscriptDecoder } from '../agent-usage-transcript.js'

export const CLAUDE_USAGE_CAPABILITY = { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' } as const

/** Claude's assistant message owns response accounting; cache fields are not added twice. */
export const decodeClaudeUsage: AgentUsageTranscriptDecoder = (record, observedAt) => {
  if (!record || typeof record !== 'object') return null
  const message = (record as { message?: unknown }).message
  if (!message || typeof message !== 'object') return null
  const usage = (message as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const { input_tokens: input, output_tokens: output } = usage as Record<string, unknown>
  if (typeof input !== 'number' || typeof output !== 'number') return null
  return parseTurnUsage({ scope: 'response', inputTokens: input, outputTokens: output, totalTokens: input + output, observedAt })
}
