import { useEffect, useState } from 'react'
import { MeshNetworkSettings } from './MeshNetworkSettings'
import { HostSettingsPane } from './HostSettingsPane'

/** Keep visited editors mounted so changing views does not discard authored connection edits. */
export function MeshSettingsPane(props: React.ComponentProps<typeof HostSettingsPane>) {
  const [view, setView] = useState<'network' | 'connections'>(() => props.navigationRequest?.hostId ? 'connections' : 'network')
  const [visited, setVisited] = useState(() => new Set([view]))
  function choose(next: 'network' | 'connections') { setView(next); setVisited(value => new Set([...value, next])) }
  useEffect(() => { if (props.navigationRequest?.hostId) choose('connections'); else if (props.navigationRequest?.field?.startsWith('mesh-')) choose('network') }, [props.navigationRequest])
  return <div className="mesh-settings-pane">
    <nav className="mesh-view-tabs" aria-label="Mesh views">{(['network', 'connections'] as const).map(item => <button type="button" key={item} aria-current={view === item ? 'page' : undefined} onClick={() => choose(item)}>{item === 'network' ? 'Network' : 'Saved connections'}</button>)}</nav>
    <div data-mesh-view="network" hidden={view !== 'network'}>{visited.has('network') ? <MeshNetworkSettings active={props.active && view === 'network'} onConnections={() => choose('connections')} /> : null}</div>
    <div data-mesh-view="connections" hidden={view !== 'connections'}>{visited.has('connections') ? <HostSettingsPane {...props} active={props.active && view === 'connections'} /> : null}</div>
  </div>
}
