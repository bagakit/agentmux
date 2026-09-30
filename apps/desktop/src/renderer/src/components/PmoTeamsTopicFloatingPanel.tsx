import { Check, Circle, X, Maximize2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { homeZoneId, spatialSources } from '../../../shared/space-addresses'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { keepPmoTeamsTopicFloatingPreview, leavePmoTeamsTopicFloatingPreview, pinPmoTeamsTopicFloating,
  createPmoTeamsTopicTargetSelector, requestPmoTeamsTopicFloatingClose, PMO_FLOATING_TAB_SLOT_PREFIX,
  resolvePmoTeamsTopicFloatingSize, type PmoTeamsTopicFloatingSize,
  type PmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { moteTargetStatus, usePmoTeamsTopicTarget } from '../lib/pmo-teams-topic-target'
import { pmoFocusSessionId } from '../lib/agent-focus'
import { isImeOwnedKeyboardEvent } from '../lib/ime-composition-keyboard-event'
import { sessionPresentationById } from '../lib/session-presentation'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { WorkbenchPresentationContext } from '../lib/workbench-presentation'
import { StatusDot } from './StatusDot'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'

const MoteChoice = memo(function MoteChoice({ topic, selected, savedTabId, onSelect, onIdentity }: {
  topic: ScratchTopicSnapshot; selected: boolean; savedTabId: string | null | undefined
  onSelect(topicId: string, tabId: string | undefined): void
  onIdentity(anchor: HTMLButtonElement | null): void
}) {
  const selectTab = useMemo(() => createPmoTeamsTopicTargetSelector({ open: false, preview: false,
    targetTopicId: topic.id, ...(selected ? { targetTabId: savedTabId } : {}) }), [topic.id, selected, savedTabId])
  const tabId = useAppStore(selectTab)
  const tab = useAppStore(state => {
    const candidate = tabId ? state.tabs[tabId] : undefined
    return candidate?.workspaceId === SCRATCH_WORKSPACE_ID && candidate.topicId === topic.id ? candidate : undefined
  })
  const region = tab?.regions[tab.layout.activeRegionId]
  const session = useAppStore(state => region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined)
  const workspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const iconTarget = useMemo(() => workspace ? topicSpaceIconTarget(workspace, topic) : undefined, [workspace, topic])
  const manualIcon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const status = moteTargetStatus(tab, session, tabId)
  const identityStatus = topic.id === PMO_TEAMS_TOPIC_ID ? 'Primary · ' + status : status
  const restoring = Boolean(tabId && (!tab || !region || region.kind === 'agent' && !session))
  return <button type="button" className="mote-chooser__choice" data-mote-topic-id={topic.id}
    data-mote-target-tab={tabId} data-mote-status={status} aria-pressed={selected}
    aria-label={topic.title + ' · ' + identityStatus} onClick={() => onSelect(topic.id, tabId)}
    onPointerEnter={event => { if (event.pointerType === 'mouse') onIdentity(event.currentTarget) }}
    onPointerLeave={() => onIdentity(null)} onFocus={event => onIdentity(event.currentTarget)} onBlur={() => onIdentity(null)}>
    <span className="mote-chooser__name">
      <SpaceObjectIcon kind={iconTarget?.kind ?? 'mote'} name={topic.title} manualIcon={manualIcon}
        avatarObjectKey={iconTarget?.key} avatarWorkspaceId={iconTarget?.avatarTarget?.workspaceId} avatarTopicId={iconTarget?.avatarTarget?.topicId} />
      <strong>{topic.title}</strong>
    </span><span className="mote-chooser__status">
      {session ? <StatusDot status={session.status} /> : <span className="mote-chooser__availability" data-mote-availability={restoring ? 'restoring' : 'no-agent'} aria-hidden="true">{restoring ? '?' : <Circle size={7} />}</span>}
      <span className="mote-chooser__status-text">{identityStatus}</span>
    </span>
    {selected ? <Check className="mote-chooser__selected" size={10} aria-hidden="true" /> : null}
  </button>
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

const MoteChooser = memo(function MoteChooser({ topics, topicId, tabId, railMode, onToggleMode, onSelect, onOpenSpace, onClose }: {
  topics: readonly ScratchTopicSnapshot[]; topicId: string; tabId: string | null | undefined
  railMode: 'cards' | 'avatars'; onToggleMode(): void
  onSelect(topicId: string, tabId: string | undefined): void; onOpenSpace(): void; onClose(): void
}) {
  const [identityAnchor, setIdentityAnchor] = useState<HTMLButtonElement | null>(null)
  const showIdentity = useCallback((anchor: HTMLButtonElement | null) => {
    const name = anchor?.querySelector<HTMLElement>('.mote-chooser__name > strong')
    setIdentityAnchor(anchor && (railMode === 'avatars' || name && name.scrollWidth > name.clientWidth) ? anchor : null)
  }, [railMode])
  return <div className="mote-chooser">
    <div className="mote-chooser__choices" role="group" aria-label="Motes">
      {topics.map(topic => <MoteChoice key={topic.id} topic={topic} selected={topic.id === topicId} savedTabId={tabId} onSelect={onSelect} onIdentity={showIdentity} />)}
    </div>
    <div className="mote-chooser__actions">
      <button type="button" aria-label="Show Mote avatars only" aria-pressed={railMode === 'avatars'} title={railMode === 'cards' ? 'Show avatars only' : 'Show Mote cards'} onClick={onToggleMode}>
        {railMode === 'cards' ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
      </button>
      <button type="button" aria-label="Open Mote Space" title="Open current Mote in Space" onClick={onOpenSpace}><Maximize2 size={13} /></button>
      <button type="button" aria-label="Close Mote" title="Close" onClick={onClose}><X size={13} /></button>
    </div>
    {identityAnchor?.isConnected ? <MoteIdentityTip anchor={identityAnchor} /> : null}
  </div>
})

function foreignFloatOwnsKeyboardEvent(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  const owner = event.target instanceof Element
    ? event.target.closest('[data-overlay-layer]:not([data-overlay-layer="window-chrome"]), [popover], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]')
    : null
  return Boolean(owner && owner !== panel && (!owner.hasAttribute('popover') || owner.matches(':popover-open')))
}

export function PmoTeamsTopicFloatingPanel({ floating, setFloating }: {
  floating: PmoTeamsTopicFloatingState; setFloating(next: Partial<PmoTeamsTopicFloatingState>): void
}): React.JSX.Element {
  const presentation = useMemo(() => ({ active: floating.open, retainedRegionId: null }), [floating.open])
  const scratch = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const openScratchTopic = useAppStore(state => state.openScratchTopic)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const reportError = useAppStore(state => state.reportError)
  const refreshTopics = useAppStore(state => state.refreshScratchTopics)
  const { topics, error: directoryError } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const motes = useMemo(() => scratchMoteTopics(topics), [topics])
  const target = usePmoTeamsTopicTarget(floating)
  const visible = floating.open || floating.preview
  const railMode = floating.railMode ?? 'cards'
  const panelRef = useRef<HTMLDivElement>(null)
  const floatingRef = useRef(floating); floatingRef.current = floating
  const spaceActionRef = useRef<AbortController | null>(null)
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const [preparationIssue, setPreparationIssue] = useState<string | null>(null)
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
    [floating.open, floating.preview, target.topicId, target.tabId])
  useEffect(() => {
    if (!floating.open) return
    // A missing exact Tab has no proven Topic; do not turn a derived default into saved identity.
    if (!floating.targetTopicId && typeof floating.targetTabId === 'string' && !target.tab) return
    if (!floating.targetTopicId || floating.targetTabId === undefined && target.tabId)
      setFloating({ targetTopicId: target.topicId, ...(target.tabId ? { targetTabId: target.tabId } : {}) })
    else if (floating.targetTabId === undefined && !target.tabId && motes.some(topic => topic.id === target.topicId))
      setFloating({ targetTabId: null })
  }, [floating.open, floating.targetTopicId, floating.targetTabId, target.topicId, target.tabId, target.tab, motes, setFloating])
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
    setFloating({ open: true, preview: false, targetTopicId: topicId, targetTabId: tabId ?? null })
  }, [setFloating])
  const close = useCallback(() => { endResize(false); spaceActionRef.current?.abort(); requestPmoTeamsTopicFloatingClose() }, [endResize])
  const openSpace = useCallback(() => {
    spaceActionRef.current?.abort()
    const controller = new AbortController(); spaceActionRef.current = controller
    const opening = target.tabId ? openScratchTopic(target.topicId, SCRATCH_WORKSPACE_ID, {
      tabId: target.tabId, signal: controller.signal
    }) : (async () => {
      const topic = await api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, target.topicId)
      if (controller.signal.aborted) return
      const current = useAppStore.getState()
      if (!current.config) throw new Error('The Workspace is still restoring')
      const sources = spatialSources(current.config, [topic], current.spaceZoneBindings)
      const space = sources.spaces.find(space => space.topicId === target.topicId)
      const zone = space && sources.zones.find(zone => zone.zoneId === homeZoneId(space.spaceId) && zone.workspaceId === SCRATCH_WORKSPACE_ID &&
        sources.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === space.spaceId))
      if (!space || !zone) throw new Error('The original Topic Space is not available')
      const receipt = await current.executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'focus',
        target: { kind: 'space', spaceId: space.spaceId, zoneId: zone.zoneId }, inputPolicy: 'preserve' }, controller.signal)
      if (receipt.operation === 'focus' && receipt.navigation.state === 'rejected')
        throw new Error(receipt.issues[0]?.message ?? 'The original Topic Space could not be selected')
    })()
    const navigation = useAppStore.getState()
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.mainSurface !== navigation.mainSurface || state.activeWorkspaceId !== navigation.activeWorkspaceId) {
        // This action's own successful empty-Space selection is an expected navigation.
        if (!target.tabId && state.mainSurface === 'workbench' && state.activeWorkspaceId === SCRATCH_WORKSPACE_ID &&
          state.workbenchSpaceSelection?.topicId === target.topicId) return
        controller.abort()
      }
    })
    const disposeNavigation = () => { unsubscribe(); controller.signal.removeEventListener('abort', disposeNavigation) }
    if (controller.signal.aborted) disposeNavigation()
    else controller.signal.addEventListener('abort', disposeNavigation, { once: true })
    void opening.then(() => {
      if (controller === spaceActionRef.current && !controller.signal.aborted) requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }).catch(error => {
      if (controller === spaceActionRef.current && !controller.signal.aborted) {
        setPreparationIssue('Opening this context in Space did not complete. The original work surface remains available.'); reportError(error)
      }
    }).finally(disposeNavigation)
  }, [target.topicId, target.tabId, openScratchTopic, reportError])

  return <WorkbenchPresentationContext.Provider value={presentation}><div ref={panelRef} id="pmo-teams-topic-floating-panel" popover="auto" role="dialog" aria-modal="false"
    aria-label={target.label} aria-describedby="mote-floating-context-status" tabIndex={-1} className="pmo-teams-topic-floating"
    data-pmo-teams-topic-floating data-state={visible ? 'open' : 'closed'}
    data-mote-target-topic={target.topicId} data-mote-target-tab={target.tabId} data-mote-target-region={target.region?.regionId}
    data-mote-target-session={target.session?.id} data-mote-status={target.statusText}
    data-mote-presentation={floating.open ? 'pinned' : floating.preview ? 'preview' : 'closed'}
    data-mote-navigation={railMode}
    data-mote-resizing={resizing ? 'true' : 'false'}
    onToggle={event => { if (event.newState === 'closed' && (floatingRef.current.open || floatingRef.current.preview)) requestPmoTeamsTopicFloatingClose({ restoreFocus: false }) }}>
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
    {visible ? <MoteChooser topics={motes} topicId={target.topicId} tabId={floating.targetTabId === null ? null : target.tabId} railMode={railMode}
      onToggleMode={() => { pinPmoTeamsTopicFloating(); setFloating({ railMode: railMode === 'cards' ? 'avatars' : 'cards' }) }}
      onSelect={selectMote} onOpenSpace={openSpace} onClose={close} /> : null}
    <div className="pmo-teams-topic-floating__content">
    {floating.preferenceIssue ? <div role="status" className="workbench-restore-notice mote-size-notice">{floating.preferenceIssue}</div> : null}
    {!scratch ? <div role="status" className="workbench-restore-notice">Original Mote retained · Workspace is still restoring</div> : null}
    {visible && (directoryError || !topics || !motes.some(mote => mote.id === target.topicId)) ? <div role="status" className="workbench-restore-notice mote-context-notice">
      <span>{directoryError ? 'Mote directory could not be refreshed: ' + directoryError : 'Mote directory is not confirmed yet.'} The current work surface is retained.</span>
      <button type="button" className="small-button" onClick={() => void refreshTopics(SCRATCH_WORKSPACE_ID, true)}>Retry directory</button>
    </div> : null}
    {preparationIssue ? <div role="status" className="workbench-restore-notice mote-context-notice"><span>{preparationIssue}</span><button type="button" className="small-button" onClick={() => setPreparationAttempt(attempt => attempt + 1)}>Retry context</button></div> : null}
    <div className="pmo-teams-topic-floating__body">
      {!target.tabId && !motes.some(topic => topic.id === target.topicId) ?
        <div role="status" className="workbench-restore-notice" data-workbench-pending-owner>Original Mote retained · Topic directory is still being confirmed</div> :
        <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} topicId={target.topicId} topicIsolation="bound-only" viewOwnership="projection"
        viewHostPrefix={PMO_FLOATING_TAB_SLOT_PREFIX} projectionTabId={target.tabId} visible={visible} interactiveResize={false}
        onTabSelect={tabId => { if (tabId !== target.tabId) { spaceActionRef.current?.abort(); setFloating({ targetTabId: tabId }) } }} />}
    </div>
    </div>
  </div></WorkbenchPresentationContext.Provider>
}
