import { CircleHelp, RadioTower, SquareTerminal } from 'lucide-react'
import type { RegionExecutionHost } from '../lib/region-execution-host'

type HostIdentity = Pick<RegionExecutionHost, 'id' | 'label' | 'kind' | 'configured'>

/** A quiet identity, not a connection or Agent-health indicator. */
export function HostBadge({ host, showLocal = false, compact = false, className = '', context = 'Execution Host' }: {
  host: HostIdentity; showLocal?: boolean; compact?: boolean; className?: string; context?: 'Host' | 'Execution Host'
}) {
  if (!showLocal && host.kind === 'local') return null
  const Icon = host.kind === 'local' ? SquareTerminal : host.kind === 'ssh' ? RadioTower : CircleHelp
  const identity = host.id ? `${host.label} · ${host.id}${host.configured ? '' : ' · Not configured'}` : 'Host unknown'
  return <span className={`host-identity ${context === 'Execution Host' ? 'agent-region-header__execution' : ''} ${className}`}
    data-execution-host-id={context === 'Execution Host' ? host.id ?? '' : undefined} data-host-id={host.id ?? ''}
    data-host-kind={host.kind} title={identity} aria-label={`${context}: ${identity}`}>
    <Icon size={12} aria-hidden="true" />{compact ? null : <span>{host.label}</span>}
  </span>
}
