import { Gauge } from 'lucide-react'
import type { AgentTurnUsage } from '@agentmux/core'

/** A native observation, not an estimate based on lifetime billing or the draft. */
export function AgentContextUsage({ usage }: { usage?: AgentTurnUsage | undefined }) {
  const context = usage?.context
  const known = context && Number.isFinite(context.capacityTokens) && context.capacityTokens > 0 &&
    Number.isFinite(context.usedTokens) && context.usedTokens >= 0
  const remaining = known ? Math.max(0, context.capacityTokens - context.usedTokens) : null
  const percent = known ? Math.floor(remaining! / context.capacityTokens * 100) : null
  const label = percent === null ? 'Context unknown' : `Context ${percent}% left`
  const detail = known && usage
    ? `${remaining!.toLocaleString()} of ${context.capacityTokens.toLocaleString()} tokens remain (${percent}%). Provider may compact when its own threshold is reached; AgentMux does not guess that threshold. Used ${context.usedTokens.toLocaleString()}. Last native observation: ${new Date(usage.observedAt).toLocaleString()}. Unsent draft excluded.`
    : 'Context remaining is unavailable because this Agent has not reported used tokens and capacity. Compression threshold is unknown.'
  return <span className="composer__context" tabIndex={0} aria-label={`${label}. ${detail}`} title={detail}><Gauge size={12} aria-hidden="true" />{label}</span>
}
