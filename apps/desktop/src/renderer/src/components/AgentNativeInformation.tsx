import type { AgentConfigurationSnapshot, AgentContextWindowUsage, AgentInformationSnapshot, AgentTurnUsage } from '@agentmux/core'
import { agentCurrentModel } from '@agentmux/core/agent-information'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { contextUsedPercent, formatTokenCount } from '../lib/agent-usage'

const RefreshIcon = semanticIconComponent('action.refresh')

/** Read-only native facts. Quota windows and context capacity keep separate labels and units. */
export function AgentNativeInformation({ information, configuration, contextWindowUsage, usage, loading = false, issue, onRefresh }: {
  information?: AgentInformationSnapshot | undefined
  configuration?: AgentConfigurationSnapshot | undefined
  contextWindowUsage?: AgentContextWindowUsage | undefined
  usage?: AgentTurnUsage | undefined
  loading?: boolean
  issue?: string | undefined
  onRefresh?: (() => Promise<void>) | undefined
}) {
  const model = agentCurrentModel(information, configuration)
  const lastModel = !model && information?.issues.some(item => item.field === 'model') ? information.model : undefined
  const context = contextWindowUsage ?? usage?.context, used = contextUsedPercent(context)
  const missing = information?.issues.filter(item => item.field !== 'configuration' && !(lastModel && item.field === 'model')) ?? []
  const hasQuota = information?.limits && information.limits.length > 0
  return <section className="agent-native-information" aria-label="Native Agent information" aria-busy={loading}>
    <dl className="agent-native-information__session">
      <div><dt>{lastModel ? 'Last model' : 'Model'}</dt><dd title={model?.id ?? lastModel?.id}>{model ? model.name ?? model.id : lastModel ? lastModel.name ?? lastModel.id : loading ? 'Reading…' : 'Not reported'}
        {lastModel ? <small>Unconfirmed</small> : model?.scope === 'next-turn' ? <small>Next turn</small> : null}</dd></div>
      <div><dt>Context</dt><dd>{context && used !== null ? <><span>{100 - used}% remaining</span>
        <small>{formatTokenCount(context.usedTokens)} / {formatTokenCount(context.capacityTokens)} tokens used</small></> : 'Not reported'}</dd></div>
      {information?.plan ? <div><dt>Plan</dt><dd>{information.plan.name}</dd></div> : null}
    </dl>
    {hasQuota ? <section className="agent-native-information__limits" aria-label="Account limits">
      <h3>Account limits</h3>
      {information.limits!.map(limit => {
        const remaining = Math.max(0, 100 - limit.usedPercent)
        const label = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(remaining)}% remaining`
        return <div className="agent-native-information__limit" key={limit.id}>
          <div><span>{limit.name}</span><strong>{label}</strong></div>
          <progress max={100} value={remaining} aria-label={`${limit.name}: ${label}`} />
          {limit.resetsAt !== undefined ? <small>Resets {new Date(limit.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small> : null}
        </div>
      })}
    </section> : null}
    {missing.length ? <p className="agent-native-information__missing">{[...new Set(missing.map(item => {
      const field = item.field === 'limits' ? 'Account limits' : item.field === 'plan' ? 'Plan' : 'Model'
      return `${field} ${item.kind === 'unsupported' ? 'not provided' : item.kind === 'unavailable' ? 'unavailable' : 'unconfirmed'}`
    }))].join(' · ')}</p> : !information && !loading ? <p className="agent-native-information__missing">Native plan and account limits not reported.</p> : null}
    {issue ? <p className="agent-native-information__issue" role="status">Refresh unavailable. {issue}{information ? ' Last confirmed values are kept.' : ''}</p> : null}
    <footer><span>{loading ? 'Reading native information…' : information ? <>Observed <time dateTime={new Date(information.observedAt).toISOString()}>{new Date(information.observedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time></> : 'Native information'}</span>
      {onRefresh ? <button type="button" className="agent-native-information__refresh" disabled={loading} onClick={() => void onRefresh()} aria-label="Refresh Agent information"><RefreshIcon size={12} />Refresh</button> : null}</footer>
  </section>
}
