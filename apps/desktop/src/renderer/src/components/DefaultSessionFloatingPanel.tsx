import { Maximize2, Minus, Minimize2, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import {
  clampDefaultSessionFloatingState,
  requestDefaultSessionFloatingClose,
  useDefaultSessionFloatingState
} from '../lib/default-session-floating'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { DefaultSessionEntry } from './DefaultSessionEntry'

const DRAG_THRESHOLD = 3

export function DefaultSessionFloatingPanel(): React.JSX.Element | null {
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const reportError = useAppStore((state) => state.reportError)
  const [floating, setFloating] = useDefaultSessionFloatingState()
  const [dragging, setDragging] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const restoreFrameRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)
  const mainMode = activeWorkspaceId === SCRATCH_WORKSPACE_ID && mainSurface === 'workbench' && !floating.open
  const visible = floating.open || mainMode

  useEffect(() => {
    if (!floating.open || !scratch) return
    void openScratchTopic('launcher:default', SCRATCH_WORKSPACE_ID).catch(reportError)
  }, [floating.open, openScratchTopic, reportError, scratch])

  useEffect(() => {
    if (!floating.open) return
    const onResize = (): void => setFloating(clampDefaultSessionFloatingState(floating))
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

  if (!scratch) return <DefaultSessionEntry placement="floating" />

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

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (floating.maximized || event.button !== 0) return
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: floating.position.left, top: floating.position.top, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    setFloating(clampDefaultSessionFloatingState({ ...floating, position: { left: drag.left + dx, top: drag.top + dy } }))
  }
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  return (
    <>
      <DefaultSessionEntry placement="floating" />
      <div
        ref={panelRef}
        className={`default-session-floating${floating.open ? '' : ' default-session-floating--main'}${visible ? '' : ' default-session-floating--hidden'}`}
        role="dialog"
        aria-modal="false"
        aria-hidden={!visible}
        aria-label="Default Session"
        data-default-session-floating
        tabIndex={-1}
        style={floating.open || mainMode ? { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height } : undefined}
      >
        <div className={`default-session-floating__shell${dragging ? ' is-dragging' : ''}`}>
        {floating.open ? (
          <div
            className="default-session-floating__titlebar"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          >
            <Sparkles size={14} />
            <strong>Default Session</strong>
            <span className="default-session-floating__topic">launcher:default</span>
            <div className="default-session-floating__actions" onPointerDown={(event) => event.stopPropagation()}>
              <button type="button" aria-label={floating.maximized ? 'Restore Default Session' : 'Maximize Default Session'} title={floating.maximized ? 'Restore' : 'Maximize'} onClick={toggleMaximized}>{floating.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
              <button type="button" aria-label="Minimize Default Session" title="Minimize" onClick={requestDefaultSessionFloatingClose}><Minus size={13} /></button>
              <button type="button" aria-label="Close Default Session" title="Close" onClick={requestDefaultSessionFloatingClose}><X size={13} /></button>
            </div>
          </div>
        ) : null}
          <div className="default-session-floating__body">
            <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} visible={visible} interactiveResize={false} />
          </div>
        </div>
      </div>
    </>
  )
}
