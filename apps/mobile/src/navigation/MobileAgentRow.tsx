import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { MobileObjectIdentity } from './MobileIdentity'

export type MobileAgentMenuTarget = { agentSessionId: string; identity: MobileObjectIdentity; beforeAction?: () => boolean }
/** Presentation only. The App owns disclosure; a row never selects or inspects an Agent. */
export const MobileAgentMenuContext = createContext<((target: MobileAgentMenuTarget) => void) | null>(null)

export function MobileAgentRow({ agentSessionId, identity, onOpen, beforeMenu, children, className = '' }: MobileAgentMenuTarget & {
  onOpen(): void; beforeMenu?(): boolean; children: ReactNode; className?: string
}) {
  const showMenu = useContext(MobileAgentMenuContext)
  const current = useRef({ agentSessionId, identity, showMenu, beforeMenu })
  current.current = { agentSessionId, identity, showMenu, beforeMenu }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const press = useRef<{ id: number; x: number; y: number; type: string } | null>(null)
  const suppressClick = useRef(false)
  const release = useRef<(() => void) | null>(null)
  function cancel() { clearTimeout(timer.current); press.current = null; release.current?.(); release.current = null }
  function openMenu() { const target = current.current; if (target.beforeMenu && !target.beforeMenu()) return; target.showMenu?.({ agentSessionId: target.agentSessionId, identity: target.identity, ...(target.beforeMenu ? { beforeAction: target.beforeMenu } : {}) }) }
  useEffect(() => {
    suppressClick.current = false
    return cancel
  }, [agentSessionId, showMenu])
  return <>
    <button type="button" className={`mobile-agent-row__open ${className}`}
      onPointerDown={event => {
        cancel(); suppressClick.current = false
        if (!showMenu || !event.isPrimary || event.button !== 0) return
        press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, type: event.pointerType }
        if (event.pointerType === 'mouse') return
        // Observe cancellation only during this gesture, not once per mounted row.
        const pointer = (value: PointerEvent) => { if (press.current && value.pointerId !== press.current.id) cancel() }
        window.addEventListener('scroll', cancel, true); window.addEventListener('pointerdown', pointer, true); window.addEventListener('blur', cancel)
        release.current = () => { window.removeEventListener('scroll', cancel, true); window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('blur', cancel) }
        timer.current = setTimeout(() => { cancel(); suppressClick.current = true; openMenu() }, 500)
      }}
      onPointerMove={event => { const start = press.current; if (start && (start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)) cancel() }}
      onPointerUp={cancel} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onContextMenu={event => { if (!showMenu) return; event.preventDefault(); if (press.current && press.current.type !== 'mouse') suppressClick.current = true; cancel(); openMenu() }}
      onKeyDown={event => { if (showMenu && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) { event.preventDefault(); cancel(); openMenu() } }}
      onClick={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); suppressClick.current = false; return }; suppressClick.current = false; onOpen() }}>
      {children}
    </button>
    {showMenu && <button type="button" className="mobile-icon-button mobile-agent-row__more" aria-label={`${identity.name} · 更多操作`} onClick={openMenu}><SemanticIcon name="action.more" size={16} /></button>}
  </>
}
