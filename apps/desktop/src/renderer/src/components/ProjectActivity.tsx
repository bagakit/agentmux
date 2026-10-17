import { useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { rowAttention } from '../lib/row-attention'
import * as Menu from './HoverDropdownMenu'
import { activityMetrics, ActivityMetrics } from './ProjectActivityMetrics'
import { ProjectActivityMenu } from './ProjectActivityMenu'

/** Closed navigation consumes only this scope's status facts, never detailed Agent content. */
export function ProjectActivity({ sessions, compact = false, visible = true }: {
  sessions: SessionSnapshot[]; compact?: boolean; visible?: boolean
}) {
  const [open, setOpen] = useState(false)
  const agents = useMemo(() => sessions.filter(session => session.kind === 'agent'), [sessions])
  const metrics = activityMetrics(agents)
  if (!metrics.length) return null
  const label = metrics.map(metric => `${metric.count} ${metric.label}`).join(' · ')
  return <Menu.Root open={visible && open} onOpenChange={setOpen}>
    <Menu.Trigger className="project-activity" data-category={rowAttention(agents).category ?? 'active'}
      title={`Agent activity · ${label}`} aria-label={`${label}. Agent activity`}>
      <ActivityMetrics sessions={agents} compact={compact} />
    </Menu.Trigger>
    {visible && open ? <ProjectActivityMenu sessions={agents} onNavigate={() => setOpen(false)} /> : null}
  </Menu.Root>
}
