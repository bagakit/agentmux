import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import pmoTeamsTopicAvatar from '../assets/pmo-teams-topic-avatar.png'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import {
  clampPmoTeamsTopicFloatingState,
  requestPmoTeamsTopicFloatingClose,
  usePmoTeamsTopicFloatingState
} from '../lib/pmo-teams-topic-floating'
import { topicIdForSession } from '../lib/workbench-tabs'
import { executionFocusContextText, pmoFocusSessionId } from '../lib/agent-focus'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
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

export function PmoTeamsTopicFloatingPanel(): React.JSX.Element | null {
  const config = useAppStore((state) => state.config)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore((state) => state.layouts)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const focusPmoSession = useAppStore((state) => state.focusPmoSession)
  const agentFocus = useAppStore((state) => state.agentFocus)
  const pmoSessionId = useAppStore((state) => pmoFocusSessionId(state.agentFocus))
  const agentNames = useAppStore((state) => state.agentNames)
  const reportError = useAppStore((state) => state.reportError)
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const [dragging, setDragging] = useState(false)
  const [opening, setOpening] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelDragRef = useRef<PanelDrag | null>(null)
  const floatingRef = useRef(floating)
  floatingRef.current = floating
  const deliveredPromptRef = useRef<string | null>(null)
  const conversationInitializedRef = useRef<string | null>(null)
  const wasOpenRef = useRef(false)
  const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
  const visible = floating.open

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
    if (!floating.open) {
      conversationInitializedRef.current = null
      return
    }
    const targetTab = floating.targetTabId ? tabs[floating.targetTabId] : undefined
    const targetSurface = targetTab?.regions[targetTab.layout.activeRegionId]
    const targetSession = targetSurface?.kind === 'agent'
      ? sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => session.kind === 'agent' && session.id === targetSurface.sessionId)
      : undefined
    const pmoTeamsSession = floating.targetTabId
      ? targetSession
      : sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.kind === 'agent')
    if (pmoTeamsSession && (conversationInitializedRef.current !== pmoTeamsSession.id || pmoSessionId !== pmoTeamsSession.id)) {
      conversationInitializedRef.current = pmoTeamsSession.id
      focusPmoSession(pmoTeamsSession.id)
      setViewMode(pmoTeamsSession.id, 'activity')
    }
  }, [config, floating.open, floating.targetTabId, focusPmoSession, pmoSessionId, sessions, setViewMode, tabs])

  useEffect(() => {
    if (!floating.open || !scratch) return
    void api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
      .then(async (snapshot) => {
        if (snapshot.title !== PMO_TEAMS_TOPIC_TITLE) {
          await api.scratch.renameTitle(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE)
        }
        await openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, {
          reveal: false,
          ...(floating.targetTabId ? { tabId: floating.targetTabId } : {})
        })
      })
      .catch(reportError)
  }, [floating.open, floating.pendingPrompt, floating.targetTabId, openScratchTopic, reportError, scratch, setFloating])

  useEffect(() => {
    const pending = floating.open ? floating.pendingPrompt : undefined
    if (!pending || deliveredPromptRef.current === pending.id || !scratch) return
    const targetTabId = floating.targetTabId
    const targetTab = targetTabId ? tabs[targetTabId] : undefined
    const targetSurface = targetTab?.regions[targetTab.layout.activeRegionId]
    const targetSessionId = targetSurface?.kind === 'agent' ? targetSurface.sessionId : undefined
    const pmoTeamsSession = targetTabId
      ? sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => session.kind === 'agent' && session.id === targetSessionId)
      : sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.kind === 'agent')
    if (pmoTeamsSession) {
      deliveredPromptRef.current = pending.id
      focusPmoSession(pmoTeamsSession.id)
      setViewMode(pmoTeamsSession.id, 'activity')
      void api.sessions.submitPrompt(pmoTeamsSession.control, pending.text, pending.id)
        .then(() => setFloating({ pendingPrompt: undefined }))
        .catch((error) => {
          deliveredPromptRef.current = null
          reportError(error)
        })
      return
    }
    const pmoTeamsTab = targetTabId
      ? (targetTab?.workspaceId === SCRATCH_WORKSPACE_ID && targetTab.topicId === PMO_TEAMS_TOPIC_ID ? targetTab : undefined)
      : Object.values(tabs).find((tab) => tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === PMO_TEAMS_TOPIC_ID)
    const layout = layouts[SCRATCH_WORKSPACE_ID]
    const group = pmoTeamsTab && layout?.groups.find((entry) => entry.tabOrder.includes(pmoTeamsTab.id))
    const regionId = pmoTeamsTab?.layout.activeRegionId
    const executorId = Object.keys(config?.executors ?? {})[0]
    if (!pmoTeamsTab || !group || !regionId || !executorId) return
    deliveredPromptRef.current = pending.id
    const executionContext = executionFocusContextText(agentFocus, sessions, (session) => agentNames[session.id] ?? session.label)
    void launchAgent(executorId, [pending.text, executionContext].join('\n\n'), group.id, {
      tabId: pmoTeamsTab.id,
      regionId
    }).then(() => setFloating({ pendingPrompt: undefined })).catch((error) => {
      deliveredPromptRef.current = null
      reportError(error)
    })
  }, [agentFocus, agentNames, config, floating.open, floating.pendingPrompt, floating.targetTabId, focusPmoSession, launchAgent, layouts, reportError, scratch, sessions, setFloating, setViewMode, tabs])

  useEffect(() => {
    const onResize = (): void => setFloating(clampPmoTeamsTopicFloatingState(floating))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [floating, setFloating])

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
        setFloating({ size: { width, height } })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [floating.open, floating.size.height, floating.size.width, setFloating])

  const geometry = { left: floating.position.left, top: floating.position.top, width: floating.size.width, height: floating.size.height }

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
      setFloating({ position: next.position })
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

  if (!scratch) return null

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

  return (
    <>
      <div
        ref={panelRef}
        className={`pmo-teams-topic-floating${floating.open ? '' : ' pmo-teams-topic-floating--hidden'}${opening ? ' pmo-teams-topic-floating--opening' : ''}${dragging ? ' is-dragging' : ''}`}
        id="pmo-teams-topic-floating-panel"
        role="dialog"
        aria-modal="false"
        aria-hidden={!visible}
        aria-label={PMO_TEAMS_TOPIC_TITLE}
        data-pmo-teams-topic-floating
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
                <span><strong className="pmo-teams-topic-floating__title" title={PMO_TEAMS_TOPIC_TITLE}>PMO teams</strong><small>Request routing</small></span>
              </span>
              <div className="pmo-teams-topic-floating__actions" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" aria-label={`Close ${PMO_TEAMS_TOPIC_TITLE}`} title="Close" onClick={requestPmoTeamsTopicFloatingClose}><X size={13} /></button>
              </div>
            </div>
          ) : null}
          <div className="pmo-teams-topic-floating__body">
            <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} topicId={PMO_TEAMS_TOPIC_ID} topicIsolation="bound-only" visible={visible} interactiveResize={false} />
          </div>
        </div>
      </div>
    </>
  )
}
