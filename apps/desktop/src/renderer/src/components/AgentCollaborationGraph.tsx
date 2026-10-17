import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Background, BaseEdge, EdgeLabelRenderer, ReactFlow, ViewportPortal, useReactFlow, useStore, type Node, type NodeHandle, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../lib/agent-collaboration'
import { collaborationConnections, collaborationAreaNode, collaborationAgentNode } from '../lib/collaboration-presentation'
import type { CollaborationPulse } from '../lib/use-collaboration-reading'
import { createCollaborationGeometrySelector, type CollaborationBox } from '../lib/collaboration-geometry'
import { routeCollaboration, type CollaborationPath } from '../lib/collaboration-routing'
import { FocusContextCardBody } from './FocusContextCardBody'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import '@xyflow/react/dist/base.css'
import '../styles/collaboration.css'

export type CollaborationSelection = { kind: 'agent' | 'relation'; id: string; relatedIds?: readonly string[] } | null
type AgentData = { box: CollaborationBox; agent: CollaborationAgent; selected: boolean; identity?: FocusContextIdentity | undefined; goals?: FocusGoalLinks | undefined; onSelect(): void; onOpen(id: string): void }
type AreaData = { box: CollaborationBox; area: CollaborationArea; folded: boolean; internal: readonly CollaborationRelation[]; onInspect(): void; onToggle(): void }
type AgentNode = Node<AgentData, 'agent'>
type AreaNode = Node<AreaData, 'area'>
type GraphNode = AgentNode | AreaNode
type RelationPath = { id: string; label: string; route: CollaborationPath; relations: readonly CollaborationRelation[]; active: number; startedAt: number; count: number; selected: boolean }
const emptyHandles: NodeHandle[] = [], emptyEdges: never[] = []
const sameItems = <T,>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((item, index) => item === right[index])
export const COLLABORATION_LABELS = { communication: 'Communication', creation: 'Creation', supervision: 'Supervision' } as const
const colors = { communication: 'var(--green)', creation: 'var(--text-2)', supervision: 'var(--amber)' } as const
const AgentNodeView = memo(function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const { agent } = data
  return <div className="collaboration-agent nodrag nopan" data-collaboration-agent={agent.id}>
    {agent.context ? <FocusContextCardBody context={agent.context} identity={data.identity} goalLinks={data.goals} selected={data.selected} onSelect={data.onSelect} onOpenWorkface={data.onOpen} />
      : <button type="button" className="collaboration-agent__reference" aria-pressed={data.selected} onClick={data.onSelect}><SemanticIcon name="object.agent" size={16} /><span><strong>{agent.sessionId}</strong><small>{agent.provenance ?? agent.subject?.hostId} · Reference only</small></span></button>}
  </div>
})
const AreaNodeView = memo(function AreaNodeView({ data }: NodeProps<AreaNode>) {
  return <div className="collaboration-area" data-kind={data.area.kind} data-folded={data.folded}>
    <button type="button" className="collaboration-area__heading nodrag nopan" aria-expanded={!data.folded} onClick={data.onToggle} title={data.area.issue ?? undefined}>
      <SemanticIcon name={data.folded ? 'navigation.next' : 'navigation.down'} size={12} /><span>{data.area.name}</span><small>{data.area.members.length}</small>
    </button>
    {data.folded && data.internal.length ? <button type="button" className="collaboration-area__internal nodrag nopan" aria-label={`${data.area.name}: ${data.internal.length} internal connections`} onClick={data.onInspect}>{data.internal.length} internal</button> : null}
  </div>
})
const nodeTypes = { agent: AgentNodeView, area: AreaNodeView }

/** Selection, source status and activity cannot invalidate fixed world geometry. */
export function AgentCollaborationGraph({ agents, areas, relations, pulses, selection, onSelect, onOpen, identities, goals, ready = true }: {
  agents: ReadonlyMap<string, CollaborationAgent>; areas: readonly CollaborationArea[]; relations: readonly CollaborationRelation[]; pulses: readonly CollaborationPulse[]
  selection: CollaborationSelection; onSelect(selection: CollaborationSelection): void; onOpen(context: FocusContext): void
  ready?: boolean; identities?: ReadonlyMap<string, FocusContextIdentity>; goals?: ReadonlyMap<string, FocusGoalLinks>
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const flow = useRef<ReactFlowInstance<GraphNode> | null>(null)
  const visibleIds = useMemo(() => new Set([...areas.flatMap(area => area.members), ...relations.flatMap(relation => [relation.source, relation.target])]), [areas, relations])
  const graphAreas = useMemo(() => {
    const placed = new Set(areas.flatMap(area => area.members)), unplaced = [...visibleIds].filter(id => !placed.has(id))
    return unplaced.length ? [...areas, { id: 'unplaced-references', name: 'Related Agents', kind: 'unplaced' as const, members: unplaced }] : areas
  }, [areas, visibleIds])
  const presentation = useMemo(() => collaborationConnections(graphAreas, relations, folded), [graphAreas, relations, folded])
  const geometrySelector = useMemo(createCollaborationGeometrySelector, [])
  const geometry = geometrySelector(graphAreas, folded)
  const actions = useRef({ onSelect, onOpen, agents, presentation }); actions.current = { onSelect, onOpen, agents, presentation }
  const nodeCache = useRef(new Map<string, GraphNode>()), heldNodes = useRef<GraphNode[]>([])
  const nodes = useMemo(() => {
    const next: GraphNode[] = [], cache = new Map<string, GraphNode>()
    for (const area of graphAreas) {
      const areaId = collaborationAreaNode(area.id), box = geometry.get(areaId)!, previous = nodeCache.current.get(areaId)
      const internal = presentation.internal.get(area.id) ?? [], old = previous?.type === 'area' ? previous.data : undefined
      const areaNode: AreaNode = old?.box === box && old.area === area && sameItems(old.internal, internal) ? previous as AreaNode : {
        id: areaId, type: 'area', position: { x: box.x, y: box.y }, width: box.width, height: box.height, measured: { width: box.width, height: box.height }, handles: emptyHandles,
        style: { width: box.width, height: box.height }, selectable: false, draggable: false,
        data: { box, area, folded: box.folded, internal,
          onInspect: old?.onInspect ?? (() => { const current = actions.current.presentation.internal.get(area.id) ?? []; if (current[0]) actions.current.onSelect({ kind: 'relation', id: current[0].id, relatedIds: current.map(relation => relation.id) }) }),
          onToggle: old?.onToggle ?? (() => setFolded(previous => { const next = new Set(previous); if (!next.delete(area.id)) next.add(area.id); return next })) }
      }
      next.push(areaNode); cache.set(areaId, areaNode)
      if (box.folded) continue
      for (const id of area.members) {
        const agent = agents.get(id); if (!agent) continue
        const nodeId = collaborationAgentNode(area.id, id), card = geometry.get(nodeId)!, previous = nodeCache.current.get(nodeId)
        const old = previous?.type === 'agent' ? previous.data : undefined, context = agent.context
        const presentationKey = context && JSON.stringify([context.hostId, context.id]), identity = presentationKey ? identities?.get(presentationKey) : undefined, links = presentationKey ? goals?.get(presentationKey) : undefined
        const selected = selection?.kind === 'agent' && selection.id === id
        const node: AgentNode = old?.box === card && old.agent === agent && old.selected === selected && old.identity === identity && old.goals === links ? previous as AgentNode : {
          id: nodeId, type: 'agent', parentId: areaId, position: { x: card.x - box.x, y: card.y - box.y }, width: card.width, height: card.height,
          measured: { width: card.width, height: card.height }, handles: emptyHandles, style: { width: card.width, height: card.height, pointerEvents: 'all' }, draggable: false, selectable: false,
          data: { box: card, agent, selected, identity, goals: links,
            onSelect: old?.onSelect ?? (() => actions.current.onSelect({ kind: 'agent', id })),
            onOpen: old?.onOpen ?? (() => { const context = actions.current.agents.get(id)?.context; if (context) actions.current.onOpen(context) }) }
        }
        next.push(node); cache.set(nodeId, node)
      }
    }
    nodeCache.current = cache
    if (!sameItems(heldNodes.current, next)) heldNodes.current = next
    return heldNodes.current
  }, [graphAreas, geometry, agents, presentation, selection, identities, goals])
  const routeCache = useRef(new Map<string, { from: CollaborationBox; to: CollaborationBox; path: RelationPath }>())
  const heldPaths = useRef<RelationPath[]>([])
  const paths = useMemo(() => {
    const live = new Map(pulses.map(pulse => [JSON.stringify([pulse.kind, collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.sender }), collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.recipient })]), pulse]))
    const next = new Map<string, { from: CollaborationBox; to: CollaborationBox; path: RelationPath }>()
    const paths = presentation.connections.map(connection => {
      const previous = routeCache.current.get(connection.id), from = geometry.get(connection.source)!, to = geometry.get(connection.target)!
      const route = previous?.from === from && previous.to === to ? previous.path.route : routeCollaboration(geometry, { ...connection, kind: connection.relations[0]!.kind })
      let pulse: CollaborationPulse | undefined
      for (const relation of connection.relations) { const candidate = live.get(JSON.stringify([relation.kind, relation.source, relation.target])); if (candidate && (!pulse || candidate.startedAt > pulse.startedAt || candidate.startedAt === pulse.startedAt && candidate.id > pulse.id)) pulse = candidate }
      const selected = selection?.kind === 'relation' && connection.relations.some(relation => relation.id === selection.id), old = previous?.path, first = connection.relations[0]!
      const fromAgent = agents.get(first.source), toAgent = agents.get(first.target)
      const label = `${COLLABORATION_LABELS[first.kind]}: ${fromAgent?.context?.name ?? fromAgent?.sessionId ?? first.source} → ${toAgent?.context?.name ?? toAgent?.sessionId ?? first.target}`
      const path: RelationPath = old?.route === route && old.label === label && old.active === (pulse?.id ?? 0) && old.selected === selected && sameItems(old.relations, connection.relations) ? old : {
        id: connection.id, label, route, relations: connection.relations, active: pulse?.id ?? 0, startedAt: pulse?.startedAt ?? 0, selected,
        count: connection.relations.reduce((count, relation) => count + relation.evidence.length, 0)
      }
      next.set(connection.id, { from, to, path }); return path
    })
    routeCache.current = next
    if (!sameItems(heldPaths.current, paths)) heldPaths.current = paths
    return heldPaths.current
  }, [presentation, geometry, pulses, selection, agents])
  const selectConnection = useCallback((path: RelationPath) => { const first = path.relations[0]; if (first) actions.current.onSelect({ kind: 'relation', id: first.id, relatedIds: path.relations.map(relation => relation.id) }) }, [])
  const clearSelection = useCallback(() => actions.current.onSelect(null), [])
  return <div className="collaboration-canvas" aria-label="Agent collaboration graph">
    <ReactFlow<GraphNode> nodes={nodes} edges={emptyEdges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance }} onPaneClick={clearSelection}
      onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.15} maxZoom={1.4} proOptions={{ hideAttribution: true }}>
      <InitialCollaborationViewport ready={ready} /><CollaborationRelations paths={paths} onSelect={selectConnection} onClear={clearSelection} />
      <Background gap={22} size={1} />
    </ReactFlow>
    <div className="collaboration-canvas__controls" aria-label="Graph viewport">
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => void flow.current?.zoomOut()}><SemanticIcon name="action.zoom-out" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => void flow.current?.zoomIn()}><SemanticIcon name="action.zoom-in" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Fit graph" onClick={() => void flow.current?.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true })}><SemanticIcon name="layout.expand" size={14} /></button>
    </div>
    {!visibleIds.size ? <p className="collaboration-canvas__empty">No Agents in this area.</p> : null}
  </div>
}

/** Only this small layer subscribes to camera bounds; xyflow owns its transform and nodes. */
const CollaborationRelations = memo(function CollaborationRelations({ paths, onSelect, onClear }: { paths: readonly RelationPath[]; onSelect(path: RelationPath): void; onClear(): void }) {
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    const [x, y, zoom] = state.transform, padding = 32 / zoom
    const left = -x / zoom - padding, top = -y / zoom - padding, right = (state.width - x) / zoom + padding, bottom = (state.height - y) / zoom + padding
    return paths.filter(({ route: { bounds } }) => bounds.x <= right && bounds.x + bounds.width >= left && bounds.y <= bottom && bounds.y + bounds.height >= top)
  }, [paths]), sameItems)
  const markerId = useId().replace(/:/g, '')
  return <ViewportPortal><svg className="collaboration-connections" style={{ position: 'absolute', width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
    <defs>{Object.entries(colors).map(([kind, color]) => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX={10} refY={5} markerWidth={8} markerHeight={8} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker>)}</defs>
    {visible.map(path => <RelationView key={path.id} record={path} markerId={markerId} onSelect={onSelect} onClear={onClear} />)}
  </svg></ViewportPortal>
})
const RelationView = memo(function RelationView({ record, markerId, onSelect, onClear }: { record: RelationPath; markerId: string; onSelect(path: RelationPath): void; onClear(): void }) {
  const kind = record.relations[0]!.kind, { path, labelX, labelY } = record.route
  const delay = useMemo(() => Math.min(0, record.startedAt - Date.now()), [record.active, record.startedAt])
  return <g className={`react-flow__edge selectable nopan collaboration-edge-group--${kind}`} data-id={record.id} tabIndex={0} role="button" aria-label={record.label} aria-pressed={record.selected}
    style={{ pointerEvents: 'stroke' }} onClick={event => { event.stopPropagation(); onSelect(record) }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(record) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClear() }
    }}>
    <BaseEdge id={record.id} path={path} markerEnd={`url(#${markerId}-${kind})`} interactionWidth={22} className={`collaboration-edge collaboration-edge--${kind}${record.selected ? ' is-selected' : ''}`} />
    {record.active ? <path key={record.active} d={path} style={{ animationDelay: `${delay}ms` }} className="collaboration-edge__pulse" data-kind={kind} /> : null}
    {record.selected && record.count > 1 ? <EdgeLabelRenderer><span className="collaboration-edge__count" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{record.count}</span></EdgeLabelRenderer> : null}
  </g>
})

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
