import { MessageCircle, TriangleAlert } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { rowAttention } from '../lib/row-attention'
import { workingAgentCount } from '../lib/project-board'
import { buildAgentRoster } from '../lib/agent-roster'
import { useAppStore } from '../store'
import * as DropdownMenu from './HoverDropdownMenu'

export function projectSessionReason(session: SessionSnapshot): string {
  if (session.kind !== 'agent') return session.status.state
  const request = session.pendingInteraction
  if (request) return request.kind === 'permission' ? request.title : request.questions.map((q) => q.prompt).join(' · ')
  if (session.status.detail) return session.status.detail
  if (session.status.state === 'waiting') return 'Waiting for your reply in the terminal'
  if (session.status.state === 'error') return 'Agent reported an error; open the terminal for details'
  return session.status.state
}

export function ProjectActivity({ sessions }: { sessions: SessionSnapshot[] }) {
  const selectSession = useAppStore((state) => state.selectSession)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const attention = rowAttention(sessions)
  const running = workingAgentCount(sessions)
  if (!attention.category && !running) return null
  const label = attention.category === 'needs-you' ? 'Needs you' : attention.category === 'error' ? 'Error' : `${running} running`
  const rows = buildAgentRoster({ sessions, providerCatalog })
  const details = rows.map((row) => `${row.label}: ${projectSessionReason(sessions.find((session) => session.id === row.sessionId)!)}`).join('\n')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger className="project-activity" data-category={attention.category ?? 'active'} title={details} aria-label={`${label}. ${details}`}>
      {attention.category === 'needs-you' ? <MessageCircle size={13} /> : attention.category === 'error' ? <TriangleAlert size={13} /> : <span className="project-activity__pulse" aria-hidden="true"><i /><i /><i /></span>}
      <span>{label}</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu project-activity-menu" side="right" align="start" sideOffset={4}>
      <DropdownMenu.Label className="composer-menu__hint">Agent activity · select to open</DropdownMenu.Label>
      {rows.map((row) => <DropdownMenu.Item key={row.sessionId} className="tab-context-menu__item project-activity-menu__item"
        onSelect={() => selectSession(row.sessionId)}><span><strong>{row.label}</strong><small>{projectSessionReason(sessions.find((session) => session.id === row.sessionId)!)}</small></span></DropdownMenu.Item>)}
      {attention.category ? <div className="composer-menu__hint">Pending requests remain here until answered.</div> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
