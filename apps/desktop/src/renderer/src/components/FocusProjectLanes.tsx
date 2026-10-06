import { HostBadge } from './HostBadge'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useState, type ReactNode, type Ref } from 'react'
import { focusProjectKey, type FocusProjectLane, type FocusRetainedProject } from '../lib/focus-project-lanes'
import { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { ProjectIcon } from './ProjectIcon'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { formatRelativeAge } from '../lib/relative-age'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeObjectIdentifierIcon = semanticIconComponent('object.identifier')
const ThemeObjectBranchIcon = semanticIconComponent('object.branch')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')


export function FocusProjectLanes({ lanes, selectedProjectKey, currentLaneId, onSelect, renderLane, rowsRef, recentProjects = [], onRead, visible = true }: {
  visible?: boolean
  rowsRef?: Ref<HTMLDivElement>
  lanes: readonly FocusProjectLane[]; selectedProjectKey: string
  currentLaneId?: string | null | undefined
  onSelect(projectKey: string): void; renderLane(lane: FocusProjectLane, heading: ReactNode): ReactNode
  recentProjects?: readonly FocusRetainedProject[]; onRead?(project: FocusRetainedProject): void
}) {
  const displayPath = usePathDisplay()
  const icons = useAppStore(state => state.spaceObjectIcons)
  const hosts = useAppStore(state => state.config?.hosts)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [visible])
  return <section className="focus-project-lanes" aria-label="Project contexts">
    <div className="focus-project-lanes__rows" ref={rowsRef}>
      {lanes.map(lane => <article className={`focus-project-lanes__row${selectedProjectKey === focusProjectKey(lane.hostId, lane.projectId) ? ' is-selected' : ''}`} data-focus-current={currentLaneId === lane.id || undefined} data-project-id={lane.projectId} data-project-key={focusProjectKey(lane.hostId, lane.projectId)} data-lane-id={lane.id} data-recovery={lane.recovery ?? undefined} key={lane.id}>
        <div className="focus-project-lanes__track">{renderLane(lane,
        <span className="focus-project-lanes__heading">
          <button type="button" className="focus-project-lanes__axis" aria-current={currentLaneId === lane.id ? 'location' : undefined} aria-pressed={selectedProjectKey === focusProjectKey(lane.hostId, lane.projectId)} title={[`${lane.name} · ${lane.activeAgentIds.length} live`, hosts?.find(host => host.id === lane.hostId)?.label ?? lane.hostId, displayPath(lane.path, lane.hostId), lane.summary].filter(Boolean).join('\n')} onClick={() => onSelect(focusProjectKey(lane.hostId, lane.projectId))}>
            {lane.objectKind === 'topic' || lane.objectKind === 'mote'
              ? <><SpaceObjectIcon kind={lane.objectKind} name={lane.labels.at(-1)!} topicGlyph manualIcon={lane.objectIconKey ? icons[lane.objectIconKey] ?? null : null} avatarWorkspaceId={lane.workspaceId} avatarTopicId={lane.topicId ?? undefined} avatarObjectKey={lane.objectIconKey} /><span className="focus-project-lanes__label"><strong>{lane.labels.at(-1)}</strong></span></>
              : <>{lane.projectWorkspaceId ? <ProjectIcon workspaceId={lane.projectWorkspaceId} name={lane.labels[0]!} /> : null}
                {lane.labels.map((label, index) => <span className="focus-project-lanes__label" key={index}>{index ? <ThemeNavigationDisclosureIcon size={10} /> : null}{index && lane.topicId && index === lane.labels.length - 1 ? <ThemeObjectIdentifierIcon size={11} /> : index ? <ThemeObjectBranchIcon size={11} /> : null}<strong>{label}</strong></span>)}</>}
            <HostBadge context="Host" host={hostIdentityProjection(lane.hostId, hosts?.find(host => host.id === lane.hostId))} />
          </button>
          {lane.summary ? <span className="focus-project-lanes__summary" title={lane.summary}>{lane.summary}</span> : null}
          <FocusProjectActivity at={lane.lastActivityAt ?? null} now={now} />
          {lane.recovery ? <span className="focus-project-lanes__recovery">{lane.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
        </span>
        )}</div>
      </article>)}
      {recentProjects.map(project => <article className="focus-project-lanes__row" data-project-id={project.projectId} data-project-key={project.key} data-observed-project="true" key={`observed:${project.key}`}>
        <FocusProjectObservation project={project} recent onRead={item => onRead?.(item)} />
      </article>)}
    </div>
    {lanes.length === 0 && recentProjects.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
  </section>
}

function FocusProjectActivity({ at, now }: { at: number | null; now: number }) {
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = useMemo(() => createFocusTimeFormatters(zone), [zone])
  return <span className="focus-project-lanes__activity" title={at === null ? 'Project task activity not recorded' : `Latest task activity across project Sessions · ${time.detailed(at)}`}>
    {at === null ? 'Activity unknown' : <>Active <time dateTime={new Date(at).toISOString()}>{formatRelativeAge(Math.max(now, Date.now()) - at, ' ago')}</time></>}
  </span>
}

function FocusProjectObservation({ project, recent = false, onRead }: { project: FocusRetainedProject; recent?: boolean; onRead(project: FocusRetainedProject): void }) {
  const hosts = useAppStore(state => state.config?.hosts)
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = useMemo(() => createFocusTimeFormatters(zone), [zone])
  const displayPath = usePathDisplay()
  const activity = project.lastActivityAt !== null && project.lastActivityAt > (project.lastFocusedAt ?? 0)
  const at = activity ? project.lastActivityAt : project.lastFocusedAt
  const status = project.state === 'retired' ? 'Closed source' : project.state === 'active' ? 'Stored source · No current Context' : 'Current status unknown'
  return <button type="button" className="focus-retained-projects__row" data-retained-project={recent ? undefined : project.key} data-recent-project={recent ? project.key : undefined}
    aria-label={`View ${project.name} focus history`} disabled={at === null}
    title={[project.name, status, 'Observed project · Focus visits and task activity are separate', displayPath(project.identity.workspacePath, project.hostId), project.identity.branch, project.identity.topicId, at === null ? 'Focus time not recorded' : time.detailed(at)].filter(Boolean).join('\n')}
    onPointerDownCapture={event => {
      if (event.button !== 0) return
      event.stopPropagation(); event.preventDefault()
    }} onClick={() => onRead(project)}>
    <span className="focus-retained-projects__identity">{recent ? <ThemeObjectHistoryIcon size={13} aria-hidden="true" /> : null}<strong>{project.name}</strong><HostBadge context="Host" host={hostIdentityProjection(project.hostId, hosts?.find(host => host.id === project.hostId))} /></span>
    <span className="focus-retained-projects__date">{activity ? 'Last active' : 'Last focused'} {at === null ? '· Time unknown' : <time dateTime={new Date(at).toISOString()}>{time.dateClock(at)}</time>}</span>
    {recent ? <span className="focus-retained-projects__date">{status}</span> : null}
  </button>
}

/** A lightweight view of the original focus observations, not another lane or
 * Session directory. Unknown spatial/control facts remain absent. */
export function FocusRetainedProjects({ projects, total, onRead }: {
  projects: readonly FocusRetainedProject[]; total: number; onRead(project: FocusRetainedProject): void
}) {
  const [expanded, setExpanded] = useState(false)
  if (!total) return null
  return <section className="focus-retained-projects" aria-label="Retained project observations">
    <button type="button" className="focus-retained-projects__toggle" aria-label="Retained projects" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <ThemeNavigationDisclosureIcon size={12} aria-hidden="true" /><ThemeObjectHistoryIcon size={13} aria-hidden="true" /><span>Past projects</span>
      <span className="focus-retained-projects__count">{projects.length === total ? total : `${projects.length} of ${total}`}</span>
    </button>
    <div className="focus-retained-projects__rows" hidden={!expanded}>
      {projects.map(project => <FocusProjectObservation key={project.key} project={project} onRead={onRead} />)}
      {projects.length === 0 ? <p className="focus-project-lanes__empty">No matching historical projects</p> : null}
    </div>
  </section>
}
