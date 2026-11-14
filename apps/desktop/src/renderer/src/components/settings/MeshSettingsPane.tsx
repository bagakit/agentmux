import { useEffect, useState } from 'react'
import { MeshNetworkSettings } from './MeshNetworkSettings'
import { HostSettingsPane } from './HostSettingsPane'
import { MeshPathsPane } from './MeshPathsPane'
import { ClusterMachinesPane } from './ClusterMachinesPane'
import type { SettingsNavigationRequest } from '../SettingsNavigation'

/** Keep visited editors mounted so changing views does not discard authored connection edits. */
type MeshView = 'paths' | 'machines' | 'network' | 'connections'
function requestedView(request?: SettingsNavigationRequest): MeshView {
  return request?.field === 'mesh-machines' ? 'machines' : request?.field === 'mesh-paths' ? 'paths' : request?.hostId ? 'connections' : request?.field?.startsWith('mesh-') ? 'network' : 'paths'
}
export function MeshSettingsPane(props: React.ComponentProps<typeof HostSettingsPane>) {
  const [view, setView] = useState<MeshView>(() => requestedView(props.navigationRequest))
  const [visited, setVisited] = useState(() => new Set([view]))
  function choose(next: MeshView) { setView(next); setVisited(value => new Set([...value, next])) }
  const [connectionRequest, setConnectionRequest] = useState<SettingsNavigationRequest>()
  useEffect(() => { setConnectionRequest(undefined); if (props.navigationRequest) choose(requestedView(props.navigationRequest)) }, [props.navigationRequest])
  function openConnection(hostId: string) { setConnectionRequest({ section: 'hosts', hostId, field: 'connection' }); choose('connections') }
  return <div className="mesh-settings-pane">
    <nav className="mesh-view-tabs" aria-label="Mesh views">{(['paths', 'machines', 'network', 'connections'] as const).map(item => <button type="button" key={item} aria-current={view === item ? 'page' : undefined} onClick={() => choose(item)}>{{ paths: 'Paths', machines: 'Machines', network: 'Gateway', connections: 'Connections' }[item]}</button>)}</nav>
    <div data-mesh-view="paths" hidden={view !== 'paths'}>{visited.has('paths') ? <MeshPathsPane active={props.active && view === 'paths'} onGateway={() => choose('network')} /> : null}</div>
    <div data-mesh-view="machines" hidden={view !== 'machines'}>{visited.has('machines') ? <ClusterMachinesPane hosts={props.config.hosts} active={props.active && view === 'machines'} onConnections={openConnection} /> : null}</div>
    <div data-mesh-view="network" hidden={view !== 'network'}>{visited.has('network') ? <MeshNetworkSettings active={props.active && view === 'network'} showTopology={false} onConnections={() => choose('connections')} /> : null}</div>
    <div data-mesh-view="connections" hidden={view !== 'connections'}>{visited.has('connections') ? <HostSettingsPane {...props} navigationRequest={connectionRequest ?? props.navigationRequest} active={props.active && view === 'connections'} /> : null}</div>
  </div>
}
