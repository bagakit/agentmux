import { memo, useMemo, useState } from 'react'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { agentRegionExecution, useAppStore } from '../store'
import { retainedFocusContext } from '../lib/focus-context'
import type { GoalTeamIdentity } from '../lib/goal-team'
import type { GoalAgentRole } from '../lib/goal-agent-selection'
import type { IdentityRead } from '../lib/use-collaboration-identities'
import { AgentContextContent } from './AgentContextContent'
import { AgentSessionReadingSurface } from './AgentSessionReadingSurface'

const sourceLabels = { create: 'Original requester', discussion: 'Original discussion', requirements: 'Requirements discussion',
  execution: 'Execution', continuation: 'Original continuation', 'delegation-owner': 'Delegation owner', 'delegation-worker': 'Delegated work',
  'execution-progress': 'Execution progress', 'execution-handoff': 'Execution handoff', 'planned-executor': 'Planned executor', supervisor: 'Supervisor notice',
  assignee: 'Executor', related: 'Related' }
const roleNames = { supervisor: 'Supervisor', assignees: 'Executor', related: 'Related' }
export const goalTeamSourceLabels = (identity: GoalTeamIdentity) => [...new Set(identity.roles.flatMap(role =>
  role === 'supervisor' && identity.currentSupervisor ? [] : [sourceLabels[role]]))]

/** Known retained identity content has no current control. Reading is an exact
 * original-source action; a missing Run never creates a substitute Session. */
export const GoalTeamReference = memo(function GoalTeamReference({ identity, read, roles, onRetry }: {
  identity: GoalTeamIdentity; read: IdentityRead | undefined
  roles: readonly GoalAgentRole[]; onRetry(): void
}) {
  const source = read?.source, { subject } = identity
  const originalName = useAppStore(state => {
    const location = source?.history?.creation?.spatialIntent
    return location && agentRegionExecution({ tabId: location.tabId, regionId: location.regionId, agentSessionId: subject.agentSessionId })?.hostId === subject.hostId
      ? state.agentNames[subject.agentSessionId] : undefined
  })
  const name = originalName ?? (source?.history?.providerId ? `${agentProviderLabel(source.history.providerId)} session` : 'Original Agent reference')
  const context = useMemo(() => source ? retainedFocusContext(source, name) : undefined, [source, name])
  const [reading, setReading] = useState<HTMLElement | null>(null)
  return <div className="goal-team__retained" data-goal-team-identity={JSON.stringify([subject.hostId, subject.agentSessionId])}>
    <div className="goal-team__roles">{roles.length ? roles.map(role => <span key={role} data-goal-team-role={role}>{roleNames[role]}</span>)
      : goalTeamSourceLabels(identity).map(label => <span key={label}>{label}</span>)}</div>
    {context ? <div className="goal-team__retained-content"><AgentContextContent context={context} presentation="card" /></div>
      : <div><strong>{name}</strong><p className="goals-caption">{read?.loading ? 'Reading its original identity…' : 'Original metadata is not yet confirmed.'}</p></div>}
    <p className="goal-team__source" title={`${subject.hostId}${source?.history?.workspacePath ? ` · ${source.history.workspacePath}` : ''}`}>{subject.hostId}{source?.history?.workspacePath ? ` · ${source.history.workspacePath}` : ''}</p>
    <div className="goal-team__reference-actions">
      {source?.history && source.state !== 'deleted' ? <button type="button" className="small-button" onClick={event => setReading(event.currentTarget)}>Read original conversation</button> : null}
      <details className="goal-team__identity-details"><summary>Reference details</summary><dl>
        <div><dt>Session</dt><dd><code>{subject.agentSessionId}</code></dd></div><div><dt>Host</dt><dd>{subject.hostId}</dd></div>
        {source?.history ? <><div><dt>Agent configuration</dt><dd>{source.history.executorId}</dd></div>
          <div><dt>Original workspace</dt><dd>{source.history.workspacePath}</dd></div>
          {source.history.nativeHandle ? <div><dt>Native conversation</dt><dd><code>{source.history.nativeHandle.sessionId}</code></dd></div> : null}</> : null}
      </dl></details>
    </div>
    {read?.issue ? <div className="goals-service" role="status"><span>{read.issue}</span><button type="button" className="small-button" onClick={onRetry}>Read original identity again</button></div> : null}
    {reading ? <AgentSessionReadingSurface source={subject} label={name} returnTrigger={reading} onClose={() => setReading(null)} /> : null}
  </div>
})
