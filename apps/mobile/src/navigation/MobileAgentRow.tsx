import './agent-row.css'
import '@agentmux/client-ui/styles/agent-avatar-face.css'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { AgentAvatarFace } from '@agentmux/client-ui/components/AgentAvatarFace'
import { FocusStateMark } from '@agentmux/client-ui/components/FocusStateMark'
import { agentProviderLabel } from '@agentmux/client-ui/components/AgentProviderIcon'
import { formatMobileClock } from '../presentation/time'
import { mobileAgentStateLabel } from './mobile-agent-status'
import { mobileNeedsYouReason } from './needs-you'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { MobileAgentLocationChoice, MobileAgentLocations } from './mobile-agent-locations'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { MobileObjectIdentity } from './MobileIdentity'
import type { MobileAgentPresentation } from './mobile-agent-status'

export type MobileAgentMenuLocation = { catalog: AgentMuxSpaceCatalog | null; group: MobileAgentLocations | undefined;
  onChoose(choice: MobileAgentLocationChoice): void; current?(): boolean }
export type MobileAgentMenuTarget = { agentSessionId: string; identity: MobileObjectIdentity; beforeAction?: () => boolean
  location?: MobileAgentMenuLocation | undefined; presentation?: MobileAgentPresentation | undefined; refreshStatus?: (() => boolean | void) | undefined }
/** Presentation only. The App owns disclosure; a row never selects or inspects an Agent. */
export const MobileAgentMenuContext = createContext<((target: MobileAgentMenuTarget) => void) | null>(null)

export function MobileAgentRow({ agentSessionId, identity, presentation, refreshStatus, location, onOpen, beforeMenu, children, selected = false, className = '' }: MobileAgentMenuTarget & {
  onOpen(): void; beforeMenu?(): boolean; children: ReactNode; selected?: boolean; className?: string
}) {
  const showMenu = useContext(MobileAgentMenuContext)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const current = useRef({ agentSessionId, identity, presentation, refreshStatus, location, showMenu, beforeMenu })
  current.current = { agentSessionId, identity, presentation, refreshStatus, location, showMenu, beforeMenu }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const press = useRef<{ id: number; x: number; y: number; type: string } | null>(null)
  const suppressClick = useRef(false)
  const release = useRef<(() => void) | null>(null)
  function cancel() { clearTimeout(timer.current); press.current = null; release.current?.(); release.current = null }
  function openMenu() { const target = current.current; if (target.beforeMenu && !target.beforeMenu()) return; target.showMenu?.({ agentSessionId: target.agentSessionId, identity: target.identity, ...(target.presentation ? { presentation: target.presentation } : {}), ...(target.refreshStatus ? { refreshStatus: target.refreshStatus } : {}), ...(target.beforeMenu ? { beforeAction: target.beforeMenu } : {}), ...(target.location ? { location: { ...target.location, current: () => alive.current && current.current.agentSessionId === target.agentSessionId && current.current.location?.group?.hostId === target.location?.group?.hostId && (target.location?.current?.() ?? true) } } : {}) }) }
  useEffect(() => {
    suppressClick.current = false
    return cancel
  }, [agentSessionId, showMenu])
  return <>
    <button type="button" className={`mobile-agent-row__open ${className}`} aria-current={selected ? 'true' : undefined}
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
    {showMenu && <IconButton className="mobile-icon-button mobile-agent-row__more" aria-label={`${identity.name} · 更多操作`} onClick={openMenu}><SemanticIcon name="action.more" size={16} /></IconButton>}
  </>
}

/** One presentation for directory and Zone rows; it never reads or qualifies a Session. */
export function MobileAgentRowContent({ title, presentation, providerId, detail }: { title: string; presentation?: MobileAgentPresentation | undefined; providerId?: string | undefined; detail?: string | undefined }) {
  const state = presentation?.stateMark ?? 'unknown', label = mobileAgentStateLabel(presentation)
  const reason = mobileNeedsYouReason(presentation)
  const summary = reason ? label : presentation?.recap?.text ?? detail ?? ''
  const clock = formatMobileClock(presentation?.lastActivityAt)
  return <>
    <span className="mobile-row-avatar mobile-executor-avatar"><AgentAvatarFace providerId={providerId} appearance={presentation?.avatar} size={24} />
      <span className="mobile-row-status" title={label}><FocusStateMark kind={state} presenceUnknown={presentation?.presenceUnknown} /></span></span>
    <span className="mobile-row-copy mobile-session-copy"><span className="mobile-row-title"><strong>{title}</strong></span>
      <span className="mobile-row-detail"><span className="mobile-session-recap" data-state={reason ?? undefined} title={summary}>{summary}</span>
        {clock && <time dateTime={new Date(presentation!.lastActivityAt!).toISOString()}>{clock}</time>}</span>
      <small className="mobile-visually-hidden">{label}{providerId ? ` · ${agentProviderLabel(providerId)}` : ' · 元信息未确认'}</small>
    </span>
  </>
}
