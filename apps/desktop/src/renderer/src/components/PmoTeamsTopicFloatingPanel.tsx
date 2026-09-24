import { X, Maximize2 } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { keepPmoTeamsTopicFloatingPreview, leavePmoTeamsTopicFloatingPreview, pinPmoTeamsTopicFloating,
  createPmoTeamsTopicTargetSelector, requestPmoTeamsTopicFloatingClose, PMO_FLOATING_TAB_SLOT_PREFIX,
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

const MoteChoice = memo(function MoteChoice({ topic, selected, savedTabId, onSelect }: {
  topic: ScratchTopicSnapshot; selected: boolean; savedTabId: string | undefined
  onSelect(topicId: string, tabId: string | undefined): void
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
  return <button type="button" className="mote-chooser__choice" data-mote-topic-id={topic.id}
    data-mote-target-tab={tabId} data-mote-status={status} aria-pressed={selected}
    aria-label={topic.title + ' · ' + status} title={topic.title + ' · ' + status} onClick={() => onSelect(topic.id, tabId)}>
    <span className="mote-chooser__name">
      {topic.id === PMO_TEAMS_TOPIC_ID && manualIcon === null ? <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" /> :
        <SpaceObjectIcon kind={iconTarget?.kind ?? 'mote'} name={topic.title} manualIcon={manualIcon} />}
      <strong>{topic.title}</strong>
    </span><span className="mote-chooser__status">{session ? <StatusDot status={session.status} /> : null}{status}</span>
  </button>
})
const MoteChooser = memo(function MoteChooser({ topics, topicId, tabId, onSelect, onOpenSpace, onClose }: {
  topics: readonly ScratchTopicSnapshot[]; topicId: string; tabId: string | undefined
  onSelect(topicId: string, tabId: string | undefined): void; onOpenSpace(): void; onClose(): void
}) {
  return <div className="mote-chooser">
    <div className="mote-chooser__choices" role="group" aria-label="Motes">
      {topics.map(topic => <MoteChoice key={topic.id} topic={topic} selected={topic.id === topicId} savedTabId={tabId} onSelect={onSelect} />)}
    </div>
    <div className="mote-chooser__actions">
      <button type="button" aria-label="Open Mote Space" title="Open current Mote in Space" onClick={onOpenSpace}><Maximize2 size={13} /></button>
      <button type="button" aria-label="Close Mote" title="Close" onClick={onClose}><X size={13} /></button>
    </div>
  </div>
})

function foreignFloatOwnsKeyboardEvent(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  const owner = event.target instanceof Element
    ? event.target.closest('[data-overlay-layer], [popover], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]')
    : null
  return Boolean(owner && owner !== panel && (!owner.hasAttribute('popover') || owner.matches(':popover-open')))
}

export function PmoTeamsTopicFloatingPanel({ floating, setFloating }: {
  floating: PmoTeamsTopicFloatingState; setFloating(next: Partial<PmoTeamsTopicFloatingState>): void
}): React.JSX.Element {
  const scratch = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const openScratchTopic = useAppStore(state => state.openScratchTopic)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const reportError = useAppStore(state => state.reportError)
  const refreshTopics = useAppStore(state => state.refreshScratchTopics)
  const { topics, error: directoryError } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const motes = useMemo(() => scratchMoteTopics(topics), [topics])
  const target = usePmoTeamsTopicTarget(floating)
  const visible = floating.open || floating.preview
  const panelRef = useRef<HTMLDivElement>(null)
  const floatingRef = useRef(floating); floatingRef.current = floating
  const spaceActionRef = useRef<AbortController | null>(null)
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const [preparationIssue, setPreparationIssue] = useState<string | null>(null)

  useEffect(() => () => { spaceActionRef.current?.abort(); spaceActionRef.current = null },
    [floating.open, floating.preview, target.topicId, target.tabId])
  useEffect(() => {
    if (floating.open && (!floating.targetTopicId || !floating.targetTabId && target.tabId))
      setFloating({ targetTopicId: target.topicId, ...(target.tabId ? { targetTabId: target.tabId } : {}) })
  }, [floating.open, floating.targetTopicId, floating.targetTabId, target.topicId, target.tabId, setFloating])
  useEffect(() => {
    if (floating.open && target.session && pmoFocusSessionId(useAppStore.getState().agentFocus) !== target.session.id) focusPmoSession(target.session.id)
  }, [floating.open, target.session, focusPmoSession])
  useEffect(() => {
    if (!floating.open || !scratch) return
    let current = true
    setPreparationIssue(null)
    void api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, target.topicId)
      .then(() => openScratchTopic(target.topicId, SCRATCH_WORKSPACE_ID, {
        reveal: false, ...(target.tabId ? { tabId: target.tabId } : {})
      })).catch(error => {
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
          panel.style.width = Math.max(0, Math.min(720, availableWidth)) + 'px'
          panel.style.height = Math.max(0, Math.min(520, availableHeight)) + 'px'
        }
      })] })
      if (!disposed) Object.assign(panel.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
    }
    panel.style.visibility = 'hidden'
    const stop = autoUpdate(anchor, panel, () => { void position() })
    return () => { disposed = true; stop() }
  }, [visible])
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
    setFloating({ open: true, preview: false, targetTopicId: topicId, targetTabId: tabId })
  }, [setFloating])
  const close = useCallback(() => { spaceActionRef.current?.abort(); requestPmoTeamsTopicFloatingClose() }, [])
  const openSpace = useCallback(() => {
    spaceActionRef.current?.abort()
    const controller = new AbortController(); spaceActionRef.current = controller
    const opening = openScratchTopic(target.topicId, SCRATCH_WORKSPACE_ID, {
      ...(target.tabId ? { tabId: target.tabId } : {}), signal: controller.signal
    })
    const navigation = useAppStore.getState()
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.mainSurface !== navigation.mainSurface || state.activeWorkspaceId !== navigation.activeWorkspaceId) controller.abort()
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

  return <WorkbenchPresentationContext.Provider value={floating.open}><div ref={panelRef} id="pmo-teams-topic-floating-panel" popover="auto" role="dialog" aria-modal="false"
    aria-label={target.label} aria-describedby="mote-floating-context-status" tabIndex={-1} className="pmo-teams-topic-floating"
    data-pmo-teams-topic-floating data-state={visible ? 'open' : 'closed'}
    data-mote-target-topic={target.topicId} data-mote-target-tab={target.tabId} data-mote-target-region={target.region?.regionId}
    data-mote-target-session={target.session?.id} data-mote-status={target.statusText}
    data-mote-presentation={floating.open ? 'pinned' : floating.preview ? 'preview' : 'closed'}
    onToggle={event => { if (event.newState === 'closed' && (floatingRef.current.open || floatingRef.current.preview)) requestPmoTeamsTopicFloatingClose({ restoreFocus: false }) }}>
    <span hidden id="mote-floating-context-status">{target.label} · {target.statusText}</span>
    {visible ? <MoteChooser topics={motes} topicId={target.topicId} tabId={target.tabId} onSelect={selectMote} onOpenSpace={openSpace} onClose={close} /> : null}
    {!scratch ? <div role="status" className="workbench-restore-notice">Original Mote retained · Workspace is still restoring</div> : null}
    {visible && (directoryError || !topics || !motes.some(mote => mote.id === target.topicId)) ? <div role="status" className="workbench-restore-notice mote-context-notice">
      <span>{directoryError ? 'Mote directory could not be refreshed: ' + directoryError : 'Mote directory is not confirmed yet.'} The current work surface is retained.</span>
      <button type="button" className="small-button" onClick={() => void refreshTopics(SCRATCH_WORKSPACE_ID, true)}>Retry directory</button>
    </div> : null}
    {preparationIssue ? <div role="status" className="workbench-restore-notice mote-context-notice"><span>{preparationIssue}</span><button type="button" className="small-button" onClick={() => setPreparationAttempt(attempt => attempt + 1)}>Retry context</button></div> : null}
    <div className="pmo-teams-topic-floating__body">
      <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} topicId={target.topicId} topicIsolation="bound-only" viewOwnership="projection"
        viewHostPrefix={PMO_FLOATING_TAB_SLOT_PREFIX} projectionTabId={target.tabId} visible={visible} interactiveResize={false}
        onTabSelect={tabId => { if (tabId !== target.tabId) { spaceActionRef.current?.abort(); setFloating({ targetTabId: tabId }) } }} />
    </div>
  </div></WorkbenchPresentationContext.Provider>
}
