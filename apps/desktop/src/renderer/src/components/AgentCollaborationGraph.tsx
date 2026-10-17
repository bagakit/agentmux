import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Background, BaseEdge, EdgeLabelRenderer, ReactFlow, ViewportPortal, useReactFlow, useStore, type Node, type NodeHandle, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../lib/agent-collaboration'
import { collaborationConnections, collaborationAreaNode, collaborationAgentNode } from '../lib/collaboration-presentation'
import type { CollaborationPulse } from '../lib/use-collaboration-reading'
import type { CollaborationLayoutBox as CollaborationBox, CollaborationLayoutInput, CollaborationPath } from '../lib/collaboration-layout-engine'
import { useCollaborationLayout } from '../lib/use-collaboration-layout'
import { collaborationNodeSize, collaborationRecency, collaborationAgentName } from '../lib/collaboration-map-presentation'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { FocusContextCardBody } from './FocusContextCardBody'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import '@xyflow/react/dist/base.css'
import '../styles/collaboration.css'

export type CollaborationSelection = { kind: 'agent' | 'relation'; id: string; relatedIds?: readonly string[] } | null
type AgentData = { box: CollaborationBox; agent: CollaborationAgent; selected: boolean; identity?: FocusContextIdentity | undefined; goals?: FocusGoalLinks | undefined; peeked: boolean; onPreview(enter: boolean): void; onSelect(): void; onOpen(id: string): void }
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
  const { agent } = data, readable = useStore(state => state.transform[2] >= .55)
  const recency = collaborationRecency(agent.lastActivityAt), label = collaborationAgentName(agent)
  const tier = agent.tier ?? (agent.context ? 'active' : 'unknown')
  return <div className={`collaboration-agent collaboration-agent--${tier}${readable ? '' : ' collaboration-agent--overview'} nodrag nopan`} data-collaboration-agent={agent.id}
    onPointerEnter={() => data.onPreview(true)} onPointerLeave={() => data.onPreview(false)} onFocusCapture={() => data.onPreview(true)}>
    {agent.context && tier === 'active' && readable ? <FocusContextCardBody context={agent.context} identity={data.identity} goalLinks={data.goals} selected={data.selected} onSelect={data.onSelect} onOpenWorkface={data.onOpen} />
      : agent.context ? <AgentMark data={data} label={label} tier={tier} recency={recency} />
        : <button type="button" className="collaboration-agent__mark" data-tier={tier} aria-label={`${label} · ${tier}`} aria-pressed={data.selected} onClick={data.onSelect} onFocus={() => data.onPreview(true)} title={`${label} · ${tier} · ${recency.label}`}>
          <span className="collaboration-agent__point" style={{ width: recency.radius * 2, height: recency.radius * 2, opacity: recency.depth }} />{tier !== 'closed' ? <strong>{label}</strong> : null}
        </button>}
  </div>
})
function AgentMark({ data, label, tier, recency }: { data: AgentData; label: string; tier: string; recency: ReturnType<typeof collaborationRecency> }) {
  const context = data.agent.context!
  const preview = useAgentInformationPreview(context, true, data.identity, data.goals, () => data.onOpen(context.id))
  useEffect(() => { if (data.peeked) preview.triggerEvents.onPointerEnter() }, [data.peeked])
  return <button type="button" ref={preview.anchor} {...preview.triggerEvents} className="collaboration-agent__mark" data-tier={tier} data-session-id={context.id}
    aria-pressed={data.selected} aria-label={`${label} · ${tier}`} aria-describedby={preview.describedBy} onClick={data.onSelect} title={`${tier} · ${recency.label}`}>
    <span className="collaboration-agent__point" style={{ width: recency.radius * 2, height: recency.radius * 2, opacity: recency.depth }} />{tier !== 'closed' ? <strong>{label}</strong> : null}
  </button>
}
const AreaNodeView = memo(function AreaNodeView({ data }: NodeProps<AreaNode>) {
  return <div className="collaboration-area" data-kind={data.area.kind} data-folded={data.folded}>
    <button type="button" className="collaboration-area__heading nodrag nopan" aria-expanded={!data.folded} onClick={data.onToggle} title={data.area.issue ?? undefined}>
      <SemanticIcon name={data.folded ? 'navigation.next' : 'navigation.down'} size={12} /><span>{data.area.name}</span><small>{data.area.members.length}</small>
    </button>
    {data.folded && data.internal.length ? <button type="button" className="collaboration-area__internal nodrag nopan" aria-label={`${data.area.name}: ${data.internal.length} internal connections`} onClick={data.onInspect}>{data.internal.length} internal</button> : null}
  </div>
})
const nodeTypes = { agent: AgentNodeView, area: AreaNodeView }

/** Metadata and pulses reuse geometry; physical size changes retain the current reading occurrence. */
export function AgentCollaborationGraph({ agents, areas, relations, pulses, selection, onSelect, onOpen, identities, goals, ready = true, active = true, locate, onVisibleAgents, onPreviewAgent, peeked }: {
  agents: ReadonlyMap<string, CollaborationAgent>; areas: readonly CollaborationArea[]; relations: readonly CollaborationRelation[]; pulses: readonly CollaborationPulse[]
  selection: CollaborationSelection; onSelect(selection: CollaborationSelection): void; onOpen(context: FocusContext): void
  ready?: boolean; active?: boolean; locate?: { token: object; agentId?: string; areaIds?: readonly string[] } | undefined; onVisibleAgents?(ids: readonly string[]): void; onPreviewAgent?(id: string | null): void; peeked?: string | null; identities?: ReadonlyMap<string, FocusContextIdentity>; goals?: ReadonlyMap<string, FocusGoalLinks>
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const flow = useRef<ReactFlowInstance<GraphNode> | null>(null)
  const readingAnchor = useRef<string | null>(null)
  const preparedLocate = useRef<object | undefined>(undefined)
  useEffect(() => {
    if (!active || !locate?.agentId || preparedLocate.current === locate.token) return
    const candidates = areas.filter(area => area.members.includes(locate.agentId!))
    if (!candidates.length) return
    preparedLocate.current = locate.token
    if (candidates.some(area => !folded.has(area.id))) return
    setFolded(previous => { const next = new Set(previous); next.delete(candidates[0]!.id); return next })
  }, [active, locate, areas, folded])

  const visibleIds = useMemo(() => new Set([...areas.flatMap(area => area.members), ...relations.flatMap(relation => [relation.source, relation.target])]), [areas, relations])
  const graphAreas = useMemo(() => {
    const placed = new Set(areas.flatMap(area => area.members)), unplaced = [...visibleIds].filter(id => !placed.has(id))
    return unplaced.length ? [...areas, { id: 'unplaced-references', name: 'Related Agents', kind: 'unplaced' as const, members: unplaced }] : areas
  }, [areas, visibleIds])
  const presentation = useMemo(() => collaborationConnections(graphAreas, relations, folded), [graphAreas, relations, folded])
  const input = useMemo<CollaborationLayoutInput>(() => ({
    areas: graphAreas.map(area => ({ id: collaborationAreaNode(area.id), name: area.name, members: area.members.map(id => collaborationAgentNode(area.id, id)), folded: folded.has(area.id) })),
    nodes: graphAreas.flatMap(area => area.members.flatMap(id => { const agent = agents.get(id); return agent ? [{ id: collaborationAgentNode(area.id, id), areaId: collaborationAreaNode(area.id), ...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown')) }] : [] })),
    connections: presentation.connections.map(connection => ({ id: connection.id, source: connection.source, target: connection.target, kind: connection.relations[0]!.kind }))
  }), [graphAreas, agents, presentation, folded])
  const layout = useCollaborationLayout(input, active, readingAnchor), geometry = layout.boxes
  const actions = useRef({ onSelect, onOpen, onPreviewAgent, agents, presentation }); actions.current = { onSelect, onOpen, onPreviewAgent, agents, presentation }
  const gestures = useRef(0)

  const nodeCache = useRef(new Map<string, GraphNode>()), heldNodes = useRef<GraphNode[]>([])
  const nodes = useMemo(() => {
    const next: GraphNode[] = [], cache = new Map<string, GraphNode>()
    for (const area of graphAreas) {
      const areaId = collaborationAreaNode(area.id), box = geometry.get(areaId), previous = nodeCache.current.get(areaId)
      if (!box) continue
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
        const nodeId = collaborationAgentNode(area.id, id), card = geometry.get(nodeId), previous = nodeCache.current.get(nodeId)
        if (!card) continue
        const old = previous?.type === 'agent' ? previous.data : undefined, context = agent.context
        const presentationKey = context && JSON.stringify([context.hostId, context.id]), identity = presentationKey ? identities?.get(presentationKey) : undefined, links = presentationKey ? goals?.get(presentationKey) : undefined
        const selected = selection?.kind === 'agent' && selection.id === id
        const node: AgentNode = old?.box === card && old.agent === agent && old.selected === selected && old.identity === identity && old.goals === links && old.peeked === (peeked === id) ? previous as AgentNode : {
          id: nodeId, type: 'agent', parentId: areaId, position: { x: card.x - box.x, y: card.y - box.y }, width: card.width, height: card.height,
          measured: { width: card.width, height: card.height }, handles: emptyHandles, style: { width: card.width, height: card.height, pointerEvents: 'all' }, draggable: false, selectable: false,
          data: { box: card, agent, selected, identity, goals: links, peeked: peeked === id,
            onPreview: old?.onPreview ?? (enter => { if (enter) readingAnchor.current = nodeId; actions.current.onPreviewAgent?.(enter ? id : null) }),
            onSelect: old?.onSelect ?? (() => { readingAnchor.current = nodeId; actions.current.onSelect({ kind: 'agent', id }) }),
            onOpen: old?.onOpen ?? (() => { const context = actions.current.agents.get(id)?.context; if (context) actions.current.onOpen(context) }) }
        }
        next.push(node); cache.set(nodeId, node)
      }
    }
    nodeCache.current = cache
    if (!sameItems(heldNodes.current, next)) heldNodes.current = next
    return heldNodes.current
  }, [graphAreas, geometry, agents, presentation, selection, identities, goals, peeked])
  const routeCache = useRef(new Map<string, { path: RelationPath }>())
  const heldPaths = useRef<RelationPath[]>([])
  const paths = useMemo(() => {
    const live = new Map(pulses.map(pulse => [JSON.stringify([pulse.kind, collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.sender }), collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.recipient })]), pulse]))
    const next = new Map<string, { path: RelationPath }>()
    const paths = presentation.connections.flatMap(connection => {
      const previous = routeCache.current.get(connection.id), route = layout.paths.get(connection.id)
      if (!route) return []
      let pulse: CollaborationPulse | undefined
      for (const relation of connection.relations) { const candidate = live.get(JSON.stringify([relation.kind, relation.source, relation.target])); if (candidate && (!pulse || candidate.startedAt > pulse.startedAt || candidate.startedAt === pulse.startedAt && candidate.id > pulse.id)) pulse = candidate }
      const selected = selection?.kind === 'relation' && connection.relations.some(relation => relation.id === selection.id), old = previous?.path, first = connection.relations[0]!
      const fromAgent = agents.get(first.source), toAgent = agents.get(first.target)
      const label = `${COLLABORATION_LABELS[first.kind]}: ${collaborationAgentName(fromAgent) || first.source} → ${collaborationAgentName(toAgent) || first.target}`
      const path: RelationPath = old?.route === route && old.label === label && old.active === (pulse?.id ?? 0) && old.selected === selected && sameItems(old.relations, connection.relations) ? old : {
        id: connection.id, label, route, relations: connection.relations, active: pulse?.id ?? 0, startedAt: pulse?.startedAt ?? 0, selected,
        count: connection.relations.reduce((count, relation) => count + relation.evidence.length, 0)
      }
      next.set(connection.id, { path }); return [path]
    })
    routeCache.current = next
    if (!sameItems(heldPaths.current, paths)) heldPaths.current = paths
    return heldPaths.current
  }, [presentation, layout.paths, pulses, selection, agents])
  const selectConnection = useCallback((path: RelationPath) => { const first = path.relations[0]; if (first) actions.current.onSelect({ kind: 'relation', id: first.id, relatedIds: path.relations.map(relation => relation.id) }) }, [])
  const clearSelection = useCallback(() => actions.current.onSelect(null), [])
  return <div className="collaboration-canvas" aria-label="Agent collaboration graph">
    <ReactFlow<GraphNode> nodes={nodes} edges={emptyEdges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance }} onPaneClick={clearSelection}
      onMoveStart={event => { if (event) ++gestures.current }} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.05} maxZoom={1.4} proOptions={{ hideAttribution: true }}>
      <CollaborationViewport ready={ready && active} geometry={geometry} areas={graphAreas} locate={locate} gestures={gestures} readingAnchor={readingAnchor} onVisibleAgents={onVisibleAgents} /><CollaborationRelations paths={paths} onSelect={selectConnection} onClear={clearSelection} />
      <Background gap={22} size={1} />
    </ReactFlow>
    <div className="collaboration-canvas__controls" aria-label="Graph viewport">
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => { ++gestures.current; void flow.current?.zoomOut() }}><SemanticIcon name="action.zoom-out" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => { ++gestures.current; void flow.current?.zoomIn() }}><SemanticIcon name="action.zoom-in" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Arrange map" title="Arrange map" onClick={layout.arrange}><SemanticIcon name="object.topology" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Fit graph" onClick={() => { ++gestures.current; void flow.current?.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true }) }}><SemanticIcon name="layout.expand" size={14} /></button>
    </div>
    {locate?.agentId && geometry.size > 0 && !graphAreas.some(area => area.members.includes(locate.agentId!)) ? <p className="collaboration-canvas__issue" role="status">The original Agent location is unconfirmed. Its identity and sources are retained.</p> : null}
    {layout.issues.size ? <p className="collaboration-canvas__issue" role="status">{[...layout.issues.values()][0]} <button type="button" onClick={layout.retry}>Retry layout</button></p> : layout.busy ? <span className="collaboration-canvas__progress" role="status">{geometry.size ? 'Drawing connections…' : 'Arranging map…'}</span> : null}
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

function worldBounds(geometry: ReadonlyMap<string, CollaborationBox>, ids?: ReadonlySet<string>) {
  const boxes = [...geometry.values()].filter(box => !ids || ids.has(box.id))
  if (!boxes.length) return null
  const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y))
  return { x: left, y: top, width: Math.max(...boxes.map(box => box.x + box.width)) - left, height: Math.max(...boxes.map(box => box.y + box.height)) - top }
}
function CollaborationViewport({ ready, geometry, areas, locate, gestures, readingAnchor, onVisibleAgents }: { ready: boolean; geometry: ReadonlyMap<string, CollaborationBox>; areas: readonly CollaborationArea[]; locate?: { token: object; agentId?: string; areaIds?: readonly string[] } | undefined; gestures: { current: number }; readingAnchor: { current: string | null }; onVisibleAgents?: ((ids: readonly string[]) => void) | undefined }) {
  const flow = useReactFlow(), initialized = useRef(false), applied = useRef<object | undefined>(undefined), pending = useRef<{ token: object | undefined; gesture: number }>({ token: undefined, gesture: gestures.current })
  const width = useStore(state => state.width), height = useStore(state => state.height)
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    if (!ready || state.transform[2] < .55) return [] as string[]
    const [x, y, zoom] = state.transform, left = -x / zoom, top = -y / zoom, right = (state.width - x) / zoom, bottom = (state.height - y) / zoom
    return [...new Set(areas.flatMap(area => area.members.flatMap(id => {
      const box = geometry.get(collaborationAgentNode(area.id, id))
      return box && box.x <= right && box.x + box.width >= left && box.y <= bottom && box.y + box.height >= top ? [id] : []
    })))].sort()
  }, [geometry, areas, ready]), sameItems)
  useEffect(() => { const timer = setTimeout(() => onVisibleAgents?.(visible), 120); return () => clearTimeout(timer) }, [visible, onVisibleAgents])
  if (pending.current.token !== locate?.token) pending.current = { token: locate?.token, gesture: gestures.current }
  useEffect(() => {
    if (!ready || !geometry.size || width <= 0 || height <= 0 || locate && applied.current === locate.token || !locate && initialized.current) return
    const gesture = pending.current.gesture
    const frame = requestAnimationFrame(() => {
      if (gestures.current !== gesture) { if (locate) applied.current = locate.token; initialized.current = true; return }
      const id = locate?.agentId && areas.flatMap(area => area.members.includes(locate.agentId!) ? [collaborationAgentNode(area.id, locate.agentId!)] : []).find(id => geometry.has(id))
      if (locate?.agentId && !id) return
      const targets = id ? new Set([id]) : locate?.areaIds?.length ? new Set(locate.areaIds.map(collaborationAreaNode)) : undefined
      const bounds = worldBounds(geometry, targets)
      if (!bounds) return
      if (id) { readingAnchor.current = id; void flow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom: 1 }) }
      else void flow.fitView({ ...(targets ? { nodes: [...targets].map(id => ({ id })) } : {}), padding: .18, minZoom: targets ? .55 : .05, maxZoom: .9, includeHiddenNodes: true })
      if (locate) applied.current = locate.token
      initialized.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, geometry, locate, width, height, areas, flow, readingAnchor])
  return null
}
