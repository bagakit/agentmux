import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Settings2 } from 'lucide-react'
import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { AgentAvatarAppearance, AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { attentionAccentFor } from '../lib/attention-event'
import { PRESENCE_MARK_CORNERS } from '../lib/presence-mark-corner'
import { AgentAvatarBadgeIcon } from './AgentAvatarBadgeIcon'
import { AgentEnamelFilter } from './AgentEnamelFilter'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { SettingsNavigation } from './SettingsNavigation'
import { SemanticIcon } from './semantic-icons'

/** Desktop presentation only; Core continues to own the Session and Provider facts. */
export const ExecutorIdentityContext = createContext<{
  config: AppConfig | null
  sessions: readonly SessionSnapshot[]
  onPanelVisibilityChange?: (visible: boolean) => void
}>({ config: null, sessions: [] })

/** Every Executor surface shares its artwork, state marker and hover/focus disclosure here. */
export function AgentAvatar({ label, onOpen, providerId, state, appearance, count, executorId, sessionId, size = 18, detail, onPanelVisibilityChange }: {
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
  /** Browser rails use the existing native-surface occlusion lease while this panel is open. */
  onPanelVisibilityChange?: ((visible: boolean) => void) | undefined
}) {
  const identity = useContext(ExecutorIdentityContext)
  const notifyPanelVisibilityChange = onPanelVisibilityChange ?? identity.onPanelVisibilityChange
  const session = sessionId ? identity.sessions.find((entry) => entry.id === sessionId && entry.kind === 'agent') : undefined
  const resolvedExecutorId = executorId ?? (session?.kind === 'agent' ? session.executorId : undefined)
  const executor = resolvedExecutorId ? identity.config?.executors[resolvedExecutorId] : undefined
  const provider = providerId ?? executor?.providerId ?? (session?.kind === 'agent' ? session.providerId : undefined)
  // Keep the persisted appearance while a user has not yet opened the Executor
  // template. New edits win immediately; the old entry is read-only until then.
  const avatar = appearance ?? (resolvedExecutorId
    ? executor?.avatar ?? identity.config?.appearance.agentAvatars?.[resolvedExecutorId]
    : undefined)
  const displayState = state ?? session?.status.state
  const name = label ?? session?.label ?? executor?.label ?? agentProviderLabel(provider ?? '')
  const statusDetail = detail ?? session?.status.detail
  const filterId = useId().replace(/:/g, '')
  const panelId = useId()
  const navigation = useContext(SettingsNavigation)
  const trigger = useRef<HTMLButtonElement & HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const nativeOverlayLeaseHeld = useRef(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const attention = displayState ? attentionAccentFor(displayState) : null
  const Element = onOpen ? 'button' : 'span'
  const statusLabel = displayState === 'running' ? 'Idle' : displayState === 'exited' ? 'Stopped' : displayState
  const accessibleName = [name, statusLabel, count && count > 1 ? `${count} Agents` : null].filter(Boolean).join(' · ')

  function keepOpen() { clearTimeout(closeTimer.current) }
  function closeNow() {
    keepOpen()
    if (nativeOverlayLeaseHeld.current) {
      nativeOverlayLeaseHeld.current = false
      notifyPanelVisibilityChange?.(false)
    }
    setPosition(null)
  }
  function show() {
    keepOpen()
    const bounds = trigger.current?.getBoundingClientRect()
    if (bounds) {
      setPosition({
        left: Math.min(Math.max(8, bounds.left), Math.max(8, window.innerWidth - 256)),
        top: bounds.bottom + 6
      })
    }
  }
  function hideSoon() {
    keepOpen()
    closeTimer.current = setTimeout(closeNow, 160)
  }
  useEffect(() => () => {
    clearTimeout(closeTimer.current)
    if (nativeOverlayLeaseHeld.current) {
      nativeOverlayLeaseHeld.current = false
      notifyPanelVisibilityChange?.(false)
    }
  }, [notifyPanelVisibilityChange])
  useEffect(() => {
    if (!position) return
    // A fixed portal becomes stale when the dock or page scrolls. Dismiss it so the
    // next hover/focus computes a fresh anchor instead of leaving a panel detached
    // from its identity mark (especially important beside native Browser surfaces).
    const dismiss = (event: Event) => {
      // Scrolling the panel itself must remain possible for long executor details;
      // a scroll of the trigger's ancestor invalidates the fixed anchor.
      if (panel.current?.contains(event.target as Node)) return
      closeNow()
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [position])
  useLayoutEffect(() => {
    if (!position || !panel.current) return
    const bounds = panel.current.getBoundingClientRect()
    const triggerBounds = trigger.current?.getBoundingClientRect()
    const region = trigger.current?.closest('.workbench-region')?.getBoundingClientRect()
    const regionCanContainPanel = region && region.width >= bounds.width + 16
    const minLeft = regionCanContainPanel ? region.left + 8 : 8
    const maxLeft = regionCanContainPanel ? region.right - bounds.width - 8 : Math.max(8, window.innerWidth - bounds.width - 8)
    const left = Math.min(Math.max(minLeft, position.left), maxLeft)
    let top = Math.min(Math.max(8, position.top), Math.max(8, window.innerHeight - bounds.height - 8))
    if (bounds.bottom > window.innerHeight - 8 && triggerBounds) {
      top = Math.max(8, triggerBounds.top - bounds.height - 6)
    }
    if (top + bounds.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - bounds.height - 8)
    }
    if (left !== position.left || top !== position.top) {
      setPosition({ left, top })
      return
    }
    const overlapsBrowser = [...document.querySelectorAll<HTMLElement>('[data-native-browser-stage]')]
      .some((stage) => {
        if (stage.closest('[inert]') || getComputedStyle(stage).visibility !== 'visible') return false
        const browser = stage.getBoundingClientRect()
        return browser.width > 0 && browser.height > 0 &&
          left < browser.right && left + bounds.width > browser.left &&
          top < browser.bottom && top + bounds.height > browser.top
      })
    if (overlapsBrowser !== nativeOverlayLeaseHeld.current) {
      nativeOverlayLeaseHeld.current = overlapsBrowser
      notifyPanelVisibilityChange?.(overlapsBrowser)
    }
  }, [position])

  const mark = <><AgentProviderIcon {...(provider ? { providerId: provider } : {})} size={Math.max(10, size - 4)} />
    {avatar?.badge ? <span className="agent-avatar__badge" data-corner={PRESENCE_MARK_CORNERS.badge} data-avatar-badge={avatar.badge}>
      <AgentAvatarBadgeIcon badge={avatar.badge} size={6} />
    </span> : null}</>
  return <>
    <Element ref={trigger} className={`agent-avatar${displayState ? ` status status--${displayState}` : ''}`}
      style={{ '--agent-avatar-size': `${size}px` } as CSSProperties}
      type={onOpen ? 'button' : undefined} tabIndex={0} role={onOpen ? undefined : 'img'} aria-label={accessibleName}
      aria-describedby={position ? panelId : undefined} data-executor-id={resolvedExecutorId}
      {...(attention ? { 'data-attention': attention } : {})}
      onPointerEnter={show} onPointerLeave={hideSoon} onFocus={show}
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
      onKeyDown={(event) => { if (event.key === 'Escape') { closeNow(); event.stopPropagation() } }}
      onClick={onOpen ? (event) => { event.stopPropagation(); onOpen() } : undefined}>
      <span className="agent-avatar__contour" aria-hidden="true">
        {avatar?.tint ? <AgentEnamelFilter id={filterId} tint={avatar.tint} className="agent-avatar__mark" filterClassName="agent-avatar__filters">{mark}</AgentEnamelFilter>
          : <span className="agent-avatar__mark">{mark}</span>}
      </span>
      {displayState === 'working'
        ? <span className="agent-avatar__status agent-avatar__status--working" data-corner={PRESENCE_MARK_CORNERS.status} aria-label="Working" role="img"><SemanticIcon name="working" size={10} strokeWidth={2.4} /></span>
        : attention !== null || displayState === 'disconnected' ? <span className="agent-avatar__status status__dot" data-corner={PRESENCE_MARK_CORNERS.status} aria-hidden="true" /> : null}
      {count && count > 1 ? <span className="agent-avatar__count" data-corner={PRESENCE_MARK_CORNERS.count} aria-hidden="true">{count}</span> : null}
    </Element>
    {position ? createPortal(<div ref={panel} id={panelId} className="agent-identity-popover" role="dialog" aria-label="Executor details"
      style={position} onPointerEnter={keepOpen} onPointerLeave={hideSoon} onFocus={keepOpen}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) hideSoon() }}
      onKeyDown={(event) => { if (event.key === 'Escape') { closeNow(); trigger.current?.focus(); event.stopPropagation() } }}
      onClick={(event) => event.stopPropagation()}>
      <header><strong>{name}</strong>{navigation && resolvedExecutorId ? <button type="button" className="icon-button" aria-label={`Edit ${executor?.label ?? name} executor`} title="Executor settings"
        onClick={() => { closeNow(); navigation.open('agents', resolvedExecutorId) }}><Settings2 size={13} /></button> : null}</header>
      <dl><dt>Provider</dt><dd>{agentProviderLabel(provider ?? '')}</dd>
        {resolvedExecutorId ? <><dt>Executor</dt><dd>{executor?.label ?? resolvedExecutorId} · {resolvedExecutorId}</dd></> : null}
        {statusLabel ? <><dt>Status</dt><dd>{statusLabel}</dd></> : null}</dl>
      {statusDetail ? <p>{statusDetail}</p> : null}
    </div>, document.body) : null}
  </>
}
