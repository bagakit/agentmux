import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Handle, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance, type Viewport } from '@xyflow/react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig } from '../../../../shared/contracts'
import type { HostCheckState } from '../../store'
import { hostCheckLabel } from '../../lib/host-check'
import { hostTransportLabel } from '../../lib/host-transport'
import { HostIcon } from '../HostBadge'
import { useHostConnectionHint } from '../HostConnectionTooltip'
import { useWorkbenchNameTooltip } from '../WorkbenchNameTooltip'
import type { LocalHostAddress } from './local-host-address'
import '@xyflow/react/dist/base.css'

const TopologyIcon = semanticIconComponent('object.topology')
const ZoomInIcon = semanticIconComponent('action.zoom-in')
const ZoomOutIcon = semanticIconComponent('action.zoom-out')
const FitIcon = semanticIconComponent('layout.expand')

export type HostTopologyItem = {
  host: HostConfig
  check: HostCheckState | undefined
  projectCount: number
  sessionCount: number
  network?: string | null | undefined
  localAddress?: LocalHostAddress | undefined
}
type HostNodeData = HostTopologyItem & { selected: boolean; onSelect: (id: string) => void }
type HostNode = Node<HostNodeData, 'host'>
type EntryNode = Node<{ label: string }, 'entry'>
type TopologyNode = HostNode | EntryNode

const HostTopologyNode = memo(function HostTopologyNode({ data }: NodeProps<HostNode>) {
  const { host, check } = data
  const hint = useHostConnectionHint(host.id, host.label)
  const address = data.localAddress
  const tooltip = useWorkbenchNameTooltip(hint.name, host.kind === 'local' ? <LocalAddressDetails address={address} /> : <span className="remote-host-route-detail"><span>{hint.detail}</span><span>SSH user · <code data-route-user>{host.kind === 'ssh' && host.transport !== 'tailcat' ? host.user || 'SSH config' : 'Not used'}</code></span><span>Port override · <code data-route-port>{host.kind === 'ssh' && host.transport !== 'tailcat' ? host.port ?? 'SSH config' : 'Not used'}</code></span><span>Runtime binding · <code data-route-runtime>{host.kind === 'ssh' ? host.runtimeId ?? 'Unconfirmed' : 'Unconfirmed'}</code></span>{data.network ? <span>{data.network}</span> : null}</span>, false, { pointerPassThrough: host.kind !== 'local' })
  const checkedAt = check && check.state !== 'idle' && check.state !== 'checking' ? check.observedAt : undefined
  return <>
    <Handle className={data.selected ? 'remote-host-port remote-host-port--selected' : 'remote-host-port'} type="target" position={Position.Left} isConnectable={false} />
    <button type="button" className="remote-host-node nodrag nopan" data-host-node={host.id} data-current-host={data.selected} {...tooltip.props}
      data-check-state={check?.state ?? 'idle'} aria-pressed={data.selected} onClick={() => data.onSelect(host.id)}
      >
      <span className="remote-host-node__kind"><HostIcon kind={host.kind} size={15} />{host.kind === 'local' ? 'LOCAL ROUTE' : `${hostTransportLabel(host).toUpperCase()} HOST`}
        <span className="remote-host-node__selection" aria-hidden="true">{data.selected ? 'Selected' : null}</span></span>
      <strong>{host.label}</strong>
      <span className="remote-host-node__address" title={host.kind === 'ssh' && host.transport !== 'tailcat' ? host.hostname : undefined}>{host.kind === 'local' ? address?.label ?? 'Local address unknown' : host.transport === 'tailcat' ? 'Private Tailcat address' : host.hostname || 'Address required'}</span>
      <span className="remote-host-node__context">{host.kind === 'local' ? address?.preferred ? `${address.preferred.name} · ${address.addresses.length} interface addresses` : 'Interface details on focus' : `${data.projectCount} registered projects · ${data.sessionCount} Session references`}</span>
      <span className="remote-host-node__footer"><span className={`remote-check-dot remote-check-dot--${check?.state ?? 'idle'}`} />
        <span>{hostCheckLabel(check ?? { state: 'idle' })}</span>{checkedAt !== undefined ? <time dateTime={new Date(checkedAt).toISOString()} title={new Date(checkedAt).toLocaleString()}>{new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null}
</span>
    </button>
    {tooltip.content}
  </>
})
function LocalAddressDetails({ address }: { address: LocalHostAddress | undefined }) {
  return <span className="remote-local-address-detail">
    {address?.addresses.length ? <span className="remote-local-address-list" role="list">{address.addresses.map(item => <span role="listitem" key={item.name + ':' + item.address}><span>{item.name}</span><code>{item.address}</code></span>)}</span> : <span>{address?.detail ?? address?.label ?? 'Local address unknown'}</span>}
    {address?.observedAt !== undefined ? <small>Local Owner · {new Date(address.observedAt).toLocaleString()}<br />Interface addresses do not confirm reachability.</small> : null}
  </span>
}
function ManagementEntry({ data }: NodeProps<EntryNode>) {
  return <div className="remote-entry-node"><span className="remote-entry-node__label">CONNECTION MANAGER</span><TopologyIcon size={32} /><strong>{data.label}</strong><span>Configured hosts</span>
    <Handle type="source" position={Position.Right} isConnectable={false} /></div>
}
const nodeTypes = { host: HostTopologyNode, entry: ManagementEntry }

/** A projection of configured routes. The graph owns viewport geometry, never Host or Runtime truth. */
export const HostTopology = memo(function HostTopology({ items, selectedId, onSelect, linkView, onOpenLink }: {
  linkView?: ReactNode
  onOpenLink?: () => void
  items: readonly HostTopologyItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const instance = useRef<ReactFlowInstance<TopologyNode, Edge> | null>(null)
  const [scope, setScope] = useState<'fleet' | 'link'>('fleet')
  const fleetViewport = useRef<Viewport | null>(null)
  function changeScope(next: 'fleet' | 'link') {
    if (scope === next) return
    if (next === 'link') { fleetViewport.current = instance.current?.getViewport() ?? null; instance.current = null; onOpenLink?.() }
    setScope(next)
  }
  const topologyKey = JSON.stringify(items.map(item => item.host.id))
  const routeKey = JSON.stringify(items.map(item => [item.host.id, item.host.kind, item.host.kind === 'ssh' ? item.host.transport : undefined]))
  const firstNodes = useMemo(() => {
    const selected = items.findIndex(item => item.host.id === selectedId)
    const start = Math.max(0, Math.min(selected - 1, items.length - 3))
    return [...(start === 0 ? [{ id: 'entry' }] : []), ...items.slice(start, start + 3).map(item => ({ id: `host:${item.host.id}` }))]
  }, [topologyKey])
  const projectedNodes: TopologyNode[] = useMemo(() => [
    { id: 'entry', type: 'entry', position: { x: 0, y: Math.min(1, Math.max(0, items.length - 1)) * 214 + 28 }, data: { label: 'AgentMux' }, selectable: false },
    ...items.map((item, index): HostNode => ({ id: `host:${item.host.id}`, type: 'host',
      position: { x: 310, y: index * 214 + 28 }, data: { ...item, selected: item.host.id === selectedId, onSelect } }))
  ], [items, selectedId, onSelect])
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>(projectedNodes)
  useEffect(() => {
    setNodes(previous => {
      const byId = new Map(previous.map(node => [node.id, node]))
      // Controlled nodes retain the library's measured geometry when their source data changes.
      return projectedNodes.map(node => {
        const measured = byId.get(node.id)?.measured
        return { ...node, ...(measured ? { measured } : {}) }
      })
    })
  }, [projectedNodes, setNodes])
  const edges = useMemo<Edge[]>(() => items.map(item => ({ id: `route:${item.host.id}`, source: 'entry', target: `host:${item.host.id}`,
    type: 'smoothstep', label: hostTransportLabel(item.host), selectable: false,
    className: item.host.id === selectedId ? 'remote-route remote-route--selected' : 'remote-route',
    zIndex: item.host.id === selectedId ? 1 : 0 })), [routeKey, selectedId])
  const fit = useCallback(() => { void instance.current?.fitView({ padding: .12, maxZoom: 1 }) }, [])
  // A new route/filter can change geometry. Checks, counters and selected state cannot reset the reader's viewport.
  useEffect(() => {
    fleetViewport.current = null
    const frame = requestAnimationFrame(() => { void instance.current?.fitView({ nodes: firstNodes, padding: .12, minZoom: .55, maxZoom: 1 }) })
    return () => cancelAnimationFrame(frame)
  }, [topologyKey])

  return <div className="remote-topology" aria-label="Configured host topology" data-host-topology>
    <header className="remote-topology__header"><div className="remote-topology__caption"><span>HOST CONNECTIONS</span><small>{scope === 'fleet' ? 'Configured hosts' : 'One selected connection'}</small></div>
      {linkView ? <div className="remote-topology__scope" aria-label="Topology scope"><button type="button" aria-label="Fleet map" aria-pressed={scope === 'fleet'} onClick={() => changeScope('fleet')}>Fleet</button><button type="button" aria-label="Selected link" aria-pressed={scope === 'link'} onClick={() => changeScope('link')}>Selected link</button></div> : null}</header>
    {scope === 'link' && linkView ? <div className="remote-topology__link">{linkView}</div> : <>
    <div className="remote-topology__viewport"><ReactFlow<TopologyNode, Edge> nodes={nodes} onNodesChange={onNodesChange} edges={edges} nodeTypes={nodeTypes}
      onInit={value => { instance.current = value }} {...(fleetViewport.current ? { defaultViewport: fleetViewport.current } : {})} fitView={fleetViewport.current === null} fitViewOptions={{ nodes: firstNodes, padding: .12, minZoom: .55, maxZoom: 1 }}
      nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false}
      elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.1} maxZoom={1.4}
      defaultEdgeOptions={{ style: { strokeWidth: 1.25 } }} proOptions={{ hideAttribution: true }}>
    </ReactFlow></div>
    {items.length === 0 ? <p className="remote-topology__empty">No hosts match this search.</p> : null}
    <div className="remote-topology__controls" aria-label="Topology viewport">
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => void instance.current?.zoomIn()}><ZoomInIcon size={15} /></button>
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => void instance.current?.zoomOut()}><ZoomOutIcon size={15} /></button>
      <button type="button" className="icon-button" aria-label="Fit all hosts" onClick={fit}><FitIcon size={15} /></button>
    </div>
    <p className="remote-topology__hint">Pan to explore · use the list to scan every host</p></>}
  </div>
})
