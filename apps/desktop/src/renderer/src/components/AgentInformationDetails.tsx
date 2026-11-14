import { SemanticIcon } from '@agentmux/client-ui/icons'
import { SelectionIndicator } from '@agentmux/client-ui/components/SelectionIndicator'
import { useId, type ReactNode } from 'react'
import type { AgentContextWindowUsage, AgentTurnUsage } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { FocusContext } from '../lib/focus-context'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import { contextUsedPercent, formatTokenCount } from '../lib/agent-usage'
import { AgentUsageDetails } from './AgentUsageDetails'
import { AgentGoalRelationships } from './FocusGoalLinks'
import { AgentCommunicationRelations } from './AgentCommunicationRelations'

export type AgentInformationTab = 'usage' | 'goals' | 'messages' | 'source'
const tabs = [['usage', 'Usage'], ['goals', 'Goals'], ['messages', 'Messages'], ['source', 'Source']] as const

/** Compact held metrics; no observation or message read is started for this chrome. */
export function AgentInformationSummary({ usage, contextWindowUsage, goalLinks, descriptionId }: { descriptionId: string; usage?: AgentTurnUsage | undefined; contextWindowUsage?: AgentContextWindowUsage | undefined; goalLinks?: FocusGoalLinks | undefined }) {
  const used = contextUsedPercent(contextWindowUsage ?? usage?.context)
  const context = used === null ? 'Context remaining not reported' : `${100 - used}% context remaining`
  const tokens = usage?.cumulative ? `${formatTokenCount(usage.cumulative.totalTokens)} native Session tokens` : 'Cumulative tokens not reported'
  return <>
    <span id={descriptionId} className="agent-information-summary-description">{context} · {tokens}{goalLinks?.confirmedCount ? ` · ${goalLinks.confirmedCount} confirmed Goals` : ''}</span>
    <span className="agent-information-metric" title={context} aria-label={context}><SemanticIcon name="object.context" size={13} /><span>{used === null ? '—' : `${100 - used}%`}</span></span>
    <span className="agent-information-metric" title={tokens} aria-label={tokens}><SemanticIcon name="object.performance" size={13} /><span>{usage?.cumulative ? formatTokenCount(usage.cumulative.totalTokens) : '—'}</span></span>
    {goalLinks?.confirmedCount ? <span className="agent-information-metric" title={`${goalLinks.confirmedCount} confirmed Goals`} aria-label={`${goalLinks.confirmedCount} confirmed Goals`}><SemanticIcon name="object.goal" size={13} /><span>{goalLinks.confirmedCount}</span></span> : null}
  </>
}

/** The caller owns exact identity and visibility. Only the selected message page reads. */
export function AgentInformationDetails({ context, goalLinks, usage, contextWindowUsage, control, tab, onTab, source }: {
  context: FocusContext; goalLinks?: FocusGoalLinks | undefined; usage?: AgentTurnUsage | undefined; contextWindowUsage?: AgentContextWindowUsage | undefined
  control?: AgentSessionControl | undefined; tab: AgentInformationTab; onTab(tab: AgentInformationTab): void
  source: ReactNode
}) {
  const id = useId()
  return <div className="agent-information-details">
    <nav className="agent-information-details__tabs" aria-label="Agent information">
      <SelectionIndicator />
      {tabs.map(([key, label]) => <button key={key} type="button" id={`${id}-${key}`} aria-controls={`${id}-body`}
        aria-current={tab === key ? 'page' : undefined} onClick={() => onTab(key)}>{label}</button>)}
    </nav>
    <section id={`${id}-body`} aria-labelledby={`${id}-${tab}`}>
      {tab === 'usage' ? <AgentUsageDetails usage={usage} contextWindowUsage={contextWindowUsage} /> : null}
      {tab === 'goals' ? goalLinks ? <AgentGoalRelationships links={goalLinks} /> : <p>No confirmed Goal links in this preview.</p> : null}
      {tab === 'messages' ? control ? <AgentCommunicationRelations key={JSON.stringify([control.hostId, control.agentSessionId, control.run.runId])} control={control} />
        : <p role="status">Original communication identity unavailable. Existing Agent content remains readable.</p> : null}
      {tab === 'source' ? source : null}
    </section>
  </div>
}
