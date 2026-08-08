import { MessageCircle, TriangleAlert } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { rowAttention } from '../lib/row-attention'
import { workingAgentCount } from '../lib/project-board'
import { buildAgentRoster } from '../lib/agent-roster'
import {
  buildActivityGroups,
  type ActivityContextInput,
  type ActivityGroup
} from '../lib/activity-groups'
import { useAppStore } from '../store'
import * as DropdownMenu from './HoverDropdownMenu'
import { AgentProviderIcon } from './AgentProviderIcon'

function quietDuration(observedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - observedAt) / 1000))
  if (seconds < 60) return `${seconds}s idle`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m idle`
  return `${Math.floor(minutes / 60)}h idle`
}

export function projectSessionReason(session: SessionSnapshot): string {
  if (session.kind !== 'agent') return session.status.state
  const request = session.pendingInteraction
  if (request) return request.kind === 'permission' ? request.title : request.questions.map((q) => q.prompt).join(' · ')
  if (session.status.detail) return session.status.detail
  if (session.status.state === 'waiting') return 'Waiting for your reply in the terminal'
  if (session.status.state === 'error') return 'Agent reported an error; open the terminal for details'
  return session.status.state
}

function groupSummary(group: ActivityGroup): string {
  const session = group.sessions[0]
  return session ? projectSessionReason(session) : 'No recent activity'
}

function groupState(group: ActivityGroup): string {
  const attention = rowAttention(group.sessions)
  if (attention.category === 'needs-you') return 'Needs you'
  if (attention.category === 'error') return 'Error'
  const running = workingAgentCount(group.sessions)
  if (running > 0) return `${running} running`
  return group.sessions[0]?.status.state ?? 'idle'
}

export function ProjectActivity({
  sessions,
  contexts = []
}: {
  sessions: SessionSnapshot[]
  contexts?: readonly ActivityContextInput[]
}) {
  const selectSession = useAppStore((state) => state.selectSession)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const attention = rowAttention(sessions)
  const running = workingAgentCount(sessions)
  if (!attention.category && !running) return null
  const label = attention.category === 'needs-you' ? 'Needs you' : attention.category === 'error' ? 'Error' : `${running} running`
  const groups = buildActivityGroups(sessions, contexts)
  const details = groups.map((group) => `${group.label}: ${groupSummary(group)}`).join('\n')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger className="project-activity" data-category={attention.category ?? 'active'} title={details} aria-label={`${label}. ${details}`}>
      {attention.category === 'needs-you' ? <MessageCircle size={13} /> : attention.category === 'error' ? <TriangleAlert size={13} /> : <span className="project-activity__pulse" aria-hidden="true"><i /><i /><i /></span>}
      <span>{label}</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu project-activity-menu" side="right" align="start" sideOffset={4}>
      <DropdownMenu.Label className="composer-menu__hint">Activity by work line · select to open</DropdownMenu.Label>
      {groups.map((group) => {
        const first = group.sessions[0]
        if (!first) return null
        const rosterRows = buildAgentRoster({ sessions: group.sessions, providerCatalog })
        return <details key={group.key} className="project-activity-group" open={groups.length === 1}>
          <summary className="project-activity-group__summary">
            <span className="project-activity-group__identity">
              <strong>{group.label}</strong>
              <small>{groupState(group)} · {groupSummary(group)}</small>
            </span>
            <span className="project-activity-group__avatars" aria-label={`${group.sessions.length} agents`}>
              {rosterRows.slice(0, 3).map((row) => <AgentProviderIcon key={row.sessionId} providerId={row.providerId} size={14} />)}
              {rosterRows.length > 3 ? <em>+{rosterRows.length - 3}</em> : null}
            </span>
          </summary>
          <div className="project-activity-group__details">
            {rosterRows.map((row) => {
              const session = group.sessions.find((item) => item.id === row.sessionId)!
              return <DropdownMenu.Item key={row.sessionId} className="tab-context-menu__item project-activity-menu__item"
                onSelect={() => selectSession(row.sessionId)}><AgentProviderIcon providerId={session.providerId} size={13} /><span><strong>{row.label}</strong><small>{projectSessionReason(session)} · {session.status.state === 'working' ? 'active now' : quietDuration(session.status.observedAt)}</small></span></DropdownMenu.Item>
            })}
          </div>
        </details>
      })}
      {attention.category ? <div className="composer-menu__hint">Pending requests remain here until answered.</div> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
