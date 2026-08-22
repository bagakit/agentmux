import { Minus, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import {
  clampDefaultSessionFloatingState,
  requestDefaultSessionFloatingClose,
  useDefaultSessionFloatingState
} from '../lib/default-session-floating'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'

const DRAG_THRESHOLD = 3

export function DefaultSessionFloatingPanel(): React.JSX.Element | null {
  const config = useAppStore((state) => state.config)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const reportError = useAppStore((state) => state.reportError)
  const [floating, setFloating] = useDefaultSessionFloatingState()
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const scratch = config?.workspaces.find((workspace) => workspace.id === SCRATCH_WORKSPACE_ID)

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

  if (!scratch || !floating.open) return null

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = { x: event.clientX, y: event.clientY, left: floating.position.left, top: floating.position.top, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    setFloating(clampDefaultSessionFloatingState({ ...floating, position: { left: drag.left + dx, top: drag.top + dy } }))
  }
  const onPointerEnd = (): void => { dragRef.current = null; setDragging(false) }

  return (
    <div
      className="default-session-floating"
      role="dialog"
      aria-modal="false"
      aria-label="Default Session"
      data-default-session-floating
      style={{ left: floating.position.left, top: floating.position.top, width: floating.size.width, height: floating.size.height }}
    >
      <div className={`default-session-floating__shell${dragging ? ' is-dragging' : ''}`}>
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
          <div className="default-session-floating__actions">
            <button type="button" aria-label="Minimize Default Session" title="Minimize" onClick={requestDefaultSessionFloatingClose}><Minus size={13} /></button>
            <button type="button" aria-label="Close Default Session" title="Close" onClick={requestDefaultSessionFloatingClose}><X size={13} /></button>
          </div>
        </div>
        <div className="default-session-floating__body">
          <WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID} visible interactiveResize={false} />
        </div>
      </div>
    </div>
  )
}
