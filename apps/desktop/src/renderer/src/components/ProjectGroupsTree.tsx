import { HostBadge } from './HostBadge'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import type { AgentMuxProjectGroupFact } from '@agentmux/core/control'
import type { WorkspaceProject } from '../lib/workspace-projects'
import { projectGroupMember } from '../lib/cross-device-project-groups'
import { matchesSpaceQuery } from '../lib/space-tree-navigation'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { folderSpaceIconTarget } from '../lib/space-object-appearance'
import { useDirectorySessions } from '../lib/workbench-session-subscriptions'
import { folderLastActivityAt } from '../lib/space-folder-icon-recency'
import { ProjectActivity } from './ProjectActivity'
import { activityContextsForWorkspaces } from '../lib/activity-groups'
import { SpaceDisclosure, SpaceSectionHeader } from './SpaceSectionHeader'

const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeActionUnlinkIcon = semanticIconComponent('action.unlink')
const ThemeObjectFolderIcon = semanticIconComponent('object.folder')


export function ProjectGroupsTree({ projects, query, activeProjectId, onCreate, onEdit, onDissolve, visible }: {
  visible: boolean
  projects: readonly WorkspaceProject[]
  query: string
  activeProjectId: string | null
  onCreate(): void
  onEdit(group: AgentMuxProjectGroupFact): void
  onDissolve(group: AgentMuxProjectGroupFact): void
}) {
  const icons = useAppStore(state => state.spaceObjectIcons)
  const groups = useAppStore(state => state.projectGroups)
  const collapsed = useAppStore(state => state.collapsedProjectGroups)
  const toggle = useAppStore(state => state.toggleProjectGroup)
  const select = useAppStore(state => state.selectWorkspace)
  const hosts = useAppStore(state => state.config?.hosts)
  const mainSurface = useAppStore(state => state.mainSurface)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const memberWorkspace = (project: WorkspaceProject) => project.workspaces.some(workspace => workspace.id === activeWorkspaceId)
    ? activeWorkspaceId! : project.preferredWorkspaceId
  const displayPath = usePathDisplay()
  const filtering = Boolean(query.trim()), sectionCollapsed = !filtering && collapsed['space:project-groups'] === true
  if (!groups.length) return null
  return <nav className="project-list project-groups" aria-label="Project groups">
    <SpaceSectionHeader label="Project groups" count={groups.length} icon={<ThemeObjectLinkIcon size={14} />}
      expanded={!sectionCollapsed} filtering={filtering} onToggle={() => toggle('space:project-groups')}
      createLabel="Create project group" onCreate={async () => onCreate()} />
    {sectionCollapsed ? null : groups.map(group => {
      const members = group.projectIds.map(id => ({ id, ...projectGroupMember(id, projects) }))
      const shown = filtering ? members.filter(member => matchesSpaceQuery(query, group.name, member.name, member.path,
        hosts?.find(host => host.id === member.hostId)?.label, member.hostId ?? undefined)) : members
      if (!shown.length) return null
      const key = `project-group:${group.groupId}`, folded = !filtering && collapsed[key] === true
      const active = group.projectIds.includes(activeProjectId ?? '') && mainSurface === 'workbench'
      const depth = { '--rail-depth': 1 } as CSSProperties
      return <div key={group.groupId} className="project-group" data-project-group={group.groupId}>
        <div className="project-rail-row-shell project-group__heading" style={depth} data-space-entry>
          <SpaceDisclosure icon={<ThemeObjectLinkIcon size={13} />} expanded={!folded} label={`${folded ? 'Expand' : 'Collapse'} ${group.name}`}
            disabled={filtering} onToggle={() => toggle(key)} />
          <button type="button" className="project-rail-row project-rail-row--disclosure" title={`${group.name} · ${members.length} projects · Double-click to edit`}
            onDoubleClick={() => onEdit(group)}
            data-space-nav={key} data-space-parent="space:project groups" data-space-expanded={!folded}
            onClick={() => {
              const preferred = members.find(member => member.id === activeProjectId && member.project) ?? members.find(member => member.project)
              if (preferred?.project) void select(memberWorkspace(preferred.project))
              else if (folded) toggle(key)
            }}>
            <span className="project-rail-row__identity"><strong>{group.name}</strong></span><small className="project-group__count">{members.length}</small>
          </button>
          <GroupActivity projects={projects} projectIds={group.projectIds} visible={visible} />
          <span className="project-group__actions"><button type="button" className="icon-button" aria-label={`Edit ${group.name}`} title="Edit project group" onClick={() => onEdit(group)}><ThemeActionEditIcon size={12} /></button>
            <button type="button" className="icon-button" aria-label={`Dissolve ${group.name}`} title="Dissolve project group" onClick={() => onDissolve(group)}><ThemeActionUnlinkIcon size={12} /></button></span>
        </div>
        {folded ? null : shown.map(member => {
          const hostIdentity = hostIdentityProjection(member.hostId, hosts?.find(host => host.id === member.hostId))
          const hostLabel = hostIdentity.label
          const selected = active && member.id === activeProjectId
          const label = `${member.name} · ${hostLabel} · ${hostIdentity.id ?? 'Unknown Host'}${member.project ? '' : ' · Registration unavailable'}`
          const target = member.hostId ? folderSpaceIconTarget({ hostId: member.hostId, repoPath: member.path, name: member.name }) : null
          const manualIcon = target ? icons[target.key] ?? null : null
          return <MemberPresence key={member.id} project={member.project} visible={visible}>{(sessions, lastActivityAt, contexts) => <div className="project-group__member-shell">
          <button type="button" key={member.id} className={`project-rail-row project-group__member${selected ? ' project-rail-row--active' : ''}`}
            style={{ '--rail-depth': 2 } as CSSProperties} data-space-nav={`${key}:member:${member.id}`} data-space-parent={key}
            data-project-group-member={member.id} aria-label={label} aria-current={selected ? 'page' : undefined}
            title={`${member.name}\n${hostLabel}\n${displayPath(member.path, member.hostId ?? undefined)}${member.project ? '' : '\nRestore the original device or registration; this member is retained.'}`}
            aria-disabled={!member.project} onClick={() => { if (member.project) void select(memberWorkspace(member.project)) }}>
            {member.project || manualIcon ? <SpaceObjectIcon kind="folder" name={member.name} manualIcon={manualIcon}
              {...(member.project ? { workspaceId: member.project.preferredWorkspaceId } : {})} folderIdentityKey={target?.key}
              lastActivityAt={lastActivityAt} visible={visible} /> : <span className="project-rail-row__icon" aria-hidden="true" title="Project registration unavailable"><ThemeObjectFolderIcon size={14} /></span>}
            <span className="project-rail-row__identity"><strong>{member.name}</strong><small><HostBadge context="Host" host={hostIdentity} />{member.project ? '' : ' · Unavailable'}</small></span>
          </button>
          {sessions.some(session => session.kind === 'agent') ? <ProjectActivity compact visible={visible} sessions={sessions} contexts={contexts} /> : null}
          </div>}</MemberPresence>
        })}
      </div>
    })}
  </nav>
}

const NO_WORKSPACES: readonly WorkspaceRecord[] = []
function MemberPresence({ project, visible, children }: {
  project: WorkspaceProject | undefined
  visible: boolean
  children(sessions: SessionSnapshot[], lastActivityAt: number | null, contexts: ReturnType<typeof activityContextsForWorkspaces>): ReactNode
}) {
  const workspaces = project?.workspaces ?? NO_WORKSPACES
  const sessions = useDirectorySessions(workspaces, visible)
  const lastActivityAt = useMemo(() => folderLastActivityAt(sessions, Date.now()), [sessions])
  const contexts = useMemo(() => activityContextsForWorkspaces(workspaces), [workspaces])
  return children(sessions, lastActivityAt, contexts)
}

function GroupActivity({ projects, projectIds, visible }: { projects: readonly WorkspaceProject[]; projectIds: readonly string[]; visible: boolean }) {
  const workspaces = useMemo(() => projectIds.flatMap(id => projects.find(project => project.id === id)?.workspaces ?? []), [projects, projectIds])
  const sessions = useDirectorySessions(workspaces, visible)
  const contexts = useMemo(() => activityContextsForWorkspaces(workspaces), [workspaces])
  return sessions.some(session => session.kind === 'agent') ? <ProjectActivity compact visible={visible} sessions={sessions} contexts={contexts} /> : null
}
