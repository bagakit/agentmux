import { HostBadge } from './HostBadge'
import { FocusLaneHeadingMenu } from './FocusLaneHeadingMenu'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref, type ComponentProps, type SyntheticEvent, type CSSProperties } from 'react'
import type { TopicCategory } from '@agentmux/core/control'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { focusProjectKey, focusLaneProjectKey, type FocusRetainedProject } from '../lib/focus-project-lanes'
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
import { focusCollectionTopicCount, focusScanPreferenceKey, type FocusScanLane } from '../lib/focus-collection-lanes'
import { categorySpaceIconTarget, type SpaceIconOverrides, type SpaceIconTarget } from '../lib/space-object-appearance'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { TopicCategoryDialog } from './TopicCategoryDialog'
import { SpaceIconPicker } from './SpaceIconPicker'
import { FocusZoneLayoutToggle } from './FocusZoneLayoutToggle'
import { FocusProjectPreferences, type FocusDiscussionSlot } from './FocusProjectPreferences'
import { FocusProjectActions } from './FocusProjectActions'
import { focusZoneContainerKey, focusZonePresentation } from '../../../shared/focus-zone-presentation'
import { focusProjectPreference, focusProjectTint, moveFocusProject, type FocusProjectPreference } from '../../../shared/focus-project-preferences'
import { saveFocusPreferences } from '../lib/focus-preferences'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { WorkspaceRowContextMenu } from './WorkspaceRowContextMenu'
import { folderSpaceIconTarget } from '../lib/space-object-appearance'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeObjectBranchIcon = semanticIconComponent('object.branch')
const CollectionIcon = semanticIconComponent('object.folder')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const UNMEASURED_CARDS: FocusLaneMetrics = { width: 0, padding: 4, gap: 2, cardGap: 2 }
type ProjectChange = { kind: 'move'; key: string; target: string; after: boolean } | { kind: 'visibility'; key: string; collapsed: boolean }
function applyProjectChange(original: readonly FocusProjectPreference[], change: ProjectChange) {
  if (change.kind === 'move') {
    if (![change.key, change.target].every(key => original.some(item => item.key === key && item.pinned))) throw Error('A pinned group changed. Review the current settings before retrying this move.')
    return moveFocusProject(original, change.key, change.target, change.after)
  }
  const current = focusProjectPreference(change.key, original)
  return original.some(item => item.key === change.key) ? original.map(item => item.key === change.key ? { ...item, collapsed: change.collapsed } : item)
    : [...original, { ...current, collapsed: change.collapsed }]
}

function collectionCountLabel(lane: FocusScanLane) {
  const topics = focusCollectionTopicCount(lane), agents = lane.contextRefs.length
  return `${topics} ${topics === 1 ? 'Topic' : 'Topics'} · ${agents} ${agents === 1 ? 'Agent' : 'Agents'}`
}

function FocusCollectionHeadingIcon({ lane, icons, resourceMenus }: { lane: FocusScanLane; icons: SpaceIconOverrides; resourceMenus: boolean }) {
  // Static examples never consume real saved assets, even when their IDs collide.
  const category = resourceMenus && lane.collection?.confirmed && lane.collection.categories.length === 1 ? lane.collection.categories[0] : undefined
  const target = category ? categorySpaceIconTarget(category) : null
  const manual = target ? icons[target.key] ?? null : null
  if (!target || manual === null) return <CollectionIcon size={14} aria-hidden="true" />
  // A saved preset needs no asset lookup. Never probe automatic appearance for a heading.
  const selectedImage = typeof manual === 'object' && (manual.kind === 'image' || manual.kind === 'series')
  return <SpaceObjectIcon kind="category" name={target.name} manualIcon={manual} imageTarget={selectedImage ? target.imageTarget : undefined} />
}


export function FocusProjectLanes({ lanes, selectedProjectKey, currentLaneId, revealRequestId, onSelect, renderLane, rowsRef, recentProjects = [], onRead, visible = true, origins, leading, cardMetrics = UNMEASURED_CARDS, replyLines = 2, resourceMenus = false, quietLanes, protectedLanes, forceExpanded = false, revealedLaneIds, renderDiscussion }: {
  quietLanes?: ReadonlySet<string>; protectedLanes?: ReadonlySet<string>; forceExpanded?: boolean; revealedLaneIds?: ReadonlySet<string>
  /** Only a real resource consumer opts in; Settings examples remain static. */
  resourceMenus?: boolean
  renderDiscussion?(lane: FocusScanLane, state: FocusDiscussionSlot): ReactNode
  leading?: ReactNode
  origins?: ReadonlyMap<string, FocusLaneOrigin>
  visible?: boolean
  rowsRef?: Ref<HTMLDivElement>
  lanes: readonly FocusScanLane[]; selectedProjectKey: string
  currentLaneId?: string | null | undefined
  revealRequestId?: string | undefined
  onSelect(projectKey: string): void; renderLane(lane: FocusScanLane, heading: ReactNode, compact?: boolean): ReactNode
  recentProjects?: readonly FocusRetainedProject[]; onRead?(at: number): void
  cardMetrics?: FocusLaneMetrics; replyLines?: FocusReplyLines
}) {
  const displayPath = usePathDisplay()
  const icons = useAppStore(state => state.spaceObjectIcons)
  const hosts = useAppStore(state => state.config?.hosts)
  const workspaces = useAppStore(state => state.config?.workspaces)
  const preferences = useAppStore(state => state.config?.focus?.projects)
  const zonePreferences = useAppStore(state => state.config?.focus?.zonePresentations)
  const authoredTopicPresentation = useAppStore(state => state.config?.focus?.topicPresentation)
  const dragged = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)
  const [orderFailure, setOrderFailure] = useState<{ message: string; change: ProjectChange; original: readonly FocusProjectPreference[] } | null>(null)
  const savingPreferences = useRef(false)
  const [preferencePending, setPreferencePending] = useState(false)
  async function saveProjectChange(change: ProjectChange, original: readonly FocusProjectPreference[]) {
    if (savingPreferences.current) return
    savingPreferences.current = true
    setPreferencePending(true)
    try { const next = applyProjectChange(original, change); await saveFocusPreferences({ projects: next }, { projects: original }); setOrderFailure(null) }
    catch (cause) { setOrderFailure({ message: presentError(cause), change, original }) }
    finally { savingPreferences.current = false; setPreferencePending(false) }
  }
  function movePin(key: string, direction: -1 | 1) {
    const original = preferences ?? [], pins = original.filter(item => item.pinned), index = pins.findIndex(item => item.key === key)
    const neighbor = pins[index + direction]
    if (!neighbor) return
    void saveProjectChange({ kind: 'move', key, target: neighbor.key, after: direction > 0 }, original)
  }
  const pinHandle = (key: string, name: string, subject: 'project' | 'collection') => <button type="button" className="focus-project-pin-handle" draggable={!preferencePending} disabled={preferencePending} aria-busy={preferencePending || undefined} aria-label={`Reorder pinned ${subject} · ${name}`} title={preferencePending ? 'Saving group order…' : 'Drag to reorder · Alt + ↑ / ↓'}
    onDragStart={event => { dragged.current = key; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key) }} onDragEnd={() => { dragged.current = null; setDropTarget(null) }}
    onKeyDown={event => { if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); movePin(key, event.key === 'ArrowUp' ? -1 : 1) } }}><SemanticIcon name="action.pin" size={12} /></button>
  const ownerDocument = useWorkbenchDocument()
  // This one editor host survives Collection reparenting after metadata changes.
  const [categoryTarget, setCategoryTarget] = useState<TopicCategory | null>(null)
  const [iconTarget, setIconTarget] = useState<SpaceIconTarget | null>(null)
  const invoker = useRef<HTMLElement | null>(null)
  const captureInvoker = () => {
    const Element = ownerDocument.defaultView?.HTMLElement, active = ownerDocument.activeElement
    invoker.current = Element && active instanceof Element ? active : null
  }
  const changeIcon = (target: SpaceIconTarget) => { captureInvoker(); setIconTarget(target) }
  const renameCategory = (target: TopicCategory) => { captureInvoker(); setCategoryTarget(target) }
  const returnFocus = () => invoker.current?.isConnected ? invoker.current : null
  const descriptionId = useId()
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const initialQuiet = useRef(new Map<string, boolean>())
  const currentCollectionId = lanes.find(lane => lane.collection?.topics.some(topic => topic.id === currentLaneId))?.id
  useEffect(() => {
    if (!revealRequestId || !currentCollectionId) return
    setCollapsed(current => { if (current.get(currentCollectionId) === false) return current; return new Map(current).set(currentCollectionId, false) })
  }, [revealRequestId, currentCollectionId])
  function toggleCollection(id: string, compact: boolean) {
    setCollapsed(current => new Map(current).set(id, !compact))
  }
  function toggleProject(key: string, compact: boolean) {
    void saveProjectChange({ kind: 'visibility', key, collapsed: !compact }, preferences ?? [])
  }
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [visible])
  // A stable frame is a project presentation, never the first checkout's identity.
  const frames: Array<{ key: string; project: boolean; lanes: FocusScanLane[] }> = []
  const projects = new Map<string, typeof frames[number]>()
  const compactLanes = new Map<string, boolean>()
  for (const lane of lanes) {
    const key = focusLaneProjectKey(lane), preference = focusProjectPreference(focusScanPreferenceKey(lane) ?? '', resourceMenus ? preferences ?? [] : [])
    const project = !lane.collection && !lane.topicId && !lane.locationUnconfirmed
    let frame = project ? projects.get(key) : undefined
    if (!frame) {
      frame = { key: project ? key : lane.id, project, lanes: [] }; frames.push(frame)
      if (project) projects.set(key, frame)
    }
    frame.lanes.push(lane)
    const current = currentLaneId === lane.id || Boolean(lane.collection?.topics.some(topic => topic.id === currentLaneId))
    if (!initialQuiet.current.has(lane.id) && !forceExpanded) initialQuiet.current.set(lane.id, Boolean(quietLanes?.has(lane.id)))
    if (initialQuiet.current.get(lane.id) && (preference.pinned || current || protectedLanes?.has(lane.id)
      || revealedLaneIds?.has(lane.id) || quietLanes && !quietLanes.has(lane.id))) initialQuiet.current.set(lane.id, false)
    const automaticallyCompact = Boolean(initialQuiet.current.get(lane.id)) && !preference.pinned && !current && !protectedLanes?.has(lane.id)
    compactLanes.set(lane.id, !forceExpanded && !revealedLaneIds?.has(lane.id) && (lane.collection ? collapsed.get(lane.id) ?? automaticallyCompact : preference.collapsed ?? automaticallyCompact))
  }
  return <section className="focus-project-lanes" aria-label="Focus context scan">
    {preferencePending ? <div className="focus-project-order-status" role="status">Saving group preferences…</div> : null}
    {orderFailure ? <div className="focus-project-order-error" role="status">{orderFailure.message}<button type="button" className="small-button" onClick={() => void saveProjectChange(orderFailure.change, orderFailure.original)}>Retry {orderFailure.change.kind === 'move' ? 'group order' : 'project visibility'}</button>
      <button type="button" className="small-button" onClick={() => {
        const current = useAppStore.getState().config?.focus?.projects ?? []
        void saveProjectChange(orderFailure.change, current)
      }}>Retry using current settings</button></div> : null}
    <div className="focus-project-lanes__rows" ref={rowsRef}>
      {leading}
      {frames.map(frame => {
        const first = frame.lanes[0]!, key = focusLaneProjectKey(first), preferenceKey = focusScanPreferenceKey(first)
        const preference = focusProjectPreference(preferenceKey ?? '', resourceMenus ? preferences ?? [] : [])
        const resource = frame.project ? workspaces?.find(workspace => workspace.hostId === first.hostId && workspace.id === first.projectId) : undefined
        const name = resource?.name ?? first.labels[0] ?? first.name
        const compact = frame.lanes.every(lane => compactLanes.get(lane.id))
        const revealed = frame.lanes.some(lane => revealedLaneIds?.has(lane.id))
        const currentProject = frame.lanes.some(lane => lane.id === currentLaneId)
        const activityAt = Math.max(0, ...frame.lanes.map(lane => lane.lastActivityAt ?? 0)) || null
        const title = <button type="button" className="focus-project-lanes__axis" data-focus-project-scope-control aria-current={currentProject ? 'location' : undefined} aria-pressed={selectedProjectKey === key} title={[resource ? displayPath(resource.path, resource.hostId) : name, ...(frame.lanes.length === 1 ? [first.summary, origins?.get(first.id)?.label, ...(origins?.get(first.id)?.locations ?? []), ...(origins?.get(first.id)?.addresses ?? [])] : [])].filter(Boolean).join('\n')} onClick={() => onSelect(key)}>
          {resource && resourceMenus ? <ProjectIcon workspaceId={resource.id} name={name} visible={visible} backdrop /> : <CollectionIcon size={15} />}
          <span className="focus-project-lanes__label"><strong>{name}</strong></span>
          <HostBadge context="Host" compact host={hostIdentityProjection(first.hostId, hosts?.find(host => host.id === first.hostId))} />
        </button>
        const category = first.collection?.confirmed && first.collection.categories.length === 1 ? first.collection.categories[0] : null
        const containerKey = frame.project ? focusZoneContainerKey('project', first.hostId, first.projectId)
          : category ? focusZoneContainerKey('collection', category.hostId, category.spaceId) : null
        const mode = focusZonePresentation(containerKey, frame.project ? 'project' : 'collection', resourceMenus ? zonePreferences : undefined, resourceMenus ? authoredTopicPresentation : undefined)
        const zoneHeadings = new Map(frame.lanes.map(zone => {
          const zoneName = zone.labels.slice(1).join(' / ') || 'Root'
          const control = <FocusLaneHeadingMenu enabled={resourceMenus} lane={zone} onRename={renameCategory} onChangeIcon={changeIcon}>
            <button type="button" className="focus-project-lanes__axis focus-zone-heading__axis" data-focus-project-scope-control
              aria-current={zone.id === currentLaneId ? 'location' : undefined} aria-pressed={selectedProjectKey === focusLaneProjectKey(zone)}
              title={[zone.name, displayPath(zone.path, zone.hostId), zone.summary, origins?.get(zone.id)?.label, ...(origins?.get(zone.id)?.locations ?? []), ...(origins?.get(zone.id)?.addresses ?? [])].filter(Boolean).join('\n')} onClick={() => onSelect(focusLaneProjectKey(zone))}>
              <ThemeObjectBranchIcon size={11} /><span className="focus-project-lanes__label"><strong>{zoneName}</strong></span>
            </button>
          </FocusLaneHeadingMenu>
          const hasNotice = origins?.get(zone.id)?.kind === 'unknown' || zone.locationUnconfirmed || zone.recovery !== null
          const notice = hasNotice ? <span className="focus-zone-notice" data-focus-zone-notice={zone.id} key={zone.id} title={zone.name}>
            <span className="focus-zone-notice__name">{zoneName} · </span>
            {origins?.get(zone.id)?.kind === 'unknown' ? <span className="focus-project-lanes__source">Source unknown</span> : null}
            {zone.locationUnconfirmed ? <span className="focus-project-lanes__recovery">Location unconfirmed</span> : null}
            {zone.recovery ? <span className="focus-project-lanes__recovery">{zone.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
          </span> : undefined
          return [zone.id, {
            section: <span className="focus-zone-heading" data-focus-zone-id={zone.id} key={zone.id}>{control}{notice}
              {zone.summary ? <span className="focus-project-lanes__summary" title={zone.summary}>{zone.summary}</span> : null}</span>,
            tag: <span className="focus-zone-heading" data-focus-zone-id={zone.id} key={zone.id}>{control}</span>,
            notice
          }] as const
        }))
        const references = (field: 'contextRefs' | 'activeAgentRefs') => [...new Map(frame.lanes.flatMap(zone => zone[field]).map(ref => [JSON.stringify([ref.hostId, ref.id]), ref])).values()]
        const scanLanes: readonly FocusScanLane[] = frame.project ? [{ ...first, id: frame.key, labels: [name], name,
          zones: frame.lanes, zoneHeadings, zonePresentation: mode, contextRefs: references('contextRefs'), activeAgentRefs: references('activeAgentRefs'),
          summary: null, recovery: null, lastActivityAt: activityAt }] : [{ ...first, ...(resourceMenus ? { zonePresentation: mode } : {}) }]
        const projectHeading = <header className="focus-project-frame__heading focus-project-lanes__heading">
            {resourceMenus ? <button type="button" className="focus-project-disclosure" aria-label={`${compact ? 'Expand' : 'Collapse'} project · ${name}`} aria-expanded={!compact} disabled={preferencePending || forceExpanded || revealed} title={forceExpanded || revealed ? 'Expanded for this search or exact reveal' : compact ? 'Expand project' : 'Collapse project'} onClick={() => toggleProject(key, compact)}><ThemeNavigationDisclosureIcon size={11} /></button> : null}
            {resourceMenus && preference.pinned ? pinHandle(key, name, 'project') : null}
            {resource && resourceMenus ? <WorkspaceRowContextMenu workspaceId={resource.id} path={resource.path} branch={resource.branch ?? null} isLocal={Boolean(hosts?.some(host => host.id === resource.hostId && host.kind === 'local'))} onChangeIcon={() => changeIcon(folderSpaceIconTarget({ hostId: resource.hostId, repoPath: resource.repoPath ?? resource.path, name: resource.name }))}>{title}</WorkspaceRowContextMenu> : title}
            {preference.note ? <span className="focus-project-lanes__personal-note" data-focus-project-note="" title={preference.note}>{preference.note}</span> : null}
            {frame.lanes.length === 1 ? <>{origins?.get(first.id)?.kind === 'unknown' ? <FocusProjectOrigin origin={origins?.get(first.id)} /> : null}
              {first.summary ? <span className="focus-project-lanes__summary" title={first.summary}>{first.summary}</span> : null}
              {first.recovery ? <span className="focus-project-lanes__recovery">{first.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}</> : null}
            <FocusProjectActivity at={activityAt} now={now} />
            {resourceMenus ? <><FocusZoneLayoutToggle containerKey={containerKey} name={name} presentation={mode} defaultPresentation={focusZonePresentation(null, 'project', undefined)} />
              <FocusProjectPreferences active={visible} projectKey={key} name={name} actions={resource ? <FocusProjectActions project={resource} /> : undefined} discussion={renderDiscussion ? state => renderDiscussion(scanLanes[0]!, state) : undefined} /></> : null}
          </header>
        return <div key={frame.key} className={frame.project ? 'focus-project-frame' : undefined} data-project-group-key={frame.project ? key : undefined}
          data-focus-current={frame.project && currentProject || undefined} data-focus-zone-presentation={resourceMenus || frame.project ? mode : undefined} data-focus-container-key={containerKey ?? undefined}
          data-pinned={preference.pinned || undefined} data-focus-project-color={frame.project ? preference.color : undefined}
          data-project-drop-target={preferenceKey && dropTarget?.key === preferenceKey ? dropTarget.after ? 'after' : 'before' : undefined}
          style={frame.project ? { '--focus-project-color': focusProjectTint(preference.color) } as CSSProperties : undefined}
          onDragOver={event => { if (preferenceKey && preference.pinned && dragged.current && dragged.current !== preferenceKey) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const box = event.currentTarget.getBoundingClientRect(); setDropTarget({ key: preferenceKey, after: event.clientY > box.top + box.height / 2 }) } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
          onDrop={event => { if (!preferenceKey) return; event.preventDefault(); const from = dragged.current; dragged.current = null; setDropTarget(null); const box = event.currentTarget.getBoundingClientRect(); if (from && preference.pinned) void saveProjectChange({ kind: 'move', key: from, target: preferenceKey, after: event.clientY > box.top + box.height / 2 }, preferences ?? []) }}>

          {scanLanes.map(lane => {
        const key = focusLaneProjectKey(lane), preference = focusProjectPreference(focusScanPreferenceKey(lane) ?? '', resourceMenus ? preferences ?? [] : [])
        const current = frame.project ? currentProject : currentLaneId === lane.id || Boolean(lane.collection?.topics.some(topic => topic.id === currentLaneId))
        const compact = frame.project ? frame.lanes.every(zone => compactLanes.get(zone.id)) : compactLanes.get(lane.id)!
        return <FocusLaneArticle name={lane.name} summary={lane.summary} visible={visible} className={`focus-project-lanes__row${!lane.collection && selectedProjectKey === key ? ' is-selected' : ''}`} data-focus-source={lane.collection ? 'collection' : origins?.get(lane.id)?.kind} data-focus-collection={lane.collection ? lane.id : undefined} data-collapsed={compact || undefined} data-focus-current={current || undefined} data-project-id={lane.collection ? undefined : lane.projectId} data-project-key={lane.collection ? undefined : key} data-lane-id={lane.id} data-recovery={lane.recovery ?? undefined} key={lane.id}
          data-pinned={preference.pinned || undefined} data-focus-project-color={preference.color} data-project-drop-target={dropTarget?.key === key ? dropTarget.after ? 'after' : 'before' : undefined}
          style={{ '--focus-project-color': focusProjectTint(preference.color) } as CSSProperties}
          >
        <div className="focus-project-lanes__track">{renderLane(lane,
        <div className={frame.project ? 'focus-project-frame__title' : 'focus-project-lanes__heading'}>
          {frame.project ? projectHeading : <>{lane.collection ? <>
            {resourceMenus && preference.pinned && preferenceKey ? pinHandle(preferenceKey, lane.name, 'collection') : null}
            <span className="focus-project-lanes__source">Collection</span>
            <FocusLaneHeadingMenu enabled={resourceMenus} lane={lane} collapsed={compact} onToggleCollection={() => toggleCollection(lane.id, compact)} onRename={renameCategory} onChangeIcon={changeIcon}><button type="button" className="focus-project-lanes__axis focus-project-lanes__collection" aria-expanded={!compact}
              aria-current={lane.collection.topics.some(topic => topic.id === currentLaneId) ? 'location' : undefined}
              aria-label={`${lane.name} · ${collectionCountLabel(lane)}`}
              title={lane.name} onClick={() => toggleCollection(lane.id, compact)}>
              <ThemeNavigationDisclosureIcon size={11} aria-hidden="true" /><FocusCollectionHeadingIcon lane={lane} icons={icons} resourceMenus={resourceMenus} />
              <span className="focus-project-lanes__label"><strong>{lane.name}</strong></span>
              <HostBadge context="Host" compact host={hostIdentityProjection(lane.hostId, hosts?.find(host => host.id === lane.hostId))} />
            </button></FocusLaneHeadingMenu>
            {lane.summary ? <span className="focus-project-lanes__recovery focus-project-lanes__collection-notice" role="status" title={lane.summary}>Details unconfirmed</span> : null}
            {lane.collection.pending ? <span className="focus-project-lanes__recovery focus-project-lanes__collection-notice" role="status" title="Collection membership changed. Finish editing or leave the current card to update its grouping.">Update pending</span> : null}
            <span className="focus-project-lanes__collection-count">{collectionCountLabel(lane)}</span>
          </> : <><FocusProjectOrigin origin={origins?.get(lane.id)} />
          {!frame.project || lane.labels.length > 1 ? <FocusLaneHeadingMenu enabled={resourceMenus} lane={lane} onRename={renameCategory} onChangeIcon={changeIcon}><button type="button" className="focus-project-lanes__axis" data-focus-project-scope-control aria-describedby={lane.summary ? descriptionId + lane.id : undefined} aria-current={currentLaneId === lane.id ? 'location' : undefined} aria-pressed={selectedProjectKey === focusLaneProjectKey(lane)} title={[`${lane.name} · ${lane.activeAgentRefs.length} live`, hosts?.find(host => host.id === lane.hostId)?.label ?? lane.hostId, displayPath(lane.path, lane.hostId)].filter(Boolean).join('\n')} onClick={() => onSelect(focusLaneProjectKey(lane))}>
            {lane.objectKind === 'topic' || lane.objectKind === 'mote'
              ? <><SpaceObjectIcon kind={lane.objectKind} name={lane.labels.at(-1)!} topicGlyph manualIcon={lane.objectIconKey ? icons[lane.objectIconKey] ?? null : null} avatarWorkspaceId={lane.workspaceId} avatarTopicId={lane.topicId ?? undefined} avatarObjectKey={lane.objectIconKey} /><span className="focus-project-lanes__label"><strong>{lane.labels.at(-1)}</strong></span></>
              : <>{(frame.project ? lane.labels.slice(1) : lane.labels).map((label, index) => <span className="focus-project-lanes__label" key={index}><ThemeObjectBranchIcon size={11} /><strong>{label}</strong></span>)}</>}
            {!frame.project ? <HostBadge context="Host" compact host={hostIdentityProjection(lane.hostId, hosts?.find(host => host.id === lane.hostId))} /> : null}
          </button></FocusLaneHeadingMenu> : null}
          {lane.summary ? <span id={descriptionId + lane.id} className="focus-project-lanes__summary">{lane.summary}</span> : null}</>}
          {!frame.project || lane.labels.length > 1 ? <FocusProjectActivity at={lane.lastActivityAt ?? null} now={now} /> : null}
          {lane.locationUnconfirmed ? <span className="focus-project-lanes__recovery">Location unconfirmed</span> : null}
          {lane.recovery ? <span className="focus-project-lanes__recovery">{lane.recovery === 'removed' ? 'Worktree removed' : 'Workspace unregistered'}</span> : null}
          {lane.collection && resourceMenus ? <><FocusZoneLayoutToggle containerKey={containerKey} name={lane.name} presentation={mode} defaultPresentation={focusZonePresentation(null, 'collection', undefined, authoredTopicPresentation)}
            unavailable="Zone layout needs one confirmed Collection. Original members and their work surfaces remain available." />
            <FocusProjectPreferences active={visible} collection {...(preferenceKey === undefined ? {} : { projectKey: preferenceKey })} name={lane.name} discussion={renderDiscussion ? state => renderDiscussion(lane, state) : undefined} /></> : null}</>}
        </div>
        , compact)}</div>
      </FocusLaneArticle>})}</div>})}
      {recentProjects.map(project => <article className="focus-project-lanes__row" data-project-id={project.projectId} data-project-key={project.key} data-observed-project="true" key={`observed:${project.key}`}>
        <FocusProjectObservation project={project} recent onRead={onRead} cardMetrics={cardMetrics} replyLines={replyLines} />
      </article>)}
    </div>
    {!leading && lanes.length === 0 && recentProjects.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
    {categoryTarget ? <TopicCategoryDialog target={categoryTarget} onClose={() => setCategoryTarget(null)} returnFocus={returnFocus} /> : null}
    {iconTarget ? <SpaceIconPicker target={iconTarget} onClose={() => setIconTarget(null)} returnFocus={returnFocus} /> : null}
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
    <span className="focus-retained-projects__identity">{recent ? <ThemeObjectHistoryIcon size={13} aria-hidden="true" /> : null}<strong>{project.name}</strong>{project.identity.source ? <span className="focus-retained-projects__source" title={`Original Runtime: ${project.identity.source.runtimeId ?? 'unconfirmed'}`}>Original source</span> : <HostBadge context="Host" host={hostIdentityProjection(project.hostId, hosts?.find(host => host.id === project.hostId))} />}</span>
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
