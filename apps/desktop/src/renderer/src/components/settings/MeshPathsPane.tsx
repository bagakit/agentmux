import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { MeshNetworkInspection } from '@agentmux/core/mesh-network'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { hostTransportLabel } from '../../lib/host-transport'
import { HostIcon } from '../HostBadge'
import { MeshNetworkMap } from './MeshNetworkMap'
import './mesh-paths.css'

/** The mesh-paths discovery address opens the continuous Mesh overview, never a second network owner. */
export function MeshPathsPane({ active, hosts = [], onGateway, onManageDevices, onAddDevice, onDevice }: {
  active: boolean
  hosts?: readonly HostConfig[]
  onGateway: () => void
  onManageDevices?: () => void
  onAddDevice?: () => void
  onDevice?: (hostId: string) => void
}) {
  const [snapshot, setSnapshot] = useState<MeshNetworkInspection>(), source = useRef<MeshNetworkInspection | undefined>(undefined)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed) }, [])
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [deviceQuery, setDeviceQuery] = useState(''), deviceNeedle = deviceQuery.trim().toLocaleLowerCase()
  // Explicit saved fields only: a Tailcat address can carry credentials and is never indexed here.
  const matchingHosts = hosts.filter(host => [host.id, host.label, ...(host.kind === 'ssh' ? [host.runtimeId ?? '', ...(host.transport === 'tailcat' ? [] : [host.hostname, host.port?.toString() ?? ''])] : [])].some(value => value.toLocaleLowerCase().includes(deviceNeedle)))
  useEffect(() => {
    if (!active || !visible) return
    const controller = new AbortController()
    setBusy(true)
    void api.mesh.call('mesh.inspect', {}, { signal: controller.signal }).then(next => {
      if (controller.signal.aborted) return
      if (source.current && source.current.owner.runtimeId !== next.owner.runtimeId) throw Error('Another Core answered this network read. The original network view is retained.')
      source.current = next; setSnapshot(next); setIssue('')
    }).catch(cause => { if (!controller.signal.aborted) setIssue(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); setBusy(false) }
  }, [active, visible, revision])
  const actions = <div className="mesh-overview-actions"><button type="button" className="small-button" onClick={onGateway}>Gateway</button>{onManageDevices ? <button type="button" className="small-button" onClick={onManageDevices}>Manage devices</button> : null}{onAddDevice ? <button type="button" className="primary-button" onClick={onAddDevice}>Add device</button> : null}<button type="button" className="small-button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? 'Reading…' : 'Refresh'}</button></div>
  return <section className="mesh-paths-pane mesh-overview" aria-label="Mesh network overview" data-settings-field="mesh-paths">
    {issue ? <div className="mesh-paths-issue" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'The last confirmed network is retained below.' : 'No current network has been confirmed. Your saved devices remain available below.'}</p><details><summary>Read details</summary><p>{issue}</p></details></div> : null}
    <MeshNetworkMap snapshot={snapshot} active={active && visible} actions={actions} reading={busy && !snapshot} stale={Boolean(issue && snapshot)} />
    <section className="mesh-saved-devices" aria-label="Saved devices">
      <header><div><h3>Saved devices <span>{deviceNeedle ? `${matchingHosts.length} / ${hosts.length}` : hosts.length}</span></h3><p>Connection settings saved by this client. These are separate from observed Mesh peers.</p></div><label className="mesh-saved-devices-filter"><TextInput type="search" aria-label="Filter saved devices" placeholder="Find saved name, Host ID, address or Runtime…" value={deviceQuery} onChange={event => setDeviceQuery(event.target.value)} /></label></header>
      <ul>{matchingHosts.map(host => <li key={host.id} data-mesh-saved-host={host.id}><span className="mesh-saved-device-icon"><HostIcon kind={host.kind} size={18} /></span><span className="mesh-saved-device-name"><strong>{host.label}</strong><small>{host.kind === 'local' ? 'This device' : host.transport === 'tailcat' ? 'Private Tailcat connection' : host.hostname || 'SSH configuration'}</small></span><span className="mesh-saved-device-transport">{host.kind === 'local' ? 'Local' : hostTransportLabel(host)}</span>{onDevice ? <button type="button" className="small-button" aria-label={`Manage ${host.label}`} onClick={() => onDevice(host.id)}>Manage</button> : null}</li>)}</ul>
      {!hosts.length ? <p className="mesh-saved-devices-empty">No device connections have been saved yet. Add a device to keep its connection settings here.</p> : !matchingHosts.length ? <p className="mesh-saved-devices-empty" role="status">No saved devices match this filter. {hosts.length} saved connections remain available. <button type="button" className="small-button" onClick={() => setDeviceQuery('')}>Clear filter</button></p> : null}
    </section>
  </section>
}
