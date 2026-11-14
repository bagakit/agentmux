import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Handle, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { TextInput } from '@agentmux/client-ui/input'
import type { MeshNetworkInspection } from '@agentmux/core/mesh-network'
import { meshPathEdges, meshPeerLabel, meshPeerState, meshRtt, meshSelectionExists, meshSelectionPath, meshTopologyModel, meshTopologySource, shortMeshIdentity, type MeshTopologyPeer, type MeshTopologySelection } from './mesh-topology'
import './mesh-topology.css'

type PeerNode = Node<{ peer: MeshTopologyPeer; selected: boolean; onPath: boolean; dimmed: boolean; onSelect(id: string): void }, 'meshPeer'>
const SIZE = { width: 188, height: 64 }
function MeshPeer({ data }: NodeProps<PeerNode>) {
  const peer = data.peer
  return <>{[Position.Left, Position.Right, Position.Top, Position.Bottom].map(position => <Handle key={'target-' + position} type="target" id={position} position={position} isConnectable={false} />)}
    <button type="button" className="mesh-explorer-node nopan" data-peer-state={peer.state} data-on-path={data.onPath || undefined} data-dimmed={data.dimmed || undefined} aria-pressed={data.selected} onClick={() => data.onSelect(peer.id)}>
      <span className="mesh-explorer-node__kind"><span className="mesh-explorer-node__socket" aria-hidden="true" />{peer.own ? 'THIS CORE' : 'PEER'}{data.selected ? <span aria-label="Selected">✓</span> : null}</span>
      <strong title={peer.id}>{meshPeerLabel(peer)}</strong>
      <span className="mesh-explorer-node__state">{meshPeerState(peer)}{peer.rttMs === null ? '' : ` · ${meshRtt(peer.rttMs)}`}</span>
    </button>{[Position.Left, Position.Right, Position.Top, Position.Bottom].map(position => <Handle key={'source-' + position} type="source" id={position} position={position} isConnectable={false} />)}</>
}
const nodeTypes = { meshPeer: MeshPeer }

/** The source's current network observation; selecting and arranging never changes network policy. */
type MeshMapProps = { snapshot?: MeshNetworkInspection | undefined; active?: boolean; actions?: ReactNode; reading?: boolean; stale?: boolean }
export function MeshNetworkMap({ snapshot, active = true, actions, reading = false, stale = false }: MeshMapProps) {
  return <MeshTopologyExplorer key={meshTopologySource(snapshot)} snapshot={snapshot} active={active} actions={actions} reading={reading} stale={stale} />
}
function MeshTopologyExplorer({ snapshot, active, actions, reading, stale }: MeshMapProps & { active: boolean; reading: boolean; stale: boolean }) {
  const model = useMemo(() => meshTopologyModel(snapshot), [snapshot])
  const [selected, select] = useState<MeshTopologySelection>(), [view, setView] = useState<'topology' | 'list'>('topology')
  const [scope, setScope] = useState<'network' | 'selection'>('network'), [category, setCategory] = useState<'peers' | 'routes' | 'circuits'>(() => model.routes.length ? 'routes' : 'peers')
  const [query, setQuery] = useState(''), [arrangeAttempt, arrange] = useState(0), [arranging, setArranging] = useState(false), [layoutIssue, setLayoutIssue] = useState('')
  const [focusRequest, setFocusRequest] = useState(0), focusedRequest = useRef(0), focusResizeRevision = useRef(0), canvasResizeRevision = useRef(0)
  const requestViewport = useCallback(() => { focusResizeRevision.current = canvasResizeRevision.current; setFocusRequest(value => value + 1) }, [])
  const positions = useRef(new Map<string, { x: number; y: number }>()), instance = useRef<ReactFlowInstance<PeerNode, Edge> | null>(null), canvas = useRef<HTMLDivElement>(null)
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
  const choosePeer = useCallback((id: string) => { select({ kind: 'peer', id }); requestViewport() }, [requestViewport])
  const visiblePeers = scope === 'network' ? model.peers : model.peers.filter(peer => pathSet.has(peer.id))
  const visibleIds = new Set(visiblePeers.map(peer => peer.id))
  const topologyKey = JSON.stringify([model.peers.map(peer => peer.id), model.edges.map(edge => edge.id).sort()])
  const projectedNodes: PeerNode[] = visiblePeers.map((peer, index) => ({ id: peer.id, type: 'meshPeer', ...SIZE,
    position: positions.current.get(peer.id) ?? { x: index % 3 * 228, y: Math.floor(index / 3) * 112 }, selectable: false,
    data: { peer, selected: selected?.kind === 'peer' && selected.id === peer.id, onPath: pathSet.has(peer.id), dimmed: Boolean(needle && !matchedPeers.has(peer.id) && !pathSet.has(peer.id)), onSelect: choosePeer } }))
  const [nodes, setNodes, onNodesChange] = useNodesState<PeerNode>(projectedNodes)
  useEffect(() => {
    setNodes(previous => {
      const held = new Map(previous.map(node => [node.id, node]))
      return projectedNodes.map(node => ({ ...held.get(node.id), ...node, position: positions.current.get(node.id) ?? held.get(node.id)?.position ?? node.position }))
    })
  }, [snapshot, selected, scope, query, setNodes])
  const nodePositions = new Map(nodes.map(node => [node.id, node.position]))
  const edges: Edge[] = model.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map(edge => {
    const source = nodePositions.get(edge.source), target = nodePositions.get(edge.target)
    const dx = (target?.x ?? 0) - (source?.x ?? 0), dy = (target?.y ?? 0) - (source?.y ?? 0), horizontal = Math.abs(dx) > Math.abs(dy)
    return { id: edge.id, source: edge.source, target: edge.target, type: 'default', selectable: false,
      sourceHandle: horizontal ? dx > 0 ? Position.Right : Position.Left : dy > 0 ? Position.Bottom : Position.Top,
      targetHandle: horizontal ? dx > 0 ? Position.Left : Position.Right : dy > 0 ? Position.Top : Position.Bottom,
      className: pathEdges.has(edge.id) ? 'mesh-explorer-edge mesh-explorer-edge--selected' : 'mesh-explorer-edge' }
  })
  const fit = useCallback(() => { void instance.current?.fitView({ padding: .16, maxZoom: 1 }) }, [])
  // Container changes are real geometry changes, not new observations. Refit the same nodes while
  // retaining their positions, so a narrow overview never leaves the original Core off-canvas.
  useEffect(() => {
    const element = canvas.current
    if (!active || view !== 'topology' || !element) return
    let frame: number | undefined, previous = ''
    const resize = () => {
      const { width, height } = element.getBoundingClientRect()
      if (!width || !height) return
      const size = `${width}:${height}`
      if (size === previous) return
      previous = size
      canvasResizeRevision.current += 1
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = undefined; fit() })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [active, view, fit])
  // A deliberate selection can open the inspector and narrow the canvas after a user pan.
  // Wait for its new dimensions, then fit once. Observations do not request a viewport change.
  useEffect(() => {
    if (!active || view !== 'topology' || focusRequest === focusedRequest.current) return
    focusedRequest.current = focusRequest
    let settled: number | undefined
    const frame = requestAnimationFrame(() => { settled = requestAnimationFrame(() => { if (canvasResizeRevision.current === focusResizeRevision.current) fit() }) })
    return () => { cancelAnimationFrame(frame); if (settled !== undefined) cancelAnimationFrame(settled) }
  }, [focusRequest, active, view, fit])
  // Geometry is finite and off-thread. Counters, RTT and selection do not relayout the network.
  useEffect(() => {
    if (!active || view !== 'topology' || !model.peers.length) return
    const ids = model.peers.map(peer => peer.id), force = arrangedAttempt.current !== arrangeAttempt
    if (!force && ids.every(id => positions.current.has(id))) return
    let worker: Worker
    try { worker = new Worker(new URL('../../lib/force-layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch { setLayoutIssue('Automatic layout is unavailable. You can move peers or use the list.'); return }
    let current = true, frame: number | undefined
    const cancel = () => { current = false; worker.terminate(); if (frame !== undefined) cancelAnimationFrame(frame); setArranging(false) }
    cancelLayout.current = cancel; arrangedAttempt.current = arrangeAttempt; setArranging(true)
    worker.onmessage = (event: MessageEvent<{ id: string; positions?: Record<string, { x: number; y: number }>; error?: string }>) => {
      if (!current || event.data.id !== topologyKey) return
      worker.terminate(); setArranging(false)
      const next = event.data.positions
      if (!next || event.data.error) { setLayoutIssue(event.data.error ?? 'Layout is unconfirmed. Your positions are kept.'); return }
      const held = ids.flatMap(id => positions.current.has(id) ? [positions.current.get(id)!] : [])
      const missing = ids.filter(id => !positions.current.has(id))
      const offset = !force && held.length && missing.length ? Math.max(...held.map(point => point.y)) + SIZE.height + 40 - Math.min(...missing.map(id => next[id]?.y ?? 0)) : 0
      for (const id of ids) if (next[id] && (force || !positions.current.has(id))) positions.current.set(id, { x: next[id]!.x, y: next[id]!.y + offset })
      setNodes(values => values.map(node => ({ ...node, position: positions.current.get(node.id) ?? node.position })))
      setLayoutIssue('')
      if (!viewportTouched.current) frame = requestAnimationFrame(fit)
    }
    worker.onerror = () => { if (current) { worker.terminate(); setArranging(false); setLayoutIssue('Automatic layout stopped. Your positions and list are kept.') } }
    worker.postMessage({ id: topologyKey, input: { nodes: model.peers.map(peer => ({ id: peer.id, ...SIZE })), edges: model.edges.map(edge => ({ source: edge.source, target: edge.target })) } })
    return () => { cancel(); if (cancelLayout.current === cancel) cancelLayout.current = null }
  }, [active, view, topologyKey, arrangeAttempt, fit, setNodes])
  const currentPeer = selected?.kind === 'peer' ? byId.get(selected.id) : undefined
  const currentRoute = selected?.kind === 'route' ? model.routes.find(route => route.serverId === selected.id) : undefined
  const currentCircuit = selected?.kind === 'circuit' ? model.circuits.find(circuit => circuit.circuitId === selected.id) : undefined
  const count = category === 'peers' ? peers.length : category === 'routes' ? routes.length : circuits.length
  function choose(next: MeshTopologySelection) { select(next); requestViewport() }
  function showPeer(id: string) { setCategory('peers'); choose({ kind: 'peer', id }) }
  const directory = <div className="mesh-explorer__directory" data-list-view={view === 'list' || undefined}>
        <nav className="mesh-explorer__categories" aria-label="Network objects">{([['peers', 'Peers', model.peers.length], ['routes', 'Endpoints', model.routes.length], ['circuits', 'Adopted circuits', model.circuits.length]] as const).map(([key, name, size]) => <button type="button" key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>{name}<span>{size}</span></button>)}</nav>
        {needle ? <p className="mesh-explorer__search-result" role="status">{count} match{count === 1 ? '' : 'es'} · <button type="button" onClick={() => setQuery('')}>Clear search</button></p> : null}
        <ul className={`mesh-explorer__objects ${category === 'peers' ? 'mesh-peer-list' : category === 'routes' ? 'mesh-route-list' : 'mesh-circuit-list'}`}>
          {category === 'peers' ? peers.map(peer => <li key={peer.id}><button type="button" data-mesh-object="peer" aria-pressed={selected?.kind === 'peer' && selected.id === peer.id} onClick={() => choose({ kind: 'peer', id: peer.id })}><span><strong>{meshPeerLabel(peer)}</strong><code>{shortMeshIdentity(peer.id)}</code></span><span>{meshPeerState(peer)}<small>{meshRtt(peer.rttMs)}</small></span></button></li>) : null}
          {category === 'routes' ? routes.map(route => <li key={route.serverId}><button type="button" data-mesh-object="route" aria-pressed={selected?.kind === 'route' && selected.id === route.serverId} onClick={() => choose({ kind: 'route', id: route.serverId })}><span><strong>{shortMeshIdentity(route.serverId)}</strong><small>Available route · {shortMeshIdentity(route.originPeerId)}</small></span><span>{route.hops} hop{route.hops === 1 ? '' : 's'}<small>{meshRtt(route.rttMs)}</small></span></button></li>) : null}
          {category === 'circuits' ? circuits.map(circuit => <li key={circuit.circuitId}><button type="button" data-mesh-object="circuit" aria-pressed={selected?.kind === 'circuit' && selected.id === circuit.circuitId} onClick={() => choose({ kind: 'circuit', id: circuit.circuitId })}><span><strong>{shortMeshIdentity(circuit.serverId)}</strong><small>{shortMeshIdentity(circuit.circuitId)}</small></span><span>Adopted<small>{Math.max(0, circuit.path.length - 1)} network hops</small></span></button></li>) : null}
        </ul>
        {!count ? <p className="mesh-explorer__directory-empty">{needle ? 'No matching objects in this category. Other network objects are unchanged.' : category === 'circuits' ? 'No adopted circuits are currently reported.' : category === 'routes' ? 'No endpoint route is currently advertised.' : 'No network peers are currently reported.'}</p> : null}
      </div>
  return <section className="mesh-network-map mesh-explorer" aria-label="Observed Mesh topology" data-mesh-topology>
    <header className="mesh-explorer__header"><div className="mesh-explorer__heading"><h3>{snapshot?.network?.networkId ?? 'Network overview'}</h3><p>{stale ? 'Last confirmed · ' : ''}{snapshot?.network ? `${model.peers.length} peers · ${model.edges.length} reciprocal link${model.edges.length === 1 ? '' : 's'} · ${model.routes.length} reachable endpoint${model.routes.length === 1 ? '' : 's'} · ${snapshot.coverage.observedOrigins}/${snapshot.coverage.configuredOrigins} origins observed` : reading ? 'Reading this Core’s network…' : 'Network topology is not observed'}</p></div>{actions}</header>
    {model.peers.length ? <div className="mesh-explorer__toolbar"><label className="mesh-explorer__search"><TextInput aria-label="Find a peer, endpoint or circuit" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find peer, endpoint or circuit…" /></label>
      <div className="mesh-explorer__segments" role="group" aria-label="Network view"><button type="button" aria-pressed={view === 'topology'} onClick={() => setView('topology')}>Topology</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button></div>
      <div className="mesh-explorer__segments" role="group" aria-label="Network scope"><button type="button" aria-pressed={scope === 'network'} onClick={() => { setScope('network'); requestViewport() }}>Network</button><button type="button" aria-pressed={scope === 'selection'} onClick={() => { setScope('selection'); requestViewport() }}>Selected path</button></div>
    </div> : null}
    <div className="mesh-explorer__body" data-empty={model.peers.length ? undefined : true} data-inspecting={selected ? true : undefined}><div className="mesh-explorer__workspace">
      {view === 'list' ? directory : null}
      {model.peers.length ? <div className="mesh-explorer__graph" hidden={view !== 'topology'}>
        <div ref={canvas} className="mesh-explorer__canvas" aria-label="Network relationship canvas">{visiblePeers.length ? <ReactFlow<PeerNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={value => { instance.current = value }}
          onNodesChange={changes => { if (changes.some(change => change.type === 'position' && change.dragging)) cancelLayout.current?.(); for (const change of changes) if (change.type === 'position' && change.position) positions.current.set(change.id, change.position); onNodesChange(changes) }}
          onMoveStart={event => { if (event) viewportTouched.current = true }} fitView fitViewOptions={{ padding: .16, maxZoom: 1 }} minZoom={.15} maxZoom={1.6} nodesDraggable nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false} deleteKeyCode={null} zoomOnScroll={false} proOptions={{ hideAttribution: true }} />
          : <div className="mesh-explorer__empty"><strong>{scope === 'selection' ? 'Choose a peer or path below.' : snapshot ? 'No network peers observed.' : 'Network state has not been observed.'}</strong><p>{scope === 'selection' ? 'The directory remains available while you focus the map.' : 'Network observation does not describe Agent health or grant device access.'}</p></div>}</div>
        <div className="mesh-explorer__canvas-tools"><span>Reciprocal authenticated links{selected?.kind === 'circuit' ? ' · adopted circuit selected' : selected?.kind === 'route' ? ' · available route selected' : ''}</span><button type="button" className="small-button" aria-label="Fit observed topology" onClick={fit}>Fit</button><button type="button" className="small-button" aria-label="Rearrange observed topology" onClick={() => { cancelLayout.current?.(); viewportTouched.current = false; arrange(value => value + 1) }}>{arranging ? 'Arranging…' : 'Arrange'}</button><button type="button" className="small-button" aria-label="Zoom in network" onClick={() => void instance.current?.zoomIn()}>+</button><button type="button" className="small-button" aria-label="Zoom out network" onClick={() => void instance.current?.zoomOut()}>−</button></div>
        {layoutIssue ? <p className="mesh-explorer__layout-issue" role="status">{layoutIssue}</p> : null}
      </div> : <p className="mesh-explorer__unobserved">{snapshot?.apply.state === 'disabled' ? 'Mesh participation is disabled. Open Gateway to join a network, or manage a saved device below.' : reading ? 'Reading this Core’s network. Saved device connections remain available below.' : 'No network topology is currently observed. Refresh to check this Core again.'}</p>}
    </div>
    {selected ? <aside className="mesh-explorer__detail" aria-label="Selected network object">
        <header><span className="mesh-explorer__eyebrow">{selected.kind === 'peer' ? 'NETWORK PEER' : selected.kind === 'route' ? 'AVAILABLE ROUTE' : 'ADOPTED CIRCUIT'}</span><button type="button" className="small-button" onClick={() => select(undefined)}>Clear</button></header>
        <h4>{currentPeer ? meshPeerLabel(currentPeer) : shortMeshIdentity(currentRoute?.serverId ?? currentCircuit?.serverId ?? selected.id)}</h4>
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
        <p className="mesh-explorer__boundary">Peer trust, device admission and Agent operation results are separate facts.</p>
    </aside> : null}</div>
    {view === 'topology' ? directory : null}

    <footer className="mesh-explorer__footer"><span><i aria-hidden="true" /> Reciprocal link <i className="mesh-explorer__legend-selected" aria-hidden="true" /> Selected path</span><span>{snapshot ? `Observed ${new Date(snapshot.observedAt).toLocaleTimeString()} · ${snapshot.coverage.complete ? 'Configured origin coverage complete' : 'Partial network view'}` : 'No observation yet'}</span><details><summary>Observation source</summary><p>Mesh network observation from Runtime <code>{snapshot?.owner.runtimeId ?? 'unconfirmed'}</code>, instance <code>{snapshot?.owner.ownerInstanceId ?? 'unconfirmed'}</code>. Peer positions are a relationship layout, not geography or a physical packet trace.</p></details></footer>
  </section>
}
