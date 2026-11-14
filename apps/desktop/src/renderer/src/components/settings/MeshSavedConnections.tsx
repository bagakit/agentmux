import { useMemo, useState } from 'react'
import type { HostConfig } from '../../../../shared/contracts'
import { currentHostCheck, hostCheckLabel } from '../../lib/host-check'
import { hostConnectionSummary } from '../../lib/host-transport'
import { useAppStore } from '../../store'
import { useHostConnectionHint } from '../HostConnectionTooltip'
import { HostTopology } from './HostTopology'

export function MeshSavedConnections({ hosts, active, onDevice }: {
  hosts: readonly HostConfig[]
  active: boolean
  onDevice: (hostId: string) => void
}) {
  const checks = useAppStore(state => state.hostChecks)
  const [selectedId, select] = useState<string | null>(null)
  const items = useMemo(() => hosts.map(host => ({
    host, check: currentHostCheck(checks[host.id], host), projectCount: 0, sessionCount: 0,
  })), [hosts, checks])
  const selected = items.find(item => item.host.id === selectedId)
  return <section className="mesh-saved-connections" aria-label="Saved connection map">
    <HostTopology items={items} active={active} selectedId={selectedId} onSelect={select} compact />
    <div className="mesh-saved-connections__legend"><i aria-hidden="true" /> Saved route <span>Logical layout</span></div>
    {selected ? <SavedConnectionDetails host={selected.host} check={selected.check} onDevice={onDevice} /> : null}
  </section>
}

function SavedConnectionDetails({ host, check, onDevice }: {
  host: HostConfig
  check: ReturnType<typeof currentHostCheck>
  onDevice: (hostId: string) => void
}) {
  const connection = useHostConnectionHint(host.id, host.label)
  const testedAt = check?.observedAt
  return <div className="mesh-saved-connections__details" aria-label="Selected saved connection">
    <div><strong>{host.label}</strong><small>{hostConnectionSummary(host)}</small><small>{connection.summary}</small>
      {check && check.state !== 'idle' ? <small>Connection test · {hostCheckLabel(check)}{testedAt !== undefined ? ` · ${new Date(testedAt).toLocaleString()}` : ''}</small> : null}</div>
    <button type="button" className="small-button" onClick={() => onDevice(host.id)}>Manage connection</button>
  </div>
}
