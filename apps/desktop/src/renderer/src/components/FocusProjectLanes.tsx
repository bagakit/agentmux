import { HostBadge } from './HostBadge'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useEffect, useId, useMemo, useState, type ReactNode, type Ref, type ComponentProps, type SyntheticEvent, type CSSProperties } from 'react'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { focusProjectKey, type FocusProjectLane, type FocusRetainedProject } from '../lib/focus-project-lanes'
import { createFocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { ProjectIcon } from './ProjectIcon'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { formatRelativeAge } from '../lib/relative-age'
import type { FocusLaneOrigin } from '../lib/focus-lane-origin'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusLaneMetrics } from '../lib/focus-lane-layout'
import type { FocusReplyLines } from '../../../shared/focus-preferences'
import { FocusLaneGroups } from './FocusLaneGroups'
import { ResolvedAgentAvatar } from './AgentAvatar'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeObjectIdentifierIcon = semanticIconComponent('object.identifier')
const ThemeObjectBranchIcon = semanticIconComponent('object.branch')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const UNMEASURED_CARDS: FocusLaneMetrics = { width: 0, padding: 4, gap: 2, cardGap: 2 }


export function FocusProjectLanes({ lanes, selectedProjectKey, currentLaneId, onSelect, renderLane, rowsRef, recentProjects = [], onRead, visible = true, origins, leading, cardMetrics = UNMEASURED_CARDS, replyLines = 2 }: {
  leading?: ReactNode
  origins?: ReadonlyMap<string, FocusLaneOrigin>
  visible?: boolean
  rowsRef?: Ref<HTMLDivElement>
  lanes: readonly FocusProjectLane[]; selectedProjectKey: string
  currentLaneId?: string | null | undefined
  onSelect(projectKey: string): void; renderLane(lane: FocusProjectLane, heading: ReactNode): ReactNode
  recentProjects?: readonly FocusRetainedProject[]; onRead?(at: number): void
  cardMetrics?: FocusLaneMetrics; replyLines?: FocusReplyLines
}) {
  const displayPath = usePathDisplay()
  const icons = useAppStore(state => state.spaceObjectIcons)
  const hosts = useAppStore(state => state.config?.hosts)
  const descriptionId = useId()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [visible])
  return <section className="focus-project-lanes" aria-label="Focus context scan">
    <div className="focus-project-lanes__rows" ref={rowsRef}>
      {leading}
      {lanes.map(lane => <FocusLaneArticle name={lane.name} summary={lane.summary} visible={visible} className={`focus-project-lanes__row${selectedProjectKey === focusProjectKey(lane.hostId, lane.projectId) ? ' is-selected' : ''}`} data-focus-source={origins?.get(lane.id)?.kind} data-focus-current={currentLaneId === lane.id || undefined} data-project-id={lane.projectId} data-project-key={focusProjectKey(lane.hostId, lane.projectId)} data-lane-id={lane.id} data-recovery={lane.recovery ?? undefined} key={lane.id}>
        <div className="focus-project-lanes__track">{renderLane(lane,
        <span className="focus-project-lanes__heading">
          <FocusProjectOrigin origin={origins?.get(lane.id)} />
          <button type="button" className="focus-project-lanes__axis" aria-describedby={lane.summary ? descriptionId + lane.id : undefined} aria-current={currentLaneId === lane.id ? 'location' : undefined} aria-pressed={selectedProjectKey === focusProjectKey(lane.hostId, lane.projectId)} title={[`${lane.name} · ${lane.activeAgentIds.length} live`, hosts?.find(host => host.id === lane.hostId)?.label ?? lane.hostId, displayPath(lane.path, lane.hostId)].filter(Boolean).join('\n')} onClick={() => onSelect(focusProjectKey(lane.hostId, lane.projectId))}>
            {lane.objectKind === 'topic' || lane.objectKind === 'mote'
              ? <><SpaceObjectIcon kind={lane.objectKind} name={lane.labels.at(-1)!} topicGlyph manualIcon={lane.objectIconKey ? icons[lane.objectIconKey] ?? null : null} avatarWorkspaceId={lane.workspaceId} avatarTopicId={lane.topicId ?? undefined} avatarObjectKey={lane.objectIconKey} /><span className="focus-project-lanes__label"><strong>{lane.labels.at(-1)}</strong></span></>
              : <>{lane.projectWorkspaceId ? <ProjectIcon workspaceId={lane.projectWorkspaceId} name={lane.labels[0]!} /> : null}
                {lane.labels.map((label, index) => <span className="focus-project-lanes__label" key={index}>{index ? <ThemeNavigationDisclosureIcon size={10} /> : null}{index && lane.topicId && index === lane.labels.length - 1 ? <ThemeObjectIdentifierIcon size={11} /> : index ? <ThemeObjectBranchIcon size={11} /> : null}<strong>{label}</strong></span>)}</>}
            <HostBadge context="Host" compact host={hostIdentityProjection(lane.hostId, hosts?.find(host => host.id === lane.hostId))} />
          </button>
          {lane.summary ? <span id={descriptionId + lane.id} className="focus-project-lanes__summary">{lane.summary}</span> : null}
          <FocusProjectActivity at={lane.lastActivityAt ?? null} now={now} />
          {lane.recovery ? <span className="focus-project-lanes__recovery">{lane.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
        </span>
        )}</div>
      </FocusLaneArticle>)}
      {recentProjects.map(project => <article className="focus-project-lanes__row" data-project-id={project.projectId} data-project-key={project.key} data-observed-project="true" key={`observed:${project.key}`}>
        <FocusProjectObservation project={project} recent onRead={onRead} cardMetrics={cardMetrics} replyLines={replyLines} />
      </article>)}
    </div>
    {!leading && lanes.length === 0 && recentProjects.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
  </section>
}

/** Inspect held Topic text without growing or repacking the original lane. */
function FocusLaneArticle({ name, summary, visible, children, ...props }: ComponentProps<'article'> & { name: string; summary: string | null; visible: boolean }) {
  const tooltip = useWorkbenchNameTooltip(name, summary ?? '', !visible || !summary, { placement: 'top-start', pointerPassThrough: true })
  const inspect = (event: SyntheticEvent<HTMLElement>) => {
    const heading = event.currentTarget.querySelector<HTMLElement>('.focus-project-lanes__heading')
    const target = event.target as Node
    if (!event.currentTarget.contains(target)) return
    // The Agent's own preview takes priority over its lane's background text.
    if (target !== event.currentTarget && !heading?.contains(target)) { tooltip.hide(); return }
    tooltip.showFor(heading ?? event.currentTarget)
  }
  return <article {...props} onMouseOver={inspect} onMouseLeave={tooltip.hide}
    onFocus={inspect} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) tooltip.hide()
    }}>{children}{tooltip.content}</article>
}

function FocusProjectOrigin({ origin }: { origin: FocusLaneOrigin | undefined }) {
  if (!origin || origin.kind === 'project') return null
  return <span className="focus-project-lanes__source" title={[origin.label, ...(origin.addresses.length ? origin.addresses : origin.locations)].join('\n')}>
    {origin.label}{origin.locations.length ? <span> · {origin.locations.join(' / ')}</span> : null}
  </span>
}

function FocusProjectActivity({ at, now }: { at: number | null; now: number }) {
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = useMemo(() => createFocusTimeFormatters(zone), [zone])
  return <span className="focus-project-lanes__activity" title={at === null ? 'Project task activity not recorded' : `Latest task activity across project Sessions · ${time.detailed(at)}`}>
    {at === null ? 'Activity unknown' : <>Active <time dateTime={new Date(at).toISOString()}>{formatRelativeAge(Math.max(now, Date.now()) - at, ' ago')}</time></>}
  </span>
}

const FocusProjectObservation = memo(function FocusProjectObservation({ project, recent = false, onRead, cardMetrics, replyLines, showCards = true }: {
  project: FocusRetainedProject; recent?: boolean; onRead: ((at: number) => void) | undefined
  cardMetrics: FocusLaneMetrics; replyLines: FocusReplyLines; showCards?: boolean
}) {
  const hosts = useAppStore(state => state.config?.hosts)
  const zone = useAppStore(state => state.focusTimelineRuler.timeZone)
  const time = useMemo(() => createFocusTimeFormatters(zone), [zone])
  const displayPath = usePathDisplay()
  const activity = project.lastActivityAt !== null && project.lastActivityAt > (project.lastFocusedAt ?? 0)
  const at = activity ? project.lastActivityAt : project.lastFocusedAt
  const status = project.state === 'retired' ? 'Closed source' : project.state === 'active' ? 'Stored source · No current Context' : 'Current status unknown'
  return <div className="focus-retained-projects__project"><button type="button" className="focus-retained-projects__row" data-retained-project={recent ? undefined : project.key} data-recent-project={recent ? project.key : undefined}
    aria-label={`View ${project.name} focus history`} disabled={at === null}
    title={[project.name, status, 'Observed project · Focus visits and task activity are separate', displayPath(project.identity.workspacePath, project.hostId), project.identity.branch, project.identity.topicId, at === null ? 'Focus time not recorded' : time.detailed(at)].filter(Boolean).join('\n')}
    onPointerDownCapture={event => {
      if (event.button !== 0) return
      event.stopPropagation(); event.preventDefault()
    }} onClick={() => { if (at !== null) onRead?.(at) }}>
    <span className="focus-retained-projects__identity">{recent ? <ThemeObjectHistoryIcon size={13} aria-hidden="true" /> : null}<strong>{project.name}</strong><HostBadge context="Host" host={hostIdentityProjection(project.hostId, hosts?.find(host => host.id === project.hostId))} /></span>
    <span className="focus-retained-projects__date">{activity ? 'Last active' : 'Last focused'} {at === null ? '· Time unknown' : <time dateTime={new Date(at).toISOString()}>{time.dateClock(at)}</time>}</span>
  </button>
    {showCards ? <FocusLaneGroups counts={[0, 0, 0, project.observations.length]} metrics={cardMetrics} replyLines={replyLines}>{layout =>
      <section className="focus-context-group" aria-label={`Saved tasks in ${project.name}`} style={{ '--focus-card-columns': layout.columns[3], '--focus-group-width': `${layout.widths[3]}px` } as CSSProperties}>
        <header className="focus-context-group__header" title={status}><strong>Saved</strong><span className="focus-context-group__count">{project.observations.length}</span></header>
        <div className="focus-context-group__cards" role="list">{project.observations.map(entry =>
          <FocusSavedTaskCard key={JSON.stringify([entry.identity!.hostId, entry.sessionId])} entry={entry} time={time} displayPath={displayPath} onRead={onRead} />
        )}</div>
      </section>
    }</FocusLaneGroups> : null}
  </div>
})

/** Original observations use the shared card geometry without subscribing to
 * current Agent state, mounting previews or inventing a control reference. */
const FocusSavedTaskCard = memo(function FocusSavedTaskCard({ entry, time, displayPath, onRead }: {
  entry: AgentFocusHistoryEntry; time: ReturnType<typeof createFocusTimeFormatters>
  displayPath: ReturnType<typeof usePathDisplay>; onRead: ((at: number) => void) | undefined
}) {
  const identity = entry.identity!
  const name = identity.name || entry.sessionId
  const dated = Number.isSafeInteger(entry.focusedAt) && entry.focusedAt > 0 && entry.focusedAt <= Date.now()
  const location = [identity.branch, identity.topicId].filter(Boolean).join(' / ')
  const Element = dated && onRead ? 'button' : 'div'
  return <div className="focus-context-card" role="listitem" data-saved-focus-session={entry.sessionId} data-saved-focus-host={identity.hostId}>
    <Element className="focus-context focus-context--card" type={Element === 'button' ? 'button' : undefined}
      aria-label={Element === 'button' ? `View ${name} saved focus history` : undefined}
      title={[`Saved observation · ${entry.sessionId}`, identity.hostId, displayPath(identity.workspacePath, identity.hostId), location, dated ? time.detailed(entry.focusedAt) : 'Focus time not recorded'].filter(Boolean).join('\n')}
      onPointerDown={event => { if (event.button === 0 && Element === 'button') event.preventDefault() }}
      onClick={Element === 'button' ? () => onRead?.(entry.focusedAt) : undefined}>
      <span className="focus-context__copy">
        <span className="focus-context__identity"><span className="focus-context__avatar" aria-hidden="true">
          {identity.providerId ? <ResolvedAgentAvatar label={name} providerId={identity.providerId} size={18} /> : <ThemeObjectHistoryIcon size={16} />}
        </span><strong>{name}</strong></span>
        {location ? <span className="focus-context__detail">{location}</span> : null}
        {dated ? <span className="focus-retained-projects__date">Last focused <time dateTime={new Date(entry.focusedAt).toISOString()}>{time.dateClock(entry.focusedAt)}</time></span> : null}
      </span>
    </Element>
  </div>
})

/** A lightweight view of the original focus observations, not another lane or
 * Session directory. Unknown spatial/control facts remain absent. */
export function FocusRetainedProjects({ projects, total, onRead, cardMetrics = UNMEASURED_CARDS, replyLines = 2 }: {
  projects: readonly FocusRetainedProject[]; total: number; onRead(at: number): void
  cardMetrics?: FocusLaneMetrics; replyLines?: FocusReplyLines
}) {
  const [expanded, setExpanded] = useState(false)
  if (!total) return null
  return <section className="focus-retained-projects" aria-label="Retained project observations">
    <button type="button" className="focus-retained-projects__toggle" aria-label="Retained projects" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <ThemeNavigationDisclosureIcon size={12} aria-hidden="true" /><ThemeObjectHistoryIcon size={13} aria-hidden="true" /><span>Past projects</span>
      <span className="focus-retained-projects__count">{projects.length === total ? total : `${projects.length} of ${total}`}</span>
    </button>
    <div className="focus-retained-projects__rows" hidden={!expanded}>
      {projects.map(project => <FocusProjectObservation key={project.key} project={project} onRead={onRead} cardMetrics={cardMetrics} replyLines={replyLines} showCards={expanded} />)}
      {projects.length === 0 ? <p className="focus-project-lanes__empty">No matching historical projects</p> : null}
    </div>
  </section>
}
