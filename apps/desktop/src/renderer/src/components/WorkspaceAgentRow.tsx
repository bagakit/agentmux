import { memo, useCallback, useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks as GoalLinks } from '../lib/focus-goal-links'
import { CONTEXT_PRESSURE_HINT, contextPressure } from '../lib/agent-usage'
import { AgentContextContent } from './AgentContextContent'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { FocusGoalLinks, FocusGoalMark } from './FocusGoalLinks'

/** Workspace navigation stays local; the Agent face, identity and reading disclosure are shared. */
export const WorkspaceAgentRow = memo(function WorkspaceAgentRow({ context, identity, goalLinks, percent, onOpen }: {
  context: FocusContext; identity?: FocusContextIdentity | undefined; goalLinks?: GoalLinks | undefined
  percent: number | null; onOpen(id: string): void
}) {
  const [goalOpen, setGoalOpen] = useState(false)
  const preview = useAgentInformationPreview(context, !goalOpen, identity, goalLinks, () => onOpen(context.id))
  const disclosure = useCallback((open: boolean) => { preview.close(); setGoalOpen(open) }, [preview.close])
  const pressure = contextPressure(percent)
  const metadata = <span className="workspace-agent-row__metadata">
    {pressure ? <span className="agent-roster__pressure" data-pressure={pressure} title={`Context window ${percent}% full — ${CONTEXT_PRESSURE_HINT[pressure]}`}>{percent}%</span> : null}
    {context.lastActivityAt === null ? <span title="Activity time unknown">—</span> : <time dateTime={new Date(context.lastActivityAt).toISOString()} title={`Last active ${new Date(context.lastActivityAt).toLocaleString()}`}>{new Date(context.lastActivityAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>}
  </span>
  return <><div className="workspace-agent-card focus-context-card">
    <button ref={preview.anchor} type="button" className="workspace-agent-row focus-context focus-context--card" data-session-id={context.id} data-state={context.state} data-bucket={context.bucket}
      aria-label={`${context.name} · ${context.stateLabel} · Open in Space`} aria-description={context.originAddress} aria-describedby={preview.describedBy} {...preview.triggerEvents}
      onClick={() => { preview.close(); onOpen(context.id) }}>
      <AgentContextContent context={context} identity={preview.position} presentation="card" metadata={metadata}
        headingAccessory={goalLinks ? <span className="focus-goal__space" aria-hidden="true"><FocusGoalMark links={goalLinks} /></span> : undefined} />
    </button>
    {goalLinks ? <FocusGoalLinks links={goalLinks} onOpenChange={disclosure} /> : null}
  </div></>
})
