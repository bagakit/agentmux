export const CLAUDE_USAGE_CAPABILITY = { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' } as const

/** Claude's assistant message owns response accounting; cache fields are not added twice. */
export function projectClaudeUsage(record: unknown, observedAt: number) {
  if (!record || typeof record !== 'object') return null
  const message = (record as { message?: unknown }).message
  if (!message || typeof message !== 'object') return null
  const usage = (message as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return null
  const { input_tokens: input, output_tokens: output } = usage as Record<string, unknown>
  if (typeof input !== 'number' || typeof output !== 'number') return null
  return { scope: 'response', inputTokens: input, outputTokens: output, totalTokens: input + output, observedAt }
}
