import { CircleHelp, RadioTower, SquareTerminal } from 'lucide-react'
import type { RegionExecutionHost } from '../lib/region-execution-host'

/** A quiet identity, not a connection or Agent-health indicator. */
export function HostBadge({ host }: { host: RegionExecutionHost }) {
  const Icon = host.kind === 'local' ? SquareTerminal : host.kind === 'ssh' ? RadioTower : CircleHelp
  const identity = host.id ? `${host.label} · ${host.id}${host.configured ? '' : ' · Not configured'}` : 'Host unknown'
  return <span className="agent-region-header__execution" data-execution-host-id={host.id ?? ''}
    data-host-kind={host.kind} title={identity} aria-label={`Execution Host: ${identity}`}>
    <Icon size={12} aria-hidden="true" /><span>{host.label}</span>
  </span>
}
