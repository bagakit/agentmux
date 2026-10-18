import { type CSSProperties, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Background, BaseEdge, EdgeLabelRenderer, ReactFlow, ViewportPortal, useReactFlow, useStore, type Node, type NodeHandle, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../lib/agent-collaboration'
import { collaborationConnections, collaborationAreaNode, collaborationAgentNode } from '../lib/collaboration-presentation'
import type { CollaborationPulse } from '../lib/use-collaboration-reading'
import type { CollaborationLayoutBox as CollaborationBox, CollaborationLayoutInput, CollaborationPath } from '../lib/collaboration-layout-engine'
import { useCollaborationLayout } from '../lib/use-collaboration-layout'
import { collaborationEnvelope, collaborationOverviewPath, collaborationOverviewScale } from '../lib/collaboration-map-geometry'
import { collaborationCameraTarget, COLLABORATION_OVERVIEW_ZOOM, COLLABORATION_READING_ZOOM, type CollaborationLocate } from '../lib/collaboration-map-camera'
import { COLLABORATION_ACTIVITY_MS, collaborationNodeSize, collaborationRecency, collaborationAgentName } from '../lib/collaboration-map-presentation'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { FocusContextCardBody } from './FocusContextCardBody'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import '@xyflow/react/dist/base.css'
import '../styles/collaboration.css'

export type CollaborationSelection = { kind: 'agent' | 'relation'; id: string; relatedIds?: readonly string[] } | null
type NodeActivity = { pulse: CollaborationPulse; direction: 'sent' | 'received' }
type AgentData = { box: CollaborationBox; agent: CollaborationAgent; selected: boolean; activity?: NodeActivity | undefined; identity?: FocusContextIdentity | undefined; goals?: FocusGoalLinks | undefined; onPreview(enter: boolean): void; onSelect(): void; onOpen(id: string): void }
type AreaData = { box: Extract<CollaborationBox, { kind: 'area' }>; envelope: string; memberGeometry: readonly CollaborationBox[]; area: CollaborationArea; folded: boolean; activity?: NodeActivity | undefined; internal: readonly CollaborationRelation[]; onInspect(): void; onLocate(): void; onToggle(): void }
type AgentNode = Node<AgentData, 'agent'>
type AreaNode = Node<AreaData, 'area'>
type GraphNode = AgentNode | AreaNode
type RelationPath = { id: string; label: string; route: CollaborationPath; sourceBox: CollaborationBox; targetBox: CollaborationBox; relations: readonly CollaborationRelation[]; active: number; startedAt: number; count: number; selected: boolean; emphasis: 'normal' | 'related' | 'muted' }
const emptyHandles: NodeHandle[] = [], emptyEdges: never[] = []
const sameItems = <T,>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((item, index) => item === right[index])
export const COLLABORATION_LABELS = { communication: 'Messages', creation: 'Created', supervision: 'Dispatch' } as const
const colors = { communication: 'var(--green)', creation: 'var(--text-2)', supervision: 'var(--amber)' } as const
const areaKinds = { project: { icon: 'object.project', label: 'Project' }, topic: { icon: 'object.topic', label: 'Topic' }, mote: { icon: 'object.mote', label: 'Mote' }, unplaced: { icon: 'object.topology', label: 'Unplaced' } } as const
const AgentNodeView = memo(function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const { agent } = data, readable = useStore(state => state.transform[2] >= COLLABORATION_READING_ZOOM)
  const overview = useStore(state => state.transform[2] < COLLABORATION_OVERVIEW_ZOOM)
  const markScale = useStore(state => state.transform[2] < COLLABORATION_OVERVIEW_ZOOM ? collaborationOverviewScale(data.box, state.transform[2]) : 1)
  const recency = collaborationRecency(agent.lastActivityAt), label = collaborationAgentName(agent)
  const tier = agent.tier ?? (agent.context ? 'active' : 'unknown')
  return <div className={`collaboration-agent collaboration-agent--${tier}${readable ? '' : ' collaboration-agent--overview'} nodrag nopan`} data-collaboration-agent={agent.id} data-overview={overview || undefined} style={{ '--collaboration-mark-scale': markScale } as CSSProperties}
    onPointerEnter={() => data.onPreview(true)} onPointerLeave={() => data.onPreview(false)} onFocusCapture={() => data.onPreview(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) data.onPreview(false) }}>
    {overview ? <AgentMark data={data} label={label} tier={tier} recency={recency} overview /> : agent.context && tier === 'active' && readable ? <FocusContextCardBody context={agent.context} identity={data.identity} goalLinks={data.goals} selected={data.selected} onSelect={data.onSelect} onOpenWorkface={data.onOpen} />
      : <AgentMark data={data} label={label} tier={tier} recency={recency} />}
    {data.activity ? <ActivityMark activity={data.activity} /> : null}
  </div>
})
function ActivityMark({ activity }: { activity: NodeActivity }) {
  const { pulse, direction } = activity
  const label = pulse.kind === 'communication' ? `Message ${direction}` : 'Dispatch updated'
  const delay = useMemo(() => Math.min(0, pulse.startedAt - Date.now()), [pulse.id, pulse.startedAt])
  return <span key={pulse.id} className="collaboration-activity" data-kind={pulse.kind} aria-label={label} title={label}
    style={{ animationDelay: `${delay}ms`, animationDuration: `${COLLABORATION_ACTIVITY_MS}ms` }}><span>{pulse.kind === 'communication' ? direction === 'sent' ? 'Sent ↗' : 'Received ↙' : 'Updated'}</span></span>
}
function AgentMark({ data, label, tier, recency, overview = false }: { data: AgentData; label: string; tier: string; recency: ReturnType<typeof collaborationRecency>; overview?: boolean }) {
  const context = data.agent.context
  const preview = useAgentInformationPreview(context, true, data.identity, data.goals, () => { if (context) data.onOpen(context.id) })
  return <button type="button" ref={preview.anchor} {...preview.triggerEvents} className={overview ? "collaboration-agent__dot" : "collaboration-agent__mark"} data-tier={tier} data-session-id={context?.id}
    aria-pressed={data.selected} aria-label={`${label} · ${tier}`} aria-describedby={preview.describedBy} onClick={data.onSelect} title={`${tier} · ${recency.label}`}>
    <span className="collaboration-agent__point" style={{ width: overview ? 12 : recency.radius * 2, height: overview ? 12 : recency.radius * 2, opacity: recency.depth }} />{!overview && tier !== 'closed' ? <strong>{label}</strong> : null}
  </button>
}
const AreaNodeView = memo(function AreaNodeView({ data }: NodeProps<AreaNode>) {
  const empty = data.area.members.length === 0
  const overview = useStore(state => state.transform[2] < COLLABORATION_OVERVIEW_ZOOM)
  return <div className="collaboration-area" data-kind={data.area.kind} data-folded={data.folded} data-empty={empty || undefined} data-overview={overview || undefined}>
    {!empty && !data.folded ? <svg className="collaboration-area__envelope" width={data.box.width} height={data.box.height} aria-hidden="true"><path d={data.envelope} /></svg> : null}
    {!overview ? <div className="collaboration-area__label" style={{ left: data.box.heading.x, top: data.box.heading.y, width: data.box.heading.width, height: data.box.heading.height }}>
    {empty ? <div className="collaboration-area__heading" title={data.area.issue ?? data.area.name}><span>{data.area.name}</span><small>0</small></div> : <button type="button" className="collaboration-area__heading nodrag nopan" aria-expanded={!data.folded} onClick={data.onToggle} title={data.area.issue ?? undefined}>
      <SemanticIcon name={data.folded ? 'navigation.next' : 'navigation.down'} size={12} /><span>{data.area.name}</span><em>{areaKinds[data.area.kind].label}</em><small>{data.area.members.length}</small>
    </button>}
    </div> : null}
    {!overview && data.folded && data.internal.length ? <button type="button" className="collaboration-area__internal nodrag nopan" aria-label={`${data.area.name}: ${data.internal.length} internal connections`} onClick={data.onInspect}>{data.internal.length} internal</button> : null}
    {!overview && data.folded && data.activity ? <ActivityMark activity={data.activity} /> : null}
  </div>
})
const nodeTypes = { agent: AgentNodeView, area: AreaNodeView }

/** Metadata and pulses reuse geometry; physical size changes retain the current reading occurrence. */
export function AgentCollaborationGraph({ agents, areas, relations, pulses, selection, onSelect, onOpen, identities, goals, ready = true, active = true, locate, onVisibleAgents, onPreviewAgent, peeked }: {
  agents: ReadonlyMap<string, CollaborationAgent>; areas: readonly CollaborationArea[]; relations: readonly CollaborationRelation[]; pulses: readonly CollaborationPulse[]
  selection: CollaborationSelection; onSelect(selection: CollaborationSelection): void; onOpen(context: FocusContext): void
  ready?: boolean; active?: boolean; locate?: CollaborationLocate | undefined; onVisibleAgents?(ids: readonly string[]): void; onPreviewAgent?(id: string | null): void; peeked?: string | null; identities?: ReadonlyMap<string, FocusContextIdentity>; goals?: ReadonlyMap<string, FocusGoalLinks>
}) {
  const [areaLocate, setAreaLocate] = useState<{ source: CollaborationLocate | undefined; request: CollaborationLocate }>()
  const effectiveLocate = areaLocate && areaLocate.source === locate ? areaLocate.request : locate
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
    return unplaced.length ? [...areas, { id: 'unplaced-references', name: 'Unresolved references', kind: 'unplaced' as const, members: unplaced }] : areas
  }, [areas, visibleIds])
  const presentation = useMemo(() => collaborationConnections(graphAreas, relations, folded), [graphAreas, relations, folded])
  const allConnections = presentation.connections
  const input = useMemo<CollaborationLayoutInput>(() => ({
    areas: graphAreas.map(area => ({ id: collaborationAreaNode(area.id), name: area.name, members: area.members.map(id => collaborationAgentNode(area.id, id)), folded: folded.has(area.id) })),
    nodes: graphAreas.flatMap(area => area.members.flatMap(id => { const agent = agents.get(id); return agent ? [{ id: collaborationAgentNode(area.id, id), areaId: collaborationAreaNode(area.id), ...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown')) }] : [] })),
    connections: allConnections.map(connection => ({ id: connection.id, source: connection.source, target: connection.target, kind: connection.relations[0]!.kind }))
  }), [graphAreas, agents, allConnections, folded])
  const layout = useCollaborationLayout(input, active, readingAnchor), geometry = layout.boxes
  const activity = useMemo(() => {
    const result = new Map<string, NodeActivity>()
    for (const pulse of pulses) {
      result.set(collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.sender }), { pulse, direction: 'sent' })
      result.set(collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.recipient }), { pulse, direction: 'received' })
    }
    return result
  }, [pulses])
  const actions = useRef({ onSelect, onOpen, onPreviewAgent, agents, presentation, locate }); actions.current = { onSelect, onOpen, onPreviewAgent, agents, presentation, locate }
  const gestures = useRef(0)

  const nodeCache = useRef(new Map<string, GraphNode>()), heldNodes = useRef<GraphNode[]>([])
  const nodes = useMemo(() => {
    const next: GraphNode[] = [], cache = new Map<string, GraphNode>()
    for (const area of graphAreas) {
      const areaId = collaborationAreaNode(area.id), box = geometry.get(areaId), previous = nodeCache.current.get(areaId)
      if (box?.kind !== 'area') continue
      const internal = presentation.internal.get(area.id) ?? [], old = previous?.type === 'area' ? previous.data : undefined
      const live = area.members.reduce<NodeActivity | undefined>((latest, id) => { const value = activity.get(id); return value && (!latest || value.pulse.id > latest.pulse.id) ? value : latest }, undefined)
      const memberGeometry = area.members.flatMap(id => { const member = geometry.get(collaborationAgentNode(area.id, id)); return member ? [member] : [] })
      const sameGeometry = old && sameItems(old.memberGeometry, memberGeometry)
      const envelope = old?.box === box && sameGeometry ? old.envelope : collaborationEnvelope(box, memberGeometry)
      const areaNode: AreaNode = old?.box === box && sameGeometry && old.area === area && old.activity === live && sameItems(old.internal, internal) ? previous as AreaNode : {
        id: areaId, type: 'area', position: { x: box.x, y: box.y }, width: box.width, height: box.height, measured: { width: box.width, height: box.height }, handles: emptyHandles,
        style: { width: box.width, height: box.height }, selectable: false, draggable: false,
        data: { box, envelope, memberGeometry, area, folded: box.folded, internal, activity: live,
          onLocate: old?.onLocate ?? (() => {
            setFolded(previous => { if (!previous.has(area.id)) return previous; const next = new Set(previous); next.delete(area.id); return next })
            setAreaLocate({ source: actions.current.locate, request: { token: {}, areaIds: [area.id] } })
          }),
          onInspect: old?.onInspect ?? (() => { const current = actions.current.presentation.internal.get(area.id) ?? []; if (current[0]) actions.current.onSelect({ kind: 'relation', id: current[0].id, relatedIds: current.map(relation => relation.id) }) }),
          onToggle: old?.onToggle ?? (() => { readingAnchor.current = areaId; setFolded(previous => { const next = new Set(previous); if (!next.delete(area.id)) next.add(area.id); return next }) }) }
      }
      next.push(areaNode); cache.set(areaId, areaNode)
      if (box.folded) continue
      for (const id of area.members) {
        const agent = agents.get(id); if (!agent) continue
        const nodeId = collaborationAgentNode(area.id, id), card = geometry.get(nodeId), previous = nodeCache.current.get(nodeId)
        if (!card) continue
        const old = previous?.type === 'agent' ? previous.data : undefined, context = agent.context
        const presentationKey = context && JSON.stringify([context.hostId, context.id]), identity = presentationKey ? identities?.get(presentationKey) : undefined, links = presentationKey ? goals?.get(presentationKey) : undefined
        const selected = selection?.kind === 'agent' && selection.id === id, live = activity.get(id)
        const node: AgentNode = old?.box === card && previous?.position.x === card.x - box.x && previous.position.y === card.y - box.y && old.agent === agent && old.selected === selected && old.identity === identity && old.goals === links && old.activity === live ? previous as AgentNode : {
          id: nodeId, type: 'agent', parentId: areaId, position: { x: card.x - box.x, y: card.y - box.y }, width: card.width, height: card.height,
          measured: { width: card.width, height: card.height }, handles: emptyHandles, style: { width: card.width, height: card.height, pointerEvents: 'all' }, draggable: false, selectable: false,
          data: { box: card, agent, selected, identity, goals: links, activity: live,
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
  }, [graphAreas, geometry, agents, presentation, selection, identities, goals, activity])
  const areaNames = useMemo(() => new Map(graphAreas.map(area => [collaborationAreaNode(area.id), area.name])), [graphAreas])
  const routeCache = useRef(new Map<string, { path: RelationPath }>())
  const heldPaths = useRef<RelationPath[]>([])
  const paths = useMemo(() => {
    const selectedRelations = selection?.kind === 'relation' ? new Set([selection.id, ...selection.relatedIds ?? []]) : null
    const live = new Map(pulses.map(pulse => [JSON.stringify([pulse.kind, collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.sender }), collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.recipient })]), pulse]))
    const next = new Map<string, { path: RelationPath }>()
    const paths = allConnections.flatMap(connection => {
      const previous = routeCache.current.get(connection.id), route = layout.paths.get(connection.id)
      const sourceBox = geometry.get(connection.source), targetBox = geometry.get(connection.target)
      if (!route || !sourceBox || !targetBox) return []
      let pulse: CollaborationPulse | undefined
      for (const relation of connection.relations) { const candidate = live.get(JSON.stringify([relation.kind, relation.source, relation.target])); if (candidate && (!pulse || candidate.startedAt > pulse.startedAt || candidate.startedAt === pulse.startedAt && candidate.id > pulse.id)) pulse = candidate }
      const selected = connection.relations.some(relation => selectedRelations?.has(relation.id)), old = previous?.path, first = connection.relations[0]!
      const fromAgent = agents.get(first.source), toAgent = agents.get(first.target)
      const emphasizedAgent = selection?.kind === 'agent' ? selection.id : selection ? null : peeked
      const related = emphasizedAgent && connection.relations.some(relation => relation.source === emphasizedAgent || relation.target === emphasizedAgent)
      const emphasis = selection || peeked ? selected || related ? 'related' : 'muted' : 'normal'
      const from = areaNames.get(connection.source) ?? (collaborationAgentName(fromAgent) || first.source)
      const to = areaNames.get(connection.target) ?? (collaborationAgentName(toAgent) || first.target)
      const count = connection.relations.reduce((count, relation) => count + relation.evidence.length, 0)
      const label = `${COLLABORATION_LABELS[first.kind]}: ${from} → ${to} · ${count} original ${count === 1 ? 'record' : 'records'}`
      const path: RelationPath = old?.route === route && old.label === label && old.active === (pulse?.id ?? 0) && old.selected === selected && old.emphasis === emphasis && sameItems(old.relations, connection.relations) ? old : {
        id: connection.id, label, route, sourceBox, targetBox, relations: connection.relations, active: pulse?.id ?? 0, startedAt: pulse?.startedAt ?? 0, selected, emphasis,
        count
      }
      next.set(connection.id, { path }); return [path]
    })
    routeCache.current = next
    if (!sameItems(heldPaths.current, paths)) heldPaths.current = paths
    return heldPaths.current
  }, [allConnections, layout.paths, geometry, pulses, selection, agents, areaNames, peeked])
  const selectConnection = useCallback((path: RelationPath) => { const first = path.relations[0]; if (first) actions.current.onSelect({ kind: 'relation', id: first.id, relatedIds: path.relations.map(relation => relation.id) }) }, [])
  const clearSelection = useCallback(() => actions.current.onSelect(null), [])
  const areaNodes = useMemo(() => nodes.filter((node): node is AreaNode => node.type === 'area'), [nodes])
  return <div className="collaboration-canvas" aria-label="Agent collaboration graph">
    <ReactFlow<GraphNode> nodes={nodes} edges={emptyEdges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance }} onPaneClick={clearSelection}
      onMoveStart={event => { if (event) ++gestures.current }} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.05} maxZoom={1.4} proOptions={{ hideAttribution: true }}>
      <CollaborationViewport ready={ready && active && !(areaLocate && areaLocate.request === effectiveLocate && effectiveLocate.areaIds?.some(id => geometry.get(collaborationAreaNode(id))?.folded))} geometry={geometry} areas={graphAreas} agents={agents} locate={effectiveLocate} gestures={gestures} readingAnchor={readingAnchor} onVisibleAgents={onVisibleAgents} /><CollaborationRelations paths={paths} onSelect={selectConnection} onClear={clearSelection} /><CollaborationRegionLabels areas={areaNodes} />
      <Background gap={22} size={1} />
    </ReactFlow>
    <div className="collaboration-canvas__controls" aria-label="Graph viewport">
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => { ++gestures.current; void flow.current?.zoomOut() }}><SemanticIcon name="action.zoom-out" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => { ++gestures.current; void flow.current?.zoomIn() }}><SemanticIcon name="action.zoom-in" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Arrange map" title="Arrange map" onClick={layout.arrange}><SemanticIcon name="object.topology" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Overview" title="Show the whole map" onClick={() => { ++gestures.current; void flow.current?.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true }) }}><SemanticIcon name="layout.expand" size={14} /></button>
    </div>
    <div className="collaboration-canvas__legend" aria-label="Relation legend">{Object.entries(COLLABORATION_LABELS).map(([kind, label]) => <span key={kind}><i className="collaboration-relation-key" data-kind={kind} aria-hidden="true" />{label}</span>)}</div>
    {locate?.agentId && geometry.size > 0 && !graphAreas.some(area => area.members.includes(locate.agentId!)) ? <p className="collaboration-canvas__issue" role="status">The original Agent location is unconfirmed. Its identity and sources are retained.</p> : null}
    {layout.issues.size ? <div className="collaboration-canvas__issue" role="status"><span>{layout.issues.has('layout') ? 'Layout needs attention. Original Agents and records are retained.' : `${layout.issues.size} ${layout.issues.size === 1 ? 'connection could' : 'connections could'} not be drawn. Original records remain readable.`}</span> <button type="button" onClick={layout.retry}>Retry layout</button><details><summary>Details</summary>{[...layout.issues].map(([id, message]) => <p key={id}>{message}</p>)}</details></div> : layout.busy ? <span className="collaboration-canvas__progress" role="status">{geometry.size ? 'Drawing connections…' : 'Arranging map…'}</span> : null}
    {!visibleIds.size ? <p className="collaboration-canvas__empty">No Agents in this map.</p> : null}
  </div>
}

/** Camera-only labels retain region context without moving or measuring the world. */
const CollaborationRegionLabels = memo(function CollaborationRegionLabels({ areas }: { areas: readonly AreaNode[] }) {
  const camera = useStore(state => [...state.transform, state.width, state.height], sameItems)
  const labels = useMemo(() => {
    const [panX = 0, panY = 0, zoom = 1, width = 0, height = 0] = camera
    if (width < 80 || height < 80) return []
    const overview = zoom < COLLABORATION_OVERVIEW_ZOOM
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
    const visible = (box: CollaborationBox) => box.x * zoom + panX < width && (box.x + box.width) * zoom + panX > 0 && box.y * zoom + panY < height && (box.y + box.height) * zoom + panY > 0
    const candidates = areas.flatMap(({ data }) => {
      const { box, area } = data
      if (!visible(box)) return []
      const left = (box.x + box.heading.x) * zoom + panX, top = (box.y + box.heading.y) * zoom + panY
      const headingVisible = left >= 8 && left + box.heading.width * zoom <= width - 8 && top >= 8 && top + box.heading.height * zoom <= height - 8
      if (!overview && (headingVisible || !data.memberGeometry.some(visible))) return []
      const labelWidth = Math.min(width - 24, Math.max(104, Math.min(224, area.name.length * 6.5 + 62)))
      return [{ data, width: labelWidth, height: 26, x: clamp(left, 12, width - labelWidth - 12),
        y: clamp(top + box.heading.height * zoom - 26, headingVisible ? 8 : 52, height - 38), context: !overview }]
    }).sort((a, b) => Number(!a.data.area.members.length) - Number(!b.data.area.members.length) || b.data.area.members.length - a.data.area.members.length || a.y - b.y || a.x - b.x || a.data.area.id.localeCompare(b.data.area.id))
    const placed: typeof candidates = []
    for (const candidate of candidates) {
      for (const offset of [0, 30, -30, 60, -60, 90, -90, 120, -120]) {
        const y = clamp(candidate.y + offset, 8, height - candidate.height - 12)
        if (placed.some(other => candidate.x < other.x + other.width + 6 && candidate.x + candidate.width + 6 > other.x && y < other.y + other.height + 4 && y + candidate.height + 4 > other.y)) continue
        placed.push({ ...candidate, y }); break
      }
    }
    return placed
  }, [areas, camera])
  return <div className="collaboration-region-labels">{labels.map(({ data, x, y, width, height, context }) => <div key={data.area.id} className="collaboration-area__overview-label" data-area-id={data.box.id} data-kind={data.area.kind} data-empty={!data.area.members.length || undefined} data-context={context || undefined} style={{ left: x, top: y, width, height }}>
    <button type="button" className="collaboration-area__summary nodrag nopan" aria-label={`Locate ${data.area.name} · ${data.area.members.length} Agents`} onClick={data.onLocate} title={data.area.issue ?? `${areaKinds[data.area.kind].label} · ${data.area.name}`}>
      <SemanticIcon name={areaKinds[data.area.kind].icon} size={13} /><span>{data.area.name}</span><small>{data.area.members.length}</small>
      {data.activity ? <i className="collaboration-area__activity" data-kind={data.activity.pulse.kind} aria-label={data.activity.pulse.kind === 'communication' ? 'Recent message activity' : 'Recent dispatch update'} /> : null}
    </button>
  </div>)}</div>
})

/** Only this small layer subscribes to camera bounds; xyflow owns its transform and nodes. */
const CollaborationRelations = memo(function CollaborationRelations({ paths, onSelect, onClear }: { paths: readonly RelationPath[]; onSelect(path: RelationPath): void; onClear(): void }) {
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    const [x, y, zoom] = state.transform, padding = 32 / zoom
    const left = -x / zoom - padding, top = -y / zoom - padding, right = (state.width - x) / zoom + padding, bottom = (state.height - y) / zoom + padding
    return paths.filter(({ route: { bounds }, sourceBox, targetBox }) => [bounds, sourceBox, targetBox].some(box => box.x <= right && box.x + box.width >= left && box.y <= bottom && box.y + box.height >= top))
  }, [paths]), sameItems)
  const zoom = useStore(state => state.transform[2])
  const markerId = useId().replace(/:/g, '')
  return <ViewportPortal><svg className="collaboration-connections" style={{ position: 'absolute', width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
    <defs>{Object.entries(colors).map(([kind, color]) => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX={10} refY={5} markerUnits="userSpaceOnUse" markerWidth={8 / zoom} markerHeight={8 / zoom} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker>)}</defs>
    {visible.map(path => <RelationView key={path.id} record={path} markerId={markerId} zoom={zoom} onSelect={onSelect} onClear={onClear} />)}
  </svg></ViewportPortal>
})
const RelationView = memo(function RelationView({ record, markerId, zoom, onSelect, onClear }: { record: RelationPath; markerId: string; zoom: number; onSelect(path: RelationPath): void; onClear(): void }) {
  const kind = record.relations[0]!.kind, { labelX, labelY } = record.route
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false)
  const path = zoom < COLLABORATION_OVERVIEW_ZOOM ? collaborationOverviewPath(record.route, record.sourceBox, record.targetBox, zoom) : record.route.path
  const delay = useMemo(() => Math.min(0, record.startedAt - Date.now()), [record.active, record.startedAt])
  return <g className={`react-flow__edge selectable nopan collaboration-edge-group--${kind}`} data-id={record.id} data-emphasis={record.emphasis} tabIndex={0} role="button" aria-label={record.label} aria-pressed={record.selected}
    style={{ pointerEvents: 'stroke' }} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onClick={event => { event.stopPropagation(); onSelect(record) }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(record) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClear() }
    }}>
    <title>{record.label}</title>
    <BaseEdge id={record.id} path={path} markerEnd={`url(#${markerId}-${kind})`} interactionWidth={22} className={`collaboration-edge collaboration-edge--${kind}${record.selected ? ' is-selected' : ''}`} />
    {record.active ? <path key={record.active} d={path} pathLength={1} style={{ animationDelay: `${delay}ms`, animationDuration: `${COLLABORATION_ACTIVITY_MS}ms` }} className="collaboration-edge__pulse" data-kind={kind} /> : null}
    {record.active && kind === 'communication' ? <circle key={`packet-${record.active}`} r={4 / zoom} className="collaboration-edge__packet" aria-hidden="true"
      style={{ offsetPath: `path("${path}")`, animationDelay: `${delay}ms`, animationDuration: `${COLLABORATION_ACTIVITY_MS}ms` }} /> : null}
    {record.selected || hovered || focused ? <EdgeLabelRenderer><span className="collaboration-edge__label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${1 / zoom})` }}>{record.label}</span></EdgeLabelRenderer> : null}
    {record.emphasis === 'related' && record.count > 1 && !record.selected && !hovered && !focused ? <EdgeLabelRenderer><span className="collaboration-edge__count" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{record.count}</span></EdgeLabelRenderer> : null}
  </g>
})

function CollaborationViewport({ ready, geometry, areas, agents, locate, gestures, readingAnchor, onVisibleAgents }: { ready: boolean; geometry: ReadonlyMap<string, CollaborationBox>; areas: readonly CollaborationArea[]; agents: ReadonlyMap<string, CollaborationAgent>; locate?: CollaborationLocate | undefined; gestures: { current: number }; readingAnchor: { current: string | null }; onVisibleAgents?: ((ids: readonly string[]) => void) | undefined }) {
  const flow = useReactFlow(), initialized = useRef(false), applied = useRef<object | undefined>(undefined), pending = useRef<{ token: object | undefined; gesture: number }>({ token: undefined, gesture: gestures.current })
  const width = useStore(state => state.width), height = useStore(state => state.height)
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    if (!ready || state.transform[2] < COLLABORATION_READING_ZOOM) return [] as string[]
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
      const target = collaborationCameraTarget(geometry, areas, agents, { width, height }, locate)
      if (!target) return
      if (target.anchor) readingAnchor.current = target.anchor
      void flow.setCenter(target.x, target.y, { zoom: target.zoom })
      if (locate) applied.current = locate.token
      initialized.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, geometry, locate, width, height, areas, agents, flow, readingAnchor])
  return null
}
