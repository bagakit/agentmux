import { CircleHelp, RadioTower } from 'lucide-react'
import type { RegionExecutionHost } from '../lib/region-execution-host'

type HostIdentity = Pick<RegionExecutionHost, 'id' | 'label' | 'kind' | 'configured'>

/** A quiet identity, not a connection or Agent-health indicator. */
export function HostBadge({ host, compact = false, className = '', context = 'Execution Host' }: {
  host: HostIdentity; compact?: boolean; className?: string; context?: 'Host' | 'Execution Host'
}) {
  if (host.kind === 'local') return null
  const Icon = host.kind === 'ssh' ? RadioTower : CircleHelp
  const identity = host.id ? `${host.label} · ${host.id}${host.configured ? '' : ' · Not configured'}` : 'Host unknown'
  return <span className={`host-identity ${context === 'Execution Host' ? 'agent-region-header__execution' : ''} ${className}`}
    data-execution-host-id={context === 'Execution Host' ? host.id ?? '' : undefined} data-host-id={host.id ?? ''}
    data-host-kind={host.kind} title={identity} aria-label={`${context}: ${identity}`}>
    <Icon size={12} aria-hidden="true" />{compact ? null : <span>{host.label}</span>}
  </span>
}
