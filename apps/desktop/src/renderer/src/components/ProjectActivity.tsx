import { useMemo, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { rowAttention } from '../lib/row-attention'
import * as Menu from './HoverDropdownMenu'
import { activityMetrics, ActivityMetrics } from './ProjectActivityMetrics'
import { ProjectActivityMenu } from './ProjectActivityMenu'
import { SemanticIcon } from './semantic-icons'

/** Closed navigation consumes only this scope's status facts, never detailed Agent content. */
export function ProjectActivity({ sessions, compact = false, visible = true, avatarMarker = false }: {
  sessions: SessionSnapshot[]; compact?: boolean; visible?: boolean; avatarMarker?: boolean
}) {
  const [open, setOpen] = useState(false)
  const agents = useMemo(() => sessions.filter(session => session.kind === 'agent'), [sessions])
  const metrics = activityMetrics(agents)
  const primary = metrics[0]
  if (!primary) return null
  const label = metrics.map(metric => `${metric.count} ${metric.label}`).join(' · ')
  return <Menu.Root open={visible && open} onOpenChange={setOpen}>
    <Menu.Trigger className="project-activity" data-category={rowAttention(agents).category ?? 'active'}
      data-avatar-marker={avatarMarker || undefined}
      title={`Agent activity · ${label}`} aria-label={`${label}. Agent activity`}>
      {avatarMarker ? <span className={`project-activity__avatar-marker project-activity__metric--${primary.key}`} aria-hidden="true">
        <SemanticIcon name={primary.icon} size={10} />
      </span> : <ActivityMetrics sessions={agents} compact={compact} />}
    </Menu.Trigger>
    {visible && open ? <ProjectActivityMenu sessions={agents} onNavigate={() => setOpen(false)} /> : null}
  </Menu.Root>
}
