import { useMemo, useRef, useState } from 'react'
import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import type { MeshNetworkInspection } from '@agentmux/core/mesh-network'

type PeerNode = Node<{ peerId: string; own: boolean; observed: boolean; selected: boolean }, 'meshPeer'>
const short = (text: string) => text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text
function MeshPeer({ data }: NodeProps<PeerNode>) {
  return <div className="mesh-peer-node" data-selected={data.selected || undefined} data-observed={data.observed || undefined}>
    <Handle type="target" position={Position.Left} isConnectable={false} /><small>{data.own ? 'THIS CORE' : data.observed ? 'OBSERVED PEER' : 'CONFIGURED PEER'}</small><strong title={data.peerId}>{short(data.peerId)}</strong><Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
}
const nodeTypes = { meshPeer: MeshPeer }
/** Draw only reciprocal authenticated records; route selection never changes network policy. */
export function MeshNetworkMap({ snapshot }: { snapshot?: MeshNetworkInspection | undefined }) {
  const [selection, setSelection] = useState<string>()
  const positions = useRef(new Map<string, {x:number;y:number}>()), instance = useRef<ReactFlowInstance<PeerNode, Edge> | null>(null)
  const [layoutRevision, setLayoutRevision] = useState(0)
  const network = snapshot?.network
  const selected = network?.routes.find(route => route.serverId === selection)
  const graph = useMemo(() => {
    if (!network) return { nodes: [], edges: [] }
    const own = network.identity?.peerId, ids = new Set([...(own ? [own] : []), ...network.peers.map(peer => peer.peerId), ...network.records.map(record => record.originPeerId)])
    const order = [...ids], depth = new Map<string, number>(own ? [[own, 0]] : []), pairs: [string, string][] = []
    for (const record of network.records) for (const neighbor of record.neighbors) {
      const reciprocal = network.records.find(other => other.originPeerId === neighbor.peerId && other.epoch === neighbor.peerEpoch)?.neighbors.some(back => back.peerId === record.originPeerId && back.peerEpoch === record.epoch && back.connectionId === neighbor.connectionId)
      if (reciprocal && record.originPeerId < neighbor.peerId) pairs.push([record.originPeerId, neighbor.peerId])
    }
    for (let i = 0; i < order.length; i++) for (const [a, b] of pairs) {
      if (depth.has(a) && !depth.has(b)) depth.set(b, depth.get(a)! + 1)
      if (depth.has(b) && !depth.has(a)) depth.set(a, depth.get(b)! + 1)
    }
    const rows = new Map<number, number>()
    const nodes: PeerNode[] = order.map(peerId => {
      const column = depth.get(peerId) ?? Math.max(1, ...depth.values()) + 1; let row = rows.get(column) ?? 0
      const key = `${network.networkId}:${peerId}`
      if (!positions.current.has(key)) {
        while ([...positions.current.values()].some(p => p.x === column * 215 && p.y === row * 96)) row++
        positions.current.set(key, { x: column * 215, y: row * 96 })
      }
      rows.set(column, row + 1)
      return { id: peerId, type: 'meshPeer', position: positions.current.get(key)!, selectable: false, data: { peerId, own: peerId === own, observed: network.records.some(record => record.originPeerId === peerId), selected: Boolean(selected?.path.includes(peerId)) } }
    })
    const edges: Edge[] = pairs.map(([source, target]) => ({ id: `${source}:${target}`, source, target, type: 'smoothstep', selectable: false,
      className: selected?.path.some((id, index, path) => index > 0 && (id === source && path[index - 1] === target || id === target && path[index - 1] === source)) ? 'mesh-edge mesh-edge-selected' : 'mesh-edge' }))
    return { nodes, edges }
  }, [network, selected, layoutRevision])
  return <section className="mesh-network-map" aria-label="Observed Mesh topology">
    <header><h4>Observed topology</h4><div className="mesh-map-actions"><button type="button" className="small-button" aria-label="Fit observed topology" onClick={() => void instance.current?.fitView({ padding: .2, maxZoom: 1 })}>Fit</button><button type="button" className="small-button" aria-label="Rearrange observed topology" onClick={() => { positions.current.clear(); setLayoutRevision(value => value + 1); requestAnimationFrame(() => void instance.current?.fitView({ padding: .2, maxZoom: 1 })) }}>Rearrange</button></div><span>{snapshot ? `${snapshot.coverage.observedOrigins} / ${snapshot.coverage.configuredOrigins} configured origins observed` : 'No observation yet'}</span></header>
    {graph.nodes.length ? <div className="mesh-topology-canvas"><ReactFlow<PeerNode, Edge> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onInit={value => { instance.current = value }} onNodesChange={changes => { let moved = false; for (const change of changes) if (change.type === 'position' && change.position) { positions.current.set(`${network?.networkId}:${change.id}`, change.position); moved = true }; if (moved) setLayoutRevision(value => value + 1) }} onNodeDragStop={(_event, node) => { positions.current.set(`${network?.networkId}:${node.id}`, node.position); setLayoutRevision(value => value + 1) }} fitView fitViewOptions={{ padding: .2, maxZoom: 1 }} minZoom={.3} maxZoom={1.5} nodesDraggable={true} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false} deleteKeyCode={null} zoomOnScroll={false} proOptions={{ hideAttribution: true }} /></div> : <p className="field-hint">Save this node’s role and trusted peers to establish a network. Observations describe network paths; existing Agents keep their original identities.</p>}
    <ol className="mesh-topology-list" aria-label="Network peer relationships">{graph.nodes.map(node => <li key={node.id}><strong>{node.data.own ? 'This Core' : node.data.observed ? 'Observed peer' : 'Configured peer'}</strong><code title={node.id}>{short(node.id)}</code><small>{graph.edges.filter(edge => edge.source === node.id || edge.target === node.id).map(edge => short(edge.source === node.id ? edge.target : edge.source)).join(' · ') || 'No reciprocal link observed'}</small></li>)}</ol>
    <div className="mesh-map-lists"><div><h5>Direct peers</h5>{network?.peers.length ? <ul className="mesh-peer-list">{network.peers.map(peer => <li key={peer.peerId}><code title={peer.peerId}>{short(peer.peerId)}</code><span>{peer.state === 'connected' ? 'Authenticated' : peer.state === 'connecting' ? 'Connecting' : 'Disconnected'}{peer.rttMs !== null ? ` · ${Math.round(peer.rttMs)} ms` : ''}</span></li>)}</ul> : <p className="field-hint">No direct peers configured.</p>}</div>
    <div><h5>Reachable original endpoints</h5>{network?.routes.length ? <ul className="mesh-route-list">{network.routes.map(route => <li key={route.serverId}><button type="button" aria-pressed={selection === route.serverId} onClick={() => setSelection(route.serverId)}><span className="mesh-route-name" title={route.serverId}>{short(route.serverId)}</span><span>{route.hops} hop{route.hops === 1 ? '' : 's'} · {Math.round(route.rttMs)} ms</span>{selection === route.serverId ? <span aria-label="Selected">✓</span> : null}</button></li>)}</ul> : <p className="field-hint">No endpoint route observed.</p>}</div></div>
    {selected ? <p className="mesh-selected-path" aria-label="Selected endpoint network path">{selected.path.map((peer, index) => <span key={peer}><code title={peer}>{short(peer)}</code>{index < selected.path.length - 1 ? ' → ' : ''}</span>)}</p> : null}
    <small className="mesh-observation-time">{snapshot ? `Observed ${new Date(snapshot.observedAt).toLocaleTimeString()} · ${snapshot.coverage.complete ? 'All configured origins observed' : 'Partial network view'}` : 'Network state is unobserved.'}</small>
  </section>
}
