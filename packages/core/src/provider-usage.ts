import { parseTurnUsage, type AgentUsageTranscriptDecoder } from './agent-usage-transcript.js'
import { CLAUDE_USAGE_CAPABILITY, projectClaudeUsage } from '@agentmux/providers/claude/usage'
import { CODEX_USAGE_CAPABILITY, projectCodexUsage } from '@agentmux/providers/codex/usage'

// The Hook worker loads only these small native adapters, never the full Provider registry.
const contributions = {
  claude: { capability: CLAUDE_USAGE_CAPABILITY, decode: projectClaudeUsage },
  codex: { capability: CODEX_USAGE_CAPABILITY, decode: projectCodexUsage }
} as const

/** The launch's exact Provider owns both format and decoder; another Provider's format grants nothing. */
export function usageTranscriptDecoder(providerId: string | undefined, format: string | undefined): AgentUsageTranscriptDecoder | undefined {
  if (!providerId || !Object.hasOwn(contributions, providerId)) return
  const contribution = contributions[providerId as keyof typeof contributions]
  if (contribution.capability.transcriptFormat !== format) return
  return (record, observedAt) => parseTurnUsage(contribution.decode(record, observedAt))
}
