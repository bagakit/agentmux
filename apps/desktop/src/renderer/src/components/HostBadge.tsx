import { CircleHelp, Monitor, Server } from 'lucide-react'
import type { RegionExecutionHost } from '../lib/region-execution-host'

type HostIdentity = Pick<RegionExecutionHost, 'id' | 'label' | 'kind' | 'configured'>

/** Machine type only; neither platform branding nor connection/Run status. */
export function HostIcon({ kind, size = 12 }: { kind: HostIdentity['kind']; size?: number }) {
  const Icon = kind === 'local' ? Monitor : kind === 'ssh' ? Server : CircleHelp
  return <Icon size={size} aria-hidden="true" />
}

/** A quiet identity, not a connection or Agent-health indicator. */
export function HostBadge({ host, compact = false, className = '', context = 'Execution Host' }: {
  host: HostIdentity; compact?: boolean; className?: string; context?: 'Host' | 'Execution Host'
}) {
  if (context === 'Execution Host' && host.kind === 'local') return null
  const identity = host.id ? `${host.label} · ${host.id}${host.configured ? '' : ' · Not configured'}` : 'Host unknown'
  return <span className={`host-identity ${context === 'Execution Host' ? 'agent-region-header__execution' : ''} ${className}`}
    data-execution-host-id={context === 'Execution Host' ? host.id ?? '' : undefined} data-host-id={host.id ?? ''}
    data-host-kind={host.kind} title={identity} aria-label={`${context}: ${identity}`}>
    <HostIcon kind={host.kind} />{compact ? null : <span>{host.label}</span>}
  </span>
}
