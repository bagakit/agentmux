import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { useHostConnectionTooltip } from './HostConnectionTooltip'
import { useLayoutEffect, useRef, useState } from 'react'

const ThemeObjectDisplayIcon = semanticIconComponent('object.display')
const ThemeObjectHostIcon = semanticIconComponent('object.host')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')


type HostIdentity = Pick<RegionExecutionHost, 'id' | 'label' | 'kind' | 'configured'>

/** Machine type only; neither platform branding nor connection/Run status. */
export function HostIcon({ kind, size = 12 }: { kind: HostIdentity['kind']; size?: number }) {
  const Icon = kind === 'local' ? ThemeObjectDisplayIcon : kind === 'ssh' ? ThemeObjectHostIcon : ThemeStatusUnknownIcon
  return <Icon size={size} aria-hidden="true" />
}

/** A quiet identity, not a connection or Agent-health indicator. */
export function HostBadge({ host, compact = false, className = '', context = 'Execution Host', suppressTooltip = false }: {
  host: HostIdentity; compact?: boolean; className?: string; context?: 'Host' | 'Execution Host'; suppressTooltip?: boolean
}) {
  const suppressed = suppressTooltip || (context === 'Execution Host' && host.kind === 'local')
  const tooltip = useHostConnectionTooltip(host.id, host.label, suppressed)
  const element = useRef<HTMLSpanElement>(null), currentTooltip = useRef(tooltip)
  currentTooltip.current = tooltip
  const [focusOwner, setFocusOwner] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (suppressed) return
    const owner = element.current?.parentElement?.closest<HTMLElement>('button, summary, a[href], [tabindex]:not([tabindex="-1"])') ?? null
    setFocusOwner(owner)
    if (!owner) return
    const show = () => currentTooltip.current.showFor(owner), hide = () => currentTooltip.current.hide()
    owner.addEventListener('focus', show); owner.addEventListener('blur', hide)
    return () => { owner.removeEventListener('focus', show); owner.removeEventListener('blur', hide) }
  }, [suppressed, host.id])
  const describedBy = tooltip.props['aria-describedby']
  useLayoutEffect(() => {
    if (!focusOwner || !describedBy) return
    const ids = (focusOwner.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)
    focusOwner.setAttribute('aria-describedby', [...new Set([...ids, describedBy])].join(' '))
    return () => {
      const remaining = (focusOwner.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(id => id && id !== describedBy)
      if (remaining.length) focusOwner.setAttribute('aria-describedby', remaining.join(' ')); else focusOwner.removeAttribute('aria-describedby')
    }
  }, [focusOwner, describedBy])
  if (context === 'Execution Host' && host.kind === 'local') return null
  const identity = host.id ? `${host.label} · ${host.id}${host.configured ? '' : ' · Not configured'}` : 'Host unknown'
  return <><span ref={element} className={`host-identity ${context === 'Execution Host' ? 'agent-region-header__execution' : ''} ${className}`} {...tooltip.props} tabIndex={suppressed || focusOwner ? undefined : 0}
    data-execution-host-id={context === 'Execution Host' ? host.id ?? '' : undefined} data-host-id={host.id ?? ''}
    data-host-kind={host.kind} aria-label={`${context}: ${identity}`}>
    <HostIcon kind={host.kind} />{compact ? null : <span>{host.label}</span>}
  </span>{tooltip.content}</>
}
