import { X, Maximize2 } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import {
  clampPmoTeamsTopicFloatingState,
  requestPmoTeamsTopicFloatingClose,
  PMO_FLOATING_TAB_SLOT_PREFIX,
  type PmoTeamsTopicFloatingState
} from '../lib/pmo-teams-topic-floating'
import { usePmoTeamsTopicTarget, type PmoTeamsTopicTarget } from '../lib/pmo-teams-topic-target'
import { pmoFocusSessionId } from '../lib/agent-focus'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { StatusDot } from './StatusDot'
const DRAG_THRESHOLD = 3

type PanelDrag = {
  pointerId: number
  startX: number
  startY: number
  latestX: number
  latestY: number
  left: number
  top: number
  moved: boolean
  frameId: number | null
}

export function PmoTeamsTopicFloatingPanel({ floating, setFloating }: {
  floating: PmoTeamsTopicFloatingState
  setFloating: (next: Partial<PmoTeamsTopicFloatingState>) => void
}): React.JSX.Element | null {
  const config = useAppStore((state) => state.config)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const focusPmoSession = useAppStore((state) => state.focusPmoSession)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const reportError = useAppStore((state) => state.reportError)
  const [opening, setOpening] = useState(false)
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const [preparationIssue, setPreparationIssue] = useState<string | null>(null)
  const wasOpenRef = useRef(false)
  const spaceActionRef = useRef<AbortController | null>(null)
  const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
  const visible = floating.open
  const target = usePmoTeamsTopicTarget(floating)
  const targetTabId = target.tabId
  const targetViewMode = useAppStore((state) => target.session ? state.viewModes[target.session.id] : undefined)

  useEffect(() => () => {
    spaceActionRef.current?.abort()
    spaceActionRef.current = null
  }, [floating.open, targetTabId])

  useEffect(() => {
    if (floating.open && !floating.targetTabId && targetTabId) {
      setFloating({ targetTabId })
    }
  }, [floating.open, floating.targetTabId, targetTabId, setFloating])

  useEffect(() => {
    if (floating.open && !wasOpenRef.current) {
      setOpening(true)
      const timer = window.setTimeout(() => setOpening(false), 220)
      wasOpenRef.current = true
      return () => window.clearTimeout(timer)
    }
    wasOpenRef.current = floating.open
  }, [floating.open])

  useEffect(() => {
    if (floating.open && target.session && pmoFocusSessionId(useAppStore.getState().agentFocus) !== target.session.id) {
      focusPmoSession(target.session.id)
    }
    if (floating.open && target.session && targetViewMode === undefined) setViewMode(target.session.id, 'activity')
  }, [floating.open, target.session, targetViewMode, focusPmoSession, setViewMode])

  useEffect(() => {
    if (!floating.open || !scratch) return
    let current = true
    void api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
      .then(async () => {
        await openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, {
          reveal: false,
          ...(targetTabId ? { tabId: targetTabId } : {})
        })
        if (current) setPreparationIssue(null)
      })
      .catch((error) => {
        if (current) {
          setPreparationIssue('Mote context preparation did not complete. The original context is kept; its current Agent status is shown above. Retry this context to finish preparation.')
          reportError(error)
        }
      })
    return () => { current = false }
  }, [floating.open, targetTabId, preparationAttempt, openScratchTopic, reportError, scratch])

  useEffect(() => {
    const onResize = (): void => setFloating(clampPmoTeamsTopicFloatingState(floating))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [floating, setFloating])

  const workbench = useMemo(
    () => <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} topicId={PMO_TEAMS_TOPIC_ID} topicIsolation="bound-only" viewOwnership="projection" viewHostPrefix={PMO_FLOATING_TAB_SLOT_PREFIX} projectionTabId={targetTabId} visible={visible} interactiveResize={false}
      onTabSelect={(tabId) => {
        if (tabId !== targetTabId) {
          spaceActionRef.current?.abort()
          setFloating({ targetTabId: tabId })
        }
      }} />,
    [visible, targetTabId, setFloating]
  )

  return (
    <PmoTeamsFloatingWindow
      floating={floating}
      target={target}
      opening={opening}
      visible={visible}
      onUpdate={setFloating}
      onClose={() => {
        spaceActionRef.current?.abort()
        requestPmoTeamsTopicFloatingClose()
      }}
      onOpenSpace={() => {
        spaceActionRef.current?.abort()
        const controller = new AbortController()
        spaceActionRef.current = controller
        const opening = openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, {
          ...(targetTabId ? { tabId: targetTabId } : {}), signal: controller.signal
        })
        const navigation = useAppStore.getState()
        const unsubscribe = useAppStore.subscribe((state) => {
          if (state.mainSurface !== navigation.mainSurface || state.activeWorkspaceId !== navigation.activeWorkspaceId) controller.abort()
        })
        const disposeNavigation = (): void => {
          unsubscribe()
          controller.signal.removeEventListener('abort', disposeNavigation)
        }
        if (controller.signal.aborted) disposeNavigation()
        else controller.signal.addEventListener('abort', disposeNavigation, { once: true })
        void opening.then(() => {
          if (controller === spaceActionRef.current && !controller.signal.aborted) {
            requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
          }
        }).catch((error) => {
          if (controller === spaceActionRef.current && !controller.signal.aborted) {
            setPreparationIssue('Opening this context in Space did not complete. The original context is kept here; retry Open Mote Space to continue its recovery.')
            reportError(error)
          }
        }).finally(disposeNavigation)
      }}
    >
      {!scratch ? <div role="status" className="workbench-restore-notice">Original Mote context retained · Workspace is still restoring · Reopen this context in Space to continue recovery</div> : null}
      {preparationIssue ? <div role="status" className="workbench-restore-notice mote-context-notice"><span>{preparationIssue}</span><button type="button" className="small-button" onClick={() => setPreparationAttempt((attempt) => attempt + 1)}>Retry context</button></div> : null}
      {workbench}
    </PmoTeamsFloatingWindow>
  )
}

type PmoTeamsFloatingWindowProps = {
  floating: PmoTeamsTopicFloatingState
  target: PmoTeamsTopicTarget
  opening: boolean
  visible: boolean
  onUpdate: (next: Partial<PmoTeamsTopicFloatingState>) => void
  onClose: () => void
  onOpenSpace: () => void
  children: React.ReactNode
}

const PmoTeamsFloatingWindow = memo(function PmoTeamsFloatingWindow({
  floating,
  target,
  opening,
  visible,
  onUpdate,
  onClose,
  onOpenSpace,
  children
}: PmoTeamsFloatingWindowProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelDragRef = useRef<PanelDrag | null>(null)
  const floatingRef = useRef(floating)
  floatingRef.current = floating

  useEffect(() => {
    if (!floating.open || !panelRef.current) return
    panelRef.current.focus({ preventScroll: true })
  }, [floating.open])

  useEffect(() => {
    if (!floating.open || !panelRef.current) return
    const element = panelRef.current
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width !== Math.round(floating.size.width) || height !== Math.round(floating.size.height)) {
        onUpdate({ size: { width, height } })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [floating.open, floating.size.height, floating.size.width, onUpdate])

  const clearDragFrame = (): void => {
    const drag = panelDragRef.current
    if (drag?.frameId !== null && drag?.frameId !== undefined) {
      window.cancelAnimationFrame(drag.frameId)
      drag.frameId = null
    }
  }

  const clearDragVisual = (): void => {
    clearDragFrame()
    if (panelRef.current) panelRef.current.style.transform = ''
  }

  const renderDragFrame = (): void => {
    const drag = panelDragRef.current
    if (!drag) return
    drag.frameId = null
    if (!drag.moved || !panelRef.current) return
    const current = floatingRef.current
    const next = clampPmoTeamsTopicFloatingState({
      ...current,
      position: {
        left: drag.left + drag.latestX - drag.startX,
        top: drag.top + drag.latestY - drag.startY
      }
    })
    panelRef.current.style.transform = `translate3d(${next.position.left - drag.left}px, ${next.position.top - drag.top}px, 0)`
  }

  const scheduleDragFrame = (): void => {
    const drag = panelDragRef.current
    if (!drag || drag.frameId !== null) return
    drag.frameId = window.requestAnimationFrame(renderDragFrame)
  }

  const finishPanelDrag = (commit: boolean, pointerId?: number): void => {
    const drag = panelDragRef.current
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return
    clearDragVisual()
    if (commit && drag.moved) {
      const current = floatingRef.current
      const next = clampPmoTeamsTopicFloatingState({
        ...current,
        position: {
          left: drag.left + drag.latestX - drag.startX,
          top: drag.top + drag.latestY - drag.startY
        }
      })
      onUpdate({ position: next.position })
    }
    const target = panelRef.current
    if (target && target.hasPointerCapture?.(drag.pointerId)) {
      try { target.releasePointerCapture(drag.pointerId) } catch { /* pointer already cancelled */ }
    }
    panelDragRef.current = null
    setDragging(false)
  }

  useEffect(() => {
    const cancel = (): void => finishPanelDrag(false)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel()
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onKeyDown)
      finishPanelDrag(false)
    }
  }, [])

  const onPanelPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    panelDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      left: floating.position.left,
      top: floating.position.top,
      moved: false,
      frameId: null
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPanelPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = panelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.latestX = event.clientX
    drag.latestY = event.clientY
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    event.preventDefault()
    scheduleDragFrame()
  }
  const onPanelPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    finishPanelDrag(true, event.pointerId)
  }

  const geometry = { left: floating.position.left, top: floating.position.top, width: floating.size.width, height: floating.size.height }
  return (
    <div
      ref={panelRef}
      className={`pmo-teams-topic-floating${floating.open ? '' : ' pmo-teams-topic-floating--hidden'}${opening ? ' pmo-teams-topic-floating--opening' : ''}${dragging ? ' is-dragging' : ''}`}
      id="pmo-teams-topic-floating-panel"
      role="dialog"
      aria-modal="false"
      aria-hidden={!visible}
      aria-label={target.label}
      aria-describedby="mote-floating-context-status"
      data-pmo-teams-topic-floating
      data-mote-target-tab={target.tabId}
      data-mote-target-region={target.region?.regionId}
      data-mote-target-session={target.session?.id}
      data-mote-status={target.statusText}
      tabIndex={-1}
      style={floating.open ? { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height } : undefined}
    >
      <div className={`pmo-teams-topic-floating__shell${dragging ? ' is-dragging' : ''}`}>
        {floating.open ? (
          <div
            className="pmo-teams-topic-floating__titlebar pmo-teams-topic-floating__titlebar--attached"
            onPointerDown={onPanelPointerDown}
            onPointerMove={onPanelPointerMove}
            onPointerUp={onPanelPointerEnd}
            onPointerCancel={onPanelPointerEnd}
          >
            <span className="pmo-teams-topic-floating__identity">
              <img src={pmoTeamsTopicAvatar} alt="" aria-hidden="true" />
              <strong className="pmo-teams-topic-floating__title">Mote</strong>
            </span>
            {target.name !== PMO_TEAMS_TOPIC_TITLE ? <span className="pmo-teams-topic-floating__topic" title={target.name}>{target.name}</span> : null}
            <span className="pmo-teams-topic-floating__status" id="mote-floating-context-status" title={`${target.label} · ${target.statusText}`}>
              {target.session ? <StatusDot status={target.session.status} /> : null}<span>{target.statusText}</span>
            </span>
            <div className="pmo-teams-topic-floating__actions" onPointerDown={(event) => event.stopPropagation()}>
              <button type="button" aria-label="Open Mote Space" aria-describedby="mote-floating-context-status" title={`Open ${target.label} in Space`} onClick={onOpenSpace}><Maximize2 size={13} /></button>
              <button type="button" aria-label={`Close ${PMO_TEAMS_TOPIC_TITLE}`} title="Close" onClick={onClose}><X size={13} /></button>
            </div>
          </div>
        ) : null}
        <div className="pmo-teams-topic-floating__body">{children}</div>
      </div>
    </div>
  )
})
