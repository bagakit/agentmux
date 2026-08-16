import { ChevronRight, MessageCircle, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { AgentTimelineItem, AgentTimelineSnapshot, AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { sessionRecentActivity } from '../lib/session-recency'
import { projectActivityRow } from '../lib/project-activity-row'
import { rowAttention } from '../lib/row-attention'
import { workingAgentCount } from '../lib/project-board'
import { workspaceForSession, workspaceRootForPath } from '../lib/workbench-tabs'
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
import { SemanticIcon } from './semantic-icons'

/** 时间轴按需拉取，绝大多数 Session 此刻没有——统一退回这份空数组，让派生落到基于状态的答案。 */
const NO_TIMELINE: readonly AgentTimelineItem[] = []

function sessionReason(
  session: SessionSnapshot,
  timelines: Record<string, AgentTimelineSnapshot>,
  workspaceRoot?: string
): string {
  return sessionRecentActivity(session, timelines[session.id]?.items ?? NO_TIMELINE, workspaceRoot)
}

/**
 * 组标题那行近况。
 *
 * 也要传仓根：这一行落在 `.project-activity-group__identity small` 里，而那个选择器带
 * `text-overflow: ellipsis`（chrome.css）——CSS 的省略号永远吃尾巴，也就是路径的识别位。
 * 与下面菜单行同一个理由，此前漏了这一处。根取**包含**（路径落在哪个仓里）而不是归属：
 * 子目录终端不被任何 workspace 精确拥有，只有包含答得出。
 */
function groupSummary(
  group: ActivityGroup,
  timelines: Record<string, AgentTimelineSnapshot>,
  config: AppConfig | null
): string {
  const session = group.sessions[0]
  if (!session) return 'No recent activity'
  const reason = sessionReason(session, timelines, workspaceRootForPath(config, session))
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
  if (attention.category === 'needs-you' || attention.category === 'error') return ''
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
  const config = useAppStore((state) => state.config)
  const timelines = useAppStore((state) => state.timelines)
  const agentNames = useAppStore((state) => state.agentNames)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const attention = rowAttention(sessions)
  const running = workingAgentCount(sessions)
  if (!attention.category && !running) return null
  // 一次渲染取一次时钟，供各行算 elapsed——与旧 quietDuration 在渲染时读 Date.now() 同口径。
  const now = Date.now()
  const label = attention.category === 'needs-you' ? 'Needs you' : attention.category === 'error' ? 'Error' : `${running} running`
  const notificationCount = attention.category === 'error'
    ? sessions.filter((session) => session.status.state === 'error').length
    : attention.category === 'needs-you'
      ? sessions.filter((session) => session.kind === 'agent' && Boolean(session.pendingInteraction)).length
      : running
  const groups = buildActivityGroups(sessions, contexts)
  const details = groups.map((group) => `${contextLabel(group)}: ${groupSummary(group, timelines, config ?? null)}`).join('\n')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger className="project-activity" data-category={attention.category ?? 'active'} title={details} aria-label={`${label}. ${details}`}>
      {attention.category === 'needs-you' ? <MessageCircle size={13} /> : attention.category === 'error' ? <TriangleAlert size={13} /> : <span className="project-activity__pulse" aria-hidden="true"><i /><i /><i /></span>}
      <strong className="project-activity__count" aria-hidden="true">{notificationCount}</strong>
      <span className="project-activity__label">{label}</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu project-activity-menu" side="right" align="start" sideOffset={4}>
      <DropdownMenu.Label className="composer-menu__hint">Activity by work line · select a row to open</DropdownMenu.Label>
      {groups.map((group) => {
        const first = group.sessions[0]
        if (!first) return null
        const rosterRows = buildAgentRoster({ sessions: group.sessions, providerCatalog })
        const expanded = expandedGroups[group.key] === true
        // A single-Agent work line has no additional roster information to reveal;
        // its summary already opens the exact Session. Do not spend a column on a
        // dead disclosure affordance.
        const canExpand = group.sessions.length > 1 || Boolean((first.kind === 'agent' && first.pendingInteraction) || first.status.detail)
        const meta = contextMeta(group)
        const summary = groupSummary(group, timelines, config ?? null)
        const state = groupState(group)
        return <div key={group.key} className={`project-activity-group${expanded ? ' project-activity-group--expanded' : ''}`}>
          <div className="project-activity-group__header">
            <DropdownMenu.Item className="project-activity-group__summary"
              title={[contextLabel(group), group.path, group.hostId].filter(Boolean).join(' · ')}
              onSelect={() => selectSession(first.id)}>
            <span className="project-activity-group__identity">
              <strong>{contextLabel(group)}</strong>
              <small>{summary}{state ? ` · ${state}` : ''}</small>
              {meta ? <em>{meta}</em> : null}
            </span>
            <span className="project-activity-group__avatars" aria-label={`${group.sessions.length} Agents in ${contextLabel(group)}`}>
              {rosterRows.slice(0, 3).map((row) => <span key={row.sessionId} title={`${agentNames[row.sessionId] ?? row.label} · ${row.state}`}><AgentProviderIcon providerId={row.providerId} size={14} /></span>)}
              {rosterRows.length > 3 ? <em>+{rosterRows.length - 3}</em> : null}
            </span>
            </DropdownMenu.Item>
            {canExpand ? <DropdownMenu.Item
              className="project-activity-group__disclosure"
              aria-label={`${expanded ? 'Hide' : 'Show'} Agents in ${contextLabel(group)}`}
              aria-expanded={expanded}
              onSelect={(event) => {
                event.preventDefault()
                setExpandedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))
              }}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </DropdownMenu.Item> : null}
          </div>
          {expanded ? <div className="project-activity-group__details">
            {rosterRows.map((row) => {
              const session = group.sessions.find((item) => item.id === row.sessionId)!
              // 这一格归哪个 workspace：走共用谓词，不在这里再写一遍前缀匹配。此前这里是一段就地的
              // `path === w.path || startsWith(w.path + '/')`，与 workspaceForSession 是同一个问题的
              // 第二种拼法——两份迟早分岔（它还漏掉了 scratch 子目录那一支）。
              //
              // 显示的**名字**取归属（这一格属于哪个 Project），缩路径的**根**取包含（路径落在哪个
              // 仓里）——子目录终端只有后者答得出，是两个问题，故取两次。
              const workspace = session.kind === 'agent' ? workspaceForSession(config ?? null, session) : undefined
              const project = workspace?.name ?? (session.kind === 'agent' ? session.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) : 'Terminal')
              const activity = projectActivityRow(
                session,
                timelines[session.id]?.items ?? NO_TIMELINE,
                now,
                workspaceRootForPath(config ?? null, session)
              )
              return <DropdownMenu.Item key={row.sessionId} className="tab-context-menu__item project-activity-menu__item"
                data-attention={activity.attention ?? undefined}
                onSelect={() => selectSession(row.sessionId)}><SemanticIcon name={session.status.state === 'working' ? 'working' : session.status.state === 'running' ? 'running' : 'neutral'} size={13} /><span><strong>{agentNames[row.sessionId] ?? row.label}</strong><small><span className="project-activity-menu__reason">{activity.reason}</span>{activity.meta ? <span className="project-activity-menu__meta">{activity.meta}</span> : null}<span className="project-activity-menu__meta">{project} · {row.providerId}</span></small></span></DropdownMenu.Item>
            })}
          </div> : null}
        </div>
      })}
      {attention.category ? <div className="composer-menu__hint">Pending requests remain here until answered.</div> : null}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}
