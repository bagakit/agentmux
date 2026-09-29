import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Settings2, X } from 'lucide-react'
import { autoUpdate, computePosition, offset, shift, size as floatingSize, type VirtualElement } from '@floating-ui/dom'
import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { AgentAvatarAppearance, AppConfig } from '../../../shared/contracts'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { attentionAccentFor } from '../lib/attention-event'
import { PRESENCE_MARK_CORNERS } from '../lib/presence-mark-corner'
import { AgentAvatarBadgeIcon } from './AgentAvatarBadgeIcon'
import { AgentEnamelFilter } from './AgentEnamelFilter'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { SettingsNavigation } from './SettingsNavigation'
import { SemanticIcon } from './semantic-icons'
import { describeAgentDisplayState } from '../../../shared/agent-state-presentation'
import { getWindowOverlayHost } from './WindowOverlayHost'

/** Desktop presentation only; Core continues to own the Session and Provider facts. */
export const ExecutorIdentityContext = createContext<{
  config: AppConfig | null
  onPanelVisibilityChange?: (visible: boolean) => void
}>({ config: null })

/** Every Executor surface shares its artwork, state marker and hover/focus disclosure here. */
export function AgentAvatar({ label, onOpen, providerId, state, appearance, count, executorId, sessionId, size = 18, detail, onPanelVisibilityChange, actionDisclosure, disclosure, visible = true }: {
  label?: string | undefined
  onOpen?: (() => void) | undefined
  providerId?: AgentProviderId | undefined
  state?: AgentDisplayState | undefined
  appearance?: AgentAvatarAppearance | undefined
  count?: number | undefined
  executorId?: string | undefined
  sessionId?: string | undefined
  size?: number
  detail?: string | undefined
  /** Composer alone opts into this same face as an explicit, pinnable action disclosure. */
  actionDisclosure?: ((controls: { close(restoreInput?: boolean): void }) => ReactNode) | undefined
  /** Existing Focus surfaces provide context content without changing onOpen navigation. */
  disclosure?: { label: string; scope: string; content: ReactNode; reference(): VirtualElement; mark?: ReactNode } | undefined
  visible?: boolean
  /** Browser rails use the existing native-surface occlusion lease while this panel is open. */
  onPanelVisibilityChange?: ((visible: boolean) => void) | undefined
}) {
  const identity = useContext(ExecutorIdentityContext)
  const notifyPanelVisibilityChange = onPanelVisibilityChange ?? identity.onPanelVisibilityChange
  const session = useAppStore(useShallow((store) => {
    const entry = sessionId ? sessionPresentationById(store.sessions).get(sessionId) : undefined
    return entry?.kind === 'agent' ? {
      executorId: entry.executorId, providerId: entry.providerId, label: entry.label,
      state: entry.status.state, detail: entry.status.detail
    } : null
  }))
  const resolvedExecutorId = executorId ?? session?.executorId
  const executor = resolvedExecutorId ? identity.config?.executors[resolvedExecutorId] : undefined
  const provider = providerId ?? executor?.providerId ?? session?.providerId
  // Keep the persisted appearance while a user has not yet opened the Executor
  // template. New edits win immediately; the old entry is read-only until then.
  const avatar = appearance ?? (resolvedExecutorId
    ? executor?.avatar ?? identity.config?.appearance.agentAvatars?.[resolvedExecutorId]
    : undefined)
  const displayState = state ?? session?.state
  const name = label ?? session?.label ?? executor?.label ?? agentProviderLabel(provider ?? '')
  const statusDetail = detail ?? session?.detail
  const filterId = useId().replace(/:/g, '')
  const panelId = useId()
  const navigation = useContext(SettingsNavigation)
  const trigger = useRef<HTMLButtonElement & HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const controlledReference = useRef<VirtualElement | undefined>(undefined)
  const nativeOverlayLeaseHeld = useRef(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const attention = displayState ? attentionAccentFor(displayState) : null
  const Element = onOpen || actionDisclosure ? 'button' : 'span'
  const pinned = useRef(false)
  const suppressFocusPreview = useRef(false)
  const previousFocus = useRef<HTMLElement | null>(null)
  const statusLabel = actionDisclosure && displayState ? describeAgentDisplayState(displayState).label : displayState === 'running' ? 'Status unknown' : displayState === 'exited' ? 'Stopped' : displayState
  const accessibleName = [name, statusLabel, count && count > 1 ? `${count} Agents` : null].filter(Boolean).join(' · ')

  function keepOpen() { clearTimeout(closeTimer.current) }
  function closeNow(restoreInput = false) {
    keepOpen()
    clearTimeout(openTimer.current)
    pinned.current = false
    const active = document.activeElement
    const ownsFocus = active === trigger.current || panel.current?.contains(active)
    const target = restoreInput && ownsFocus ? previousFocus.current : null
    if (nativeOverlayLeaseHeld.current) {
      nativeOverlayLeaseHeld.current = false
      notifyPanelVisibilityChange?.(false)
    }
    setPosition(null)
    if (target?.isConnected) target.focus({ preventScroll: true })
  }
  function closeToTrigger() {
    closeNow()
    suppressFocusPreview.current = true
    trigger.current?.focus({ preventScroll: true })
    suppressFocusPreview.current = false
  }
  function show() {
    keepOpen()
    clearTimeout(openTimer.current)
    if (disclosure && (!trigger.current?.isConnected || trigger.current.closest('[inert]') || document.visibilityState === 'hidden')) return
    if (!visible) return
    if (!position && document.activeElement instanceof HTMLElement && document.activeElement !== trigger.current) previousFocus.current = document.activeElement
    const bounds = trigger.current?.getBoundingClientRect()
    if (bounds) {
      controlledReference.current = disclosure?.reference()
      setPosition({
        left: Math.min(Math.max(8, bounds.left), Math.max(8, window.innerWidth - 256)),
        top: bounds.bottom + 6
      })
    }
  }
  function showSoon() {
    keepOpen()
    clearTimeout(openTimer.current)
    openTimer.current = setTimeout(show, 180)
  }
  function hideSoon() {
    keepOpen()
    clearTimeout(openTimer.current)
    if (pinned.current) return
    closeTimer.current = setTimeout(closeNow, 160)
  }
  useLayoutEffect(() => { if (actionDisclosure) closeNow() }, [sessionId, visible])
  useEffect(() => {
    if (!position || !actionDisclosure) return
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) closeNow()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [Boolean(position), Boolean(actionDisclosure)])
  useEffect(() => () => {
    clearTimeout(closeTimer.current)
    clearTimeout(openTimer.current)
    if (nativeOverlayLeaseHeld.current) {
      nativeOverlayLeaseHeld.current = false
      notifyPanelVisibilityChange?.(false)
    }
  }, [notifyPanelVisibilityChange])
  useEffect(() => {
    if (!disclosure) return
    closeNow()
    const dismiss = (event: Event) => {
      if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return
      if (event.type === 'pointerdown' && (trigger.current?.contains(event.target as Node) || panel.current?.contains(event.target as Node))) return
      closeNow()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) closeNow() }
    document.addEventListener('visibilitychange', dismiss)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      clearTimeout(openTimer.current); clearTimeout(closeTimer.current)
      document.removeEventListener('visibilitychange', dismiss)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [disclosure?.scope])
  useEffect(() => {
    if (!position) return
    // A fixed portal becomes stale when the dock or page scrolls. Dismiss it so the
    // next hover/focus computes a fresh anchor instead of leaving a panel detached
    // from its identity mark (especially important beside native Browser surfaces).
    const dismiss = (event: Event) => {
      if (controlledReference.current && event.type === 'resize') return
      // Scrolling the panel itself must remain possible for long executor details;
      // a scroll of the trigger's ancestor invalidates the fixed anchor.
      if (panel.current?.contains(event.target as Node)) return
      if (actionDisclosure && pinned.current) show()
      else closeNow()
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [position])
  function syncNativeOverlayLease(left: number, top: number, width: number, height: number) {
    const overlapsBrowser = [...document.querySelectorAll<HTMLElement>('[data-native-browser-stage]')]
      .some((stage) => {
        if (stage.closest('[inert]') || getComputedStyle(stage).visibility !== 'visible') return false
        const browser = stage.getBoundingClientRect()
        return browser.width > 0 && browser.height > 0 &&
          left < browser.right && left + width > browser.left &&
          top < browser.bottom && top + height > browser.top
      })
    if (overlapsBrowser !== nativeOverlayLeaseHeld.current) {
      nativeOverlayLeaseHeld.current = overlapsBrowser
      notifyPanelVisibilityChange?.(overlapsBrowser)
    }
  }
  useLayoutEffect(() => {
    const reference = controlledReference.current, surface = panel.current
    if (!position || !reference || !surface) return
    let disposed = false
    const update = async () => {
      const { x, y } = await computePosition(reference, surface, {
        strategy: 'fixed', placement: 'top', middleware: [offset(6), shift({ padding: 8 }), floatingSize({ padding: 8,
          apply({ availableWidth, availableHeight }) {
            if (disposed) return
            surface.style.width = `${Math.max(0, Math.min(320, availableWidth))}px`
            surface.style.maxHeight = `${Math.max(0, Math.min(440, window.innerHeight * .6, availableHeight))}px`
          }
        })]
      })
      if (disposed) return
      Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      const bounds = surface.getBoundingClientRect()
      syncNativeOverlayLease(x, y, bounds.width, bounds.height)
    }
    const stop = autoUpdate(reference, surface, () => { void update() })
    return () => { disposed = true; stop() }
  }, [position])
  useLayoutEffect(() => {
    if (!position || !panel.current || controlledReference.current) return
    let bounds = panel.current.getBoundingClientRect()
    const triggerBounds = trigger.current?.getBoundingClientRect()
    let left = position.left, top = position.top
    if (actionDisclosure) {
      const surface = trigger.current?.closest<HTMLElement>('.agent-surface')
      const regionBounds = trigger.current?.closest<HTMLElement>('[data-workbench-region-id]')?.getBoundingClientRect()
      const composer = surface?.querySelector<HTMLElement>('.composer')?.getBoundingClientRect()
      const terminal = surface?.querySelector<HTMLElement>('.terminal-view__xterm')?.getBoundingClientRect()
      const regionMinTop = Math.max(8, (regionBounds?.top ?? 0) + 8)
      const composerEdge = Math.min(window.innerHeight - 8, composer?.top ?? triggerBounds?.top ?? window.innerHeight) - 6
      const aboveBottom = Math.min(composerEdge, terminal ? terminal.bottom - 32 - 6 : composerEdge)
      // A short lower split borrows window space above its Region, preserving its input edge.
      const aboveTop = aboveBottom - regionMinTop < Math.min(360, bounds.height) ? 8 : regionMinTop
      const belowTop = Math.max(regionMinTop, terminal ? terminal.bottom + 6 : composerEdge)
      const belowBottom = composerEdge
      // The native input band and Composer are separate protected areas; a pending card can lie between them.
      const useBelow = belowBottom - belowTop > aboveBottom - aboveTop
      const minTop = useBelow ? belowTop : aboveTop
      const protectedBottom = useBelow ? belowBottom : aboveBottom
      const minLeft = Math.max(8, (regionBounds?.left ?? 0) + 8)
      const maxRight = Math.min(window.innerWidth - 8, (regionBounds?.right ?? window.innerWidth) - 8)
      panel.current.style.width = `${Math.min(296, Math.max(0, maxRight - minLeft))}px`
      panel.current.style.maxHeight = `${Math.max(0, Math.min(360, protectedBottom - minTop))}px`
      panel.current.dataset.compact = String(protectedBottom - minTop < 160)
      bounds = panel.current.getBoundingClientRect()
      left = Math.min(Math.max(minLeft, (triggerBounds?.right ?? left) - bounds.width), maxRight - bounds.width)
      top = Math.max(minTop, protectedBottom - bounds.height)
    } else {
      const region = trigger.current?.closest('.workbench-region')?.getBoundingClientRect()
      const regionCanContainPanel = region && region.width >= bounds.width + 16
      const minLeft = regionCanContainPanel ? region.left + 8 : 8
      const maxLeft = regionCanContainPanel ? region.right - bounds.width - 8 : Math.max(8, window.innerWidth - bounds.width - 8)
      left = Math.min(Math.max(minLeft, position.left), maxLeft)
      top = Math.min(Math.max(8, position.top), Math.max(8, window.innerHeight - bounds.height - 8))
      if (bounds.bottom > window.innerHeight - 8 && triggerBounds) top = Math.max(8, triggerBounds.top - bounds.height - 6)
      if (top + bounds.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - bounds.height - 8)
    }
    if (left !== position.left || top !== position.top) { setPosition({ left, top }); return }
    syncNativeOverlayLease(left, top, bounds.width, bounds.height)
  }, [position, actionDisclosure])
  useEffect(() => {
    if (!position || !actionDisclosure || !panel.current) return
    const observer = new ResizeObserver(() => show())
    observer.observe(panel.current)
    const surface = trigger.current?.closest('.agent-surface')
    if (surface) observer.observe(surface)
    return () => observer.disconnect()
  }, [Boolean(position), Boolean(actionDisclosure)])

  const mark = <>{disclosure?.mark ?? <AgentProviderIcon {...(provider ? { providerId: provider } : {})} size={Math.max(10, size - 4)} />}
    {avatar?.badge ? <span className="agent-avatar__badge" data-corner={PRESENCE_MARK_CORNERS.badge} data-avatar-badge={avatar.badge}>
      <AgentAvatarBadgeIcon badge={avatar.badge} size={6} />
    </span> : null}</>
  const overlayHost = getWindowOverlayHost()
  return <>
    <Element ref={trigger} className={`agent-avatar${displayState ? ` status status--${displayState}` : ''}`}
      style={{ '--agent-avatar-size': `${size}px` } as CSSProperties}
      type={onOpen || actionDisclosure ? 'button' : undefined} tabIndex={0} role={onOpen || actionDisclosure ? undefined : 'img'} aria-label={actionDisclosure ? `${accessibleName} · Agent status and actions` : accessibleName}
      aria-describedby={position ? panelId : undefined} aria-expanded={actionDisclosure ? Boolean(position) : undefined} aria-controls={actionDisclosure ? panelId : undefined} data-executor-id={resolvedExecutorId}
      {...(attention ? { 'data-attention': attention } : {})}
      onPointerEnter={disclosure ? showSoon : show} onPointerLeave={hideSoon}
      onPointerDown={() => { if (document.activeElement instanceof HTMLElement && document.activeElement !== trigger.current) previousFocus.current = document.activeElement }}
      onFocus={(event) => {
        if (suppressFocusPreview.current) return
        if (!position && event.relatedTarget instanceof HTMLElement) previousFocus.current = event.relatedTarget
        show()
      }}
      onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget as Node)) hideSoon() }}
      onKeyDownCapture={(event) => {
        // The avatar is the disclosure control. Keep the first Tab in the
        // disclosure so keyboard users can reach the settings action.
        if (event.key !== 'Tab' || event.shiftKey || !panel.current) return
        const firstAction = panel.current.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (!firstAction) return
        event.preventDefault()
        firstAction.focus()
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') { closeToTrigger(); event.stopPropagation() } }}
      onClick={actionDisclosure ? (event) => {
        event.stopPropagation()
        if (pinned.current) closeToTrigger()
        else { show(); pinned.current = true }
      } : onOpen ? (event) => { event.stopPropagation(); if (disclosure) closeNow(); onOpen() } : undefined}>
      <span className="agent-avatar__contour" aria-hidden="true">
        {avatar?.tint ? <AgentEnamelFilter id={filterId} tint={avatar.tint} className="agent-avatar__mark" filterClassName="agent-avatar__filters">{mark}</AgentEnamelFilter>
          : <span className="agent-avatar__mark">{mark}</span>}
      </span>
      {displayState === 'working'
        ? <span className="agent-avatar__status agent-avatar__status--working" data-corner={PRESENCE_MARK_CORNERS.status} aria-label="Working" role="img"><SemanticIcon name="working" size={10} strokeWidth={2.4} /></span>
        : attention !== null || displayState === 'disconnected' ? <span className="agent-avatar__status status__dot" data-corner={PRESENCE_MARK_CORNERS.status} aria-hidden="true" /> : null}
      {count && count > 1 ? <span className="agent-avatar__count" data-corner={PRESENCE_MARK_CORNERS.count} aria-hidden="true">{count}</span> : null}
    </Element>
    {position && overlayHost ? createPortal(<div ref={panel} id={panelId} className={`agent-identity-popover${actionDisclosure ? ' agent-identity-popover--actions' : disclosure ? ' recent-focus__context-preview' : ''}`} role={disclosure ? 'tooltip' : 'dialog'} aria-label={actionDisclosure ? 'Agent status and actions' : disclosure?.label ?? 'Executor details'}
      style={{ ...position, ...(disclosure ? { visibility: 'hidden' } : {}) }} onPointerEnter={keepOpen} onPointerLeave={hideSoon} onFocus={keepOpen}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) hideSoon() }}
      onKeyDown={(event) => { if (event.key === 'Escape') { closeToTrigger(); event.stopPropagation() } }}
      onPointerDown={() => { if (actionDisclosure) pinned.current = true }}
      onClick={(event) => event.stopPropagation()}>
      {disclosure ? disclosure.content : <><header><strong>{name}</strong><span className="agent-identity-popover__controls">{navigation && resolvedExecutorId ? <button type="button" className="icon-button" aria-label={`Edit ${executor?.label ?? name} executor`} title="Executor settings"
        onClick={() => { closeNow(); navigation.open('agents', resolvedExecutorId) }}><Settings2 size={13} /></button> : null}{actionDisclosure ? <button type="button" className="icon-button" aria-label="Close Agent status" onClick={closeToTrigger}><X size={13} /></button> : null}</span></header>
      {actionDisclosure ? actionDisclosure({ close: closeNow }) : <><dl><dt>Provider</dt><dd>{agentProviderLabel(provider ?? '')}</dd>
        {resolvedExecutorId ? <><dt>Executor</dt><dd>{executor?.label ?? resolvedExecutorId} · {resolvedExecutorId}</dd></> : null}
        {statusLabel ? <><dt>Status</dt><dd>{statusLabel}</dd></> : null}</dl>
      {statusDetail ? <p>{statusDetail}</p> : null}</>}</>}
    </div>, overlayHost) : null}
  </>
}
