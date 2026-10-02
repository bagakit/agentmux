import { Folder, Link2, Pencil, Unlink } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { AgentMuxProjectGroupFact } from '@agentmux/core/control'
import type { WorkspaceProject } from '../lib/workspace-projects'
import { projectGroupMember } from '../lib/cross-device-project-groups'
import { matchesSpaceQuery } from '../lib/space-tree-navigation'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import type { SessionSnapshot } from '../../../shared/contracts'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { folderSpaceIconTarget } from '../lib/space-object-appearance'
import { ProjectActivity } from './ProjectActivity'
import { activityContextsForWorkspaces } from '../lib/activity-groups'
import { SpaceDisclosure, SpaceSectionHeader } from './SpaceSectionHeader'

export function ProjectGroupsTree({ projects, query, activeProjectId, onCreate, onEdit, onDissolve, sessionsByProject, lastActivityByProject, visible }: {
  sessionsByProject: ReadonlyMap<string, SessionSnapshot[]>
  lastActivityByProject: ReadonlyMap<string, number | null>
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
    <SpaceSectionHeader label="Project groups" count={groups.length} icon={<Link2 size={14} />}
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
      const groupSessions = [...new Map(members.flatMap(member => sessionsByProject.get(member.id) ?? []).map(session => [session.id, session])).values()]
      return <div key={group.groupId} className="project-group" data-project-group={group.groupId}>
        <div className="project-rail-row-shell project-group__heading" style={depth} data-space-entry>
          <SpaceDisclosure icon={<Link2 size={13} />} expanded={!folded} label={`${folded ? 'Expand' : 'Collapse'} ${group.name}`}
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
          {groupSessions.some(session => session.kind === 'agent') ? <ProjectActivity compact sessions={groupSessions} contexts={activityContextsForWorkspaces(members.flatMap(member => member.project?.workspaces ?? []))} /> : null}
          <span className="project-group__actions"><button type="button" className="icon-button" aria-label={`Edit ${group.name}`} title="Edit project group" onClick={() => onEdit(group)}><Pencil size={12} /></button>
            <button type="button" className="icon-button" aria-label={`Dissolve ${group.name}`} title="Dissolve project group" onClick={() => onDissolve(group)}><Unlink size={12} /></button></span>
        </div>
        {folded ? null : shown.map(member => {
          const hostLabel = hosts?.find(host => host.id === member.hostId)?.label ?? member.hostId ?? 'Device unconfirmed'
          const selected = active && member.id === activeProjectId
          const label = `${member.name} · ${hostLabel}${member.project ? '' : ' · Registration unavailable'}`
          const target = member.hostId ? folderSpaceIconTarget({ hostId: member.hostId, repoPath: member.path, name: member.name }) : null
          const manualIcon = target ? icons[target.key] ?? null : null
          return <div key={member.id} className="project-group__member-shell">
          <button type="button" key={member.id} className={`project-rail-row project-group__member${selected ? ' project-rail-row--active' : ''}`}
            style={{ '--rail-depth': 2 } as CSSProperties} data-space-nav={`${key}:member:${member.id}`} data-space-parent={key}
            data-project-group-member={member.id} aria-label={label} aria-current={selected ? 'page' : undefined}
            title={`${member.name}\n${hostLabel}\n${displayPath(member.path, member.hostId ?? undefined)}${member.project ? '' : '\nRestore the original device or registration; this member is retained.'}`}
            aria-disabled={!member.project} onClick={() => { if (member.project) void select(memberWorkspace(member.project)) }}>
            {member.project || manualIcon ? <SpaceObjectIcon kind="folder" name={member.name} manualIcon={manualIcon}
              {...(member.project ? { workspaceId: member.project.preferredWorkspaceId } : {})} folderIdentityKey={target?.key}
              lastActivityAt={lastActivityByProject.get(member.id)} visible={visible} /> : <span className="project-rail-row__icon" aria-hidden="true" title="Project registration unavailable"><Folder size={14} /></span>}
            <span className="project-rail-row__identity"><strong>{member.name}</strong><small>{hostLabel}{member.project ? '' : ' · Unavailable'}</small></span>
          </button>
          {(sessionsByProject.get(member.id) ?? []).some(session => session.kind === 'agent') ? <ProjectActivity compact sessions={sessionsByProject.get(member.id)!} contexts={activityContextsForWorkspaces(member.project?.workspaces ?? [])} /> : null}
          </div>
        })}
      </div>
    })}
  </nav>
}
