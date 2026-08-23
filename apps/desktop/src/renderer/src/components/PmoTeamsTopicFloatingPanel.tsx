import { Maximize2, Minimize2, X } from 'lucide-react'
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
import { PmoTeamsTopicEntry } from './PmoTeamsTopicEntry'

const DRAG_THRESHOLD = 3
const ATTACHED_LAUNCHER_OFFSET = { left: 12, top: 4 }

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
  const [launcherDragging, setLauncherDragging] = useState(false)
  const [opening, setOpening] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const launcherDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const suppressLauncherClickRef = useRef(false)
  const restoreFrameRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
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
    const leaderSession = sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.kind === 'agent')
    if (leaderSession && conversationInitializedRef.current !== leaderSession.id) {
      conversationInitializedRef.current = leaderSession.id
      setViewMode(leaderSession.id, 'activity')
    }
  }, [config, floating.open, sessions, setViewMode])

  useEffect(() => {
    if (!floating.open || floating.openAnchor !== 'compact' || typeof window === 'undefined') return
    const width = Math.max(420, Math.min(floating.size.width, Math.max(420, window.innerWidth - 32)))
    const height = Math.max(280, Math.min(floating.size.height, Math.max(280, window.innerHeight - 48)))
    const compactLeft = Math.max(16, Math.min(window.innerWidth - width - 16, window.innerWidth - width - 32))
    const compactTop = Math.max(16, window.innerHeight - height - 64)
    setFloating(clampPmoTeamsTopicFloatingState({
      ...floating,
      position: { left: compactLeft, top: compactTop },
      openAnchor: undefined
    }))
  }, [floating, setFloating])

  useEffect(() => {
    if (!floating.open || !scratch) return
    void api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
      .then(async (snapshot) => {
        if (snapshot.title !== PMO_TEAMS_TOPIC_TITLE) {
          await api.scratch.renameTitle(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE)
        }
        await openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false })
      })
      .catch(reportError)
  }, [floating.open, openScratchTopic, reportError, scratch])

  useEffect(() => {
    const pending = floating.open ? floating.pendingPrompt : undefined
    if (!pending || deliveredPromptRef.current === pending.id || !scratch) return
    const leaderSession = sessions.find((session): session is Extract<typeof session, { kind: 'agent' }> => topicIdForSession(config, session) === PMO_TEAMS_TOPIC_ID && session.kind === 'agent')
    if (leaderSession) {
      deliveredPromptRef.current = pending.id
      setViewMode(leaderSession.id, 'activity')
      void api.sessions.submitPrompt(leaderSession.control, pending.text, pending.id)
        .then(() => setFloating({ pendingPrompt: undefined }))
        .catch((error) => {
          deliveredPromptRef.current = null
          reportError(error)
        })
      return
    }
    const leaderTab = Object.values(tabs).find((tab) => tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === PMO_TEAMS_TOPIC_ID)
    const layout = layouts[SCRATCH_WORKSPACE_ID]
    const group = leaderTab && layout?.groups.find((entry) => entry.tabOrder.includes(leaderTab.id))
    const regionId = leaderTab?.layout.activeRegionId
    const executorId = Object.keys(config?.executors ?? {})[0]
    if (!leaderTab || !group || !regionId || !executorId) return
    deliveredPromptRef.current = pending.id
    void launchAgent(executorId, pending.text, group.id, {
      tabId: leaderTab.id,
      regionId
    }).then(() => setFloating({ pendingPrompt: undefined })).catch((error) => {
      deliveredPromptRef.current = null
      reportError(error)
    })
  }, [config, floating.open, floating.pendingPrompt, launchAgent, layouts, reportError, scratch, sessions, setFloating, setViewMode, tabs])

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
    if (!floating.open || !panelRef.current || floating.maximized) return
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
  }, [floating.open, floating.maximized, floating.size.height, floating.size.width, setFloating])

  if (!scratch) {
    return <PmoTeamsTopicEntry placement="floating" />
  }

  const geometry = floating.maximized && typeof window !== 'undefined'
    ? { left: 16, top: 16, width: Math.max(420, window.innerWidth - 32), height: Math.max(280, window.innerHeight - 48) }
    : { left: floating.position.left, top: floating.position.top, width: floating.size.width, height: floating.size.height }

  const toggleMaximized = (): void => {
    if (floating.maximized) {
      const restore = restoreFrameRef.current
      setFloating({ maximized: false, ...(restore ? { position: { left: restore.left, top: restore.top }, size: { width: restore.width, height: restore.height } } : {}) })
      return
    }
    restoreFrameRef.current = { left: floating.position.left, top: floating.position.top, width: floating.size.width, height: floating.size.height }
    setFloating({ maximized: true })
  }

  const onPanelPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (floating.maximized || event.button !== 0) return
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
      launcherPosition: floating.open
        ? { left: position.left + ATTACHED_LAUNCHER_OFFSET.left, top: position.top + ATTACHED_LAUNCHER_OFFSET.top }
        : floating.launcherPosition
    }))
  }
  const onPanelPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = panelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    panelDragRef.current = null
    setDragging(false)
  }

  const onLauncherPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const origin = floating.open
      ? { left: floating.position.left, top: floating.position.top }
      : floating.launcherPosition
    launcherDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: origin.left, top: origin.top, moved: false }
    suppressLauncherClickRef.current = false
    setLauncherDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onLauncherPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = launcherDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    suppressLauncherClickRef.current = true
    const position = { left: drag.left + dx, top: drag.top + dy }
    setFloating(clampPmoTeamsTopicFloatingState({
      ...floating,
      ...(floating.open ? {
        position,
        launcherPosition: { left: position.left + ATTACHED_LAUNCHER_OFFSET.left, top: position.top + ATTACHED_LAUNCHER_OFFSET.top }
      } : { launcherPosition: position })
    }))
  }
  const onLauncherPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = launcherDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    launcherDragRef.current = null
    setLauncherDragging(false)
  }
  const onLauncherOpen = (): void => {
    if (suppressLauncherClickRef.current) {
      suppressLauncherClickRef.current = false
      return
    }
    if (floating.open) {
      requestPmoTeamsTopicFloatingClose()
      return
    }
    const position = typeof window === 'undefined'
      ? floating.position
      : {
          left: floating.launcherPosition.left - ATTACHED_LAUNCHER_OFFSET.left,
          top: floating.launcherPosition.top > window.innerHeight / 2
            ? floating.launcherPosition.top - floating.size.height - 8
            : floating.launcherPosition.top + 42 + 8
        }
    setFloating(clampPmoTeamsTopicFloatingState({ ...floating, open: true, position }))
  }

  return (
    <>
      <PmoTeamsTopicEntry
        placement="floating"
        style={floating.open
          ? { left: geometry.left + ATTACHED_LAUNCHER_OFFSET.left, top: geometry.top + ATTACHED_LAUNCHER_OFFSET.top }
          : { left: floating.launcherPosition.left, top: floating.launcherPosition.top }}
        attached={floating.open}
        dragging={launcherDragging}
        onPointerDown={onLauncherPointerDown}
        onPointerMove={onLauncherPointerMove}
        onPointerUp={onLauncherPointerEnd}
        onPointerCancel={onLauncherPointerEnd}
        onOpen={onLauncherOpen}
      />
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
              <strong>{PMO_TEAMS_TOPIC_TITLE}</strong>
              <div className="pmo-teams-topic-floating__actions" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" aria-label={floating.maximized ? `Restore ${PMO_TEAMS_TOPIC_TITLE}` : `Maximize ${PMO_TEAMS_TOPIC_TITLE}`} title={floating.maximized ? 'Restore' : 'Maximize'} onClick={toggleMaximized}>{floating.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
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
