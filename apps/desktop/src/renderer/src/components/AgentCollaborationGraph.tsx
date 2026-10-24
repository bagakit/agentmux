import { createContext, useContext, type CSSProperties, memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Background, BaseEdge, EdgeLabelRenderer, ReactFlow, ViewportPortal, useReactFlow, useStore, type Node, type NodeHandle, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../lib/agent-collaboration'
import { collaborationConnections, collaborationConnectionStrength, collaborationAreaNode, collaborationAgentNode } from '../lib/collaboration-presentation'
import { collaborationAreaAncestors, createCollaborationHierarchy, collaborationVisibleAreas } from '../lib/collaboration-hierarchy'
import type { CollaborationPulse } from '../lib/use-collaboration-reading'
import type { CollaborationLayoutBox as CollaborationBox, CollaborationLayoutInput, CollaborationPath } from '../lib/collaboration-layout-engine'
import { useCollaborationLayout } from '../lib/use-collaboration-layout'
import { collaborationEnvelope, collaborationVisiblePath } from '../lib/collaboration-map-geometry'
import { COLLABORATION_DETAIL_START, COLLABORATION_OVERVIEW_MARK_SIZE, collaborationCameraDuration, collaborationIdentityInk, collaborationMapContentInk, collaborationMapLod, collaborationOverviewScale, collaborationVisibleHull } from '../lib/collaboration-map-lod'
import { collaborationCameraTarget, COLLABORATION_OVERVIEW_ZOOM, type CollaborationLocate } from '../lib/collaboration-map-camera'
import { COLLABORATION_ACTIVITY_MS, collaborationNodeSize, collaborationRecency, collaborationAgentName, collaborationAgentGlyph } from '../lib/collaboration-map-presentation'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { FocusContextCardBody } from './FocusContextCardBody'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { CollaborationRegionLabels } from './CollaborationRegionLabels'
import { useCollaborationMotion } from '../lib/use-collaboration-motion'
import { ExecutorIdentityContext, ResolvedAgentAvatar } from './AgentAvatar'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import { agentInformationPreview } from '../lib/agent-information-preview'
import '@xyflow/react/dist/base.css'
import '../styles/collaboration.css'

export type CollaborationSelection = { kind: 'agent' | 'relation'; id: string; relatedIds?: readonly string[] } | null
type NodeActivity = { pulse: CollaborationPulse; direction: 'sent' | 'received' }
type AgentData = { box: CollaborationBox; agent: CollaborationAgent; selected: boolean; activity?: NodeActivity | undefined; identity?: FocusContextIdentity | undefined; goals?: FocusGoalLinks | undefined; onPreview(enter: boolean): void; onSelect(): void; onOpen(id: string): void }
type AreaData = { box: Extract<CollaborationBox, { kind: 'area' }>; envelope: string; memberGeometry: readonly CollaborationBox[]; area: CollaborationArea; totalMembers: number; depth: number; folded: boolean; activity?: NodeActivity | undefined; internal: readonly CollaborationRelation[]; onInspect(): void; onLocate(): void; onToggle(anchor?: { x: number; y: number }): void }
type AgentNode = Node<AgentData, 'agent'>
type AreaNode = Node<AreaData, 'area'>
type GraphNode = AgentNode | AreaNode
type RelationPath = { id: string; label: string; route: CollaborationPath; sourceBox: CollaborationBox; targetBox: CollaborationBox; sourceRadius: number; targetRadius: number; sourcePointRadius: number; targetPointRadius: number; relations: readonly CollaborationRelation[]; active: number; startedAt: number; count: number; selected: boolean; emphasis: 'normal' | 'related' | 'muted' }
const emptyHandles: NodeHandle[] = [], emptyEdges: never[] = []
const sameItems = <T,>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((item, index) => item === right[index])
export const COLLABORATION_LABELS = { communication: 'Messages', creation: 'Created', supervision: 'Dispatch' } as const
const colors = { communication: 'var(--green)', creation: 'var(--text-2)', supervision: 'var(--amber)' } as const
const MapMotionContext = createContext(true)
const AgentNodeView = memo(function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const { agent } = data, zoom = useStore(state => state.transform[2])
  const lod = collaborationMapLod(zoom), overview = lod.identity === 0
  const root = useRef<HTMLDivElement>(null)
  const [focusedLayer, setFocusedLayer] = useState<'identity' | 'detail' | null>(null)
  const readingLayer = useSyncExternalStore(agentInformationPreview.subscribe, () => {
    const request = agentInformationPreview.getAll().find(request => root.current?.contains(request.anchor))
    return request?.anchor.closest<HTMLElement>('[data-map-layer]')?.dataset.mapLayer as 'identity' | 'detail' | undefined
  })
  const recency = collaborationRecency(agent.lastActivityAt), label = collaborationAgentName(agent)
  const tier = agent.tier ?? (agent.context ? 'active' : 'unknown')
  const detail = agent.context && tier === 'active' ? lod.detail : 0
  const contentInk = collaborationMapContentInk(detail)
  const projectedLayer = contentInk.detail > 0 ? 'detail' : 'identity', heldLayer = readingLayer ?? focusedLayer, owner = heldLayer ?? projectedLayer
  const identityOpacity = heldLayer ? Number(owner === 'identity') : contentInk.identity
  const detailOpacity = heldLayer ? Number(owner === 'detail') : contentInk.detail
  const focusProxy = Boolean(heldLayer) && owner === 'detail' && detail < .5
  const glyph = collaborationAgentGlyph(agent)
  const hull = collaborationVisibleHull(data.box, zoom, glyph.overviewRadius, glyph.pointRadius), markScale = collaborationOverviewScale(data.box, zoom)
  const identityInk = collaborationIdentityInk(hull.width, zoom, lod.identity, markScale,
    glyph.identity ? (22 - 2 * lod.identity) / 2 : 6 + (recency.radius - 6) * lod.identity)
  return <div ref={root} className={`collaboration-agent collaboration-agent--${tier}${detail < 1 ? ' collaboration-agent--overview' : ''} nodrag nopan`} data-collaboration-agent={agent.id} data-overview={overview || undefined} data-reading={Boolean(readingLayer) || undefined}
    style={{ '--collaboration-mark-scale': markScale, '--collaboration-identity': lod.identity, '--collaboration-detail': detail, '--collaboration-avatar-center': `${identityInk.avatarCenter}px` } as CSSProperties}
    onPointerEnter={() => data.onPreview(true)} onPointerLeave={() => data.onPreview(false)} onFocusCapture={event => { data.onPreview(true); setFocusedLayer((event.target as HTMLElement).closest<HTMLElement>('[data-map-layer]')?.dataset.mapLayer as 'identity' | 'detail' ?? null) }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocusedLayer(null); data.onPreview(false) } }}>
    <div className="collaboration-agent__body" data-selected={data.selected || undefined} style={{ left: hull.x - data.box.x, top: hull.y - data.box.y, width: hull.width, height: hull.height, borderRadius: hull.radius }}>
      <div className="collaboration-agent__identity-layer" data-map-layer="identity" inert={owner !== 'identity'} aria-hidden={owner !== 'identity'} style={{ opacity: identityOpacity, '--collaboration-mark-scale': markScale } as CSSProperties}>
        <AgentMark data={data} label={label} tier={tier} recency={recency} overview={overview} identityProgress={lod.identity} markScale={markScale} identityInk={identityInk} />
      </div>
      {agent.context && (tier === 'active' && detail > 0 || owner === 'detail') ? <div className="collaboration-agent__detail-layer" data-map-layer="detail" data-focus-proxy={focusProxy || undefined} inert={owner !== 'detail'} aria-hidden={owner !== 'detail'} style={{ opacity: detailOpacity }}>
        <FocusContextCardBody context={agent.context} identity={data.identity} goalLinks={data.goals} selected={data.selected} onSelect={data.onSelect} onOpenWorkface={data.onOpen} />
      </div> : null}
    </div>
    {focusProxy ? <span className="collaboration-agent__focus-proxy" aria-hidden="true" style={{ left: data.box.width / 2, top: hull.y - data.box.y - 8 / zoom, transform: `scale(${1 / zoom}) translate(-50%, -100%)` }}><strong>{label}</strong><kbd>↓ Read</kbd></span> : null}
    {data.activity ? <ActivityMark activity={data.activity} /> : null}
  </div>
})
function ActivityMark({ activity }: { activity: NodeActivity }) {
  const { pulse, direction } = activity, motion = useContext(MapMotionContext)
  const label = pulse.kind === 'communication' ? `Message ${direction}` : 'Dispatch updated'
  const delay = useMemo(() => Math.min(0, pulse.startedAt - Date.now()), [pulse.id, pulse.startedAt, motion])
  return <span key={pulse.id} className="collaboration-activity" data-kind={pulse.kind} aria-label={label} title={label}
    style={{ animationDelay: `${delay}ms` }}><span>{pulse.kind === 'communication' ? direction === 'sent' ? 'Sent ↗' : 'Received ↙' : 'Updated'}</span></span>
}
function AgentMark({ data, label, tier, recency, overview = false, identityProgress = 1, markScale = 1, identityInk }: { data: AgentData; label: string; tier: string; recency: ReturnType<typeof collaborationRecency>; overview?: boolean; identityProgress?: number; markScale?: number; identityInk: ReturnType<typeof collaborationIdentityInk> }) {
  const context = data.agent.context, { config } = useContext(ExecutorIdentityContext)
  const providerId = data.agent.providerId ?? context?.providerId, executorId = data.agent.executorId ?? context?.executorId
  const appearance = executorId ? config?.executors[executorId]?.avatar ?? config?.appearance.agentAvatars?.[executorId] : undefined
  const showIdentity = collaborationAgentGlyph(data.agent).identity
  const preview = useAgentInformationPreview(context, true, data.identity, data.goals, () => { if (context) data.onOpen(context.id) })
  return <button type="button" ref={preview.anchor} {...preview.triggerEvents} className={overview ? "collaboration-agent__dot" : "collaboration-agent__mark"} data-tier={tier} data-session-id={context?.id} style={overview ? { width: COLLABORATION_OVERVIEW_MARK_SIZE, height: COLLABORATION_OVERVIEW_MARK_SIZE } : undefined}
    aria-pressed={data.selected} aria-label={`${label} · ${tier}`} aria-describedby={preview.describedBy} onClick={data.onSelect} title={`${tier} · ${recency.label}`}>
    <span className="collaboration-agent__avatar" style={{ '--collaboration-avatar-scale': markScale + (1 - markScale) * identityProgress } as CSSProperties}>
      {showIdentity ? <ResolvedAgentAvatar label={label} providerId={providerId!} executorId={executorId} appearance={appearance} size={22 - 2 * identityProgress} /> : null}
      <span className="collaboration-agent__point" data-identity={showIdentity || undefined} style={{ width: (6 + (recency.radius - 6) * identityProgress) * 2, height: (6 + (recency.radius - 6) * identityProgress) * 2, opacity: recency.depth }} />
    </span>{!overview && tier !== 'closed' ? <strong style={{ left: identityInk.nameLeft, opacity: identityInk.opacity, fontSize: identityInk.fontSize }}>{label}</strong> : null}
  </button>
}
const AreaNodeView = memo(function AreaNodeView({ data }: NodeProps<AreaNode>) {
  const empty = data.memberGeometry.length === 0
  const overview = useStore(state => state.transform[2] < COLLABORATION_OVERVIEW_ZOOM)
  return <div className="collaboration-area" data-kind={data.area.kind} data-depth={data.depth} data-folded={data.folded} data-empty={empty || undefined} data-overview={overview || undefined}>
    {!empty && !data.folded ? <svg className="collaboration-area__envelope" width={data.box.width} height={data.box.height} aria-hidden="true"><path d={data.envelope} /></svg> : null}
  </div>
})
const nodeTypes = { agent: AgentNodeView, area: AreaNodeView }

/** Metadata and pulses reuse geometry; physical size changes retain the current reading occurrence. */
export function AgentCollaborationGraph({ agents, areas, relations, pulses, selection, onSelect, onOpen, identities, goals, ready = true, active = true, locate, context, onVisibleAgents, onPreviewAgent, peeked }: {
  agents: ReadonlyMap<string, CollaborationAgent>; areas: readonly CollaborationArea[]; relations: readonly CollaborationRelation[]; pulses: readonly CollaborationPulse[]
  selection: CollaborationSelection; onSelect(selection: CollaborationSelection): void; onOpen(context: FocusContext): void
  ready?: boolean; active?: boolean; locate?: CollaborationLocate | undefined; onVisibleAgents?(ids: readonly string[]): void; onPreviewAgent?(id: string | null): void; peeked?: string | null; identities?: ReadonlyMap<string, FocusContextIdentity>; goals?: ReadonlyMap<string, FocusGoalLinks>
  context?: { name: string; onLocate(): void }
}) {
  const motion = useCollaborationMotion(active), hud = useRef<HTMLDivElement>(null), contextControl = useRef<HTMLButtonElement>(null)
  const [areaLocate, setAreaLocate] = useState<{ source: CollaborationLocate | undefined; request: CollaborationLocate }>()
  const effectiveLocate = areaLocate && areaLocate.source === locate ? areaLocate.request : locate
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const flow = useRef<ReactFlowInstance<GraphNode> | null>(null)
  const cameraAnimation = useRef<object | null>(null)
  const animateCamera = (move: (duration: number) => Promise<boolean> | undefined) => {
    const duration = collaborationCameraDuration(motion.enabled), token = {}
    if (duration) cameraAnimation.current = token
    void move(duration)?.finally(() => { if (cameraAnimation.current === token) cameraAnimation.current = null })
  }
  useEffect(() => {
    if ((!active || !motion.enabled) && cameraAnimation.current && flow.current) {
      cameraAnimation.current = null
      void flow.current.setViewport(flow.current.getViewport(), { duration: 0 })
    }
  }, [active, motion.enabled])
  const readingAnchor = useRef<string | null>(null)
  const foldAnchor = useRef<{ id: string; folded: boolean; x: number; y: number; gesture: number; source: CollaborationLocate | undefined } | null>(null)
  const preparedLocate = useRef<object | undefined>(undefined)
  useEffect(() => {
    if (!active || !locate || preparedLocate.current === locate.token) return
    const candidates = areas.filter(area => locate.agentId ? area.members.includes(locate.agentId) : locate.areaIds?.includes(area.id))
    if (!candidates.length) return
    preparedLocate.current = locate.token
    if (candidates.some(area => [area.id, ...collaborationAreaAncestors(areas, area.id)].every(id => !folded.has(id)))) return
    const reveal = [candidates[0]!.id, ...collaborationAreaAncestors(areas, candidates[0]!.id)]
    setFolded(previous => { const next = new Set(previous); for (const id of reveal) next.delete(id); return next })
  }, [active, locate, areas, folded])

  const visibleIds = useMemo(() => new Set([...areas.flatMap(area => area.members), ...relations.flatMap(relation => [relation.source, relation.target])]), [areas, relations])
  const worldAreas = useMemo(() => {
    const placed = new Set(areas.flatMap(area => area.members)), unplaced = [...visibleIds].filter(id => !placed.has(id))
    return unplaced.length ? [...areas, { id: 'unplaced-references', name: 'Unresolved references', kind: 'unplaced' as const, members: unplaced }] : areas
  }, [areas, visibleIds])
  const hierarchy = useMemo(() => createCollaborationHierarchy(worldAreas), [worldAreas])
  const graphAreas = useMemo(() => collaborationVisibleAreas(worldAreas, folded), [worldAreas, folded])
  const presentation = useMemo(() => collaborationConnections(worldAreas, relations, folded), [worldAreas, relations, folded])
  const allConnections = presentation.connections
  const input = useMemo<CollaborationLayoutInput>(() => ({
    areas: worldAreas.map(area => ({ id: collaborationAreaNode(area.id), name: area.name, parentId: area.parentId ? collaborationAreaNode(area.parentId) : null, members: area.members.map(id => collaborationAgentNode(area.id, id)), folded: folded.has(area.id) })),
    nodes: worldAreas.flatMap(area => area.members.flatMap(id => { const agent = agents.get(id); return agent ? [{ id: collaborationAgentNode(area.id, id), areaId: collaborationAreaNode(area.id), ...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown')) }] : [] })),
    connections: allConnections.map(connection => ({ id: connection.id, source: connection.source, target: connection.target, kind: connection.relations[0]!.kind, strength: collaborationConnectionStrength(connection) }))
  }), [worldAreas, agents, allConnections, folded])
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
  useEffect(() => {
    const pending = foldAnchor.current
    if (!pending) return
    if (!active || pending.gesture !== gestures.current || pending.source !== locate) { foldAnchor.current = null; return }
    const box = geometry.get(pending.id)
    if (box?.kind !== 'area' || box.folded !== pending.folded || !flow.current) return
    foldAnchor.current = null
    // A clamped screen label is the user's reading occurrence. Keep that
    // occurrence when its original world heading was outside the viewport.
    const { zoom } = flow.current.getViewport()
    void flow.current.setViewport({ zoom, x: pending.x - (box.x + box.heading.x) * zoom,
      y: pending.y - (box.y + box.heading.y + box.heading.height) * zoom })
  }, [geometry, locate, active])

  const nodeCache = useRef(new Map<string, GraphNode>()), heldNodes = useRef<GraphNode[]>([])
  const nodes = useMemo(() => {
    const next: GraphNode[] = [], cache = new Map<string, GraphNode>()
    for (const area of graphAreas) {
      const areaId = collaborationAreaNode(area.id), box = geometry.get(areaId), previous = nodeCache.current.get(areaId)
      if (box?.kind !== 'area') continue
      const internal = presentation.internal.get(area.id) ?? [], old = previous?.type === 'area' ? previous.data : undefined
      const live = area.members.reduce<NodeActivity | undefined>((latest, id) => { const value = activity.get(id); return value && (!latest || value.pulse.id > latest.pulse.id) ? value : latest }, undefined)
      const memberGeometry = [...area.members.flatMap(id => { const member = geometry.get(collaborationAgentNode(area.id, id)); return member ? [member] : [] }),
        ...(hierarchy.children.get(area.id) ?? []).flatMap(child => geometry.get(collaborationAreaNode(child.id)) ?? [])]
      const totalMembers = hierarchy.members.get(area.id)?.length ?? area.members.length, depth = hierarchy.depth.get(area.id) ?? 0
      const sameGeometry = old && sameItems(old.memberGeometry, memberGeometry)
      const envelope = old?.box === box && sameGeometry ? old.envelope : collaborationEnvelope(box, memberGeometry)
      const areaNode: AreaNode = old?.box === box && sameGeometry && old.area === area && old.totalMembers === totalMembers && old.depth === depth && old.activity === live && sameItems(old.internal, internal) ? previous as AreaNode : {
        id: areaId, type: 'area', position: { x: box.x, y: box.y }, width: box.width, height: box.height, measured: { width: box.width, height: box.height }, handles: emptyHandles,
        style: { width: box.width, height: box.height, zIndex: depth }, selectable: false, draggable: false,
        data: { box, envelope, memberGeometry, area, totalMembers, depth, folded: box.folded, internal, activity: live,
          onLocate: old?.onLocate ?? (() => {
            foldAnchor.current = null
            setFolded(previous => { if (!previous.has(area.id)) return previous; const next = new Set(previous); next.delete(area.id); return next })
            setAreaLocate({ source: actions.current.locate, request: { token: {}, areaIds: [area.id] } })
          }),
          onInspect: old?.onInspect ?? (() => { const current = actions.current.presentation.internal.get(area.id) ?? []; if (current[0]) actions.current.onSelect({ kind: 'relation', id: current[0].id, relatedIds: current.map(relation => relation.id) }) }),
          onToggle: old?.onToggle ?? (anchor => {
            readingAnchor.current = areaId
            const box = nodeCache.current.get(areaId)?.data.box
            foldAnchor.current = anchor && box?.kind === 'area' ? { ...anchor, id: areaId, folded: !box.folded, gesture: gestures.current, source: actions.current.locate } : null
            setFolded(previous => { const next = new Set(previous); if (!next.delete(area.id)) next.add(area.id); return next })
          }) }
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
  }, [hierarchy, graphAreas, geometry, agents, presentation, selection, identities, goals, activity])
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
      const sourceGlyph = collaborationAgentGlyph(fromAgent), targetGlyph = collaborationAgentGlyph(toAgent)
      const sourceRadius = sourceGlyph.overviewRadius, targetRadius = targetGlyph.overviewRadius
      const sourcePointRadius = sourceGlyph.pointRadius, targetPointRadius = targetGlyph.pointRadius
      const count = connection.relations.reduce((count, relation) => count + relation.evidence.length, 0)
      const label = `${COLLABORATION_LABELS[first.kind]}: ${from} → ${to} · ${count} original ${count === 1 ? 'record' : 'records'}`
      const path: RelationPath = old?.route === route && old.label === label && old.sourceRadius === sourceRadius && old.targetRadius === targetRadius && old.sourcePointRadius === sourcePointRadius && old.targetPointRadius === targetPointRadius && old.active === (pulse?.id ?? 0) && old.selected === selected && old.emphasis === emphasis && sameItems(old.relations, connection.relations) ? old : {
        id: connection.id, label, route, sourceBox, targetBox, sourceRadius, targetRadius, sourcePointRadius, targetPointRadius, relations: connection.relations, active: pulse?.id ?? 0, startedAt: pulse?.startedAt ?? 0, selected, emphasis,
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
  return <MapMotionContext.Provider value={motion.enabled}><div className="collaboration-canvas" data-motion={motion.enabled ? 'on' : 'off'} style={{ '--collaboration-activity-duration': `${COLLABORATION_ACTIVITY_MS}ms` } as CSSProperties} aria-label="Agent collaboration graph">
    <ReactFlow<GraphNode> nodes={nodes} edges={emptyEdges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance }} onPaneClick={clearSelection}
      onMoveStart={event => { if (event) { ++gestures.current; cameraAnimation.current = null } }} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.05} maxZoom={1.4} proOptions={{ hideAttribution: true }}>
      <CollaborationViewport ready={ready && active && !(areaLocate && areaLocate.request === effectiveLocate && effectiveLocate.areaIds?.some(id => geometry.get(collaborationAreaNode(id))?.folded))} geometry={geometry} areas={graphAreas} agents={agents} locate={effectiveLocate} gestures={gestures} readingAnchor={readingAnchor} cameraAnimation={cameraAnimation} onVisibleAgents={onVisibleAgents} /><CollaborationRelations paths={paths} active={active} onSelect={selectConnection} onClear={clearSelection} /><CollaborationRegionLabels areas={areaNodes} geometry={geometry} active={active} selectedAgent={selection?.kind === 'agent' ? selection.id : effectiveLocate?.agentId} locatedAreas={effectiveLocate?.areaIds} hud={hud} contextControl={context ? contextControl : null} />
      <Background gap={22} size={1} />
    </ReactFlow>
    {context ? <button ref={contextControl} type="button" className="collaboration-map__locate" title="Locate original context" onClick={context.onLocate}><SemanticIcon name="action.locate" size={14} /><span>{context.name}</span></button> : null}
    <div ref={hud} className="collaboration-canvas__hud"><div className="collaboration-canvas__controls" aria-label="Graph viewport">
      <button type="button" className="collaboration-canvas__motion" aria-label="Map animations" aria-pressed={motion.enabled} aria-busy={motion.saving || undefined} disabled={motion.saving} title={`Map animations: ${motion.enabled ? 'on' : 'off'}${motion.preference === 'system' ? ' · Following system' : ''}. Messages continue updating.`} onClick={() => void motion.setEnabled(!motion.enabled)}><span className="collaboration-canvas__motion-switch" aria-hidden="true" /><span>Motion</span><strong>{motion.enabled ? 'On' : 'Off'}</strong></button>
      <span className="collaboration-canvas__divider" aria-hidden="true" />
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => { ++gestures.current; animateCamera(duration => flow.current?.zoomOut({ duration })) }}><SemanticIcon name="action.zoom-out" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => { ++gestures.current; animateCamera(duration => flow.current?.zoomIn({ duration })) }}><SemanticIcon name="action.zoom-in" size={14} /></button>
      <button type="button" className="icon-button collaboration-canvas__arrange" aria-label="Arrange map" title="Arrange using observed relationships" onClick={layout.arrange}><SemanticIcon name="object.topology" size={14} /><span>Arrange</span></button>
      <button type="button" className="icon-button" aria-label="Overview" title="Show the whole map" onClick={() => { ++gestures.current; animateCamera(duration => flow.current?.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true, duration })) }}><SemanticIcon name="layout.expand" size={14} /></button>
    </div>
    {motion.issue ? <p className="collaboration-canvas__motion-issue" role="status">{motion.issue}</p> : null}
    <div className="collaboration-canvas__legend" aria-label="Map legend"><div aria-label="Agent states">{(['active', 'idle', 'closed', 'unknown'] as const).map(tier => <span key={tier}><i className="collaboration-node-key" data-tier={tier} aria-hidden="true" />{{active: 'Active', idle: 'Idle', closed: 'Closed', unknown: 'Unconfirmed'}[tier]}</span>)}</div><div aria-label="Relation legend">{Object.entries(COLLABORATION_LABELS).map(([kind, label]) => <span key={kind}><i className="collaboration-relation-key" data-kind={kind} aria-hidden="true" />{label}</span>)}</div></div></div>
    {locate?.agentId && geometry.size > 0 && !graphAreas.some(area => area.members.includes(locate.agentId!)) ? <p className="collaboration-canvas__issue" role="status">The original Agent location is unconfirmed. Its identity and sources are retained.</p> : null}
    {layout.issues.size ? <div className="collaboration-canvas__issue" role="status"><span>{layout.issues.has('layout') ? 'Layout needs attention. Original Agents and records are retained.' : `${layout.issues.size} ${layout.issues.size === 1 ? 'connection could' : 'connections could'} not be drawn. Original records remain readable.`}</span> <button type="button" onClick={layout.retry}>Retry layout</button><details><summary>Details</summary>{[...layout.issues].map(([id, message]) => <p key={id}>{message}</p>)}</details></div> : layout.busy ? <span className="collaboration-canvas__progress" role="status">{geometry.size ? 'Drawing connections…' : 'Arranging map…'}</span> : null}
    {!visibleIds.size ? <p className="collaboration-canvas__empty">No Agents in this map.</p> : null}
  </div></MapMotionContext.Provider>
}

/** Only this small layer subscribes to camera bounds; xyflow owns its transform and nodes. */
const CollaborationRelations = memo(function CollaborationRelations({ paths, active, onSelect, onClear }: { paths: readonly RelationPath[]; active: boolean; onSelect(path: RelationPath): void; onClear(): void }) {
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    const [x, y, zoom] = state.transform, padding = 32 / zoom
    const left = -x / zoom - padding, top = -y / zoom - padding, right = (state.width - x) / zoom + padding, bottom = (state.height - y) / zoom + padding
    return paths.filter(({ route: { bounds }, sourceBox, targetBox }) => [bounds, sourceBox, targetBox].some(box => box.x <= right && box.x + box.width >= left && box.y <= bottom && box.y + box.height >= top))
  }, [paths]), sameItems)
  const zoom = useStore(state => state.transform[2])
  const markerId = useId().replace(/:/g, '')
  return <ViewportPortal><svg className="collaboration-connections" style={{ position: 'absolute', width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
    <defs>{Object.entries(colors).map(([kind, color]) => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX={10} refY={5} markerUnits="userSpaceOnUse" markerWidth={8 / zoom} markerHeight={8 / zoom} orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={color} /></marker>)}</defs>
    {visible.map(path => <RelationView key={path.id} record={path} markerId={markerId} zoom={zoom} active={active} onSelect={onSelect} onClear={onClear} />)}
  </svg></ViewportPortal>
})
const RelationView = memo(function RelationView({ record, markerId, zoom, active, onSelect, onClear }: { record: RelationPath; markerId: string; zoom: number; active: boolean; onSelect(path: RelationPath): void; onClear(): void }) {
  const kind = record.relations[0]!.kind, { labelX, labelY } = record.route, motion = useContext(MapMotionContext)
  const tooltip = useWorkbenchNameTooltip(record.label, '', !active, { placement: 'bottom', pointerPassThrough: true })
  const show = (event: { currentTarget: SVGGElement }) => {
    const anchor = event.currentTarget.querySelector<SVGPathElement>('.react-flow__edge-path')
    if (anchor) tooltip.showFor(anchor)
  }
  const path = collaborationVisiblePath(record.route, record.sourceBox, record.targetBox, zoom, record.sourceRadius, record.targetRadius, record.sourcePointRadius, record.targetPointRadius)
  const delay = useMemo(() => Math.min(0, record.startedAt - Date.now()), [record.active, record.startedAt, motion])
  return <><g className={`react-flow__edge selectable nopan collaboration-edge-group--${kind}`} data-id={record.id} data-emphasis={record.emphasis} data-recent={record.active ? true : undefined} tabIndex={0} role="button" aria-label={record.label} aria-pressed={record.selected} {...tooltip.props}
    style={{ pointerEvents: 'stroke' }} onMouseEnter={show} onMouseLeave={event => { if (!event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) tooltip.hide() }} onFocus={show} onClick={event => { event.stopPropagation(); onSelect(record) }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(record) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClear(); tooltip.hide() }
    }}>
    <BaseEdge id={record.id} path={path} markerEnd={`url(#${markerId}-${kind})`} interactionWidth={22} className={`collaboration-edge collaboration-edge--${kind}${record.selected ? ' is-selected' : ''}`} />
    {record.active && motion ? <path key={record.active} d={path} pathLength={1} style={{ animationDelay: `${delay}ms` }} className="collaboration-edge__pulse" data-kind={kind} /> : null}
    {record.active && motion && kind === 'communication' ? <circle key={`packet-${record.active}`} r={4 / zoom} className="collaboration-edge__packet" data-kind={kind} aria-hidden="true"
      style={{ offsetPath: `path("${path}")`, animationDelay: `${delay}ms` }} /> : null}
    {record.emphasis === 'related' && record.count > 1 && !record.selected && !tooltip.props['aria-describedby'] ? <EdgeLabelRenderer><span className="collaboration-edge__count" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{record.count}</span></EdgeLabelRenderer> : null}
  </g>{tooltip.content}</>
})

function CollaborationViewport({ ready, geometry, areas, agents, locate, gestures, readingAnchor, cameraAnimation, onVisibleAgents }: { ready: boolean; geometry: ReadonlyMap<string, CollaborationBox>; areas: readonly CollaborationArea[]; agents: ReadonlyMap<string, CollaborationAgent>; locate?: CollaborationLocate | undefined; gestures: { current: number }; readingAnchor: { current: string | null }; cameraAnimation: { current: object | null }; onVisibleAgents?: ((ids: readonly string[]) => void) | undefined }) {
  const flow = useReactFlow(), initialized = useRef(false), applied = useRef<object | undefined>(undefined), pending = useRef<{ token: object | undefined; gesture: number }>({ token: undefined, gesture: gestures.current })
  const motion = useContext(MapMotionContext)
  const width = useStore(state => state.width), height = useStore(state => state.height)
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    if (!ready || state.transform[2] <= COLLABORATION_DETAIL_START) return [] as string[]
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
      const duration = collaborationCameraDuration(motion, !initialized.current), animation = {}
      if (duration) cameraAnimation.current = animation
      void flow.setCenter(target.x, target.y, { zoom: target.zoom, duration }).finally(() => { if (cameraAnimation.current === animation) cameraAnimation.current = null })
      if (locate) applied.current = locate.token
      initialized.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, geometry, locate, width, height, areas, agents, flow, readingAnchor, motion, cameraAnimation])
  return null
}
