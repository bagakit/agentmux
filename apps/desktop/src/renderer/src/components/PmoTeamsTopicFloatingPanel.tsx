import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import {
  clampPmoTeamsTopicFloatingState,
  requestPmoTeamsTopicFloatingClose,
  usePmoTeamsTopicFloatingState
} from '../lib/pmo-teams-topic-floating'
import { topicIdForSession } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
const DRAG_THRESHOLD = 3

export function PmoTeamsTopicFloatingPanel(): React.JSX.Element | null {
  const config = useAppStore((state) => state.config)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore((state) => state.layouts)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const reportError = useAppStore((state) => state.reportError)
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const [dragging, setDragging] = useState(false)
  const [opening, setOpening] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
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
    const pmoTeamsSession = sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.kind === 'agent')
    if (pmoTeamsSession && conversationInitializedRef.current !== pmoTeamsSession.id) {
      conversationInitializedRef.current = pmoTeamsSession.id
      setViewMode(pmoTeamsSession.id, 'activity')
    }
  }, [config, floating.open, sessions, setViewMode])

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
        if (!floating.pendingPrompt && floating.targetTabId) setFloating({ targetTabId: undefined })
      })
      .catch(reportError)
  }, [floating.open, floating.pendingPrompt, floating.targetTabId, openScratchTopic, reportError, scratch, setFloating])

  useEffect(() => {
    const pending = floating.open ? floating.pendingPrompt : undefined
    if (!pending || deliveredPromptRef.current === pending.id || !scratch) return
    const targetTab = floating.targetTabId ? tabs[floating.targetTabId] : undefined
    const targetSurface = targetTab?.regions[targetTab.layout.activeRegionId]
    const targetSessionId = targetSurface?.kind === 'agent' ? targetSurface.sessionId : undefined
    const pmoTeamsSession = sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => session.kind === 'agent' && session.id === targetSessionId)
      ?? sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.kind === 'agent')
    if (pmoTeamsSession) {
      deliveredPromptRef.current = pending.id
      setViewMode(pmoTeamsSession.id, 'activity')
      void api.sessions.submitPrompt(pmoTeamsSession.control, pending.text, pending.id)
        .then(() => setFloating({ pendingPrompt: undefined, targetTabId: undefined }))
        .catch((error) => {
          deliveredPromptRef.current = null
          reportError(error)
        })
      return
    }
    const pmoTeamsTab = targetTab?.workspaceId === SCRATCH_WORKSPACE_ID && targetTab.topicId === PMO_TEAMS_TOPIC_ID
      ? targetTab
      : Object.values(tabs).find((tab) => tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === PMO_TEAMS_TOPIC_ID)
    const layout = layouts[SCRATCH_WORKSPACE_ID]
    const group = pmoTeamsTab && layout?.groups.find((entry) => entry.tabOrder.includes(pmoTeamsTab.id))
    const regionId = pmoTeamsTab?.layout.activeRegionId
    const executorId = Object.keys(config?.executors ?? {})[0]
    if (!pmoTeamsTab || !group || !regionId || !executorId) return
    deliveredPromptRef.current = pending.id
    void launchAgent(executorId, pending.text, group.id, {
      tabId: pmoTeamsTab.id,
      regionId
    }).then(() => setFloating({ pendingPrompt: undefined, targetTabId: undefined })).catch((error) => {
      deliveredPromptRef.current = null
      reportError(error)
    })
  }, [config, floating.open, floating.pendingPrompt, floating.targetTabId, launchAgent, layouts, reportError, scratch, sessions, setFloating, setViewMode, tabs])

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

  if (!scratch) return null

  const geometry = { left: floating.position.left, top: floating.position.top, width: floating.size.width, height: floating.size.height }

  const onPanelPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    panelDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: floating.position.left, top: floating.position.top, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPanelPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = panelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    const position = { left: drag.left + dx, top: drag.top + dy }
    setFloating(clampPmoTeamsTopicFloatingState({
      ...floating,
      position,
    }))
  }
  const onPanelPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = panelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    panelDragRef.current = null
    setDragging(false)
  }

  return (
    <>
      <div
        ref={panelRef}
        className={`pmo-teams-topic-floating${floating.open ? '' : ' pmo-teams-topic-floating--hidden'}${opening ? ' pmo-teams-topic-floating--opening' : ''}`}
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
              <strong className="pmo-teams-topic-floating__title" title={PMO_TEAMS_TOPIC_TITLE}>PMO teams</strong>
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
