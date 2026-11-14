import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Handle, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
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
const ArrangeIcon = semanticIconComponent('action.arrange-graph')

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
const HOST_SIZE = { width: 192, height: 106 }
const ENTRY_SIZE = { width: 128, height: 80 }
const ports = [Position.Left, Position.Right, Position.Top, Position.Bottom]

function Ports({ type }: { type: 'source' | 'target' }) {
  return ports.map(position => <Handle key={position} id={position} type={type} position={position} isConnectable={false} />)
}

const HostTopologyNode = memo(function HostTopologyNode({ data }: NodeProps<HostNode>) {
  const { host, check } = data
  const hint = useHostConnectionHint(host.id, host.label)
  const address = data.localAddress
  const tooltip = useWorkbenchNameTooltip(hint.name, host.kind === 'local' ? <LocalAddressDetails address={address} /> : <span className="remote-host-route-detail"><span>{hint.detail}</span><span>SSH user · <code data-route-user>{host.kind === 'ssh' && host.transport !== 'tailcat' ? host.user || 'SSH config' : 'Not used'}</code></span><span>Port override · <code data-route-port>{host.kind === 'ssh' && host.transport !== 'tailcat' ? host.port ?? 'SSH config' : 'Not used'}</code></span><span>Runtime binding · <code data-route-runtime>{host.kind === 'ssh' ? host.runtimeId ?? 'Unconfirmed' : 'Unconfirmed'}</code></span>{data.network ? <span>{data.network}</span> : null}</span>, false, { pointerPassThrough: host.kind !== 'local' })
  const checkedAt = check && check.state !== 'idle' && check.state !== 'checking' ? check.observedAt : undefined
  return <>
    <Ports type="target" />
    <button type="button" className="remote-host-node nopan" data-host-node={host.id} data-current-host={data.selected} {...tooltip.props}
      data-check-state={check?.state ?? 'idle'} aria-pressed={data.selected} onClick={() => { tooltip.hide(); data.onSelect(host.id) }}
      >
      <span className="remote-host-node__kind"><HostIcon kind={host.kind} size={14} />{host.kind === 'local' ? 'Local' : hostTransportLabel(host)}<span className={`remote-check-dot remote-check-dot--${check?.state ?? 'idle'}`} role="img" aria-label={hostCheckLabel(check ?? { state: 'idle' })} /></span>
      <strong>{host.label}</strong>
      <span className="remote-host-node__address" title={host.kind === 'ssh' && host.transport !== 'tailcat' ? host.hostname : undefined}>{host.kind === 'local' ? address?.label ?? 'Local address unknown' : host.transport === 'tailcat' ? 'Private Tailcat address' : host.hostname || 'Address required'}</span>
      <span className="remote-host-node__footer">
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
  return <div className="remote-entry-node"><TopologyIcon size={20} /><strong>{data.label}</strong><span>Saved connections</span><Ports type="source" /></div>
}
const nodeTypes = { host: HostTopologyNode, entry: ManagementEntry }

/** A projection of configured routes. The graph owns viewport geometry, never Host or Runtime truth. */
export const HostTopology = memo(function HostTopology({ items, selectedId, onSelect, linkView, onOpenLink, active = true }: {
  active?: boolean
  linkView?: ReactNode
  onOpenLink?: () => void
  items: readonly HostTopologyItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const instance = useRef<ReactFlowInstance<TopologyNode, Edge> | null>(null)
  const [scope, setScope] = useState<'fleet' | 'link'>('fleet')
  const cancelLayout = useRef<(() => void) | null>(null)
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const viewportTouched = useRef(false)
  const [arrangeAttempt, arrange] = useState(0)
  const [arranging, setArranging] = useState(false)
  const [layoutIssue, setLayoutIssue] = useState<string | null>(null)
  function changeScope(next: 'fleet' | 'link') {
    if (scope === next) return
    if (next === 'link') onOpenLink?.()
    setScope(next)
  }
  const topologyKey = JSON.stringify(items.map(item => item.host.id))
  const routeKey = JSON.stringify(items.map(item => [item.host.id, item.host.kind, item.host.kind === 'ssh' ? item.host.transport : undefined]))
  const projectedNodes: TopologyNode[] = useMemo(() => [
    { id: 'entry', type: 'entry', position: { x: 0, y: 0 }, ...ENTRY_SIZE, data: { label: 'AgentMux' }, selectable: false },
    ...items.map((item, index): HostNode => ({ id: `host:${item.host.id}`, type: 'host',
      position: { x: 220 + index % 2 * 232, y: Math.floor(index / 2) * 146 }, ...HOST_SIZE, data: { ...item, selected: item.host.id === selectedId, onSelect } }))
  ], [items, selectedId, onSelect])
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>(projectedNodes)
  useEffect(() => {
    setNodes(previous => {
      const byId = new Map(previous.map(node => [node.id, node]))
      // Controlled nodes retain the library's measured geometry when their source data changes.
      return projectedNodes.map(node => {
        const previousNode = byId.get(node.id)
        const position = positions.current.get(node.id) ?? previousNode?.position ?? node.position
        const data = previousNode && Object.entries(node.data).every(([key, value]) => Reflect.get(previousNode.data, key) === value) ? previousNode.data : node.data
        return { ...previousNode, ...node, position, data } as TopologyNode
      })
    })
  }, [projectedNodes, setNodes])
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(nodes.map(node => [node.id, node]))
    const source = byId.get('entry')
    return items.map(item => {
    const target = byId.get(`host:${item.host.id}`)
    const dx = (target?.position.x ?? 220) + HOST_SIZE.width / 2 - (source?.position.x ?? 0) - ENTRY_SIZE.width / 2
    const dy = (target?.position.y ?? 0) + HOST_SIZE.height / 2 - (source?.position.y ?? 0) - ENTRY_SIZE.height / 2
    const horizontal = Math.abs(dx) > Math.abs(dy)
    return { id: `route:${item.host.id}`, source: 'entry', target: `host:${item.host.id}`,
    sourceHandle: horizontal ? dx > 0 ? Position.Right : Position.Left : dy > 0 ? Position.Bottom : Position.Top,
    targetHandle: horizontal ? dx > 0 ? Position.Left : Position.Right : dy > 0 ? Position.Top : Position.Bottom,
    type: 'default', selectable: false,
    className: item.host.id === selectedId ? 'remote-route remote-route--selected' : 'remote-route',
    zIndex: item.host.id === selectedId ? 1 : 0 }
  })}, [nodes, routeKey, selectedId])
  const fit = useCallback(() => { void instance.current?.fitView({ padding: .18, maxZoom: 1 }) }, [])
  const arrangedAttempt = useRef(-1)
  // Finite, off-thread geometry. Status, selection and counters never start a layout.
  useEffect(() => {
    if (!active || scope !== 'fleet') return
    const ids = ['entry', ...items.map(item => `host:${item.host.id}`)]
    const force = arrangedAttempt.current !== arrangeAttempt
    if (!force && ids.every(id => positions.current.has(id))) return
    let worker: Worker
    try { worker = new Worker(new URL('../../lib/force-layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch { setLayoutIssue('Automatic layout could not start. Move hosts freely or retry Arrange.'); return }
    let current = true, frame: number | undefined
    const cancel = () => { current = false; worker.terminate(); if (frame !== undefined) cancelAnimationFrame(frame); setArranging(false) }
    cancelLayout.current = cancel
    arrangedAttempt.current = arrangeAttempt
    setArranging(true)
    worker.onmessage = (event: MessageEvent<{ id: string; positions?: Record<string, { x: number; y: number }>; error?: string }>) => {
      if (!current || event.data.id !== topologyKey) return
      worker.terminate(); setArranging(false)
      const next = event.data.positions
      if (!next || event.data.error) { setLayoutIssue(event.data.error ?? 'Layout is unconfirmed. Your positions are kept.'); return }
      const missing = ids.filter(id => !positions.current.has(id))
      const held = ids.flatMap(id => positions.current.has(id) ? [positions.current.get(id)!] : [])
      const offsetY = !force && held.length && missing.length ? Math.max(...held.map(point => point.y)) + HOST_SIZE.height + 40 - Math.min(...missing.map(id => next[id]!.y)) : 0
      for (const id of ids) if (force || !positions.current.has(id)) positions.current.set(id, { x: next[id]!.x, y: next[id]!.y + offsetY })
      setNodes(values => values.map(node => ({ ...node, position: positions.current.get(node.id) ?? node.position })))
      arrangedAttempt.current = arrangeAttempt; setLayoutIssue(null)
      if (!viewportTouched.current) frame = requestAnimationFrame(fit)
    }
    worker.onerror = () => { if (current) { worker.terminate(); setArranging(false); setLayoutIssue('Automatic layout stopped. Move hosts freely or retry Arrange.') } }
    worker.postMessage({ id: topologyKey, input: {
      nodes: ids.map(id => ({ id, ...(id === 'entry' ? ENTRY_SIZE : HOST_SIZE) })),
      edges: items.map(item => ({ source: 'entry', target: `host:${item.host.id}` }))
    } })
    return () => { cancel(); if (cancelLayout.current === cancel) cancelLayout.current = null }
  }, [active, scope, topologyKey, arrangeAttempt, fit, setNodes])

  return <div className="remote-topology" aria-label="Configured host topology" data-host-topology>
    <header className="remote-topology__header"><div className="remote-topology__caption"><span>HOST CONNECTIONS</span><small>{scope === 'fleet' ? 'Configured hosts' : 'One selected connection'}</small></div>
      {linkView ? <div className="remote-topology__scope" aria-label="Topology scope"><button type="button" aria-label="Fleet map" aria-pressed={scope === 'fleet'} onClick={() => changeScope('fleet')}>Fleet</button><button type="button" aria-label="Selected link" aria-pressed={scope === 'link'} onClick={() => changeScope('link')}>Selected link</button></div> : null}</header>
    <div hidden={scope !== 'link'} className="remote-topology__link">{scope === 'link' ? linkView : null}</div>
    <div hidden={scope !== 'fleet'} className="remote-topology__viewport"><ReactFlow<TopologyNode, Edge> nodes={nodes} onNodesChange={changes => {
      if (changes.some(change => change.type === 'position' && change.dragging)) cancelLayout.current?.()
      for (const change of changes) if (change.type === 'position' && change.position) positions.current.set(change.id, change.position)
      onNodesChange(changes)
    }} edges={edges} nodeTypes={nodeTypes}
      onInit={value => { instance.current = value }} fitView fitViewOptions={{ padding: .18, maxZoom: 1 }}
      onMoveStart={event => { if (event) viewportTouched.current = true }}
      nodesDraggable nodeDragThreshold={4} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false}
      elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.1} maxZoom={1.4}
      defaultEdgeOptions={{ style: { strokeWidth: 1.25 } }} proOptions={{ hideAttribution: true }}>
    </ReactFlow></div>
    {items.length === 0 ? <p className="remote-topology__empty">No hosts match this search.</p> : null}
    <div hidden={scope !== 'fleet'} className="remote-topology__controls" aria-label="Topology viewport">
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => void instance.current?.zoomIn()}><ZoomInIcon size={15} /></button>
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => void instance.current?.zoomOut()}><ZoomOutIcon size={15} /></button>
      <button type="button" className="icon-button" aria-label="Fit all hosts" onClick={fit}><FitIcon size={15} /></button>
      <button type="button" className="remote-topology__arrange" aria-label="Arrange hosts" aria-busy={arranging} onClick={() => { viewportTouched.current = false; arrange(value => value + 1) }}><ArrangeIcon size={14} />{arranging ? 'Arranging…' : 'Arrange'}</button>
    </div>
    {scope === 'fleet' ? <p className="remote-topology__hint" role={layoutIssue ? 'status' : undefined}>{layoutIssue ?? 'Saved connections · drag to arrange'}</p> : null}
  </div>
})
