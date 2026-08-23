import { Maximize2, Minus, Minimize2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { LEADER_TOPIC_ID, LEADER_TOPIC_TITLE, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import {
  clampLeaderTopicFloatingState,
  requestLeaderTopicFloatingClose,
  useLeaderTopicFloatingState
} from '../lib/leader-topic-floating'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { LeaderTopicEntry } from './LeaderTopicEntry'

const DRAG_THRESHOLD = 3
const ATTACHED_LAUNCHER_OFFSET = { left: 12, top: 4 }

export function LeaderTopicFloatingPanel(): React.JSX.Element | null {
  const config = useAppStore((state) => state.config)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const reportError = useAppStore((state) => state.reportError)
  const [floating, setFloating] = useLeaderTopicFloatingState()
  const [dragging, setDragging] = useState(false)
  const [launcherDragging, setLauncherDragging] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const launcherDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const suppressLauncherClickRef = useRef(false)
  const restoreFrameRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
  const visible = floating.open

  useEffect(() => {
    if (!floating.open || !scratch) return
    void api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, LEADER_TOPIC_ID)
      .then(async (snapshot) => {
        if (snapshot.title !== LEADER_TOPIC_TITLE) {
          await api.scratch.renameTitle(SCRATCH_WORKSPACE_ID, LEADER_TOPIC_ID, LEADER_TOPIC_TITLE)
        }
        await openScratchTopic(LEADER_TOPIC_ID, SCRATCH_WORKSPACE_ID)
      })
      .catch(reportError)
  }, [floating.open, openScratchTopic, reportError, scratch])

  useEffect(() => {
    const onResize = (): void => setFloating(clampLeaderTopicFloatingState(floating))
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
    return <LeaderTopicEntry placement="floating" />
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
    setFloating(clampLeaderTopicFloatingState({
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
    setFloating(clampLeaderTopicFloatingState({
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
      requestLeaderTopicFloatingClose()
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
    setFloating(clampLeaderTopicFloatingState({ ...floating, open: true, position }))
  }

  return (
    <>
      <LeaderTopicEntry
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
        className={`leader-topic-floating${floating.open ? '' : ' leader-topic-floating--hidden'}`}
        id="leader-topic-floating-panel"
        role="dialog"
        aria-modal="false"
        aria-hidden={!visible}
        aria-label={LEADER_TOPIC_TITLE}
        data-leader-topic-floating
        tabIndex={-1}
        style={floating.open ? { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height } : undefined}
      >
        <div className={`leader-topic-floating__shell${dragging ? ' is-dragging' : ''}`}>
          {floating.open ? (
            <div
              className="leader-topic-floating__titlebar leader-topic-floating__titlebar--attached"
              onPointerDown={onPanelPointerDown}
              onPointerMove={onPanelPointerMove}
              onPointerUp={onPanelPointerEnd}
              onPointerCancel={onPanelPointerEnd}
            >
              <strong>{LEADER_TOPIC_TITLE}</strong>
              <span className="leader-topic-floating__topic">{LEADER_TOPIC_ID}</span>
              <div className="leader-topic-floating__actions" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" aria-label={floating.maximized ? `Restore ${LEADER_TOPIC_TITLE}` : `Maximize ${LEADER_TOPIC_TITLE}`} title={floating.maximized ? 'Restore' : 'Maximize'} onClick={toggleMaximized}>{floating.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
                <button type="button" aria-label={`Minimize ${LEADER_TOPIC_TITLE}`} title="Minimize" onClick={requestLeaderTopicFloatingClose}><Minus size={13} /></button>
                <button type="button" aria-label={`Close ${LEADER_TOPIC_TITLE}`} title="Close" onClick={requestLeaderTopicFloatingClose}><X size={13} /></button>
              </div>
            </div>
          ) : null}
          <div className="leader-topic-floating__body">
            <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} topicId={LEADER_TOPIC_ID} topicIsolation="bound-only" visible={visible} interactiveResize={false} />
          </div>
        </div>
      </div>
    </>
  )
}
