import { HostBadge } from './HostBadge'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { ChevronRight, GitBranch, Hash, History } from 'lucide-react'
import { useMemo, useState, type ReactNode, type Ref } from 'react'
import { focusProjectKey, type FocusProjectLane, type FocusRetainedProject } from '../lib/focus-project-lanes'
import { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { ProjectIcon } from './ProjectIcon'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'

export function FocusProjectLanes({ lanes, selectedProjectKey, onSelect, renderLane, rowsRef }: {
  rowsRef?: Ref<HTMLDivElement>
  lanes: readonly FocusProjectLane[]; selectedProjectKey: string
  onSelect(projectKey: string): void; renderLane(lane: FocusProjectLane, heading: ReactNode): ReactNode
}) {
  const displayPath = usePathDisplay()
  const icons = useAppStore(state => state.spaceObjectIcons)
  const hosts = useAppStore(state => state.config?.hosts)
  return <section className="focus-project-lanes" aria-label="Project contexts">
    <div className="focus-project-lanes__rows" ref={rowsRef}>
      {lanes.map(lane => <article className={`focus-project-lanes__row${selectedProjectKey === focusProjectKey(lane.hostId, lane.projectId) ? ' is-selected' : ''}`} data-project-id={lane.projectId} data-project-key={focusProjectKey(lane.hostId, lane.projectId)} data-lane-id={lane.id} data-recovery={lane.recovery ?? undefined} key={lane.id}>
        <div className="focus-project-lanes__track">{renderLane(lane,
        <span className="focus-project-lanes__heading">
          <button type="button" className="focus-project-lanes__axis" aria-pressed={selectedProjectKey === focusProjectKey(lane.hostId, lane.projectId)} title={`${lane.name} · ${lane.activeAgentIds.length} live · ${displayPath(lane.path, lane.hostId)}`} onClick={() => onSelect(focusProjectKey(lane.hostId, lane.projectId))}>
            {lane.objectKind === 'topic' || lane.objectKind === 'mote'
              ? <><SpaceObjectIcon kind={lane.objectKind} name={lane.labels.at(-1)!} topicGlyph manualIcon={lane.objectIconKey ? icons[lane.objectIconKey] ?? null : null} avatarWorkspaceId={lane.workspaceId} avatarTopicId={lane.topicId ?? undefined} avatarObjectKey={lane.objectIconKey} /><span className="focus-project-lanes__label"><strong>{lane.labels.at(-1)}</strong></span></>
              : <>{lane.projectWorkspaceId ? <ProjectIcon workspaceId={lane.projectWorkspaceId} name={lane.labels[0]!} /> : null}
                {lane.labels.map((label, index) => <span className="focus-project-lanes__label" key={index}>{index ? <ChevronRight size={10} /> : null}{index && lane.topicId && index === lane.labels.length - 1 ? <Hash size={11} /> : index ? <GitBranch size={11} /> : null}<strong>{label}</strong></span>)}</>}
            <HostBadge context="Host" host={hostIdentityProjection(lane.hostId, hosts?.find(host => host.id === lane.hostId))} />
          </button>
          {lane.summary ? <span className="focus-project-lanes__summary" title={lane.summary}>{lane.summary}</span> : null}
          {lane.recovery ? <span className="focus-project-lanes__recovery">{lane.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
        </span>
        )}</div>
      </article>)}
    </div>
    {lanes.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
  </section>
}

/** A lightweight view of the original focus observations, not another lane or
 * Session directory. Unknown spatial/control facts remain absent. */
export function FocusRetainedProjects({ projects, total, onRead }: {
  projects: readonly FocusRetainedProject[]; total: number; onRead(project: FocusRetainedProject): void
}) {
  const [expanded, setExpanded] = useState(false)
  const hosts = useAppStore(state => state.config?.hosts)
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = useMemo(() => createFocusTimeFormatters(zone), [zone])
  const displayPath = usePathDisplay()
  if (!total) return null
  return <section className="focus-retained-projects" aria-label="Retained project observations">
    <button type="button" className="focus-retained-projects__toggle" aria-label="Retained projects" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={12} aria-hidden="true" /><History size={13} aria-hidden="true" /><span>Past projects</span>
      <span className="focus-retained-projects__count">{projects.length === total ? total : `${projects.length} of ${total}`}</span>
    </button>
    <div className="focus-retained-projects__rows" hidden={!expanded}>
      {projects.map(project => <button type="button" className="focus-retained-projects__row" data-retained-project={project.key} key={project.key}
        aria-label={`View ${project.name} focus history`} disabled={project.lastFocusedAt === null}
        title={[project.name, 'Observed project · Focus visits, not task activity', displayPath(project.identity.workspacePath, project.hostId), project.identity.branch, project.identity.topicId, project.lastFocusedAt === null ? 'Focus time not recorded' : time.detailed(project.lastFocusedAt)].filter(Boolean).join('\n')}
        onPointerDownCapture={event => {
          if (event.button !== 0) return
          // Like the Timeline window controls, this changes the viewport while
          // retaining the same pinned input and its native text selection.
          event.stopPropagation(); event.preventDefault()
        }} onClick={() => onRead(project)}>
        <span className="focus-retained-projects__identity"><strong>{project.name}</strong><HostBadge context="Host" host={hostIdentityProjection(project.hostId, hosts?.find(host => host.id === project.hostId))} /></span>
        <span className="focus-retained-projects__date">Last focused {project.lastFocusedAt === null ? '· Time unknown' : <time dateTime={new Date(project.lastFocusedAt).toISOString()}>{time.dateClock(project.lastFocusedAt)}</time>}</span>
      </button>)}
      {projects.length === 0 ? <p className="focus-project-lanes__empty">No matching historical projects</p> : null}
    </div>
  </section>
}
