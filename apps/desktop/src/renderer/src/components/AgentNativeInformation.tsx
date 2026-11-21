import type { AgentConfigurationSnapshot, AgentContextWindowUsage, AgentInformationLimit, AgentInformationSnapshot, AgentTurnUsage } from '@agentmux/core'
import { agentCurrentModel, agentModelOption } from '@agentmux/core/agent-information'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentSessionControl } from '../../../shared/contracts'
import { contextUsedPercent, formatTokenCount } from '../lib/agent-usage'
import { useAgentNativeInformation } from '../lib/use-agent-native-information'

const RefreshIcon = semanticIconComponent('action.refresh')
const quotaPercent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function sampleAge(observedAt: number, now: number) {
  const minutes = Math.floor((now - observedAt) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function limitName({ name, windowMinutes }: AgentInformationLimit) {
  const suffix = ` · ${windowMinutes} min`
  if (!windowMinutes || !name.endsWith(suffix)) return name
  const unit = windowMinutes % 1440 === 0 ? 'day' : windowMinutes % 60 === 0 ? 'hour' : 'minute'
  const value = windowMinutes / (unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1)
  return `${name.slice(0, -suffix.length)} · ${new Intl.NumberFormat(undefined, { style: 'unit', unit }).format(value)}`
}

/** This mounted face owns account demand. Model and context keep their original sources. */
export function AgentNativeInformation({ information: retained, configuration, contextWindowUsage, usage, control, nativeSessionId }: {
  information?: AgentInformationSnapshot | undefined
  configuration?: AgentConfigurationSnapshot | undefined
  contextWindowUsage?: AgentContextWindowUsage | undefined
  usage?: AgentTurnUsage | undefined
  control?: AgentSessionControl | undefined
  nativeSessionId?: string | undefined
}) {
  const { information, issue, loading, now, refresh } = useAgentNativeInformation(control, retained, nativeSessionId)
  const model = agentCurrentModel(information, configuration)
  const option = agentModelOption(configuration)
  const lastModel = !model && configuration?.observation?.state === 'unconfirmed' && option
    ? { id: option.currentValue, name: option.choices.find(choice => choice.value === option.currentValue)?.name }
    : !model && information?.issues.some(item => item.field === 'model') ? information.model : undefined
  const context = contextWindowUsage ?? usage?.context, used = contextUsedPercent(context)
  const missing = information?.issues.filter(item => item.field !== 'configuration' && !(lastModel && item.field === 'model')) ?? []
  const limits = information?.limits ?? []
  const observed = information && new Date(information.observedAt)
  return <section className="agent-native-information" aria-label="Native Agent information" aria-busy={loading}>
    <dl className="agent-native-information__session">
      <div><dt>{lastModel ? 'Last model' : 'Model'}</dt><dd title={model?.id ?? lastModel?.id}>{model ? model.name ?? model.id : lastModel ? lastModel.name ?? lastModel.id : loading ? 'Reading…' : 'Not reported'}
        {lastModel ? <small>Unconfirmed</small> : model?.scope === 'next-turn' ? <small>Next turn</small> : null}</dd></div>
      <div><dt>Context</dt><dd>{context && used !== null ? <><span>{used}% used</span>
        <small>{formatTokenCount(context.usedTokens)} / {formatTokenCount(context.capacityTokens)} tokens</small></> : 'Not reported'}</dd></div>
    </dl>
    {information?.plan || limits.length ? <section className="agent-native-information__limits" aria-label="Account limits">
      <h3>Account limits{information?.plan ? <strong title="Subscription plan">{information.plan.name}</strong> : null}</h3>
      {limits.map(limit => {
        const remaining = Math.max(0, 100 - limit.usedPercent)
        const name = limitName(limit), label = `${quotaPercent.format(remaining)}% remaining`
        const reset = limit.resetsAt === undefined ? undefined : new Date(limit.resetsAt)
        return <div className="agent-native-information__limit" key={limit.id}>
          <div><span>{name}</span><strong>{label}</strong></div>
          <progress max={100} value={remaining} aria-label={`${name}: ${label}`} />
          {reset ? <small>Resets <time dateTime={reset.toISOString()}>{reset.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></small> : null}
        </div>
      })}
    </section> : null}
    {missing.length ? <p className="agent-native-information__missing">{[...new Set(missing.map(item => {
      const field = item.field === 'limits' ? 'Account limits' : item.field === 'plan' ? 'Plan' : 'Model'
      return `${field} ${item.kind === 'unsupported' ? 'not provided' : item.kind === 'unavailable' ? 'unavailable' : 'unconfirmed'}`
    }))].join(' · ')}</p> : !information && !loading && !issue ? <p className="agent-native-information__missing">Native plan and account limits not reported.</p> : null}
    {issue ? <p className="agent-native-information__issue" role="status">{issue}{information ? ' Last confirmed values are shown.' : ''}</p> : null}
    <footer>
      <span>{observed ? <>{loading ? 'Refreshing account' : 'Account snapshot'} <time dateTime={observed.toISOString()} title={observed.toLocaleString()}>{sampleAge(observed.getTime(), now)}</time></>
        : loading ? 'Reading account…' : 'Account snapshot unavailable'}</span>
      {control ? <button type="button" className="agent-native-information__refresh" aria-disabled={loading} data-loading={loading}
        onClick={() => void refresh()} aria-label="Refresh Agent information" title={loading ? 'Reading account…' : 'Refresh account snapshot'}><RefreshIcon size={13} /></button> : null}
    </footer>
  </section>
}
