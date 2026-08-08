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
    ? `${remaining!.toLocaleString()} / ${context.capacityTokens.toLocaleString()} tokens remaining; ${context.usedTokens.toLocaleString()} used. Last native observation: ${new Date(usage.observedAt).toLocaleString()}. Updates after a turn; excludes your unsent draft.`
    : 'Context remaining is unknown: this Agent has not reported both current usage and context capacity.'
  return <span className="composer__context" tabIndex={0} aria-label={`${label}. ${detail}`} title={detail}>{label}</span>
}
