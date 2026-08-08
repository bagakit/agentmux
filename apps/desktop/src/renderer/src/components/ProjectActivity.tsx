import { ChevronRight, MessageCircle, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { rowAttention } from '../lib/row-attention'
import { workingAgentCount } from '../lib/project-board'
import { buildAgentRoster } from '../lib/agent-roster'
import {
  buildActivityGroups,
  ACTIVITY_CONTEXT_KIND_LABEL,
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
  if (!session) return 'No recent activity'
  const reason = projectSessionReason(session)
  if (reason !== session.status.state) return reason
  switch (session.status.state) {
    case 'starting': return 'Starting Agent'
    case 'running':
    case 'working': return 'Working · no recent summary'
    case 'waiting': return 'Waiting for your reply'
    case 'blocked': return 'Blocked · needs attention'
    case 'disconnected': return 'Connection lost'
    case 'done': return 'Turn complete'
    case 'exited': return 'Run exited'
    case 'error': return 'Agent reported an error'
  }
}

function groupState(group: ActivityGroup): string {
  const attention = rowAttention(group.sessions)
  if (attention.category === 'needs-you') return 'Needs you'
  if (attention.category === 'error') return 'Error'
  const running = workingAgentCount(group.sessions)
  if (running > 0) return `${running} running`
  return group.sessions[0]?.status.state ?? 'idle'
}

function contextLabel(group: ActivityGroup): string {
  if (group.kind === 'unassigned') return ACTIVITY_CONTEXT_KIND_LABEL.unassigned
  return `${ACTIVITY_CONTEXT_KIND_LABEL[group.kind]} · ${group.label}`
}

function contextMeta(group: ActivityGroup): string | null {
  const host = group.hostId && group.hostId !== 'local' ? group.hostId : null
  if (group.kind === 'unassigned') return host ? `Host · ${host}` : 'No Topic / Branch / Worktree binding'
  if (host) return `${host} · ${group.path ?? 'path unavailable'}`
  return group.path
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const attention = rowAttention(sessions)
  const running = workingAgentCount(sessions)
  if (!attention.category && !running) return null
  const label = attention.category === 'needs-you' ? 'Needs you' : attention.category === 'error' ? 'Error' : `${running} running`
  const groups = buildActivityGroups(sessions, contexts)
  const details = groups.map((group) => `${contextLabel(group)}: ${groupSummary(group)}`).join('\n')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger className="project-activity" data-category={attention.category ?? 'active'} title={details} aria-label={`${label}. ${details}`}>
      {attention.category === 'needs-you' ? <MessageCircle size={13} /> : attention.category === 'error' ? <TriangleAlert size={13} /> : <span className="project-activity__pulse" aria-hidden="true"><i /><i /><i /></span>}
      <span>{label}</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu project-activity-menu" side="right" align="start" sideOffset={4}>
      <DropdownMenu.Label className="composer-menu__hint">Activity by work line · select a row to open</DropdownMenu.Label>
      {groups.map((group) => {
        const first = group.sessions[0]
        if (!first) return null
        const rosterRows = buildAgentRoster({ sessions: group.sessions, providerCatalog })
        const expanded = expandedGroups[group.key] === true
        const meta = contextMeta(group)
        return <div key={group.key} className={`project-activity-group${expanded ? ' project-activity-group--expanded' : ''}`}>
          <div className="project-activity-group__header">
            <DropdownMenu.Item className="project-activity-group__summary"
              title={[contextLabel(group), group.path, group.hostId].filter(Boolean).join(' · ')}
              onSelect={() => selectSession(first.id)}>
            <span className="project-activity-group__identity">
              <strong>{contextLabel(group)}</strong>
              <small>{groupSummary(group)} · {groupState(group)}</small>
              {meta ? <em>{meta}</em> : null}
            </span>
            <span className="project-activity-group__avatars" aria-label={`${group.sessions.length} Agents in ${contextLabel(group)}`}>
              {rosterRows.slice(0, 3).map((row) => <span key={row.sessionId} title={`${row.label} · ${row.state}`}><AgentProviderIcon providerId={row.providerId} size={14} /></span>)}
              {rosterRows.length > 3 ? <em>+{rosterRows.length - 3}</em> : null}
            </span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="project-activity-group__disclosure"
              aria-label={`${expanded ? 'Hide' : 'Show'} Agents in ${contextLabel(group)}`}
              aria-expanded={expanded}
              onSelect={(event) => {
                event.preventDefault()
                setExpandedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))
              }}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </DropdownMenu.Item>
          </div>
          {expanded ? <div className="project-activity-group__details">
            {rosterRows.map((row) => {
              const session = group.sessions.find((item) => item.id === row.sessionId)!
              return <DropdownMenu.Item key={row.sessionId} className="tab-context-menu__item project-activity-menu__item"
                onSelect={() => selectSession(row.sessionId)}><AgentProviderIcon providerId={session.providerId} size={13} /><span><strong>{row.label}</strong><small>{projectSessionReason(session)} · {session.status.state === 'working' ? 'active now' : quietDuration(session.status.observedAt)}</small></span></DropdownMenu.Item>
            })}
          </div> : null}
        </div>
      })}
      {attention.category ? <div className="composer-menu__hint">Pending requests remain here until answered.</div> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
