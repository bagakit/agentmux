import type { AgentTurnUsage } from '@agentmux/core'
import { agentUsageScopeLabel, contextUsedPercent, formatTokenCount } from '../lib/agent-usage'

function TokenCounts({ usage }: { usage: Pick<AgentTurnUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'> }) {
  return <dl>
    <div><dt>Input</dt><dd>{formatTokenCount(usage.inputTokens)}</dd></div>
    <div><dt>Output</dt><dd>{formatTokenCount(usage.outputTokens)}</dd></div>
    <div><dt>Total</dt><dd>{formatTokenCount(usage.totalTokens)}</dd></div>
  </dl>
}

/** Held native facts only. The caller owns disclosure, identity, reading and observation lifetime. */
export function AgentUsageDetails({ usage }: { usage?: AgentTurnUsage | undefined }) {
  const context = usage?.context, used = contextUsedPercent(context)
  const remaining = used === null ? null : 100 - used
  return <div className="agent-usage-details">
    <section className="agent-usage-details__context">
      <h3>Context window</h3>
      {context && used !== null ? <>
        <strong>{used}% used</strong> <span>({remaining}% remaining)</span>
        <p>{formatTokenCount(context.usedTokens)} of {formatTokenCount(context.capacityTokens)} tokens · {formatTokenCount(Math.max(0, context.capacityTokens - context.usedTokens))} remaining</p>
      </> : <p>Used tokens and capacity not reported.</p>}
    </section>
    <section className="agent-usage-details__section composer__context-turn" data-agent-usage-scope="native-session">
      <h3>Native Session</h3>
      {usage?.cumulative ? <TokenCounts usage={usage.cumulative} /> : <p>Cumulative tokens not reported.</p>}
    </section>
    <section className="agent-usage-details__section composer__context-turn" data-agent-usage-scope={usage?.scope ?? 'unknown'}>
      <h3>{usage ? agentUsageScopeLabel(usage) : 'Last response'}</h3>
      {usage ? <TokenCounts usage={usage} /> : <p>No native response sample.</p>}
    </section>
    <p className="agent-usage-details__observed">{usage ? <>Last observed {new Date(usage.observedAt).toLocaleString()}.</> : 'Observation unavailable.'} Native readings; context excludes the unsent draft. Compaction threshold unknown.</p>
  </div>
}
