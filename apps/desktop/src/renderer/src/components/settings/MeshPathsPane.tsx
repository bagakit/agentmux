import { useEffect, useMemo, useRef, useState } from 'react'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import { Button } from '@agentmux/client-ui/components/Button'
import type { HostConfig } from '../../../../shared/contracts'
import { meshLocationValue, meshPeerLocationKey, type MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { api } from '../../lib/api'
import { useMeshDeviceLocations } from './use-mesh-device-locations'
import { savedMeshDevices } from './MeshSavedDevices'
import { MeshNetworkMap } from './MeshNetworkMap'
import { MeshLocationsPanel, type MapAnnotationTarget } from './MeshLocationsPanel'
import { meshPeerLabel, meshTopologyModel } from './mesh-topology'
import { useAppStore } from '../../store'
import './mesh-paths.css'

/** The mesh-paths discovery address opens the continuous Mesh overview, never a second network owner. */
export function MeshPathsPane({ active, hosts, locations, separateRuntimeId, onGateway, onDevice }: {
  active: boolean
  hosts: readonly HostConfig[]
  locations?: MeshMapLocations | undefined
  separateRuntimeId?: string | undefined
  onGateway: () => void
  onDevice: (hostId: string) => void
}) {
  const [editingLocation, editLocation] = useState<MapAnnotationTarget>()
  const peerLocations = useAppStore(state => state.config?.meshNetworkMapLocations)
  const links = useAppStore(state => state.meshDeviceLinks.saved)
  const devices = useMemo(() => savedMeshDevices(links), [links])
  const locationEditor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active && editingLocation !== undefined) locationEditor.current?.scrollIntoView({ block: 'nearest' })
  }, [active, editingLocation])
  const [snapshot, setSnapshot] = useState<MeshNetworkInspection>(), source = useRef<MeshNetworkInspection | undefined>(undefined)
  const [settings, setSettings] = useState<MeshNetworkSettings>()
  const [settingsIssue, setSettingsIssue] = useState('')
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed) }, [])
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active || !visible) return
    const controller = new AbortController()
    setBusy(true)
    const options = { signal: controller.signal, ...(separateRuntimeId ? { separateRuntimeId } : {}) }
    void api.mesh.call('mesh.inspect', {}, options).then(next => {
      if (controller.signal.aborted) return
      if (source.current && source.current.owner.runtimeId !== next.owner.runtimeId) throw Error('Another Core answered this network read. The original network view is retained.')
      source.current = next; setSnapshot(next); setIssue('')
    }).catch(cause => { if (!controller.signal.aborted) setIssue(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    void api.mesh.call('settings.mesh.inspect', {}, options).then(next => {
      if (!controller.signal.aborted) { setSettings(next); setSettingsIssue('') }
    }).catch(cause => { if (!controller.signal.aborted) setSettingsIssue(cause instanceof Error ? cause.message : String(cause)) })
    return () => { controller.abort(); setBusy(false) }
  }, [active, visible, revision, separateRuntimeId])
  const [geographicVisible, setGeographicVisible] = useState(true)
  const observedLocations = useMeshDeviceLocations(hosts, active && visible && geographicVisible, revision,
    !meshLocationValue(locations, 'local'), snapshot?.network?.networkId)
  const sameOwner = !snapshot || snapshot.owner.runtimeId === settings?.owner.runtimeId
    && snapshot.owner.ownerInstanceId === settings.owner.ownerInstanceId
  const savedTargets = sameOwner ? settings?.configuration.peers : undefined
  const savedIssue = settingsIssue || (settings && !sameOwner ? 'The saved settings belong to another Core instance.' : '')
  const savedHosts = useMemo(() => hosts.filter(host => host.kind === 'ssh'), [hosts])
  const networkId = snapshot?.network?.networkId
  const targets = useMemo((): MapAnnotationTarget[] => [
    ...devices.map(device => ({ field: 'meshNetworkMapLocations' as const, key: device.id, label: device.serverId })),
    ...hosts.map(host => ({ field: 'meshMapLocations' as const, key: host.id, label: host.label, local: host.kind === 'local' })),
    ...(networkId ? meshTopologyModel(snapshot).peers.filter(peer => !peer.own).map(peer => ({
      field: 'meshNetworkMapLocations' as const, key: meshPeerLocationKey(networkId, peer.id), label: meshPeerLabel(peer),
    })) : []),
  ], [devices, hosts, snapshot, networkId])
  const editHost = (id: string) => editLocation(targets.find(t => t.field === 'meshMapLocations' && t.key === id))
  const editPeer = (id: string) => editLocation(targets.find(t => t.field === 'meshNetworkMapLocations' && networkId && t.key === meshPeerLocationKey(networkId, id)))
  const actions = <><Button type="button" aria-expanded={editingLocation !== undefined} onClick={() => { const local = hosts.find(host => host.kind === 'local'); if (local) editHost(local.id) }}>My map annotations</Button>
    <Button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? 'Reading…' : 'Refresh network'}</Button></>
  const network = issue || !snapshot ? 'Unknown' : { active: 'Active', disabled: 'Disabled', starting: 'Starting', unavailable: 'Unavailable' }[snapshot.apply.state]
  const connected = !issue && snapshot?.network
    ? snapshot.network.peers.filter(peer => peer.state === 'connected').length : undefined
  return <section className="mesh-paths-pane" aria-label="Mesh network overview" data-settings-field="mesh-paths">
    <dl className="cluster-network-facts" aria-label="Current network participation">
      <div><dt>Network identity</dt><dd>{separateRuntimeId ? 'Separate Mesh identity' : 'This Mac'}</dd></div>
      <div><dt>Participation</dt><dd>{network}{!issue && snapshot?.network ? <small title={snapshot.network.networkId ?? undefined}>{snapshot.network.networkId}</small> : null}</dd></div>
      <div><dt>Connected peers</dt><dd>{connected ?? 'Unobserved'}</dd></div>
      <div><dt>{issue && snapshot ? 'Last confirmed' : 'Observed'}</dt><dd>{snapshot
        ? <time dateTime={new Date(snapshot.observedAt).toISOString()}>{new Date(snapshot.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
        : busy ? 'Reading…' : 'Unobserved'}</dd></div>
    </dl>
    {issue ? <div className="mesh-paths-issue" role="status"><strong>Network observation unavailable.</strong><p>{snapshot ? 'Showing the last confirmed network.' : 'Current network state is unknown.'}</p><details><summary>Read details</summary><p>{issue}</p></details></div> : null}
    <div ref={locationEditor} hidden={editingLocation === undefined}>
      <MeshLocationsPanel targets={targets} peerLocations={peerLocations} locations={locations} active={active} editing={editingLocation} onEdit={editLocation} />
    </div>
    <MeshNetworkMap devices={devices} onEndpointLocation={id => editLocation(targets.find(t => t.field === 'meshNetworkMapLocations' && t.key === id))}
      onGeographicViewChange={setGeographicVisible} observedLocations={observedLocations} snapshot={snapshot} active={active && visible} actions={actions} localClient
      hosts={savedHosts} locations={locations} onLocation={editHost} onPeerLocation={editPeer} peerLocations={peerLocations} onDevice={onDevice} onGateway={onGateway} savedTargets={savedTargets} savedIssue={savedIssue} reading={busy && !snapshot} stale={Boolean(issue && snapshot)} />
  </section>
}
