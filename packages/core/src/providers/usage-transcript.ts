import type { AgentUsageTranscriptDecoder } from '../agent-usage-transcript.js'
import { CLAUDE_USAGE_CAPABILITY, decodeClaudeUsage } from './claude-usage.js'
import { CODEX_USAGE_CAPABILITY, decodeCodexUsage } from './codex-usage.js'

// The Hook worker loads only these small native adapters, never the full Provider registry.
const contributions = {
  claude: { capability: CLAUDE_USAGE_CAPABILITY, decode: decodeClaudeUsage },
  codex: { capability: CODEX_USAGE_CAPABILITY, decode: decodeCodexUsage }
} as const

/** The launch's exact Provider owns both format and decoder; another Provider's format grants nothing. */
export function usageTranscriptDecoder(providerId: string | undefined, format: string | undefined): AgentUsageTranscriptDecoder | undefined {
  if (!providerId || !Object.hasOwn(contributions, providerId)) return
  const contribution = contributions[providerId as keyof typeof contributions]
  return contribution.capability.transcriptFormat === format ? contribution.decode : undefined
}
