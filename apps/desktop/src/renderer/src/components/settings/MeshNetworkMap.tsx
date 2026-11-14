import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BaseEdge, getViewportForBounds, Position, ReactFlow, useNodesState, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance, type XYPosition } from '@xyflow/react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { HostConfig } from '../../../../shared/contracts'
import { meshLocationValue, readMeshLocation, type MeshMapLocations } from '../../../../shared/mesh-map-locations'
import { hostConnectionSummary } from '../../lib/host-transport'
import { TextInput } from '@agentmux/client-ui/input'
import type { MeshNetworkInspection, MeshNetworkSettings } from '@agentmux/core/mesh-network'
import { meshPathEdges, meshPeerLabel, meshPeerState, meshRtt, meshSelectionExists, meshSelectionPath, meshTopologyModel, meshTopologySource, shortMeshIdentity, type MeshTopologyPeer, type MeshTopologySelection } from './mesh-topology'
import './mesh-topology.css'
import { MeshGeography, placeGeographicNodes, projectMeshLocation } from './MeshGeography'
import { MeshPorts, MeshSavedClient, MeshSavedHost, SAVED_CLIENT_ID, SavedConnectionDetails, savedConnectionNodes, savedHostId,
  type SavedClientNode, type SavedHostNode } from './MeshSavedConnections'

type PeerNode = Node<{ peer: MeshTopologyPeer; sharedLocal: boolean; selected: boolean; onPath: boolean; dimmed: boolean; onSelect(id: string): void }, 'meshPeer'>
type MapNode = PeerNode | SavedHostNode | SavedClientNode
type MapEdge = Edge<{ sourcePoint?: XYPosition; targetPoint?: XYPosition }>
const SIZE = { width: 188, height: 64 }
const COMPACT_PEER_SIZE = { width: 166, height: SIZE.height }
const MIN_ZOOM = .15
const MAX_ZOOM = 2
const NO_HOSTS: readonly HostConfig[] = []
function MeshPeer({ data }: NodeProps<PeerNode>) {
  const { peer, sharedLocal } = data
  return <><MeshPorts type="target" />
    <button type="button" className="mesh-explorer-node nopan" data-peer-state={peer.state} data-shared-local={sharedLocal || undefined} data-on-path={data.onPath || undefined} data-dimmed={data.dimmed || undefined} aria-pressed={data.selected} onClick={() => data.onSelect(peer.id)}>
      <span className="mesh-explorer-node__kind"><span className="mesh-explorer-node__socket" aria-hidden="true" />{sharedLocal ? 'LOCAL DEVICE' : peer.own ? 'THIS CORE' : peer.ingress.length ? 'GATEWAY INGRESS' : 'PEER'}{data.selected ? <span aria-label="Selected">✓</span> : null}</span>
      <strong title={peer.id}>{sharedLocal ? 'This device' : meshPeerLabel(peer)}</strong>
      <span className="mesh-explorer-node__state">{sharedLocal ? 'Saved links · Relay' : meshPeerState(peer)}{peer.rttMs === null ? '' : ` · ${meshRtt(peer.rttMs)}`}</span>
    </button><MeshPorts type="source" /></>
}
const nodeTypes = { meshPeer: MeshPeer, savedClient: MeshSavedClient, savedHost: MeshSavedHost }
function MeshArc({ id, sourceX: startX, sourceY: startY, targetX: endX, targetY: endY, data }: EdgeProps<MapEdge>) {
  const { x: sourceX, y: sourceY } = data?.sourcePoint ?? { x: startX, y: startY }
  const { x: targetX, y: targetY } = data?.targetPoint ?? { x: endX, y: endY }
  if (data?.sourcePoint && data.targetPoint && sourceX === targetX && sourceY === targetY) {
    return <BaseEdge id={id} path={`M ${sourceX},${sourceY} C ${sourceX - 48},${sourceY - 22} ${sourceX - 48},${sourceY + 22} ${sourceX},${sourceY}`} />
  }
  const dx = targetX - sourceX, dy = targetY - sourceY
  const bend = Math.min(Math.hypot(dx, dy) * .2, 80)
  const direction = Math.sign(dx || dy)
  const midX = (sourceX + targetX) / 2 + (Math.abs(dy) > Math.abs(dx) ? bend * direction : 0)
  const midY = (sourceY + targetY) / 2 - (Math.abs(dx) >= Math.abs(dy) ? bend : 0)
  return <BaseEdge id={id} path={`M ${sourceX},${sourceY} Q ${midX},${midY} ${targetX},${targetY}`} />
}
const edgeTypes = { meshArc: MeshArc }

type GatewayTargets = MeshNetworkSettings['configuration']['peers']
function MeshGateways({ snapshot, peers, selected, stale, savedTargets, savedIssue, onGateway, onPeer }: {
  snapshot?: MeshNetworkInspection | undefined; peers: MeshTopologyPeer[]; selected?: MeshTopologySelection | undefined; stale: boolean
  savedTargets?: GatewayTargets | undefined; savedIssue?: string | undefined
  onGateway: () => void; onPeer: (id: string) => void
}) {
  const gateway = snapshot?.gateway
  const listener = gateway?.listener
  const published = peers.filter(peer => peer.ingress.length)
  const observedIds = new Set(peers.map(peer => peer.id))
  const configured = (savedTargets ?? []).flatMap(peer => {
    const advertised = published.find(item => item.id === peer.peerId)
    const additional = peer.endpoints.filter(target => !advertised?.ingress.some(ingress => ingress.endpoint === target.endpoint && ingress.useTls === target.useTls))
    return additional.length ? [{ id: peer.peerId, endpoints: additional }] : []
  })
  const state = gateway ? { disabled: 'Off', starting: 'Starting', listening: 'Listening', unavailable: 'Unavailable' }[gateway.state] : 'Unknown'
  return <section className="mesh-gateways" aria-label="Gateways">
    <header><h4>Gateways</h4><Button type="button" onClick={onGateway}>Configure</Button></header>
    <div className="mesh-gateways__local"><span><strong>Local listener</strong>{listener ? <code>{listener.host}:{listener.port}</code> : null}</span>
      <span data-listening={!stale && gateway?.state === 'listening' || undefined}>{stale ? 'Last confirmed · ' : ''}{state}</span></div>
    {gateway?.issue ? <p className="mesh-gateways__issue">{gateway.issue.message}</p> : null}
    {published.length ? <ul aria-label="Advertised gateways">{published.map(peer => <li key={peer.id}>
      <button type="button" aria-pressed={selected?.kind === 'peer' && selected.id === peer.id} onClick={() => onPeer(peer.id)}>
        <span><strong>{peer.own ? 'This Core' : peer.ingress[0]?.endpoint}</strong>{peer.own ? <small>{peer.ingress[0]?.endpoint}</small> : null}{peer.ingress.length > 1 ? <small>+{peer.ingress.length - 1} addresses</small> : null}</span>
        <small>{peer.own ? 'Published' : meshPeerState(peer)}</small>
      </button>
    </li>)}</ul> : <p className="mesh-gateways__empty">{snapshot?.network ? 'No advertised gateways in this observation.' : 'Gateway advertisements are not observed.'}</p>}
    {configured.length ? <ul aria-label="Saved gateway targets">{configured.map(peer => <li key={peer.id}>
      {peer.endpoints.map(target => observedIds.has(peer.id)
        ? <button type="button" key={`${target.useTls}:${target.endpoint}`} aria-pressed={selected?.kind === 'peer' && selected.id === peer.id} onClick={() => onPeer(peer.id)}><strong>{target.endpoint}</strong><small>Saved target</small></button>
        : <div key={`${target.useTls}:${target.endpoint}`} className="mesh-gateways__local"><span><strong>{target.endpoint}</strong><small>Saved target</small></span><small>Not observed</small></div>)}
    </li>)}</ul> : null}
    {savedIssue ? <details className="mesh-gateways__source"><summary>{savedTargets ? 'Saved targets · last confirmed' : 'Saved targets unavailable'}</summary><p>{savedIssue}</p></details> : null}
  </section>
}

type MeshMapView = 'geography' | 'connections' | 'list'

/** The source's current network observation; selecting and arranging never changes network policy. */
type MeshMapProps = {
  snapshot?: MeshNetworkInspection | undefined; active?: boolean; actions?: ReactNode; reading?: boolean; stale?: boolean
  onGateway?: (() => void) | undefined; savedTargets?: GatewayTargets | undefined; savedIssue?: string | undefined
  hosts?: readonly HostConfig[]; onDevice?: ((hostId: string) => void) | undefined; localClient?: boolean
  locations?: MeshMapLocations | undefined; onLocation?: ((hostId: string) => void) | undefined
}
export function MeshNetworkMap({ snapshot, active = true, reading = false, stale = false, hosts = NO_HOSTS, ...props }: MeshMapProps) {
  const [view, setView] = useState<MeshMapView>(props.localClient ? 'geography' : 'connections')
  const [selectedHostId, selectHost] = useState<string>()
  return <MeshTopologyExplorer key={meshTopologySource(snapshot)} {...props} snapshot={snapshot} active={active}
    hosts={hosts} view={view} setView={setView} selectedHostId={selectedHostId} selectHost={selectHost} reading={reading} stale={stale} />
}
function MeshTopologyExplorer({ snapshot, active, actions, hosts, onDevice, localClient, view, setView, locations, onLocation, selectedHostId, selectHost, onGateway, savedTargets, savedIssue, reading, stale }: MeshMapProps & {
  view: MeshMapView; setView: (view: MeshMapView) => void
  active: boolean; reading: boolean; stale: boolean; hosts: readonly HostConfig[]
  selectedHostId: string | undefined; selectHost: (id: string | undefined) => void
}) {
  const model = useMemo(() => meshTopologyModel(snapshot), [snapshot])
  const [selected, select] = useState<MeshTopologySelection>()
  const [narrow, setNarrow] = useState(false)
  const points = useMemo(() => {
    const positions = new Map<string, XYPosition>()
    for (const host of hosts) {
      const location = readMeshLocation(meshLocationValue(locations, host.id))
      if (location) positions.set(savedHostId(host.id), projectMeshLocation(location))
    }
    const here = localClient && readMeshLocation(meshLocationValue(locations, 'local'))
    if (here) positions.set(SAVED_CLIENT_ID, projectMeshLocation(here))
    return positions
  }, [hosts, localClient, locations])
  const geographic = view === 'geography'
  const localPlaced = points.has(SAVED_CLIENT_ID)
  const hasRelayPeers = model.peers.some(peer => !peer.own)
  const mixed = hosts.length > 0 && hasRelayPeers
  const portrait = mixed && narrow
  const hasMap = localClient || hosts.length > 0 || hasRelayPeers || localPlaced
  const selectedHost = hosts.find(host => host.id === selectedHostId)
  const [scope, setScope] = useState<'network' | 'selection'>('network')
  const [chosenCategory, setCategory] = useState<'peers' | 'routes' | 'circuits' | 'hosts'>(() => model.routes.length ? 'routes' : 'peers')
  const category = !hasRelayPeers ? 'hosts' : chosenCategory === 'hosts' && !hosts.length ? 'peers' : chosenCategory
  const [query, setQuery] = useState(''), [arrangeAttempt, arrange] = useState(0), [arranging, setArranging] = useState(false), [layoutIssue, setLayoutIssue] = useState('')
  const [focusRequest, setFocusRequest] = useState(0), focusedRequest = useRef(0), focusResizeRevision = useRef(0), canvasResizeRevision = useRef(0)
  const requestViewport = useCallback(() => { focusResizeRevision.current = canvasResizeRevision.current; setFocusRequest(value => value + 1) }, [])
  const widePositions = useRef(new Map<string, { x: number; y: number }>())
  const narrowPositions = useRef(new Map<string, { x: number; y: number }>())
  const positions = portrait ? narrowPositions.current : widePositions.current
  const instance = useRef<ReactFlowInstance<MapNode, MapEdge> | null>(null), canvas = useRef<HTMLDivElement>(null)
  const viewportTouched = useRef(false), cancelLayout = useRef<(() => void) | null>(null), arrangedAttempt = useRef(-1)
  const path = meshSelectionPath(model, selected), pathSet = useMemo(() => new Set(path), [path.join('\0')])
  const pathEdges = useMemo(() => meshPathEdges(path), [path.join('\0')])
  const selectionMissing = Boolean(selected && !meshSelectionExists(model, selected))
  const byId = useMemo(() => new Map(model.peers.map(peer => [peer.id, peer])), [model.peers])
  const needle = query.trim().toLocaleLowerCase()
  const matches = (values: readonly string[]) => !needle || values.some(value => value.toLocaleLowerCase().includes(needle))
  const peers = model.peers.filter(peer => matches([peer.id, ...peer.ingress.map(item => item.endpoint), ...peer.endpoints]))
  const routes = model.routes.filter(route => matches([route.serverId, ...route.path, ...route.advertisedIngress.map(item => item.endpoint)]))
  const circuits = model.circuits.filter(circuit => matches([circuit.circuitId, circuit.serverId, ...circuit.path]))
  const matchedPeers = new Set([...peers.map(peer => peer.id), ...routes.flatMap(route => route.path), ...circuits.flatMap(circuit => circuit.path)])
  const matchesHost = (host: HostConfig) => matches([host.id, host.label, hostConnectionSummary(host)])
  const matchingHosts = hosts.filter(matchesHost)
  const choosePeer = useCallback((id: string) => { selectHost(undefined); select({ kind: 'peer', id }); requestViewport() }, [selectHost, requestViewport])
  const chooseHost = useCallback((id: string) => { select(undefined); selectHost(id); setScope('network'); setCategory('hosts'); requestViewport() }, [selectHost, requestViewport])
  const focused = hasRelayPeers && scope === 'selection' && path.length > 0
  // MeshPathsPane obtains this observation directly from the original local Core.
  const sharedPeerId = localClient ? model.peers.find(peer => peer.own)?.id : undefined
  const peerNodeId = (id: string) => id === sharedPeerId ? SAVED_CLIENT_ID : `relay:${id}`
  const peerSize = mixed ? COMPACT_PEER_SIZE : SIZE
  const savedNodes = savedConnectionNodes(hosts, narrow || mixed, selectedHostId, host => !focused && matchesHost(host), chooseHost, localClient || localPlaced)
  const clientPosition = savedNodes[0]?.position
  const visiblePeers = hasRelayPeers ? model.peers : model.peers.filter(peer => peer.id === sharedPeerId)
  const projectedNodes: MapNode[] = [
    ...savedNodes.filter(node => node.type !== 'savedClient' || !sharedPeerId),
    ...visiblePeers.map((peer, index): PeerNode => {
      const id = peerNodeId(peer.id)
      const sharedLocal = id === SAVED_CLIENT_ID
      const position = sharedLocal && clientPosition ? clientPosition : { x: (mixed ? 492 : 0) + index % 3 * (peerSize.width + 40), y: Math.floor(index / 3) * 108 }
      return { id, type: 'meshPeer', ...peerSize, position, selectable: false,
        data: { peer, sharedLocal, selected: selected?.kind === 'peer' && selected.id === peer.id, onPath: pathSet.has(peer.id),
          dimmed: !pathSet.has(peer.id) && (focused || Boolean(needle && !matchedPeers.has(peer.id))), onSelect: choosePeer } }
    }),
  ]
  const geography = geographic ? placeGeographicNodes(projectedNodes, points, narrow) : undefined
  const placedNodes = geography?.placements ?? projectedNodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position }))
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>(placedNodes)
  useEffect(() => {
    setNodes(previous => {
      const held = new Map(previous.map(node => [node.id, node]))
      return placedNodes.map(node => {
        const { className: _className, draggable: _draggable, ...measured } = held.get(node.id) ?? {}
        return { ...measured, ...node }
      })
    })
  }, [snapshot, hosts, points, narrow, selected, selectedHostId, scope, query, geographic, setNodes, choosePeer, chooseHost, sharedPeerId])
  const visiblePeerIds = new Set(visiblePeers.map(peer => peer.id))
  const links = [
    ...model.edges.filter(edge => visiblePeerIds.has(edge.source) && visiblePeerIds.has(edge.target))
      .map(edge => ({ id: `relay:${edge.id}`, source: peerNodeId(edge.source), target: peerNodeId(edge.target), saved: false, selected: pathEdges.has(edge.id) })),
    ...hosts.map(host => ({ id: savedHostId(host.id), source: SAVED_CLIENT_ID, target: savedHostId(host.id), saved: true, selected: selectedHostId === host.id })),
  ]
  const topologyKey = JSON.stringify([projectedNodes.map(node => node.id), links.map(link => link.id).sort()])
  const nodePositions = new Map(nodes.map(node => [node.id, node.position]))
  const edges = links.map(({ id, source, target, saved, selected }): MapEdge => {
    const from = nodePositions.get(source), to = nodePositions.get(target)
    const dx = (to?.x ?? 0) - (from?.x ?? 0), dy = (to?.y ?? 0) - (from?.y ?? 0)
    const horizontal = Math.abs(dx) > Math.abs(dy)
    const sourcePoint = geographic ? points.get(source) : undefined, targetPoint = geographic ? points.get(target) : undefined
    return {
      id, source, target, type: 'meshArc', selectable: false,
      data: { ...(sourcePoint ? { sourcePoint } : {}), ...(targetPoint ? { targetPoint } : {}) },
      sourceHandle: horizontal ? dx > 0 ? Position.Right : Position.Left : dy > 0 ? Position.Bottom : Position.Top,
      targetHandle: horizontal ? dx > 0 ? Position.Left : Position.Right : dy > 0 ? Position.Top : Position.Bottom,
      className: `mesh-explorer-edge ${saved ? 'mesh-explorer-edge--saved' : 'mesh-explorer-edge--relay'}${selected ? ' mesh-explorer-edge--selected' : focused ? ' mesh-explorer-edge--muted' : ''}`,
    }
  })
  const fitPadding = geographic ? .045 : narrow ? .08 : .16
  const boundsX = geography?.bounds.x, boundsY = geography?.bounds.y
  const boundsWidth = geography?.bounds.width, boundsHeight = geography?.bounds.height
  const fit = useCallback(() => {
    if (boundsWidth !== undefined && boundsHeight !== undefined) {
      const rect = canvas.current?.getBoundingClientRect()
      if (rect?.width && rect.height) void instance.current?.setViewport(getViewportForBounds({
        x: boundsX ?? 0, y: boundsY ?? 0, width: boundsWidth, height: boundsHeight
      }, rect.width, rect.height, MIN_ZOOM, MAX_ZOOM, fitPadding))
    }
    else void instance.current?.fitView({ padding: fitPadding, maxZoom: 1 })
  }, [fitPadding, boundsX, boundsY, boundsWidth, boundsHeight])
  // Container changes are real geometry changes, not new observations. Refit the same nodes while
  // retaining their positions, so a narrow overview never leaves the original Core off-canvas.
  useEffect(() => {
    const element = canvas.current
    if (!active || view === 'list' || !element) return
    let frame: number | undefined, previous = ''
    const resize = () => {
      const { width, height } = element.getBoundingClientRect()
      if (!width || !height) return
      const size = `${width}:${height}`
      if (size === previous) return
      previous = size
      setNarrow(width < 590)
      canvasResizeRevision.current += 1
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = undefined; fit() })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [active, view, fit, hasMap])
  // A deliberate selection can open the inspector and narrow the canvas after a user pan.
  // Wait for its new dimensions, then fit once. Observations do not request a viewport change.
  useEffect(() => {
    if (!active || view === 'list' || focusRequest === focusedRequest.current) return
    focusedRequest.current = focusRequest
    let settled: number | undefined
    const frame = requestAnimationFrame(() => { settled = requestAnimationFrame(() => { if (canvasResizeRevision.current === focusResizeRevision.current) fit() }) })
    return () => { cancelAnimationFrame(frame); if (settled !== undefined) cancelAnimationFrame(settled) }
  }, [focusRequest, active, view, fit])
  // Geometry is finite and off-thread. Counters, RTT and selection do not relayout the network.
  useEffect(() => {
    if (!active || view === 'list' || !hasRelayPeers || geographic) return
    const ids = projectedNodes.map(node => node.id), force = arrangedAttempt.current !== arrangeAttempt
    if (!force && ids.every(id => positions.has(id))) return
    let worker: Worker
    try { worker = new Worker(new URL('../../lib/force-layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch { setLayoutIssue('Automatic layout is unavailable. You can move devices or use the list.'); return }
    let current = true, frame: number | undefined
    const cancel = () => { current = false; worker.terminate(); if (frame !== undefined) cancelAnimationFrame(frame); setArranging(false) }
    cancelLayout.current = cancel; arrangedAttempt.current = arrangeAttempt; setArranging(true)
    worker.onmessage = (event: MessageEvent<{ id: string; positions?: Record<string, { x: number; y: number }>; error?: string }>) => {
      if (!current || event.data.id !== topologyKey) return
      worker.terminate(); setArranging(false)
      const raw = event.data.positions
      if (!raw || event.data.error) { setLayoutIssue(event.data.error ?? 'Layout is unconfirmed. Your positions are kept.'); return }
      const next = portrait ? Object.fromEntries(Object.entries(raw).map(([id, { x, y }]) => [id, { x: y, y: x }])) : raw
      const held = ids.flatMap(id => positions.has(id) ? [positions.get(id)!] : [])
      const missing = ids.filter(id => !positions.has(id))
      const offset = !force && held.length && missing.length
        ? Math.max(...held.map(point => point.y)) + SIZE.height + 40 - Math.min(...missing.map(id => next[id]?.y ?? 0)) : 0
      for (const id of ids) if (next[id] && (force || !positions.has(id))) {
        positions.set(id, { x: next[id]!.x, y: next[id]!.y + offset })
      }
      setNodes(values => values.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })))
      setLayoutIssue('')
      if (!viewportTouched.current) frame = requestAnimationFrame(fit)
    }
    worker.onerror = () => { if (current) { worker.terminate(); setArranging(false); setLayoutIssue('Automatic layout stopped. Your positions and list are kept.') } }
    worker.postMessage({ id: topologyKey, input: {
      // Transpose the box dimensions as well as the returned coordinates so cards never rotate.
      nodes: projectedNodes.map(({ id, width, height }) => portrait ? { id, width: height, height: width } : { id, width, height }),
      edges: links.map(({ source, target }) => ({ source, target })),
    } })
    return () => { cancel(); if (cancelLayout.current === cancel) cancelLayout.current = null }
  }, [active, view, topologyKey, arrangeAttempt, fit, setNodes, hasRelayPeers, portrait, positions, geographic])
  const currentPeer = selected?.kind === 'peer' ? byId.get(selected.id) : undefined
  const currentRoute = selected?.kind === 'route' ? model.routes.find(route => route.serverId === selected.id) : undefined
  const currentCircuit = selected?.kind === 'circuit' ? model.circuits.find(circuit => circuit.circuitId === selected.id) : undefined
  const count = category === 'peers' ? peers.length : category === 'routes' ? routes.length : category === 'circuits' ? circuits.length : matchingHosts.length
  function choose(next: MeshTopologySelection) { selectHost(undefined); select(next); requestViewport() }
  function showPeer(id: string) { setCategory('peers'); choose({ kind: 'peer', id }) }
  const directory = <div className="mesh-explorer__directory" data-list-view={view === 'list' || undefined}>
        <nav className="mesh-explorer__categories" aria-label="Network objects">{([['peers', 'Peers', model.peers.length], ['routes', 'Endpoints', model.routes.length], ['circuits', 'Adopted circuits', model.circuits.length], ...(hosts.length ? [['hosts', 'Saved connections', hosts.length] as const] : [])] as const).filter(([key]) => key === 'hosts' || hasRelayPeers).map(([key, name, size]) => <button type="button" key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>{name}<span>{size}</span></button>)}</nav>
        {needle ? <p className="mesh-explorer__search-result" role="status">{count} match{count === 1 ? '' : 'es'} · <button type="button" onClick={() => setQuery('')}>Clear search</button></p> : null}
        <ul className={`mesh-explorer__objects ${category === 'peers' ? 'mesh-peer-list' : category === 'routes' ? 'mesh-route-list' : 'mesh-circuit-list'}`}>
          {category === 'peers' ? peers.map(peer => <li key={peer.id}><button type="button" data-mesh-object="peer" aria-pressed={selected?.kind === 'peer' && selected.id === peer.id} onClick={() => choose({ kind: 'peer', id: peer.id })}><span><strong>{meshPeerLabel(peer)}</strong><code>{shortMeshIdentity(peer.id)}</code></span><span>{meshPeerState(peer)}<small>{meshRtt(peer.rttMs)}</small></span></button></li>) : null}
          {category === 'routes' ? routes.map(route => <li key={route.serverId}><button type="button" data-mesh-object="route" aria-pressed={selected?.kind === 'route' && selected.id === route.serverId} onClick={() => choose({ kind: 'route', id: route.serverId })}><span><strong>{shortMeshIdentity(route.serverId)}</strong><small>Available route · {shortMeshIdentity(route.originPeerId)}</small></span><span>{route.hops} hop{route.hops === 1 ? '' : 's'}<small>{meshRtt(route.rttMs)}</small></span></button></li>) : null}
          {category === 'hosts' ? matchingHosts.map(host => <li key={host.id}><button type="button" data-mesh-object="host" aria-pressed={selectedHostId === host.id} onClick={() => chooseHost(host.id)}>
            <span><strong>{host.label}</strong><small>{hostConnectionSummary(host)}</small></span><span>Saved route</span>
          </button></li>) : null}
          {category === 'circuits' ? circuits.map(circuit => <li key={circuit.circuitId}><button type="button" data-mesh-object="circuit" aria-pressed={selected?.kind === 'circuit' && selected.id === circuit.circuitId} onClick={() => choose({ kind: 'circuit', id: circuit.circuitId })}><span><strong>{shortMeshIdentity(circuit.serverId)}</strong><small>{shortMeshIdentity(circuit.circuitId)}</small></span><span>Adopted<small>{Math.max(0, circuit.path.length - 1)} network hops</small></span></button></li>) : null}
        </ul>
        {!count ? <p className="mesh-explorer__directory-empty">{needle ? 'No matching objects in this category. Other network objects are unchanged.' : category === 'circuits' ? 'No adopted circuits are currently reported.' : category === 'routes' ? 'No endpoint route is currently advertised.' : category === 'hosts' ? 'No saved connections.' : 'No network peers are currently reported.'}</p> : null}
      </div>
  const inspector = selectedHost ? <SavedConnectionDetails host={selectedHost} onDevice={onDevice} onLocation={onLocation}
    location={meshLocationValue(locations, selectedHost.id)} onClear={() => selectHost(undefined)} />
    : selected ? <aside className="mesh-explorer__detail" aria-label="Selected network object">
        <header><span className="mesh-explorer__eyebrow">{selected.kind === 'peer' ? 'NETWORK PEER' : selected.kind === 'route' ? 'AVAILABLE ROUTE' : 'ADOPTED CIRCUIT'}</span><Button type="button" onClick={() => select(undefined)}>Clear</Button></header>
        <h4>{currentPeer ? meshPeerLabel(currentPeer) : shortMeshIdentity(currentRoute?.serverId ?? currentCircuit?.serverId ?? selected.id)}</h4>
        {currentPeer?.own && currentPeer.id === sharedPeerId && onLocation ? <Button type="button" onClick={() => onLocation('local')}>Edit map location</Button> : null}
        {selectionMissing ? <p role="status">This object is no longer in the current observation. Its selected identity is retained; choose another object to inspect the current network.</p> : null}
        {currentPeer ? <section><h5>Reciprocal neighbors · {currentPeer.neighbors.length}</h5>{currentPeer.neighbors.length ? <ul>{currentPeer.neighbors.map(id => <li key={id}><button type="button" onClick={() => showPeer(id)}>{byId.get(id) ? meshPeerLabel(byId.get(id)!) : shortMeshIdentity(id)}</button></li>)}</ul> : <p>No reciprocal link observed.</p>}</section> : null}
        {path.length > 1 ? <section className="mesh-explorer__path"><h5>{selected.kind === 'circuit' ? 'Adopted path' : 'Available path'} · {path.length - 1} network hops</h5><ol aria-label="Selected endpoint network path">{path.map((id, index) => <li key={index + ':' + id}><span>{index + 1}</span><button type="button" onClick={() => showPeer(id)}><strong>{byId.get(id) ? meshPeerLabel(byId.get(id)!) : shortMeshIdentity(id)}</strong><code>{shortMeshIdentity(id)}</code></button></li>)}</ol><p>{selected.kind === 'circuit' ? 'The circuit keeps this adopted path. A newer available route may differ.' : 'This route is available for new circuits. It does not prove a completed Core operation.'}</p></section> : null}
        <details className="mesh-explorer__identity"><summary>Technical identity</summary><dl><dt>{selected.kind === 'peer' ? 'Peer identity' : selected.kind === 'route' ? 'Original endpoint' : 'Circuit identity'}</dt><dd><code>{selected.id}</code></dd>
          {currentPeer ? <><dt>Observation</dt><dd>{meshPeerState(currentPeer)} · {currentPeer.observed ? 'Origin record present' : 'No origin record'}</dd><dt>Epoch</dt><dd>{currentPeer.epoch ?? 'Not observed'}</dd><dt>Direct peer RTT</dt><dd>{meshRtt(currentPeer.rttMs)}</dd></> : null}
          {currentRoute ? <><dt>Available route RTT</dt><dd>{meshRtt(currentRoute.rttMs)}</dd><dt>Publisher generation</dt><dd><code>{currentRoute.publisherGeneration}</code></dd></> : null}
          {currentCircuit ? <><dt>Original endpoint</dt><dd><code>{currentCircuit.serverId}</code></dd><dt>Path</dt><dd>Adopted by this circuit · {Math.max(0, currentCircuit.path.length - 1)} network hops</dd></> : null}
        </dl>
        {currentPeer?.ingress.length ? <section><h5>Advertised gateway addresses</h5>{currentPeer.ingress.map(item => <code key={item.endpoint}>{item.useTls ? 'wss://' : 'ws://'}{item.endpoint}</code>)}</section> : null}
        </details>
    </aside> : null
  const networkState = snapshot?.apply.state === 'disabled' ? 'Mesh Relay is off on this Core'
    : reading ? 'Reading Mesh Relay…'
      : snapshot?.network ? 'No Relay peers observed' : 'Mesh Relay observation unavailable'
  const relaySummary = snapshot?.network && hasRelayPeers
    ? `${model.peers.length} Relay peers · ${model.edges.length} reciprocal link${model.edges.length === 1 ? '' : 's'} · ${model.routes.length} reachable endpoint${model.routes.length === 1 ? '' : 's'}`
    : networkState
  const legend = hasMap ? <span className="mesh-explorer__legend" aria-label="Link styles">
    {hosts.length ? <><i className="mesh-explorer__legend-saved" aria-hidden="true" /> Saved connection</> : null}
    {hasRelayPeers ? <><i aria-hidden="true" /> Relay link{path.length > 1 ? <><i className="mesh-explorer__legend-selected" aria-hidden="true" /> Selected path</> : null}</> : null}
  </span> : null
  const summary = [hosts.length ? `${hosts.length} saved route${hosts.length === 1 ? '' : 's'}` : '', (stale ? 'Last confirmed · ' : '') + relaySummary].filter(Boolean).join(' · ')
  return <section className="mesh-network-map mesh-explorer" aria-label="Observed Mesh topology" data-mesh-topology data-mesh-overview={onGateway ? true : undefined}>
    <header className="mesh-explorer__header"><div className="mesh-explorer__heading"><h3>Network map{snapshot?.network?.networkId ? <small>{snapshot.network.networkId}</small> : null}</h3><p>{localClient ? 'From this device · ' : ''}{summary}</p></div>{actions}</header>
    {hasMap ? <div className="mesh-explorer__toolbar"><label className="mesh-explorer__search"><TextInput aria-label={hosts.length ? hasRelayPeers ? 'Find a device, peer or path' : 'Find a device' : 'Find a peer, endpoint or circuit'} value={query} onChange={event => setQuery(event.target.value)} placeholder={hosts.length ? hasRelayPeers ? 'Find a device, peer or path' : 'Find a device' : 'Find a peer or path'} /></label>
      <div className="mesh-explorer__segments" role="group" aria-label="Network view">
        {([['geography', 'Geography'], ['connections', 'Connections'], ['list', 'List']] as const).map(([mode, label]) =>
          <button type="button" key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{label}</button>)}
      </div>
      {hasRelayPeers ? <div className="mesh-explorer__segments" role="group" aria-label="Network scope"><button type="button" aria-pressed={!focused} onClick={() => { setScope('network'); requestViewport() }}>Network</button><button type="button" aria-pressed={focused} disabled={!path.length} onClick={() => { setScope('selection'); requestViewport() }}>Selected path</button></div> : null}
    </div> : null}
    <div className="mesh-explorer__body" data-empty={!hasMap || undefined}><div className="mesh-explorer__workspace">
      {view === 'list' ? directory : null}
      {view !== 'list' && legend ? <div className="mesh-explorer__map-key" data-geographic={geographic || undefined}>{legend}
        <span>{geography ? `${geography.marks.length} located · ${geography.unknown} location unknown` : 'Connection diagram'}</span></div> : null}
      {hasMap ? <div className="mesh-explorer__graph" hidden={view === 'list'}>
        <div ref={canvas} className="mesh-explorer__canvas" data-mixed={mixed || undefined} data-saved={hosts.length > 0 || undefined} data-narrow={narrow || undefined}
          data-geographic={geographic || undefined} aria-label="Network relationship canvas">
          <ReactFlow<MapNode, MapEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={value => { instance.current = value; if (geographic) requestViewport() }}
          onNodesChange={changes => { if (changes.some(change => change.type === 'position' && change.dragging)) cancelLayout.current?.(); for (const change of changes) if (change.type === 'position' && change.position && !geographic) positions.set(change.id, change.position); onNodesChange(changes) }}
          onMoveStart={event => { if (event) viewportTouched.current = true }} fitView={!geographic} fitViewOptions={{ padding: fitPadding, maxZoom: 1 }} minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} nodesDraggable={!geographic} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false} deleteKeyCode={null} zoomOnScroll={false} proOptions={{ hideAttribution: true }}>
          {geography ? <MeshGeography {...geography} /> : null}
          </ReactFlow></div>
        <div className="mesh-explorer__canvas-tools"><span>{selected?.kind === 'circuit' ? 'Adopted circuit selected' : selected?.kind === 'route' ? 'Available route selected' : ''}</span><Button type="button" aria-label="Fit observed topology" onClick={fit}>Fit</Button>{hasRelayPeers && !geographic ? <Button type="button" aria-label="Rearrange observed topology" onClick={() => { cancelLayout.current?.(); viewportTouched.current = false; arrange(value => value + 1) }}>{arranging ? 'Arranging…' : 'Arrange'}</Button> : null}<Button type="button" aria-label="Zoom in network" onClick={() => void instance.current?.zoomIn()}>+</Button><Button type="button" aria-label="Zoom out network" onClick={() => void instance.current?.zoomOut()}>−</Button></div>
        {layoutIssue ? <p className="mesh-explorer__layout-issue" role="status">{layoutIssue}</p> : null}
      </div> : <div className="mesh-explorer__empty mesh-explorer__no-connections" role="status">
        <strong>{reading ? 'Reading connections…' : 'No connections to show'}</strong>
        <p>{onGateway ? 'Add a device below or configure Mesh Relay.' : networkState}</p>
      </div>}
      {onGateway && hasRelayPeers && view !== 'list' ? directory : null}
      {!onGateway || view === 'list' ? inspector : null}
    </div>
    {onGateway ? <div className="mesh-explorer__companion">
      {view !== 'list' ? inspector : null}
      <MeshGateways snapshot={snapshot} peers={model.peers} selected={selected} stale={stale} savedTargets={savedTargets} savedIssue={savedIssue} onGateway={onGateway} onPeer={showPeer} />
    </div> : null}
    </div>
    {!onGateway && view !== 'list' && hasRelayPeers ? directory : null}

    <footer className="mesh-explorer__footer">
      <span>{snapshot ? `Mesh observed ${new Date(snapshot.observedAt).toLocaleTimeString()}${snapshot.network && !snapshot.coverage.complete ? ' · Partial network view' : ''}` : 'No Relay observation yet'}</span>
      <details><summary>Mesh observation source</summary><p>Runtime <code>{snapshot?.owner.runtimeId ?? 'unconfirmed'}</code>, instance <code>{snapshot?.owner.ownerInstanceId ?? 'unconfirmed'}</code>.</p></details>
    </footer>
  </section>
}
