import { Archive, Check, Circle, X, ArrowUpRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { MOTE_SOUL_PATH, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { homeZoneId, spatialSources } from '../../../shared/space-addresses'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { keepPmoTeamsTopicFloatingPreview, leavePmoTeamsTopicFloatingPreview, pinPmoTeamsTopicFloating,
  createPmoTeamsTopicTargetSelector, requestPmoTeamsTopicFloatingClose, requestPmoTeamsTopicFloatingOpen, PMO_FLOATING_TAB_SLOT_PREFIX,
  readPmoTeamsTopicFloatingState, subscribePmoTeamsTopicFloatingState, pmoTeamsTopicFloatingTargetTopicId,
  resolvePmoTeamsTopicFloatingSize, type PmoTeamsTopicFloatingSize,
  type PmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { moteTargetStatus, usePmoTeamsTopicTarget } from '../lib/pmo-teams-topic-target'
import { pmoFocusSessionId } from '../lib/agent-focus'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { sessionPresentationById } from '../lib/session-presentation'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { MoteWorkface } from './MoteWorkface'
import { MoteProfilePopover } from './MoteProfilePopover'
import { WorkbenchPresentationContext } from '../lib/workbench-presentation'
import { StatusDot } from './StatusDot'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { topicSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import { SpaceIconPicker } from './SpaceIconPicker'
import { MoteRenameDialog } from './MoteRenameDialog'
import { SpaceObjectContextMenu } from './SpaceObjectContextMenu'
import { MoteArchiveNotice, useMoteArchiveAction } from './MoteArchiveNotice'
import { primaryMoteHasBot } from '../lib/primary-mote-executor'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import type { MoteWorkbenchProjectionResult } from '../lib/mote-workbench-projection'
import { workbenchDisplayReferenceMatches } from '../lib/workbench-resource-display'
import { spatialCatalog } from '../lib/space-agent-control'

const MoteChoice = memo(function MoteChoice({ topic, selected, savedTabId, onSelect, onIdentity, onArchive, pending, container, currentTopicId, onRename, onAvatar, onOpenSpace, catalog, reference, onReferenceSelect }: {
  catalog?: AgentMuxSpaceCatalog | null | undefined; reference?: WorkbenchProjectionSelection | null | undefined
  onReferenceSelect(topicId: string, reference: WorkbenchProjectionSelection): void
  topic: ScratchTopicSnapshot; selected: boolean; savedTabId: string | null | undefined
  onSelect(topicId: string, tabId: string | undefined): void
  onIdentity(anchor: HTMLButtonElement | null): void
  onArchive(topic: ScratchTopicSnapshot, archived: boolean): Promise<boolean>; pending: string | null; container(): HTMLElement | null; currentTopicId: string
  onRename(topic: ScratchTopicSnapshot): void; onAvatar(target: SpaceIconTarget): void; onOpenSpace(topicId: string, tabId: string | undefined): void
}) {
  const selectTab = useMemo(() => createPmoTeamsTopicTargetSelector({ open: false, preview: false,
    targetTopicId: topic.id, ...(selected ? { targetTabId: savedTabId } : {}) }), [topic.id, selected, savedTabId])
  const tabId = useAppStore(selectTab)
  const tab = useAppStore(state => {
    const candidate = tabId ? state.tabs[tabId] : undefined
    return candidate?.workspaceId === SCRATCH_WORKSPACE_ID && candidate.topicId === topic.id ? candidate : undefined
  })
  const selectedReference = selected ? reference : undefined
  const regionId = selectedReference ? selectedReference.tabId === tabId ? selectedReference.regionId : undefined
    : selectedReference === null ? undefined : tab?.layout.activeRegionId
  const region = regionId ? tab?.regions[regionId] : undefined
  const session = useAppStore(state => region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined)
  const workspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const iconTarget = useMemo(() => workspace ? topicSpaceIconTarget(workspace, topic, bindings) : undefined, [workspace, topic, bindings])
  const pinned = useAppStore(state => state.pinnedItems[SCRATCH_WORKSPACE_ID]?.includes(topic.id) === true)
  const scope = useMoteWorkfaceScope(SCRATCH_WORKSPACE_ID, topic.id)
  const fileReference = useMemo(() => {
    if (selected && reference !== undefined) return reference?.tabId === tabId ? reference : null
    const candidates = catalog?.locations.filter(location => location.tabId === tabId && location.regionId === regionId) ?? []
    return candidates.length === 1 ? candidates[0] : null
  }, [selected, reference, catalog, tabId, regionId])
  const files = useMoteMaterialsActions(scope, { floating: true, reference: fileReference, onReferenceSelect: value => onReferenceSelect(topic.id, value) })
  const manualIcon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const retainedPrimaryBot = useAppStore(state => topic.id === PMO_TEAMS_TOPIC_ID && primaryMoteHasBot(state))
  const targetStatus = moteTargetStatus(tab, session, tabId, regionId ?? null)
  const status = retainedPrimaryBot && targetStatus === 'No Agent yet' ? 'Status unknown' : targetStatus
  const identityStatus = (topic.moteArchive?.state === 'archived' ? 'Archived · ' : '') + (topic.id === PMO_TEAMS_TOPIC_ID ? 'Primary · ' : '') + status
  const restoring = Boolean(retainedPrimaryBot && targetStatus === 'No Agent yet' || tabId && (!tab || !region || region.kind === 'agent' && !session))
  const choice = <button type="button" className="mote-chooser__choice" data-mote-topic-id={topic.id}
    data-mote-target-tab={tabId} data-mote-status={status} aria-pressed={selected}
    aria-label={topic.title + ' · ' + identityStatus} onClick={() => onSelect(topic.id, tabId)}
    onPointerEnter={event => { if (event.pointerType === 'mouse') onIdentity(event.currentTarget) }}
    onPointerLeave={() => onIdentity(null)} onFocus={event => onIdentity(event.currentTarget)} onBlur={() => onIdentity(null)}>
    <span className="mote-chooser__name">
      <SpaceObjectIcon kind={iconTarget?.kind ?? 'mote'} name={topic.title} manualIcon={manualIcon}
        moteSessionId={region?.kind === 'agent' ? region.sessionId : undefined} moteHostId={workspace?.hostId}
        moteAvailability={(!tabId || region?.kind === 'launcher') && !retainedPrimaryBot ? 'no-agent' : 'restoring'}
        avatarObjectKey={iconTarget?.key} avatarWorkspaceId={iconTarget?.avatarTarget?.workspaceId} avatarTopicId={iconTarget?.avatarTarget?.topicId} />
      <strong>{topic.title}</strong>
    </span><span className="mote-chooser__status">
      {session ? <StatusDot status={session.status} /> : <span className="mote-chooser__availability" data-mote-availability={restoring ? 'restoring' : 'no-agent'} aria-hidden="true">{restoring ? '?' : <Circle size={7} />}</span>}
      <span className="mote-chooser__status-text">{identityStatus}</span>
    </span>
    {selected ? <Check className="mote-chooser__selected" size={10} aria-hidden="true" /> : null}
  </button>
  return iconTarget ? <SpaceObjectContextMenu target={iconTarget} container={container} onChangeIcon={onAvatar} moteActions={{
    pinned, onTogglePin: () => useAppStore.getState().togglePinnedItem(SCRATCH_WORKSPACE_ID, topic.id),
    onRename: () => onRename(topic), onEdit: () => { if (scope && fileReference) void files.open(scope.rootPath + '/' + MOTE_SOUL_PATH); else onOpenSpace(topic.id, tabId) },
    onNewDiscussion: () => { const state = useAppStore.getState(), layout = state.layouts[SCRATCH_WORKSPACE_ID]
      if (!layout) return
      const id = state.openLauncher({ workspaceId: SCRATCH_WORKSPACE_ID, tabGroupId: layout.activeGroupId, topicId: topic.id, reveal: false })
      if (id) onSelect(topic.id, id)
    }, onOpenSpace: () => onOpenSpace(topic.id, tabId)
  }} moteArchive={{
    archived: topic.moteArchive?.state === 'archived', disabled: pending === topic.id || topic.id === PMO_TEAMS_TOPIC_ID || !topic.moteArchive || topic.moteArchive.state === 'unknown',
    ...(topic.id === PMO_TEAMS_TOPIC_ID ? { reason: 'Primary Mote cannot be archived' } : {}),
    onChange: () => onArchive(topic, topic.moteArchive?.state !== 'archived'),
    returnFocus: () => {
      const panel = container(), resource = useAppStore.getState().config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
      if (!panel?.matches(':popover-open') || panel.dataset.moteTargetTopic !== currentTopicId || resource?.hostId !== workspace?.hostId || resource?.path !== workspace?.path) return null
      return panel.querySelector<HTMLButtonElement>(`[data-mote-archived="${topic.id}"] button`) ?? panel.querySelector<HTMLButtonElement>('[aria-label="Show archived Motes"]')
    }
  }}>{choice}</SpaceObjectContextMenu> : choice
})
function MoteIdentityTip({ anchor }: { anchor: HTMLButtonElement }) {
  const ref = useRef<HTMLDivElement>(null)
  const [label, setLabel] = useState(anchor.getAttribute('aria-label') ?? '')
  useLayoutEffect(() => {
    const tooltip = ref.current, boundary = anchor.closest<HTMLElement>('[data-pmo-teams-topic-floating]')
    if (!tooltip || !boundary) return
    let disposed = false
    const sync = () => setLabel(anchor.getAttribute('aria-label') ?? '')
    const observer = new MutationObserver(sync)
    observer.observe(anchor, { attributes: true, attributeFilter: ['aria-label'] }); sync()
    const position = async () => {
      const result = await computePosition(anchor, tooltip, { placement: 'right', strategy: 'fixed',
        middleware: [offset(6), flip({ boundary, padding: 8 }), shift({ boundary, padding: 8 })] })
      if (!disposed) Object.assign(tooltip.style, { left: result.x + 'px', top: result.y + 'px' })
    }
    const stop = autoUpdate(anchor, tooltip, () => { void position() })
    return () => { disposed = true; observer.disconnect(); stop() }
  }, [anchor])
  return <div ref={ref} role="tooltip" className="mote-chooser__identity">{label}</div>
}

const MoteChooser = memo(function MoteChooser({ topics, topicId, tabId, railMode, onToggleMode, onSelect, onClose, onArchive, pending, container, onRename, onAvatar, onOpenMoteSpace, catalog, reference, onReferenceSelect }: {
  catalog?: AgentMuxSpaceCatalog | null | undefined; reference?: WorkbenchProjectionSelection | null | undefined
  onReferenceSelect(topicId: string, reference: WorkbenchProjectionSelection): void
  topics: readonly ScratchTopicSnapshot[]; topicId: string; tabId: string | null | undefined
  railMode: 'cards' | 'avatars'; onToggleMode(): void
  onSelect(topicId: string, tabId: string | undefined): void; onClose(): void
  onArchive(topic: ScratchTopicSnapshot, archived: boolean): Promise<boolean>; pending: string | null; container(): HTMLElement | null
  onRename(topic: ScratchTopicSnapshot): void; onAvatar(target: SpaceIconTarget): void; onOpenMoteSpace(topicId: string, tabId: string | undefined): void
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [identityAnchor, setIdentityAnchor] = useState<HTMLButtonElement | null>(null)
  const showIdentity = useCallback((anchor: HTMLButtonElement | null) => {
    const name = anchor?.querySelector<HTMLElement>('.mote-chooser__name > strong')
    setIdentityAnchor(anchor && (railMode === 'avatars' || name && name.scrollWidth > name.clientWidth) ? anchor : null)
  }, [railMode])
  return <div className="mote-chooser">
    <div className="mote-chooser__choices" role="group" aria-label="Motes">
      {topics.filter(topic => topic.moteArchive?.state !== 'archived' || showArchived).map(topic => <MoteChoice key={topic.id} topic={topic} selected={topic.id === topicId} savedTabId={tabId} onSelect={onSelect} onIdentity={showIdentity} onArchive={onArchive} pending={pending} container={container} currentTopicId={topicId} onRename={onRename} onAvatar={onAvatar} onOpenSpace={onOpenMoteSpace} catalog={catalog} reference={reference} onReferenceSelect={onReferenceSelect} />)}
    </div>
    <div className="mote-chooser__actions">
      <button type="button" className="mote-chooser__archive" aria-label="Show archived Motes" aria-pressed={showArchived} title={showArchived ? 'Hide archived Motes' : 'Show archived Motes'} onClick={() => setShowArchived(value => !value)}><Archive size={13} /><span>{topics.filter(topic => topic.moteArchive?.state === 'archived').length}</span></button>
      <button type="button" aria-label="Show Mote avatars only" aria-pressed={railMode === 'avatars'} title={railMode === 'cards' ? 'Show avatars only' : 'Show Mote cards'} onClick={onToggleMode}>
        {railMode === 'cards' ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
      </button>
      <button type="button" aria-label="Close Mote" title="Close" onClick={onClose}><X size={13} /></button>
    </div>
    {identityAnchor?.isConnected ? <MoteIdentityTip anchor={identityAnchor} /> : null}
  </div>
})

function foreignFloatOwnsKeyboardEvent(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  // Native auto-popovers can keep focus on their invoker. Escape belongs to
  // that open inner surface even when the event originates outside its body.
  if (Array.from(panel?.querySelectorAll('[popover]') ?? []).some(owner => owner.matches(':popover-open'))) return true
  const owner = event.target instanceof Element
    ? event.target.closest('[data-overlay-layer]:not([data-overlay-layer="window-chrome"]), [popover], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]')
    : null
  return Boolean(owner && owner !== panel && (!owner.hasAttribute('popover') || owner.matches(':popover-open')))
}

export function PmoTeamsTopicFloatingPanel({ floating, setFloating, projectionState }: {
  projectionState?: MoteWorkbenchProjectionResult | undefined
  floating: PmoTeamsTopicFloatingState; setFloating(next: Partial<PmoTeamsTopicFloatingState>): void
}): React.JSX.Element {
  const presentation = useMemo(() => ({ active: floating.open, retainedRegionId: null, surface: 'mote' as const }), [floating.open])
  const scratch = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const openScratchTopic = useAppStore(state => state.openScratchTopic)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const reportError = useAppStore(state => state.reportError)
  const refreshTopics = useAppStore(state => state.refreshScratchTopics)
  const { topics, error: directoryError } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const motes = useMemo(() => scratchMoteTopics(topics), [topics])
  const archive = useMoteArchiveAction(scratch)
  const target = usePmoTeamsTopicTarget(floating)
  const tabs = useAppStore(state => state.tabs)
  const discussionChoices = useMemo(() => Object.values(tabs).filter(tab =>
    tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === target.topicId), [tabs, target.topicId])
  const visible = floating.open || floating.preview
  const railMode = floating.railMode ?? 'cards'
  const panelRef = useRef<HTMLDivElement>(null)
  const menuContainer = useCallback(() => panelRef.current, [])
  const selectedMote = motes.find(topic => topic.id === target.topicId)
  const floatingRef = useRef(floating); floatingRef.current = floating
  const spaceActionRef = useRef<AbortController | null>(null)
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const [preparationIssue, setPreparationIssue] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<ScratchTopicSnapshot | null>(null)
  const [avatarTarget, setAvatarTarget] = useState<SpaceIconTarget | null>(null)
  const actionTopicId = useRef<string | null>(null)
  const returnToMote = useCallback(() => {
    const panel = panelRef.current
    return panel?.matches(':popover-open') ? panel.querySelector<HTMLButtonElement>('[data-mote-topic-id="' + actionTopicId.current + '"]') ?? null : null
  }, [])
  const positionRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const availableSize = useRef<PmoTeamsTopicFloatingSize>({ width: 0, height: 0 })
  const drag = useRef<{ pointerId: number; handle: HTMLElement; x: number; y: number;
    start: PmoTeamsTopicFloatingSize; preferred: PmoTeamsTopicFloatingSize; size: PmoTeamsTopicFloatingSize;
    changedX: boolean; changedY: boolean; cursor: string; userSelect: string } | null>(null)
  const frame = useRef<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const endResize = useCallback((commit: boolean) => {
    const gesture = drag.current
    if (!gesture) return
    drag.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (gesture.handle.hasPointerCapture(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId)
    document.body.style.cursor = gesture.cursor; document.body.style.userSelect = gesture.userSelect
    setResizing(false)
    const widthChanged = gesture.changedX && gesture.size.width !== gesture.start.width
    const heightChanged = gesture.changedY && gesture.size.height !== gesture.start.height
    if (commit && (widthChanged || heightChanged)) setFloating({ size: {
      width: widthChanged ? gesture.size.width : gesture.preferred.width,
      height: heightChanged ? gesture.size.height : gesture.preferred.height
    } })
    void positionRef.current?.()
  }, [setFloating])
  useEffect(() => {
    const cancel = () => endResize(false)
    const escape = (event: KeyboardEvent) => {
      if (!drag.current || event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return
      event.preventDefault(); event.stopImmediatePropagation(); endResize(false)
    }
    window.addEventListener('blur', cancel)
    document.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('blur', cancel); document.removeEventListener('keydown', escape, true); cancel() }
  }, [endResize])
  useEffect(() => { if (!visible) endResize(false) }, [visible, endResize])

  useEffect(() => () => { spaceActionRef.current?.abort(); spaceActionRef.current = null },
    [floating.open, floating.preview, target.topicId, target.tabId, floating.reference?.displayWorkspaceId,
      floating.reference?.groupId, floating.reference?.tabId, floating.reference?.regionId])
  useEffect(() => {
    if (!floating.open) return
    // A missing exact Tab has no proven Topic; do not turn a derived default into saved identity.
    if (!floating.targetTopicId && typeof floating.targetTabId === 'string' && !target.tab) return
    if (!floating.targetTopicId || floating.targetTabId === undefined && target.tabId)
      setFloating({ targetTopicId: target.topicId, ...(target.tabId ? { targetTabId: target.tabId } : {}) })
    else if (floating.targetTabId === undefined && !target.tabId && discussionChoices.length === 0 && motes.some(topic => topic.id === target.topicId))
      setFloating({ targetTabId: null })
  }, [floating.open, floating.targetTopicId, floating.targetTabId, target.topicId, target.tabId, target.tab, discussionChoices.length, motes, setFloating])
  useEffect(() => {
    const reference = projectionState?.projection?.selection[0]
    if (floating.open && floating.reference === undefined && reference?.tabId === target.tabId)
      setFloating({ reference })
  }, [floating.open, floating.reference, target.tabId, projectionState?.projection, setFloating])
  useEffect(() => {
    if (floating.open && target.session && pmoFocusSessionId(useAppStore.getState().agentFocus) !== target.session.id) focusPmoSession(target.session.id)
  }, [floating.open, target.session, focusPmoSession])
  useEffect(() => {
    if (!floating.open || !scratch) return
    let current = true
    setPreparationIssue(null)
    void api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, target.topicId)
      .then(() => {
        if (!current || !target.tabId) return
        return openScratchTopic(target.topicId, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: target.tabId })
      }).catch(error => {
        if (current) {
          setPreparationIssue('Context preparation did not complete. The original work surface remains available.')
          reportError(error)
        }
      })
    return () => { current = false }
  }, [floating.open, scratch, target.topicId, target.tabId, preparationAttempt, openScratchTopic, reportError])

  useLayoutEffect(() => {
    const panel = panelRef.current
    const anchor = document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')
    if (!panel) return
    if (!visible) { if (panel.matches(':popover-open')) panel.hidePopover(); return }
    if (!anchor) return
    if (!panel.matches(':popover-open')) {
      ;(panel.showPopover as (options: { source: HTMLButtonElement }) => void).call(panel, { source: anchor })
    }
    let disposed = false
    const position = async () => {
      const result = await computePosition(anchor, panel, { placement: 'top-start', strategy: 'fixed', middleware: [offset(6), shift({ padding: 8 }), size({ padding: 8,
        apply({ availableWidth, availableHeight }) {
          if (disposed) return
          availableSize.current = { width: availableWidth, height: availableHeight }
          const dimensions = resolvePmoTeamsTopicFloatingSize(drag.current?.size ?? floatingRef.current.size,
            availableSize.current, floatingRef.current.railMode ?? 'cards', window.innerWidth)
          panel.style.width = dimensions.width + 'px'
          panel.style.height = dimensions.height + 'px'
        }
      })] })
      if (!disposed) Object.assign(panel.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
    }
    panel.style.visibility = 'hidden'
    positionRef.current = position
    const stop = autoUpdate(anchor, panel, () => { void position() })
    return () => { disposed = true; stop(); if (positionRef.current === position) positionRef.current = undefined }
  }, [visible, floating.size?.width, floating.size?.height, railMode, scratch, topics])
  useEffect(() => {
    if (!floating.preview) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event) || foreignFloatOwnsKeyboardEvent(event, panelRef.current)) return
      event.preventDefault(); event.stopPropagation(); requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [floating.preview])
  // Retained Views are React portals whose logical owner stays in App. The
  // operative boundary is this actual DOM surface, including those Views.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const enter = (event: PointerEvent) => { if (event.pointerType === 'mouse') keepPmoTeamsTopicFloatingPreview() }
    const leave = (event: PointerEvent) => { if (event.pointerType === 'mouse') leavePmoTeamsTopicFloatingPreview() }
    const pin = () => pinPmoTeamsTopicFloating()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event) || foreignFloatOwnsKeyboardEvent(event, panel)) return
      event.preventDefault(); event.stopPropagation(); spaceActionRef.current?.abort(); requestPmoTeamsTopicFloatingClose()
    }
    panel.addEventListener('pointerenter', enter)
    panel.addEventListener('pointerleave', leave)
    panel.addEventListener('pointerdown', pin, true)
    panel.addEventListener('focus', pin, true)
    panel.addEventListener('keydown', escape)
    return () => {
      panel.removeEventListener('pointerenter', enter)
      panel.removeEventListener('pointerleave', leave)
      panel.removeEventListener('pointerdown', pin, true)
      panel.removeEventListener('focus', pin, true)
      panel.removeEventListener('keydown', escape)
    }
  }, [])

  const selectMote = useCallback((topicId: string, tabId: string | undefined) => {
    spaceActionRef.current?.abort()
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(tabId ? { targetTabId: tabId } : {}) })
  }, [])
  const selectFileReference = useCallback((topicId: string, reference: WorkbenchProjectionSelection) => {
    setFloating({ targetTopicId: topicId, targetTabId: reference.tabId, reference })
  }, [setFloating])
  const selectDiscussion = useCallback((tabId: string, groupId?: string, explicitDisplayWorkspaceId?: string) => {
    const state = useAppStore.getState(), current = readPmoTeamsTopicFloatingState() ?? floating
    // Native input focus reports the retained entity, not a placement choice.
    // Keep even an unconfirmed raw reference until the person chooses a Group.
    if (!groupId && current.targetTabId === tabId) return
    const tab = state.tabs[tabId]
    const topicId = pmoTeamsTopicFloatingTargetTopicId(current, state.tabs)
    // This is the display Workspace rendered by the original Workbench below,
    // including its retained-reference workface, not the resource's home guess.
    const displayWorkspaceId = explicitDisplayWorkspaceId ?? projectionState?.projection?.displayWorkspaceId ?? SCRATCH_WORKSPACE_ID
    // The original action may have just created this Tab before React renders
    // its next catalog. Confirm against the original owner's current graph.
    const candidates = [...new Map(spatialCatalog(state, topics ?? []).locations.filter(location => location.tabId === tabId &&
      location.displayWorkspaceId === displayWorkspaceId &&
      (!groupId || location.groupId === groupId) && location.regionId === tab?.layout.activeRegionId &&
      workbenchDisplayReferenceMatches(state.layouts[location.displayWorkspaceId], location))
      .map(({ displayWorkspaceId, groupId, tabId, regionId }) => {
        const reference = { displayWorkspaceId, groupId, tabId, regionId }
        return [JSON.stringify(reference), reference] as const
      })).values()]
    const exact = tab?.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId &&
      tab.regions[tab.layout.activeRegionId] && candidates.length === 1 ? candidates[0] : null
    if (!exact) {
      reportError(new Error('This exact discussion location is no longer confirmed. Its original content is kept; choose its current location.'))
      return
    }
    spaceActionRef.current?.abort()
    setFloating({ targetTabId: tabId, reference: { displayWorkspaceId: exact.displayWorkspaceId,
      groupId: exact.groupId, tabId: exact.tabId, regionId: exact.regionId } })
  }, [projectionState, setFloating, floating, reportError, topics])
  const close = useCallback(() => { endResize(false); spaceActionRef.current?.abort(); requestPmoTeamsTopicFloatingClose() }, [endResize])
  const openSpace = useCallback((topicId = target.topicId, tabId = topicId === target.topicId ? target.tabId : undefined) => {
    spaceActionRef.current?.abort()
    setPreparationIssue(null)
    const controller = new AbortController(); spaceActionRef.current = controller
    const floatingIntent = () => {
      const current = readPmoTeamsTopicFloatingState(), reference = current?.reference
      return JSON.stringify([current?.open, current?.preview, current?.targetTopicId, current?.targetTabId,
        reference === null, reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, reference?.regionId])
    }
    const intent = floatingIntent()
    let destination: WorkbenchProjectionSelection | null = null
    let destinationSpaceId: string | null = null
    let destinationZoneId: string | null = null
    const opening = (async () => {
      const before = useAppStore.getState()
      if (tabId) {
        const tab = before.tabs[tabId]
        const selected = topicId === target.topicId && tabId === target.tabId
        if (selected) {
          const currentFloat = readPmoTeamsTopicFloatingState() ?? floating
          if (pmoTeamsTopicFloatingTargetTopicId(currentFloat, before.tabs) !== topicId ||
            currentFloat.targetTabId !== undefined && currentFloat.targetTabId !== tabId)
            throw new Error('The selected Mote discussion has changed. Its original content is kept.')
          destination = currentFloat.reference !== undefined ? currentFloat.reference : projectionState?.projection?.selection[0] ?? null
        }
        else {
          const candidates = [...new Map(spatialCatalog(before, topics ?? []).locations
            .filter(location => location.tabId === tabId && location.regionId === tab?.layout.activeRegionId)
            .map(({ displayWorkspaceId, groupId, tabId, regionId }) => {
              const reference = { displayWorkspaceId, groupId, tabId, regionId }
              return [JSON.stringify(reference), reference] as const
            })).values()]
          if (candidates.length === 1) destination = candidates[0]!
        }
        if (!destination || destination.tabId !== tabId || tab?.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== topicId)
          throw new Error('This exact discussion location is not confirmed. Choose its current location; the original content is kept.')
      }
      const topic = tabId ? topics?.find(topic => topic.id === topicId) : await api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, topicId)
      if (controller.signal.aborted) return false
      if (!topic) throw new Error('The original Mote directory is still being confirmed')
      const current = useAppStore.getState()
      if (!current.config) throw new Error('The Workspace is still restoring')
      const sources = spatialSources(current.config, [topic], current.spaceZoneBindings)
      const space = sources.spaces.find(space => space.topicId === topicId)
      const zone = space && sources.zones.find(zone => zone.zoneId === homeZoneId(space.spaceId) && zone.workspaceId === SCRATCH_WORKSPACE_ID &&
        sources.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === space.spaceId))
      if (!space || !zone) throw new Error('The original Mote Space is not available')
      destinationSpaceId = space.spaceId
      destinationZoneId = zone.zoneId
      const receipt = await current.executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'focus',
        target: { kind: 'space', spaceId: space.spaceId, ...(destination ?? { zoneId: zone.zoneId }) }, inputPolicy: 'preserve' }, controller.signal)
      if (receipt.operation !== 'focus') throw new Error('The original Mote Space focus was not confirmed')
      if (!['applied', 'unchanged'].includes(receipt.navigation.state))
        throw new Error(receipt.issues[0]?.message ?? 'The original Mote Space could not be selected')
      return true
    })()
    const navigation = useAppStore.getState()
    const beforeSpace = JSON.stringify(navigation.workbenchSpaceSelection)
    let ownChoiceObserved = false, ownNavigationObserved = false
    const unsubscribe = useAppStore.subscribe(state => {
      const choice = state.workbenchSpaceSelection
      if (!ownChoiceObserved && state.mainSurface === navigation.mainSurface && state.activeWorkspaceId === navigation.activeWorkspaceId &&
        JSON.stringify(choice) === beforeSpace) return
      const workspaceId = destination?.displayWorkspaceId ?? SCRATCH_WORKSPACE_ID
      const ownChoice = choice?.spaceId === destinationSpaceId && (destination
        ? choice.workspaceId === workspaceId && choice.groupId === destination.groupId &&
          choice.tabId === destination.tabId && choice.regionId === destination.regionId
        : !tabId && choice.workspaceId === workspaceId && choice.zoneId === destinationZoneId && choice.topicId === topicId && !choice.tabId && !choice.regionId)
      const finalSurface = state.mainSurface === 'workbench' && state.activeWorkspaceId === workspaceId
      // The public owner first commits its exact Work choice, then its Workspace,
      // then Space. Shared layout activation is not part of this navigation.
      const ownCommit = !ownNavigationObserved && state.mainSurface === navigation.mainSurface &&
        (state.activeWorkspaceId === navigation.activeWorkspaceId || state.activeWorkspaceId === workspaceId)
      if (ownChoice && (finalSurface || ownCommit)) {
        ownChoiceObserved = true
        if (finalSurface) ownNavigationObserved = true
        return
      }
      // Any different choice latches cancellation, including A→B→A before paint.
      controller.abort()
    })
    // Latch original floating intent immediately, including A→B→A before React commits.
    const unsubscribeFloating = subscribePmoTeamsTopicFloatingState(() => {
      if (floatingIntent() !== intent) controller.abort()
    })
    const disposeNavigation = () => { unsubscribe(); unsubscribeFloating(); controller.signal.removeEventListener('abort', disposeNavigation) }
    if (controller.signal.aborted) disposeNavigation()
    else controller.signal.addEventListener('abort', disposeNavigation, { once: true })
    void opening.then(opened => {
      if (opened && controller === spaceActionRef.current && !controller.signal.aborted) requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }).catch(error => {
      if (controller === spaceActionRef.current && !controller.signal.aborted) {
        setPreparationIssue('Opening this context in Space did not complete. The original work surface remains available.'); reportError(error)
      }
    }).finally(disposeNavigation)
  }, [target.topicId, target.tabId, floating.reference, projectionState, topics, reportError])

  return <WorkbenchPresentationContext.Provider value={presentation}><div ref={panelRef} id="pmo-teams-topic-floating-panel" popover="auto" role="dialog" aria-modal="false"
    aria-label={target.label} aria-describedby="mote-floating-context-status" tabIndex={-1} className="pmo-teams-topic-floating"
    data-pmo-teams-topic-floating data-state={visible ? 'open' : 'closed'}
    data-mote-target-topic={target.topicId} data-mote-target-tab={target.tabId} data-mote-target-region={target.region?.regionId}
    data-mote-target-session={target.session?.id} data-mote-status={target.statusText}
    data-mote-presentation={floating.open ? 'pinned' : floating.preview ? 'preview' : 'closed'}
    data-mote-navigation={railMode}
    data-mote-resizing={resizing ? 'true' : 'false'}
    onToggle={event => { if (event.target === event.currentTarget && event.newState === 'closed' && (floatingRef.current.open || floatingRef.current.preview)) requestPmoTeamsTopicFloatingClose({ restoreFocus: false }) }}>
    <span hidden id="mote-floating-context-status">{target.label} · {target.statusText}</span>
    {visible ? <span className="pmo-teams-topic-floating__resize" role="separator" tabIndex={0}
      aria-label="Resize Mote window" aria-orientation="vertical"
      onPointerDown={event => {
        if (drag.current || event.button !== 0 || !panelRef.current) return
        event.preventDefault()
        const rect = panelRef.current.getBoundingClientRect()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerId: event.pointerId, handle: event.currentTarget, x: event.clientX, y: event.clientY,
          start: { width: rect.width, height: rect.height }, size: { width: rect.width, height: rect.height },
          preferred: floatingRef.current.size ?? { width: rect.width, height: rect.height }, changedX: false, changedY: false,
          cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
        document.body.style.cursor = 'nesw-resize'; document.body.style.userSelect = 'none'; setResizing(true)
      }}
      onPointerMove={event => {
        const gesture = drag.current
        if (!gesture || event.pointerId !== gesture.pointerId) return
        gesture.changedX = event.clientX !== gesture.x; gesture.changedY = event.clientY !== gesture.y
        gesture.size = resolvePmoTeamsTopicFloatingSize({ width: gesture.start.width + event.clientX - gesture.x,
          height: gesture.start.height + gesture.y - event.clientY }, availableSize.current, railMode, window.innerWidth)
        if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; void positionRef.current?.() })
      }}
      onPointerUp={event => { if (event.pointerId === drag.current?.pointerId) endResize(true) }}
      onPointerCancel={event => { if (event.pointerId === drag.current?.pointerId) endResize(false) }}
      onLostPointerCapture={event => { if (event.pointerId === drag.current?.pointerId) endResize(false) }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !panelRef.current) return
        event.preventDefault(); event.stopPropagation()
        if (drag.current) return
        pinPmoTeamsTopicFloating()
        const rect = panelRef.current.getBoundingClientRect(), step = event.shiftKey ? 20 : 10
        const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft'
        const dimensions = resolvePmoTeamsTopicFloatingSize({ width: rect.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          height: rect.height + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0) }, availableSize.current, railMode, window.innerWidth)
        if (horizontal ? dimensions.width === rect.width : dimensions.height === rect.height) return
        const preferred = floatingRef.current.size ?? rect
        setFloating({ size: { width: horizontal ? dimensions.width : preferred.width,
          height: horizontal ? preferred.height : dimensions.height } })
      }} /> : null}
    {visible ? <MoteChooser onReferenceSelect={selectFileReference} catalog={projectionState?.catalog} reference={floating.reference} topics={motes} topicId={target.topicId} tabId={floating.targetTabId === null ? null : target.tabId} railMode={railMode}
      onToggleMode={() => { pinPmoTeamsTopicFloating(); setFloating({ railMode: railMode === 'cards' ? 'avatars' : 'cards' }) }}
      onSelect={selectMote} onClose={close} onArchive={archive.change} pending={archive.pending} container={menuContainer}
      onRename={topic => { actionTopicId.current = topic.id; setRenameTarget(topic) }}
      onAvatar={icon => { actionTopicId.current = icon.avatarTarget?.topicId ?? null; setAvatarTarget(icon) }}
      onOpenMoteSpace={openSpace} /> : null}
    <div className="pmo-teams-topic-floating__content">
    {floating.preferenceIssue ? <div role="status" className="workbench-restore-notice mote-size-notice">{floating.preferenceIssue}</div> : null}
    {selectedMote?.moteArchive?.state === 'archived' ? <div role="status" className="workbench-restore-notice mote-context-notice" data-mote-archived={selectedMote.id}>
      <span>{selectedMote.title} · Archived. The original work surface remains available.</span>
      <button type="button" className="small-button" disabled={archive.pending === selectedMote.id} onClick={() => void archive.change(selectedMote, false)}>Restore Mote</button>
    </div> : null}
    <MoteArchiveNotice workspaceId={SCRATCH_WORKSPACE_ID} issue={archive.issue ?? (selectedMote?.moteArchive?.state === 'unknown' ? selectedMote.moteArchive.issue : null)} failure={archive.failure} targetName={selectedMote?.title} />
    {!scratch ? <div role="status" className="workbench-restore-notice">Original Mote retained · Workspace is still restoring</div> : null}
    {visible && (directoryError || !topics || !motes.some(mote => mote.id === target.topicId)) ? <div role="status" className="workbench-restore-notice mote-context-notice">
      <span>{directoryError ? 'Mote directory could not be refreshed: ' + directoryError : 'Mote directory is not confirmed yet.'} The current work surface is retained.</span>
      <button type="button" className="small-button" onClick={() => void refreshTopics(SCRATCH_WORKSPACE_ID, true)}>Retry directory</button>
    </div> : null}
    {preparationIssue ? <div role="status" className="workbench-restore-notice mote-context-notice"><span>{preparationIssue}</span><button type="button" className="small-button" onClick={() => setPreparationAttempt(attempt => attempt + 1)}>Retry context</button></div> : null}
    {visible && floating.targetTabId === undefined && !target.tabId && discussionChoices.length > 1 ?
      <div role="status" className="workbench-restore-notice mote-context-notice">
        <span>Choose a discussion to continue. Each original work surface is kept.</span>
        {discussionChoices.map(tab => <button type="button" className="small-button" key={tab.id}
          onClick={() => selectMote(target.topicId, tab.id)}>{tab.name || 'Discussion'}</button>)}
      </div> : null}
    {projectionState?.issue ? <div role="status" className="workbench-restore-notice mote-context-notice">
      <span>{projectionState.issue}</span>
      {projectionState.choices.map((reference, index) => <button type="button" className="small-button" key={JSON.stringify(reference)}
        onClick={() => setFloating({ targetTabId: reference.tabId, reference })}>
        {useAppStore.getState().config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)?.name ?? 'Workspace'} · Location {index + 1}
      </button>)}
    </div> : null}
    <div className="pmo-teams-topic-floating__body">
      <MoteProfilePopover workspaceId={SCRATCH_WORKSPACE_ID} topicId={target.topicId} reference={floating.reference}
        active={visible} onReferenceSelect={selectFileReference}>{profileTrigger =>
      !target.tabId && !motes.some(topic => topic.id === target.topicId) ?
        <div role="status" className="workbench-restore-notice" data-workbench-pending-owner>Original Mote retained · Topic directory is still being confirmed</div> :
        <MoteWorkface workspaceId={SCRATCH_WORKSPACE_ID} topicId={target.topicId} floating visible={visible} recoverOnOpen={floating.open} reference={floating.reference} conversationEntry={floating.conversationEntry} onTabSelect={selectDiscussion}>
        <WorkspaceWorkbench workspaceId={projectionState?.projection?.displayWorkspaceId ?? SCRATCH_WORKSPACE_ID}
          topicId={target.topicId} topicIsolation="bound-only" viewOwnership="projection"
          projection={projectionState?.projection ?? undefined} viewHostPrefix={PMO_FLOATING_TAB_SLOT_PREFIX}
          retainedTabId={target.tabId} visible={visible} interactiveResize={false}
          onTabSelect={selectDiscussion} presentationAction={<>{profileTrigger}
            <button type="button" className="pane-action"
            aria-label="Open in Space" title="Open current Mote in Space" onClick={() => openSpace()}><ArrowUpRight size={14} /></button></>} /></MoteWorkface>}
      </MoteProfilePopover>
    </div>
    </div>
    <MoteRenameDialog target={renameTarget && scratch ? { topic: renameTarget, workspace: scratch } : null} onClose={() => setRenameTarget(null)} returnFocus={returnToMote} />
    <SpaceIconPicker target={avatarTarget} onClose={() => setAvatarTarget(null)} returnFocus={returnToMote} />
  </div></WorkbenchPresentationContext.Provider>
}
