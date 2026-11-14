import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { MeshNetworkSettings } from './MeshNetworkSettings'
import { HostSettingsPane, type HostAddRequest } from './HostSettingsPane'
import { MeshPathsPane } from './MeshPathsPane'
import { ClusterMachinesPane } from './ClusterMachinesPane'
import type { SettingsNavigationRequest } from '../SettingsNavigation'

/** Observation tasks share one homepage; visited editors retain their original drafts and requests. */
type MeshView = 'paths' | 'machines' | 'network' | 'connections'
function requestedView(request?: SettingsNavigationRequest): MeshView {
  return request?.field === 'mesh-machines' ? 'machines' : request?.field === 'mesh-paths' ? 'paths' : request?.hostId ? 'connections' : request?.field?.startsWith('mesh-') ? 'network' : 'paths'
}
export function MeshSettingsPane(props: React.ComponentProps<typeof HostSettingsPane>) {
  const appliedNavigation = useRef(props.navigationRequest)
  const [chosenView, setChosenView] = useState<MeshView>(() => requestedView(props.navigationRequest))
  const pendingNavigation = appliedNavigation.current !== props.navigationRequest
  const view = pendingNavigation && props.navigationRequest ? requestedView(props.navigationRequest) : chosenView
  const [visited, setVisited] = useState(() => new Set([view]))
  const [connectionRequest, setConnectionRequest] = useState<SettingsNavigationRequest>()
  const [addHostRequest, setAddHostRequest] = useState<HostAddRequest>()
  const addHostNavigation = useRef(props.navigationRequest)
  function supersedeAdd() { setAddHostRequest(undefined) }
  function choose(next: MeshView) { supersedeAdd(); setChosenView(next); setVisited(value => new Set([...value, next])) }
  useEffect(() => {
    appliedNavigation.current = props.navigationRequest
    supersedeAdd()
    setConnectionRequest(undefined)
    if (props.navigationRequest) choose(requestedView(props.navigationRequest))
  }, [props.navigationRequest])
  function openConnection(hostId: string) { setConnectionRequest({ section: 'hosts', hostId, field: 'connection' }); choose('connections') }
  function addDevice() { setConnectionRequest(undefined); choose('connections'); addHostNavigation.current = props.navigationRequest; setAddHostRequest({ intentId: mintObjectId() }) }
  const mounted = (item: MeshView) => visited.has(item) || view === item
  const editing = view === 'network' || view === 'connections'
  return <div className="mesh-settings-pane" data-mesh-home-view={view}>
    {editing ? <header className="mesh-editor-navigation"><button type="button" className="small-button" onClick={() => choose('paths')}>← Back to Mesh</button><span>{view === 'network' ? 'Gateway settings' : 'Device connections'}</span></header>
      : <nav className="mesh-view-tabs" aria-label="Mesh views">{(['paths', 'machines'] as const).map(item => <button type="button" key={item} aria-current={view === item ? 'page' : undefined} onClick={() => choose(item)}>{item === 'paths' ? 'Overview' : 'Machines'}</button>)}</nav>}
    <div data-mesh-view="paths" hidden={view !== 'paths'}>{mounted('paths') ? <MeshPathsPane active={props.active && view === 'paths'} hosts={props.config.hosts} onGateway={() => choose('network')} onManageDevices={() => choose('connections')} onAddDevice={addDevice} onDevice={openConnection} /> : null}</div>
    <div data-mesh-view="machines" hidden={view !== 'machines'}>{mounted('machines') ? <ClusterMachinesPane hosts={props.config.hosts} active={props.active && view === 'machines'} onConnections={openConnection} /> : null}</div>
    <div data-mesh-view="network" hidden={view !== 'network'}>{mounted('network') ? <MeshNetworkSettings active={props.active && view === 'network'} showTopology={false} onConnections={() => choose('connections')} /> : null}</div>
    <div data-mesh-view="connections" hidden={view !== 'connections'}>{mounted('connections') ? <HostSettingsPane {...props} navigationRequest={pendingNavigation ? props.navigationRequest : connectionRequest ?? props.navigationRequest} addHostRequest={addHostNavigation.current === props.navigationRequest ? addHostRequest : undefined} active={props.active && view === 'connections'} /> : null}</div>
  </div>
}
