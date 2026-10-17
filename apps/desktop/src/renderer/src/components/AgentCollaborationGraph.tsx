import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Background, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, useReactFlow, useStore, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../lib/agent-collaboration'
import type { CollaborationPulse } from '../lib/use-collaboration-reading'
import { routeCollaboration, type CollaborationBox, type CollaborationPath } from '../lib/collaboration-routing'
import { FocusContextCardBody } from './FocusContextCardBody'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import '@xyflow/react/dist/base.css'
import '../styles/collaboration.css'

export type CollaborationSelection = { kind: 'agent' | 'relation'; id: string; relatedIds?: readonly string[] } | null
type AgentData = { agent: CollaborationAgent; selected: boolean; identity?: FocusContextIdentity | undefined; goals?: FocusGoalLinks | undefined; onSelect(): void; onOpen(id: string): void }
type AreaData = { area: CollaborationArea; folded: boolean; onToggle(): void }
type AgentNode = Node<AgentData, 'agent'>
type AreaNode = Node<AreaData, 'area'>
type GraphNode = AgentNode | AreaNode
type RelationEdge = Edge<{ relations: CollaborationRelation[]; active: number; startedAt: number; count: number; route?: CollaborationPath }, 'relation'>
export const COLLABORATION_LABELS = { communication: 'Communication', creation: 'Creation', supervision: 'Supervision' } as const
const AgentNodeView = memo(function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const { agent } = data
  return <div className="collaboration-agent nodrag nopan" data-collaboration-agent={agent.id}>
    <CollaborationPorts direction="in" />
    {agent.context ? <FocusContextCardBody context={agent.context} identity={data.identity} goalLinks={data.goals} selected={data.selected} onSelect={data.onSelect} onOpenWorkface={data.onOpen} />
      : <button type="button" className="collaboration-agent__reference" aria-pressed={data.selected} onClick={data.onSelect}><SemanticIcon name="object.agent" size={16} /><span><strong>{agent.sessionId}</strong><small>{agent.provenance ?? agent.subject?.hostId} · Reference only</small></span></button>}
    <CollaborationPorts direction="out" />
  </div>
})
function AreaNodeView({ data }: NodeProps<AreaNode>) {
  return <div className="collaboration-area" data-kind={data.area.kind} data-folded={data.folded}>
    <button type="button" className="collaboration-area__heading nodrag nopan" aria-expanded={!data.folded} onClick={data.onToggle} title={data.area.issue ?? undefined}>
      <SemanticIcon name={data.folded ? 'navigation.next' : 'navigation.down'} size={12} /><span>{data.area.name}</span><small>{data.area.members.length}</small>
    </button>
    {data.folded ? <><CollaborationPorts direction="in" /><CollaborationPorts direction="out" /></> : null}
  </div>
}
function CollaborationPorts({ direction }: { direction: 'in' | 'out' }) {
  return <>{(['communication', 'creation', 'supervision'] as const).flatMap((kind, index) => (['left', 'right'] as const).map(side => <Handle key={`${kind}-${side}`} id={`${kind}-${direction}-${side}`} type={direction === 'in' ? 'target' : 'source'} position={side === 'left' ? Position.Left : Position.Right} style={{ top: `${(index * 2 + (direction === 'out' ? .5 : 1.5)) / 6 * 100}%` }} isConnectable={false} />))}</>
}
function RelationEdgeView(props: EdgeProps<RelationEdge>) {
  const { path, labelX, labelY } = props.data!.route!
  const delay = useMemo(() => Math.min(0, (props.data?.startedAt ?? 0) - Date.now()), [props.data?.active, props.data?.startedAt])
  return <><BaseEdge id={props.id} path={path} {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})} interactionWidth={22} className={`collaboration-edge collaboration-edge--${props.data?.relations[0]?.kind}${props.selected ? ' is-selected' : ''}`} />
    {props.data?.active ? <path key={props.data.active} d={path} style={{ animationDelay: `${delay}ms` }} className="collaboration-edge__pulse" data-kind={props.data.relations[0]?.kind} /> : null}
    {(props.data?.count ?? 0) > 1 ? <EdgeLabelRenderer><span className="collaboration-edge__count" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{props.data!.count}</span></EdgeLabelRenderer> : null}</>
}
const nodeTypes = { agent: AgentNodeView, area: AreaNodeView }, edgeTypes = { relation: RelationEdgeView }

/** The graph owns presentation geometry only. Every card and workface action keeps its original owner. */
export function AgentCollaborationGraph({ agents, areas, relations, pulses, selection, onSelect, onOpen, identities, goals, ready = true }: {
  agents: ReadonlyMap<string, CollaborationAgent>; areas: readonly CollaborationArea[]; relations: readonly CollaborationRelation[]; pulses: readonly CollaborationPulse[]
  selection: CollaborationSelection; onSelect(selection: CollaborationSelection): void; onOpen(context: FocusContext): void
  ready?: boolean; identities?: ReadonlyMap<string, FocusContextIdentity>; goals?: ReadonlyMap<string, FocusGoalLinks>
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const flow = useRef<ReactFlowInstance<GraphNode, RelationEdge> | null>(null)
  const visibleIds = useMemo(() => new Set([...areas.flatMap(area => area.members), ...relations.flatMap(relation => [relation.source, relation.target])]), [areas, relations])
  const graphAreas = useMemo(() => {
    const placed = new Set(areas.flatMap(area => area.members)), unplaced = [...visibleIds].filter(id => !placed.has(id))
    return unplaced.length ? [...areas, { id: 'unplaced-references', name: 'Related Agents', kind: 'unplaced' as const, members: unplaced }] : areas
  }, [areas, visibleIds])
  const nodes = useMemo<GraphNode[]>(() => {
    const result: GraphNode[] = [], heights = [0, 0]
    graphAreas.forEach((area, index) => {
      const column = index % 2, x = column * 630, y = heights[column]!, expandedHeight = 56 + Math.max(1, Math.ceil(area.members.length / 2)) * 108
      heights[column] = y + expandedHeight + 46
      const collapsed = folded.has(area.id), areaId = JSON.stringify(['area', area.id])
      result.push({ id: areaId, type: 'area', position: { x, y }, width: 586, height: collapsed ? 48 : expandedHeight, style: { width: 586, height: collapsed ? 48 : expandedHeight }, data: { area, folded: collapsed, onToggle: () => setFolded(previous => { const next = new Set(previous); if (!next.delete(area.id)) next.add(area.id); return next }) }, selectable: false, draggable: false })
      if (collapsed) return
      area.members.forEach((id, at) => {
        const agent = agents.get(id)
        if (!agent) return
        const context = agent.context, presentationKey = context && JSON.stringify([context.hostId, context.id])
        result.push({ id: JSON.stringify([area.id, id]), type: 'agent', parentId: areaId, width: 250, height: 94, position: { x: 18 + at % 2 * 300, y: 44 + Math.floor(at / 2) * 108 }, style: { width: 250, height: 94, pointerEvents: 'all' }, draggable: false, selectable: false,
          data: { agent, selected: selection?.kind === 'agent' && selection.id === id, identity: presentationKey ? identities?.get(presentationKey) : undefined, goals: presentationKey ? goals?.get(presentationKey) : undefined,
            onSelect: () => onSelect({ kind: 'agent', id }), onOpen: () => { if (context) onOpen(context) } } })
      })
    })
    return result
  }, [graphAreas, agents, folded, selection, identities, goals, onSelect, onOpen])
  const edges = useMemo<RelationEdge[]>(() => {
    const result = new Map<string, RelationEdge>(), byNode = new Map(nodes.map(node => [node.id, node]))
    const worldX = (id: string) => { const node = byNode.get(id)!; return node.position.x + (node.parentId ? byNode.get(node.parentId)!.position.x : 0) }
    for (const relation of relations) {
      const sourceAreas = graphAreas.filter(area => area.members.includes(relation.source)), targetAreas = graphAreas.filter(area => area.members.includes(relation.target))
      const shared = sourceAreas.find(area => targetAreas.includes(area)), sourceArea = shared ?? sourceAreas[0], targetArea = shared ?? targetAreas[0]
      if (!sourceArea || !targetArea) continue
      const endpoint = (area: CollaborationArea, id: string) => folded.has(area.id) ? JSON.stringify(['area', area.id]) : JSON.stringify([area.id, id])
      const source = endpoint(sourceArea, relation.source), target = endpoint(targetArea, relation.target)
      if (source === target) continue
      const id = JSON.stringify([relation.kind, source, target]), held = result.get(id), forward = worldX(source) <= worldX(target)
      const pulse = pulses.filter(pulse => relation.kind === pulse.kind && relation.source === collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.sender }) && relation.target === collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.recipient })).at(-1)
      const active = pulse?.id ?? 0, startedAt = pulse?.startedAt ?? 0
      if (held) { held.data!.relations.push(relation); held.data!.count += relation.evidence.length; if (active > held.data!.active) { held.data!.active = active; held.data!.startedAt = startedAt }; held.selected ||= selection?.kind === 'relation' && selection.id === relation.id }
      else result.set(id, { id, type: 'relation', source, target, sourceHandle: `${relation.kind}-out-${forward ? 'right' : 'left'}`, targetHandle: `${relation.kind}-in-${forward ? 'left' : 'right'}`, data: { relations: [relation], active, startedAt, count: relation.evidence.length }, selected: selection?.kind === 'relation' && selection.id === relation.id,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }, className: `collaboration-edge-group--${relation.kind}` })
    }
    return [...result.values()]
  }, [relations, graphAreas, folded, pulses, selection, nodes])
  const boxes = useMemo<CollaborationBox[]>(() => {
    const byId = new Map(nodes.map(node => [node.id, node]))
    return nodes.flatMap(node => {
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      const x = node.position.x + (parent?.position.x ?? 0), y = node.position.y + (parent?.position.y ?? 0)
      if (node.type === 'area' && !node.data.folded) return [{ id: 'heading:' + node.id, x: x + 8, y: y + 5, width: node.width! - 16, height: 28, heading: true }]
      return [{ id: node.id, x, y, width: node.width!, height: node.height! }]
    })
  }, [nodes])
  const routingKey = JSON.stringify([boxes, edges.map(edge => [edge.id, edge.source, edge.target, edge.data!.relations[0]!.kind])])
  const [routing, setRouting] = useState<{ key: string; paths: Record<string, CollaborationPath>; issue?: string }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    const cancellation = new AbortController()
    void routeCollaboration(boxes, edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, kind: edge.data!.relations[0]!.kind })), cancellation.signal).then(paths => { if (current) setRouting({ key: routingKey, paths }) }, error => { if (current) setRouting({ key: routingKey, paths: {}, issue: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false; cancellation.abort() }
  }, [routingKey, retry])
  const routed = routing?.key === routingKey ? edges.flatMap(edge => { const route = routing.paths[edge.id]; return route ? [{ ...edge, data: { ...edge.data!, route } }] : [] }) : []
  return <div className="collaboration-canvas" aria-label="Agent collaboration graph">
    <ReactFlow<GraphNode, RelationEdge> nodes={nodes} edges={routed} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance }}
      onEdgeClick={(_event, edge) => { if (edge.data?.relations[0]) onSelect({ kind: 'relation', id: edge.data.relations[0].id, relatedIds: edge.data.relations.map(relation => relation.id) }) }} onPaneClick={() => onSelect(null)}
      onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.15} maxZoom={1.4} proOptions={{ hideAttribution: true }}>
      <InitialCollaborationViewport ready={ready} />
      <Background gap={22} size={1} />
    </ReactFlow>
    {routing?.key === routingKey && routing.issue ? <p className="collaboration-canvas__issue" role="status">{routing.issue} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry connections</button></p> : null}
    <div className="collaboration-canvas__controls" aria-label="Graph viewport">
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => void flow.current?.zoomOut()}><SemanticIcon name="action.zoom-out" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => void flow.current?.zoomIn()}><SemanticIcon name="action.zoom-in" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Fit graph" onClick={() => void flow.current?.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true })}><SemanticIcon name="layout.expand" size={14} /></button>
    </div>
    {!visibleIds.size ? <p className="collaboration-canvas__empty">No Agents in this area.</p> : null}
  </div>
}

function InitialCollaborationViewport({ ready }: { ready: boolean }) {
  const flow = useReactFlow(), fitted = useRef(false)
  const width = useStore(state => state.width), height = useStore(state => state.height)
  useEffect(() => {
    if (!ready || fitted.current || width <= 0 || height <= 0) return
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true }).then(success => { fitted.current = success }) })
    return () => cancelAnimationFrame(frame)
  }, [flow, ready, width, height])
  return null
}
