import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { Button } from '@agentmux/client-ui/components/Button'
import { MeshDeviceAccess } from './MeshDeviceAccess'
import { MeshNetworkSettings } from './MeshNetworkSettings'
import { HostSettingsPane, type HostAddRequest } from './HostSettingsPane'
import { MeshPathsPane } from './MeshPathsPane'
import { ClusterMachinesPane } from './ClusterMachinesPane'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import { useAppStore } from '../../store'

/** Observation tasks share one homepage; visited editors retain their original drafts and requests. */
type MeshView = 'paths' | 'machines' | 'join' | 'network' | 'connections' | 'access'
function requestedView(request?: SettingsNavigationRequest): MeshView {
  return request?.field === 'mesh-machines' ? 'machines' : request?.field === 'mesh-paths' ? 'paths' : request?.field === 'mesh-join' && (!request.hostId || request.hostId === 'local') ? 'join' : request?.field === 'mesh-access-work' ? 'access' : request?.hostId || request?.field === 'mesh-devices' ? 'connections' : request?.field?.startsWith('mesh-') ? 'network' : 'paths'
}
const subpages: Partial<Record<MeshView, string>> = { join: 'mesh-join', machines: 'mesh-machines', network: 'mesh-configuration', connections: 'mesh-devices' }
export function MeshSettingsPane({ onSubpageChange, ...props }: React.ComponentProps<typeof HostSettingsPane> & {
  onSubpageChange?: ((field: string | undefined) => void) | undefined
}) {
  const separateRuntimeId = useAppStore(state => state.meshGatewayRuntimeId) ?? undefined
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
  const observing = view === 'paths' || view === 'machines'
  const editing = !observing
  const observationScroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { onSubpageChange?.(subpages[view]) }, [onSubpageChange, view])
  const scrollPositions = useRef({ paths: 0, machines: 0 })
  useLayoutEffect(() => {
    if (observing && observationScroll.current) observationScroll.current.scrollTop = scrollPositions.current[view]
  }, [view, observing])
  return <div className="mesh-settings-pane" data-mesh-home-view={view}>
    {editing ? <header className="mesh-editor-navigation"><Button type="button" onClick={() => choose('paths')}>← Mesh overview</Button></header> : null}
    <div ref={observationScroll} data-mesh-view={view === 'machines' ? 'machines' : 'paths'} hidden={!observing}
      onScroll={event => { if (view === 'paths' || view === 'machines') scrollPositions.current[view] = event.currentTarget.scrollTop }}>
      {view === 'paths' ? <nav className="mesh-home-actions" aria-label="Device setup">
        <Button type="button" variant="primary" onClick={() => choose('join')}>Connect to a Relay Gateway</Button>
        <Button type="button" onClick={() => choose('access')}>Use another device</Button>
      </nav> : null}
      <div hidden={view !== 'paths'}>{separateRuntimeId ? <p className="mesh-network-note">This map uses the separate Mesh identity selected in the connection guide.</p> : null}
        {mounted('paths') ? <MeshPathsPane key={separateRuntimeId ?? 'original'} separateRuntimeId={separateRuntimeId} active={props.active && view === 'paths'} hosts={props.config.hosts} locations={props.config.meshMapLocations} onDevice={openConnection} onGateway={() => choose('network')} /> : null}</div>
      {mounted('paths') || mounted('machines') ? <ClusterMachinesPane hosts={props.config.hosts} active={props.active && observing}
        compact={view !== 'machines'} onAddDevice={addDevice} onConnections={openConnection} /> : null}
    </div>
    <div data-mesh-view="join" hidden={view !== 'join'}>{mounted('join') ? <MeshNetworkSettings join active={props.active && view === 'join'} onDone={() => choose('paths')} onAccess={() => choose('access')} onManage={() => choose('network')} /> : null}</div>
    <div data-mesh-view="network" hidden={view !== 'network'}>{mounted('network') ? <MeshNetworkSettings active={props.active && view === 'network'} showTopology={false} onConnections={() => choose('connections')} onJoin={() => choose('join')} /> : null}</div>
    <div data-mesh-view="access" hidden={view !== 'access'}>{mounted('access') ? <section data-settings-field="mesh-access-work"><MeshDeviceAccess /></section> : null}</div>
    <div data-mesh-view="connections" hidden={view !== 'connections'}>{mounted('connections') ? <HostSettingsPane {...props} navigationRequest={pendingNavigation ? props.navigationRequest : connectionRequest ?? props.navigationRequest} addHostRequest={addHostNavigation.current === props.navigationRequest ? addHostRequest : undefined} active={props.active && view === 'connections'} /> : null}</div>
  </div>
}
