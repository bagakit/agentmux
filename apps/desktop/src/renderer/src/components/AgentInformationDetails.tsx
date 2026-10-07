import { useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import { useAppStore } from '../store'
import { contextUsedPercent, formatTokenCount } from '../lib/agent-usage'
import { AgentUsageDetails } from './AgentUsageDetails'
import { AgentGoalRelationships } from './FocusGoalLinks'
import { AgentCommunicationRelations } from './AgentCommunicationRelations'

/** Shared disclosure over existing held Session facts. Closed sections add no readers. */
export function AgentInformationDetails({ context, goalLinks }: { context: FocusContext; goalLinks?: FocusGoalLinks | undefined }) {
  const session = useAppStore(state => state.sessions.find(session => session.kind === 'agent' && session.id === context.id &&
    session.hostId === context.hostId && session.control.run.runId === context.runId))
  const [connections, setConnections] = useState(false)
  const usage = session?.kind === 'agent' ? session.turnUsage : undefined, used = contextUsedPercent(usage?.context)
  const summary = [used === null ? 'Context unknown' : `${100 - used}% context left`,
    usage?.cumulative ? `${formatTokenCount(usage.cumulative.totalTokens)} Session tokens` : 'Session total unknown'].join(' · ')
  return <div className="agent-information-details">
    <details><summary>Usage <span>{summary}</span></summary><AgentUsageDetails usage={usage} /></details>
    <details onToggle={event => { if (event.target === event.currentTarget) setConnections(event.currentTarget.open) }}>
      <summary>Connections <span>{goalLinks ? `${goalLinks.confirmedCount} confirmed ${goalLinks.confirmedCount === 1 ? 'Goal' : 'Goals'}${goalLinks.items.some(goal => goal.unconfirmedRoles.length) ? ' · Possible links' : ''}` : 'Goals and messages'}</span></summary>
      {goalLinks ? <AgentGoalRelationships links={goalLinks} /> : null}
      {connections ? session?.kind === 'agent' ? <AgentCommunicationRelations key={JSON.stringify([session.control.hostId, session.control.agentSessionId, session.control.run.runId])} control={session.control} /> : <p role="status">Original communication identity unavailable. Existing Agent content remains readable.</p> : null}
    </details>
  </div>
}
