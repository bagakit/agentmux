import type { HostConfig } from '../../../shared/contracts'

/** Device identity only. Availability and Provider qualification retain their original owners. */
export function AgentDeviceSelect({ hosts, value, onChange, disabled = false, busy = false }: {
  hosts: readonly HostConfig[]; value: string; onChange(hostId: string): void; disabled?: boolean; busy?: boolean
}) {
  return <label className="agent-device-select"><span>Agent runs on</span>
    <select aria-label="Agent runs on" aria-busy={busy || undefined} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">Choose a device…</option>
      {value && !hosts.some(host => host.id === value) ? <option value={value}>Selected device · unavailable</option> : null}
      {hosts.map(host => <option value={host.id} key={host.id}>{host.label}{hosts.some(other => other.id !== host.id && other.label === host.label) ? ` · ${host.id}` : ''}{host.kind === 'local' ? ' · This device' : ''}</option>)}
    </select>
  </label>
}
