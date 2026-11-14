import { createContext, useContext, type RefObject, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BaseEdge, EdgeLabelRenderer, ReactFlow, ViewportPortal, useReactFlow, useStore, type Node, type NodeHandle, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../lib/agent-collaboration'
import { collaborationConnections, collaborationConnectionStrength, collaborationAreaNode, collaborationAgentNode } from '../lib/collaboration-presentation'
import { collaborationAreaAncestors, createCollaborationHierarchy, collaborationVisibleAreas } from '../lib/collaboration-hierarchy'
import type { CollaborationPulse } from '../lib/use-collaboration-reading'
import type { CollaborationLayoutBox as CollaborationBox, CollaborationLayoutInput, CollaborationPath } from '../lib/collaboration-layout-engine'
import { useCollaborationLayout } from '../lib/use-collaboration-layout'
import { collaborationEnvelope, collaborationVisibleRoute } from '../lib/collaboration-map-geometry'
import { collaborationDistantFaceInk, collaborationMapReadsSummary, COLLABORATION_OVERVIEW_MARK_SIZE, collaborationCameraDuration, collaborationIdentityInk, collaborationMapContentInk, collaborationMapLod, collaborationMapTextBudget, collaborationOverviewScale, collaborationVisibleHull } from '../lib/collaboration-map-lod'
import { collaborationCameraTarget, COLLABORATION_OVERVIEW_ZOOM, type CollaborationLocate } from '../lib/collaboration-map-camera'
import { COLLABORATION_ACTIVITY_MS, collaborationCardSlot, collaborationNodeSize, collaborationRecencyLabel, collaborationRecencyStep, collaborationAgentName, collaborationAgentGlyph, useCollaborationRecencyClock, type CollaborationRecencyStep } from '../lib/collaboration-map-presentation'
import { useAgentInformationPreview } from './AgentInformationPreview'
import { FocusContextCardBody } from './FocusContextCardBody'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import { CollaborationRegionLabels } from './CollaborationRegionLabels'
import { CollaborationMapGround } from './CollaborationMapGround'
import { useCollaborationMotion } from '../lib/use-collaboration-motion'
import { ExecutorIdentityContext, ResolvedAgentAvatar } from './AgentAvatar'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import { resolveFocusMapPreferences } from '../../../shared/focus-map-preferences'
import { useAppStore } from '../store'
import { CollaborationFocusRegions, CollaborationMapPreferences } from '../lib/collaboration-map-preferences'
import { SettingsNavigation } from './SettingsNavigation'
import { CollaborationCompactState, CollaborationEssentialState } from './CollaborationCompactState'
import { COLLABORATION_LABELS, collaborationRelationSummary } from '../lib/collaboration-relation-presentation'
import { CollaborationRelationArrow, CollaborationRelationKey } from './CollaborationRelationMark'
import { agentInformationPreview } from '../lib/agent-information-preview'
import { createPointerRestGate, PointerRestGateContext, type PointerRestGate } from '../lib/pointer-rest-gate'
import '@xyflow/react/dist/base.css'
import { CollaborationBoundsIndex } from '../lib/collaboration-spatial-index'
import { CollaborationDispatchSignal, COLLABORATION_TRANSFER_MS } from './CollaborationDispatchSignal'

export type CollaborationSelection = { kind: 'agent' | 'relation'; id: string; relatedIds?: readonly string[] } | null
type NodeActivity = { pulse: CollaborationPulse; direction: 'sent' | 'received' }
type AgentData = { box: CollaborationBox; agent: CollaborationAgent; step: CollaborationRecencyStep; selected: boolean; activity?: NodeActivity | undefined; identity?: FocusContextIdentity | undefined; goals?: FocusGoalLinks | undefined; onPreview(enter: boolean): void; onSelect(): void; onOpen(id: string): void }
type AreaData = { box: Extract<CollaborationBox, { kind: 'area' }>; envelope: string; boundary: string; memberGeometry: readonly CollaborationBox[]; area: CollaborationArea; totalMembers: number; childCount: number; depth: number; folded: boolean; activity?: NodeActivity | undefined; internal: readonly CollaborationRelation[]; onInspect(): void; onLocate(): void; onToggle(anchor?: { x: number; y: number }): void }
type AgentNode = Node<AgentData, 'agent'>
type AreaNode = Node<AreaData, 'area'>
type GraphNode = AgentNode | AreaNode
type RelationPath = { id: string; label: string; title: string; detail: string; unconfirmed: boolean; route: CollaborationPath; sourceBox: CollaborationBox; targetBox: CollaborationBox; sourceRadius: number; targetRadius: number; sourcePointRadius: number; targetPointRadius: number; sourceDistant: boolean; targetDistant: boolean; relations: readonly CollaborationRelation[]; active: number; startedAt: number; count: number; weight: number; selected: boolean; emphasis: 'normal' | 'related' | 'muted' }
const emptyHandles: NodeHandle[] = [], emptyEdges: never[] = []
const sameItems = <T,>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((item, index) => item === right[index])
const colors = { communication: 'var(--green)', creation: 'var(--text-2)', supervision: 'var(--amber)' } as const
const MapMotionContext = createContext(true)
const TIER_LABELS = { active: 'Active', idle: 'Idle', closed: 'Closed', unknown: 'Unconfirmed' } as const
const MapReadingProxyContext = createContext<(element: HTMLSpanElement | null) => (() => void) | undefined>(() => undefined)
const AgentNodeView = memo(function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const { agent } = data, zoom = useStore(state => state.transform[2])
  const registerReadingProxy = useContext(MapReadingProxyContext), gate = useContext(PointerRestGateContext)
  const preferences = useContext(CollaborationMapPreferences)
  const lod = collaborationMapLod(zoom, preferences), overview = lod.identity === 0 || data.box.width <= 28 && data.box.height <= 28
  const root = useRef<HTMLDivElement>(null)
  const [focusedLayer, setFocusedLayer] = useState<'identity' | 'detail' | null>(null)
  const readingLayer = useSyncExternalStore(agentInformationPreview.subscribe, () => {
    const request = agentInformationPreview.getAll().find(request => root.current?.contains(request.anchor))
    return request?.anchor.closest<HTMLElement>('[data-map-layer]')?.dataset.mapLayer as 'identity' | 'detail' | undefined
  })
  const label = collaborationAgentName(agent)
  const tier = agent.tier ?? (agent.context ? 'active' : 'unknown')
  const detail = agent.context && collaborationCardSlot(data.box) ? lod.detail : 0
  const contentInk = collaborationMapContentInk(detail)
  const projectedLayer = contentInk.detail > 0 ? 'detail' : 'identity', heldLayer = readingLayer ?? focusedLayer, owner = heldLayer ?? projectedLayer
  const identityOpacity = heldLayer ? Number(owner === 'identity') : contentInk.identity
  const detailOpacity = heldLayer ? Number(owner === 'detail') : contentInk.detail
  const focusProxy = Boolean(heldLayer) && owner === 'detail' && detail < .5
  const glyph = collaborationAgentGlyph(agent, data.step)
  const hull = collaborationVisibleHull(data.box, zoom, glyph.overviewRadius, glyph.pointRadius, preferences, glyph.distant), markScale = collaborationOverviewScale(data.box, zoom, glyph.overviewRadius * 2, glyph.distant)
  // Names align on the largest disc so a recency step never shifts the column.
  const identityInk = collaborationIdentityInk(hull.width, zoom, lod.identity, markScale, COLLABORATION_OVERVIEW_MARK_SIZE / 2)
  return <div ref={root} className={`collaboration-agent collaboration-agent--${tier}${detail < 1 ? ' collaboration-agent--overview' : ''} nodrag`} data-collaboration-agent={agent.id} data-recency={data.step} data-overview={overview || undefined} data-reading={Boolean(readingLayer) || undefined}
    style={{ ...collaborationMapTextBudget(zoom), '--collaboration-mark-scale': markScale, '--collaboration-identity': lod.identity, '--collaboration-detail': detail, '--collaboration-avatar-center': `${identityInk.avatarCenter}px` } as CSSProperties}
    onPointerEnter={event => gate.enter(event.currentTarget, () => data.onPreview(true))} onPointerLeave={event => { gate.leave(event.currentTarget); data.onPreview(false) }} onFocusCapture={event => { data.onPreview(true); setFocusedLayer((event.target as HTMLElement).closest<HTMLElement>('[data-map-layer]')?.dataset.mapLayer as 'identity' | 'detail' ?? null) }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocusedLayer(null); data.onPreview(false) } }}>
    <div className="collaboration-agent__body" data-selected={data.selected || undefined} style={{ left: hull.x - data.box.x, top: hull.y - data.box.y, width: hull.width, height: hull.height, borderRadius: hull.radius }}>
      <div className="collaboration-agent__identity-layer" data-map-layer="identity" inert={owner !== 'identity'} aria-hidden={owner !== 'identity'} style={{ opacity: identityOpacity, '--collaboration-mark-scale': markScale } as CSSProperties}>
        <AgentMark data={data} label={label} tier={tier} glyph={glyph} overview={overview} identityProgress={lod.identity} markScale={markScale} identityInk={identityInk} status={lod.status} />
      </div>
      {agent.context && (detail > 0 || owner === 'detail') ? <div className="collaboration-agent__detail-layer" data-map-layer="detail" data-focus-proxy={focusProxy || undefined} inert={owner !== 'detail'} aria-hidden={owner !== 'detail'} style={{ opacity: detailOpacity }}>
        <FocusContextCardBody context={agent.context} identity={data.identity} goalLinks={data.goals} disclosure={{ status: lod.status, summary: lod.summary }} selected={data.selected} onSelect={data.onSelect} onOpenWorkface={data.onOpen} />
      </div> : null}
    </div>
    {focusProxy ? <span ref={registerReadingProxy} className="collaboration-agent__focus-proxy" aria-hidden="true" style={{ left: data.box.width / 2, top: hull.y - data.box.y - 8 / zoom, transform: `scale(${1 / zoom}) translate(-50%, -100%)` }}><strong>{label}</strong><kbd>↓ Read</kbd></span> : null}
    {data.activity ? <ActivityMark activity={data.activity} style={{ left: hull.x - data.box.x + hull.width / 2, top: hull.y - data.box.y + hull.height / 2, width: hull.width, height: hull.height, borderRadius: hull.radius }} /> : null}
  </div>
})
/** The local route or layout failure, as a compact corner service window. It collapses to a
 * count that stays visible; it cannot be closed while lines are missing, and a successful
 * retry removes it because its issues clear. */
function CollaborationLayoutNotice({ issues, onRetry }: { issues: ReadonlyMap<string, string>; onRetry(): void }) {
  const [collapsed, setCollapsed] = useState(false), layout = issues.has('layout')
  const summary = layout ? 'Layout needs attention. Original Agents and records are retained.'
    : `${issues.size} ${issues.size === 1 ? 'connection could' : 'connections could'} not be drawn. Original records remain readable.`
  const count = layout ? 'Layout issue' : `${issues.size} not drawn`
  return <div className="collaboration-canvas__issue" role="status" data-collapsed={collapsed || undefined}>
    {collapsed ? <button type="button" className="collaboration-canvas__issue-chip" aria-expanded={false} aria-label={summary} title={summary} onClick={() => setCollapsed(false)}><SemanticIcon name="status.warning" size={12} /><span>{count}</span></button> : <>
      <span>{summary}</span>
      <span className="collaboration-canvas__issue-actions"><button type="button" onClick={onRetry}>Retry layout</button>
        <button type="button" className="icon-button" aria-label="Collapse layout notice" aria-expanded title="Collapse" onClick={() => setCollapsed(true)}><SemanticIcon name="action.collapse" size={12} /></button></span>
      <details><summary>Details</summary>{[...issues].map(([id, message]) => <p key={id}>{message}</p>)}</details>
    </>}
  </div>
}
function ActivityMark({ activity, style }: { activity: NodeActivity; style: CSSProperties }) {
  const { pulse, direction } = activity, motion = useContext(MapMotionContext)
  const label = pulse.kind === 'communication' ? `Observed message activity · ${direction === 'sent' ? 'source' : 'destination'}` : 'Dispatch updated'
  const delay = useMemo(() => Math.min(0, pulse.startedAt - Date.now()), [pulse.id, pulse.startedAt, motion])
  return <span key={pulse.id} className="collaboration-activity" data-kind={pulse.kind} data-direction={pulse.kind === 'communication' ? direction : 'updated'} aria-label={label} title={label}
    style={{ ...style, '--collaboration-transfer-delay': `${delay}ms`, '--collaboration-transfer-duration': `${COLLABORATION_TRANSFER_MS}ms` } as CSSProperties}><span /></span>
}
/** One identity mark across scales: old distant points reveal the original Executor face.
 * Runnable members sit on a disc; confirmed-closed members drop it and recede. */
function AgentMark({ data, label, tier, glyph, overview = false, identityProgress = 1, markScale = 1, identityInk, status = 0 }: { data: AgentData; label: string; tier: string; glyph: ReturnType<typeof collaborationAgentGlyph>; overview?: boolean; identityProgress?: number; markScale?: number; identityInk: ReturnType<typeof collaborationIdentityInk>; status?: number }) {
  const context = data.agent.context, { config } = useContext(ExecutorIdentityContext), zoom = useStore(state => state.transform[2])
  const providerId = data.agent.providerId ?? context?.providerId ?? undefined, executorId = data.agent.executorId ?? context?.executorId
  const appearance = executorId ? config?.executors[executorId]?.avatar ?? config?.appearance.agentAvatars?.[executorId] : undefined
  const preview = useAgentInformationPreview(context, true, data.identity, data.goals, () => { if (context) data.onOpen(context.id) })
  const diameter = glyph.overviewRadius * 2, faceInk = glyph.distant ? collaborationDistantFaceInk(zoom) : 1
  return <button type="button" ref={preview.anchor} {...preview.triggerEvents} className={overview ? "collaboration-agent__dot" : "collaboration-agent__mark"} data-tier={tier} data-distant={faceInk < 1 || undefined} data-session-id={context?.id} style={{ ...(overview ? { width: diameter, height: diameter } : {}), '--collaboration-hit-size': `${24 / (zoom * markScale)}px` } as CSSProperties}
    aria-pressed={data.selected} aria-label={`${label} · ${tier}`} aria-describedby={preview.describedBy} onClick={data.onSelect} title={`${TIER_LABELS[tier as keyof typeof TIER_LABELS] ?? tier} · ${collaborationRecencyLabel(data.agent)}`}>
    <span className="collaboration-agent__avatar" style={{ '--collaboration-avatar-scale': markScale + (1 - markScale) * identityProgress } as CSSProperties}>
      <span aria-hidden="true" className="collaboration-agent__far-point" style={{ opacity: 1 - faceInk, width: diameter, height: diameter }} />
      <span className="collaboration-agent__face" style={{ opacity: faceInk }}><ResolvedAgentAvatar label={label} providerId={providerId} executorId={executorId} appearance={appearance} size={glyph.icon} tintMark={!glyph.closed} />
      {tier === 'active' || tier === 'unknown' ? <span className="collaboration-agent__point" /> : null}
      {context ? <CollaborationEssentialState context={context} /> : null}</span>
    </span>{!overview && tier !== 'closed' ? <strong style={{ left: identityInk.nameLeft, opacity: identityInk.opacity, fontSize: identityInk.fontSize, transform: status > 0 ? `translateY(${-7 * status}px)` : undefined }}>{label}</strong> : null}
    {context && !overview ? <CollaborationCompactState context={context} progress={status} left={identityInk.nameLeft} opacity={identityInk.opacity} zoom={zoom} /> : null}
  </button>
}
const AreaNodeView = memo(function AreaNodeView({ data }: NodeProps<AreaNode>) {
  const empty = data.memberGeometry.length === 0
  const overview = useStore(state => state.transform[2] < COLLABORATION_OVERVIEW_ZOOM)
  const focus = useContext(CollaborationFocusRegions), recede = focus !== null && !focus.has(data.area.id)
  return <div className="collaboration-area" data-kind={data.area.kind} data-depth={data.depth} data-folded={data.folded} data-empty={empty || undefined} data-overview={overview || undefined} data-recede={recede || undefined}>
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
  const preferences = useAppStore(state => resolveFocusMapPreferences(state.config?.focus?.map)), settings = useContext(SettingsNavigation)
  const motion = useCollaborationMotion(active), hud = useRef<HTMLDivElement>(null), contextControl = useRef<HTMLButtonElement>(null)
  const now = useCollaborationRecencyClock(active)
  const steps = useMemo(() => new Map([...agents].map(([id, agent]) => [id, collaborationRecencyStep(agent, now)])), [agents, now])
  const [readingProxies, setReadingProxies] = useState<readonly HTMLSpanElement[]>([])
  /** The camera is moving: a direct gesture or an animated move. Pointer entries wait for its
   * rest, and region names keep their slot. One gate, read by every hover owner on the Map. */
  const [gate] = useState(createPointerRestGate)
  const registerReadingProxy = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return
    setReadingProxies(previous => previous.includes(element) ? previous : [...previous, element])
    return () => setReadingProxies(previous => previous.filter(proxy => proxy !== element))
  }, [])
  const [areaLocate, setAreaLocate] = useState<{ source: CollaborationLocate | undefined; request: CollaborationLocate }>()
  const effectiveLocate = areaLocate && areaLocate.source === locate ? areaLocate.request : locate
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const flow = useRef<ReactFlowInstance<GraphNode> | null>(null)
  const cameraAnimation = useRef<object | null>(null)
  const animateCamera = (move: (duration: number) => Promise<boolean> | undefined) => {
    const duration = collaborationCameraDuration(motion.enabled), token = {}
    if (duration) { cameraAnimation.current = token; gate.begin('camera-animation') }
    void move(duration)?.finally(() => { if (cameraAnimation.current === token) { cameraAnimation.current = null; gate.end('camera-animation') } })
  }
  useEffect(() => {
    if ((!active || !motion.enabled) && cameraAnimation.current && flow.current) {
      cameraAnimation.current = null; gate.end('camera-animation')
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
  // Occurrence geometry is a reading choice, not live Agent state. Re-admit
  // sizes only for new occurrences or the user's explicit Arrange action.
  const slotSizes = useRef(new Map<string, { width: number; height: number }>())
  const [slotRevision, setSlotRevision] = useState(0)
  const input = useMemo<CollaborationLayoutInput>(() => ({
    areas: worldAreas.map(area => ({ id: collaborationAreaNode(area.id), name: area.name, parentId: area.parentId ? collaborationAreaNode(area.parentId) : null, members: area.members.map(id => collaborationAgentNode(area.id, id)), folded: folded.has(area.id) })),
    nodes: worldAreas.flatMap(area => area.members.flatMap(id => {
      const agent = agents.get(id); if (!agent) return []
      const nodeId = collaborationAgentNode(area.id, id)
      const knownTime = agent.lastActivityAt != null && Number.isFinite(agent.lastActivityAt) && agent.lastActivityAt > 0
      const size = slotSizes.current.get(nodeId) ?? collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown'), knownTime ? steps.get(id) : undefined)
      slotSizes.current.set(nodeId, size)
      return [{ id: nodeId, areaId: collaborationAreaNode(area.id), ...size }]
    })),
    connections: allConnections.map(connection => ({ id: connection.id, source: connection.source, target: connection.target, kind: connection.relations[0]!.kind, strength: collaborationConnectionStrength(connection) }))
  }), [worldAreas, agents, allConnections, folded, slotRevision, steps])
  useEffect(() => {
    const retained = new Set(input.nodes.map(node => node.id))
    for (const id of slotSizes.current.keys()) if (!retained.has(id)) slotSizes.current.delete(id)
  }, [input.nodes])
  const layout = useCollaborationLayout(input, active, readingAnchor, motion.enabled), geometry = layout.boxes
  useEffect(() => { if (locate) layout.settle() }, [locate?.token, layout.settle])
  const activity = useMemo(() => {
    const result = new Map<string, NodeActivity>()
    for (const pulse of pulses) {
      result.set(collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.sender }), { pulse, direction: 'sent' })
      result.set(collaborationSubjectKey({ hostId: pulse.hostId, agentSessionId: pulse.recipient }), { pulse, direction: 'received' })
    }
    return result
  }, [pulses])
  const actions = useRef({ onSelect, onOpen, onPreviewAgent, agents, presentation, locate, settle: layout.settle }); actions.current = { onSelect, onOpen, onPreviewAgent, agents, presentation, locate, settle: layout.settle }
  const gestures = useRef(0)
  // xyflow defers a gesture's end by 150ms under panOnScroll and does not cancel it when the
  // next gesture starts, so an end older than the latest start belongs to an earlier gesture.
  const gestureStart = useRef(-Infinity)
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (!event) return
    layout.settle(); ++gestures.current; gestureStart.current = event.timeStamp
    if (cameraAnimation.current) { cameraAnimation.current = null; gate.end('camera-animation') }
    gate.begin('gesture')
  }, [layout.settle, gate])
  const onMoveEnd = useCallback((event: MouseEvent | TouchEvent | null) => { if (event && event.timeStamp >= gestureStart.current) gate.end('gesture') }, [gate])
  // The canvas carries the motion fact for hover styling without a React render.
  const canvas = useRef<HTMLDivElement>(null)
  useEffect(() => gate.subscribe(() => { canvas.current?.toggleAttribute('data-camera-moving', gate.moving()) }), [gate])
  useEffect(() => {
    const pending = foldAnchor.current
    if (!pending) return
    if (!active || pending.gesture !== gestures.current || pending.source !== locate) { foldAnchor.current = null; return }
    const box = geometry.get(pending.id)
    if (box?.kind !== 'area' || box.folded !== pending.folded || !flow.current || layout.busy) return
    // A clamped screen label is the user's reading occurrence. Keep that
    // occurrence when its original world heading was outside the viewport.
    const window = canvas.current?.ownerDocument.defaultView ?? globalThis.window
    // Let the original label's ResizeObserver finish measuring a newly shown
    // internal-connection row before aligning its stable identity/action row.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        if (foldAnchor.current !== pending || pending.gesture !== gestures.current || pending.source !== locate || !flow.current) return
        foldAnchor.current = null
        const viewport = flow.current.getViewport(), { zoom } = viewport
        const label = [...canvas.current?.querySelectorAll<HTMLElement>('.collaboration-area__overview-label') ?? []].find(label => label.dataset.areaId === pending.id)
        const bounds = label?.getBoundingClientRect(), summary = label?.querySelector('.collaboration-area__summary')?.getBoundingClientRect(), surface = canvas.current?.getBoundingClientRect()
        // Screen labels can have a collision-avoidance offset from their world
        // heading. Adding that offset again would walk the label sideways.
        void flow.current.setViewport(bounds?.width && summary?.height && surface?.width && surface.height
          ? { zoom,
            x: Math.abs(pending.x - (bounds.left - surface.left)) <= .75 ? viewport.x : pending.x - (box.x + box.heading.x) * zoom,
            y: Math.abs(pending.y - (summary.bottom - surface.top)) <= .75 ? viewport.y : pending.y - (box.y + box.heading.y + box.heading.height) * zoom }
          : { zoom, x: pending.x - (box.x + box.heading.x) * zoom, y: pending.y - (box.y + box.heading.y + box.heading.height) * zoom })
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [geometry, locate, active, layout.busy])

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
      const childCount = hierarchy.children.get(area.id)?.length ?? 0
      const sameGeometry = old && sameItems(old.memberGeometry, memberGeometry)
      const envelope = old?.box === box && sameGeometry && old.boundary === preferences.boundary ? old.envelope : collaborationEnvelope(box, memberGeometry, preferences.boundary)
      const areaNode: AreaNode = old?.box === box && old.envelope === envelope && sameGeometry && old.area === area && old.totalMembers === totalMembers && old.childCount === childCount && old.depth === depth && old.activity === live && sameItems(old.internal, internal) ? previous as AreaNode : {
        id: areaId, type: 'area', position: { x: box.x, y: box.y }, width: box.width, height: box.height, measured: { width: box.width, height: box.height }, handles: emptyHandles,
        style: { width: box.width, height: box.height, zIndex: depth }, selectable: false, draggable: false,
        data: { box, envelope, boundary: preferences.boundary, memberGeometry, area, totalMembers, childCount, depth, folded: box.folded, internal, activity: live,
          onLocate: old?.onLocate ?? (() => {
            actions.current.settle()
            foldAnchor.current = null
            setFolded(previous => { if (!previous.has(area.id)) return previous; const next = new Set(previous); next.delete(area.id); return next })
            setAreaLocate({ source: actions.current.locate, request: { token: {}, areaIds: [area.id] } })
          }),
          onInspect: old?.onInspect ?? (() => { const current = actions.current.presentation.internal.get(area.id) ?? []; if (current[0]) actions.current.onSelect({ kind: 'relation', id: current[0].id, relatedIds: current.map(relation => relation.id) }) }),
          onToggle: old?.onToggle ?? (anchor => {
            actions.current.settle()
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
        const selected = selection?.kind === 'agent' && selection.id === id, live = activity.get(id), step = steps.get(id) ?? 'older'
        const node: AgentNode = old?.box === card && previous?.position.x === card.x - box.x && previous.position.y === card.y - box.y && old.agent === agent && old.step === step && old.selected === selected && old.identity === identity && old.goals === links && old.activity === live ? previous as AgentNode : {
          id: nodeId, type: 'agent', parentId: areaId, position: { x: card.x - box.x, y: card.y - box.y }, width: card.width, height: card.height,
          measured: { width: card.width, height: card.height }, handles: emptyHandles, style: { width: card.width, height: card.height, pointerEvents: 'none' }, draggable: false, selectable: false,
          data: { box: card, agent, step, selected, identity, goals: links, activity: live,
            onPreview: old?.onPreview ?? (enter => { if (enter) { actions.current.settle(); readingAnchor.current = nodeId } actions.current.onPreviewAgent?.(enter ? id : null) }),
            onSelect: old?.onSelect ?? (() => { actions.current.settle(); readingAnchor.current = nodeId; actions.current.onSelect({ kind: 'agent', id }) }),
            onOpen: old?.onOpen ?? (() => { const context = actions.current.agents.get(id)?.context; if (context) actions.current.onOpen(context) }) }
        }
        next.push(node); cache.set(nodeId, node)
      }
    }
    nodeCache.current = cache
    if (!sameItems(heldNodes.current, next)) heldNodes.current = next
    return heldNodes.current
  }, [hierarchy, graphAreas, geometry, agents, steps, presentation, selection, identities, goals, activity, preferences.boundary])
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
      const sourceGlyph = collaborationAgentGlyph(fromAgent, steps.get(first.source) ?? 'older'), targetGlyph = collaborationAgentGlyph(toAgent, steps.get(first.target) ?? 'older')
      const sourceRadius = sourceGlyph.overviewRadius, targetRadius = targetGlyph.overviewRadius
      const sourcePointRadius = sourceGlyph.pointRadius, targetPointRadius = targetGlyph.pointRadius
      const count = connection.relations.reduce((count, relation) => count + relation.evidence.length, 0)
      // The same saturated strength the layout uses: one message reads 0, sixteen or more read 1.
      const weight = Math.min(1, Math.log2(collaborationConnectionStrength(connection)) / 4)
      const { title, unconfirmed } = old && sameItems(old.relations, connection.relations) ? old
        : collaborationRelationSummary(first.kind, first.kind === 'creation' ? connection.relations.flatMap(relation => relation.evidence) : [])
      const detail = `${from} → ${to} · ${count} original ${count === 1 ? 'record' : 'records'}`
      const label = `${title}: ${detail}`
      const path: RelationPath = old?.route === route && old.sourceBox === sourceBox && old.targetBox === targetBox && old.label === label && old.sourceRadius === sourceRadius && old.targetRadius === targetRadius && old.sourcePointRadius === sourcePointRadius && old.targetPointRadius === targetPointRadius && old.sourceDistant === sourceGlyph.distant && old.targetDistant === targetGlyph.distant && old.active === (pulse?.id ?? 0) && old.weight === weight && old.selected === selected && old.emphasis === emphasis && sameItems(old.relations, connection.relations) ? old : {
        id: connection.id, label, title, detail, unconfirmed, route, sourceBox, targetBox, sourceRadius, targetRadius, sourcePointRadius, targetPointRadius, sourceDistant: sourceGlyph.distant, targetDistant: targetGlyph.distant, relations: connection.relations, active: pulse?.id ?? 0, startedAt: pulse?.startedAt ?? 0, selected, emphasis,
        count, weight
      }
      next.set(connection.id, { path }); return [path]
    })
    routeCache.current = next
    if (!sameItems(heldPaths.current, paths)) heldPaths.current = paths
    return heldPaths.current
  }, [allConnections, layout.paths, geometry, pulses, selection, agents, steps, areaNames, peeked])
  /** Arrow keys pan a share of the viewport, +/- zoom about its centre, Shift+1 shows the whole
   * map. Only the canvas itself takes these keys; a focused control, search or Reader keeps them. */
  const keyboardCamera = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const instance = flow.current
    if (event.target !== event.currentTarget || !instance || event.metaKey || event.ctrlKey || event.altKey) return
    const { x, y, zoom } = instance.getViewport(), bounds = event.currentTarget.getBoundingClientRect()
    const share = event.shiftKey ? .5 : .15, step = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key]
    let move: ((duration: number) => Promise<boolean> | undefined) | undefined
    if (step) move = duration => instance.setViewport({ x: x + step[0]! * bounds.width * share, y: y + step[1]! * bounds.height * share, zoom }, { duration })
    else if (event.key === '+' || event.key === '=') move = duration => instance.zoomIn({ duration })
    else if (event.key === '-' || event.key === '_') move = duration => instance.zoomOut({ duration })
    else if (event.key === '!' || event.shiftKey && event.code === 'Digit1') move = duration => instance.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true, duration })
    if (!move) return
    event.preventDefault(); layout.settle(); ++gestures.current; animateCamera(move)
  }
  const selectConnection = useCallback((path: RelationPath) => { const first = path.relations[0]; if (first) actions.current.onSelect({ kind: 'relation', id: first.id, relatedIds: path.relations.map(relation => relation.id) }) }, [])
  const clearSelection = useCallback(() => actions.current.onSelect(null), [])
  const areaNodes = useMemo(() => nodes.filter((node): node is AreaNode => node.type === 'area'), [nodes])
  // A selected or previewed Agent keeps its own regions, its direct peers' regions and their
  // ancestors present; every other region recedes. Members, relations and controls remain.
  const focusAgent = selection?.kind === 'agent' ? selection.id : selection ? null : peeked ?? null
  const focusRegions = useMemo(() => {
    if (!focusAgent) return null
    const peers = new Set([focusAgent, ...relations.flatMap(relation => relation.source === focusAgent ? [relation.target] : relation.target === focusAgent ? [relation.source] : [])])
    const kept = new Set<string>()
    for (const [id, members] of hierarchy.members) if ([...peers].some(peer => members.includes(peer))) for (const owner of [id, ...hierarchy.ancestors.get(id) ?? []]) kept.add(owner)
    return kept
  }, [focusAgent, relations, hierarchy])
  return <CollaborationMapPreferences.Provider value={preferences}><MapReadingProxyContext.Provider value={registerReadingProxy}><MapMotionContext.Provider value={motion.enabled}><CollaborationFocusRegions.Provider value={focusRegions}><PointerRestGateContext.Provider value={gate}><div ref={canvas} className="collaboration-canvas" data-motion={motion.enabled ? 'on' : 'off'} style={{ '--collaboration-activity-duration': `${COLLABORATION_ACTIVITY_MS}ms` } as CSSProperties} aria-label="Agent collaboration graph"
    tabIndex={0} aria-roledescription="map" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - Shift+1" onKeyDown={keyboardCamera}>
    <ReactFlow<GraphNode> nodes={nodes} edges={emptyEdges} nodeTypes={nodeTypes} onInit={instance => { flow.current = instance }} onPaneClick={clearSelection}
      onMoveStart={onMoveStart} onMoveEnd={onMoveEnd}
      panOnScroll panOnScrollSpeed={1} paneClickDistance={4} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.05} maxZoom={1.4} proOptions={{ hideAttribution: true }}>
      <CollaborationMapGround />
      <CollaborationViewport canvas={canvas} ready={ready && active && !(areaLocate && areaLocate.request === effectiveLocate && effectiveLocate.areaIds?.some(id => geometry.get(collaborationAreaNode(id))?.folded))} geometry={geometry} areas={graphAreas} agents={agents} locate={effectiveLocate} gestures={gestures} readingAnchor={readingAnchor} cameraAnimation={cameraAnimation} gate={gate} onVisibleAgents={onVisibleAgents} /><CollaborationRelations paths={paths} active={active} onSelect={selectConnection} onClear={clearSelection} /><CollaborationRegionLabels areas={areaNodes} geometry={geometry} active={active} selectedAgent={selection?.kind === 'agent' ? selection.id : effectiveLocate?.agentId} locatedAreas={effectiveLocate?.areaIds} hud={hud} contextControl={context ? contextControl : null} readingProxies={readingProxies} />
    </ReactFlow>
    {context ? <button ref={contextControl} type="button" className="collaboration-map__locate" title="Locate original context" onClick={context.onLocate}><SemanticIcon name="action.locate" size={14} /><span>{context.name}</span></button> : null}
    <div ref={hud} className="collaboration-canvas__hud">{layout.issues.size ? <CollaborationLayoutNotice issues={layout.issues} onRetry={layout.retry} /> : null}<div className="collaboration-canvas__controls" aria-label="Graph viewport">
      {settings ? <button type="button" className="icon-button" aria-label="Map settings" title="Boundary and zoom levels" onClick={() => settings.open('focus', undefined, 'map')}><SemanticIcon name="object.settings" size={14} /></button> : null}
      <button type="button" className="collaboration-canvas__motion" aria-label="Map animations" aria-pressed={motion.enabled} aria-busy={motion.saving || undefined} disabled={motion.saving} title={`Map animations: ${motion.enabled ? 'on' : 'off'}${motion.preference === 'system' ? ' · Following system' : ''}. Messages continue updating.`} onClick={() => void motion.setEnabled(!motion.enabled)}><span className="collaboration-canvas__motion-switch" aria-hidden="true" /><span>Motion</span><strong>{motion.enabled ? 'On' : 'Off'}</strong></button>
      <span className="collaboration-canvas__divider" aria-hidden="true" />
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => { layout.settle(); ++gestures.current; animateCamera(duration => flow.current?.zoomOut({ duration })) }}><SemanticIcon name="action.zoom-out" size={14} /></button>
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => { layout.settle(); ++gestures.current; animateCamera(duration => flow.current?.zoomIn({ duration })) }}><SemanticIcon name="action.zoom-in" size={14} /></button>
      <button type="button" className="icon-button collaboration-canvas__arrange" aria-label="Arrange map" title="Reorganize using current activity and observed relationships. Positions stay fixed between structural changes and explicit arrangement." onClick={() => { slotSizes.current.clear(); setSlotRevision(value => value + 1); layout.arrange() }}><SemanticIcon name="object.topology" size={14} /><span>Arrange</span></button>
      <button type="button" className="icon-button" aria-label="Overview" title="Show the whole map" onClick={() => { layout.settle(); ++gestures.current; animateCamera(duration => flow.current?.fitView({ padding: .1, maxZoom: 1, includeHiddenNodes: true, duration })) }}><SemanticIcon name="layout.expand" size={14} /></button>
    </div>
    {motion.issue ? <p className="collaboration-canvas__motion-issue" role="status">{motion.issue}</p> : null}
    <div className="collaboration-canvas__legend" aria-label="Map legend"><div aria-label="Agent states">{(['active', 'idle', 'closed', 'unknown'] as const).map(tier => <span key={tier}><i className="collaboration-node-key" data-tier={tier} aria-hidden="true"><ResolvedAgentAvatar label="" size={11} tintMark={false} /></i>{TIER_LABELS[tier]}</span>)}</div><div aria-label="Recency"><span><i className="collaboration-recency-key" aria-hidden="true">{([14, 11, 9] as const).map(size => <ResolvedAgentAvatar key={size} label="" size={size} tintMark={false} />)}</i>Recent → older</span></div><div aria-label="Relation legend">{Object.entries(COLLABORATION_LABELS).map(([kind, label]) => <span key={kind}><CollaborationRelationKey kind={kind as CollaborationRelation['kind']} />{label}</span>)}</div></div></div>
    {locate?.agentId && geometry.size > 0 && !graphAreas.some(area => area.members.includes(locate.agentId!)) ? <p className="collaboration-canvas__issue" role="status">The original Agent location is unconfirmed. Its identity and sources are retained.</p> : null}
    {!layout.issues.size && layout.busy ? <span className="collaboration-canvas__progress" role="status">{geometry.size ? 'Drawing connections…' : 'Arranging map…'}</span> : null}
    {!visibleIds.size ? <p className="collaboration-canvas__empty">No Agents in this map.</p> : null}
  </div></PointerRestGateContext.Provider></CollaborationFocusRegions.Provider></MapMotionContext.Provider></MapReadingProxyContext.Provider></CollaborationMapPreferences.Provider>
}

/** Only this small layer subscribes to camera bounds; xyflow owns its transform and nodes. */
const CollaborationRelations = memo(function CollaborationRelations({ paths, active, onSelect, onClear }: { paths: readonly RelationPath[]; active: boolean; onSelect(path: RelationPath): void; onClear(): void }) {
  const index = useMemo(() => new CollaborationBoundsIndex(paths.flatMap((path, order) =>
    [path.route.bounds, path.sourceBox, path.targetBox].map(box => ({ ...box, path, order })))), [paths])
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    const [x, y, zoom] = state.transform, padding = 32 / zoom
    const left = -x / zoom - padding, top = -y / zoom - padding, right = (state.width - x) / zoom + padding, bottom = (state.height - y) / zoom + padding
    const hits = index.query({ x: left, y: top, width: right - left, height: bottom - top })
    return [...new Map(hits.map(hit => [hit.order, hit.path])).entries()].sort(([a], [b]) => a - b).map(([, path]) => path)
  }, [index]), sameItems)
  const zoom = useStore(state => state.transform[2]), preferences = useContext(CollaborationMapPreferences)
  const markerId = useId().replace(/:/g, '')
  // At icon scale routes into one face clip to its small circle and their heads stack. One
  // ordinary inbound head per target and kind is drawn; the rest of that group are counted
  // beside it. Selected and emphasised routes always keep their own head.
  const iconScale = collaborationMapLod(zoom, preferences).identity === 0
  const heads = useMemo(() => {
    const result = new Map<string, number>()
    if (!iconScale) return result
    const groups = new Map<string, RelationPath[]>()
    for (const path of visible) {
      if (path.selected || path.emphasis === 'related' || path.targetBox.kind !== 'agent') continue
      const key = JSON.stringify([path.targetBox.id, path.relations[0]!.kind]), group = groups.get(key)
      if (group) group.push(path); else groups.set(key, [path])
    }
    for (const group of groups.values()) if (group.length > 1) {
      const [lead, ...rest] = [...group].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
      result.set(lead!.id, rest.length)
      for (const path of rest) result.set(path.id, -1)
    }
    return result
  }, [visible, iconScale])
  return <ViewportPortal><svg className="collaboration-connections" style={{ position: 'absolute', width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
    <defs>{Object.entries(colors).map(([kind, color]) => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 20 12" refX={19} refY={6} markerUnits="userSpaceOnUse" markerWidth={20 / zoom} markerHeight={12 / zoom} orient="auto-start-reverse" style={{ color }}><CollaborationRelationArrow kind={kind as CollaborationRelation['kind']} /></marker>)}</defs>
    {visible.map(path => <RelationView key={path.id} record={path} markerId={markerId} zoom={zoom} active={active} onSelect={onSelect} onClear={onClear} merged={heads.get(path.id) ?? 0} />)}
  </svg></ViewportPortal>
})
const RelationView = memo(function RelationView({ record, markerId, zoom, active, onSelect, onClear, merged = 0 }: { record: RelationPath; markerId: string; zoom: number; active: boolean; onSelect(path: RelationPath): void; onClear(): void
  /** 0 own head; -1 head drawn by the lead route into the same face; n > 0 lead with n more. */
  merged?: number }) {
  const kind = record.relations[0]!.kind, { labelX, labelY } = record.route, motion = useContext(MapMotionContext), gate = useContext(PointerRestGateContext)
  const tooltip = useWorkbenchNameTooltip(record.title, record.detail, !active, { placement: 'bottom', pointerPassThrough: true })
  const show = (event: { currentTarget: SVGGElement }) => {
    const anchor = event.currentTarget.querySelector<SVGPathElement>('.react-flow__edge-path')
    if (anchor) tooltip.showFor(anchor)
  }
  const latestShow = useRef(show); latestShow.current = show
  const preferences = useContext(CollaborationMapPreferences)
  // The clipped curve depends on zoom only through the two painted endpoint bodies, which hold
  // still across much of the zoom range; re-clip only when either body actually changes.
  const sourceHull = collaborationVisibleHull(record.sourceBox, zoom, record.sourceRadius, record.sourcePointRadius, preferences, record.sourceDistant)
  const targetHull = collaborationVisibleHull(record.targetBox, zoom, record.targetRadius, record.targetPointRadius, preferences, record.targetDistant)
  const hullKey = `${sourceHull.x},${sourceHull.y},${sourceHull.width},${sourceHull.height},${sourceHull.radius};${targetHull.x},${targetHull.y},${targetHull.width},${targetHull.height},${targetHull.radius}`
  const visibleRoute = useMemo(() => collaborationVisibleRoute(record.route, record.sourceBox, record.targetBox, zoom, record.sourceRadius, record.targetRadius, record.sourcePointRadius, record.targetPointRadius, preferences, record.sourceDistant, record.targetDistant),
    [record, hullKey, preferences])
  const { path, points } = visibleRoute
  const end = points.at(-1)
  let before = end
  for (let index = points.length - 2; end && index >= 0; index--) {
    const point = points[index]!
    if (point.x !== end.x || point.y !== end.y) { before = point; break }
  }
  const dx = end && before ? end.x - before.x : 0, dy = end && before ? end.y - before.y : 0, length = Math.hypot(dx, dy)
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const caption = end && length > 0 && (record.unconfirmed || zoom >= .7 || record.emphasis === 'related')
  const routeLength = useMemo(() => points.reduce((total, point, index) => index ? total + Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y) : 0, 0), [points])
  return <><g className={`react-flow__edge selectable collaboration-edge-group--${kind}`} data-id={record.id} data-emphasis={record.emphasis} data-recent={record.active ? true : undefined} tabIndex={0} role="button" aria-label={record.label} aria-pressed={record.selected} {...tooltip.props}
    style={{ pointerEvents: 'stroke', '--edge-weight': record.weight } as CSSProperties} onMouseEnter={event => { const group = event.currentTarget; gate.enter(group, () => latestShow.current({ currentTarget: group })) }} onMouseLeave={event => { gate.leave(event.currentTarget); if (!event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) tooltip.hide() }} onFocus={show} onClick={event => { event.stopPropagation(); onSelect(record) }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(record) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClear(); tooltip.hide() }
    }}>
    <BaseEdge id={record.id} path={path} {...merged < 0 ? {} : { markerEnd: `url(#${markerId}-${kind})` }} interactionWidth={22} className={`collaboration-edge collaboration-edge--${kind}${record.selected ? ' is-selected' : ''}`} />
    {record.active && motion && kind !== 'creation' ? <CollaborationDispatchSignal key={record.active} pulseId={record.active} startedAt={record.startedAt} path={path} length={routeLength} zoom={zoom} kind={kind} /> : null}
    {caption ? <EdgeLabelRenderer><span className="collaboration-edge__caption" data-creation-unconfirmed={record.unconfirmed} data-relation-id={record.id} aria-hidden="true"
      style={{ transform: `translate(${end.x - dx / length * 24 / zoom}px, ${end.y - dy / length * 24 / zoom}px) scale(${1 / zoom}) translate(${horizontal ? dx > 0 ? '-100%' : '0' : '-50%'}, ${horizontal ? 'calc(-100% - 5px)' : dy > 0 ? '-100%' : '0'})` }}>{record.title}</span></EdgeLabelRenderer> : null}
    {record.emphasis === 'related' && record.count > 1 && !record.selected && !tooltip.props['aria-describedby'] ? <EdgeLabelRenderer><span className="collaboration-edge__count" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{record.count}</span></EdgeLabelRenderer> : null}
    {merged > 0 && end ? <EdgeLabelRenderer><span className="collaboration-edge__merged" data-kind={kind} aria-hidden="true" style={{ transform: `translate(${end.x - (length ? dx / length : 0) * 26 / zoom}px, ${end.y - (length ? dy / length : 0) * 26 / zoom}px) scale(${1 / zoom}) translate(-50%, -50%)` }}>+{merged}</span></EdgeLabelRenderer> : null}
  </g>{tooltip.content}</>
})

function CollaborationViewport({ canvas, ready, geometry, areas, agents, locate, gestures, readingAnchor, cameraAnimation, gate, onVisibleAgents }: { canvas: RefObject<HTMLDivElement | null>; ready: boolean; geometry: ReadonlyMap<string, CollaborationBox>; areas: readonly CollaborationArea[]; agents: ReadonlyMap<string, CollaborationAgent>; locate?: CollaborationLocate | undefined; gestures: { current: number }; readingAnchor: { current: string | null }; cameraAnimation: { current: object | null }; gate: PointerRestGate; onVisibleAgents?: ((ids: readonly string[]) => void) | undefined }) {
  const flow = useReactFlow(), initialized = useRef(false), applied = useRef<object | undefined>(undefined), pending = useRef<{ token: object | undefined; gesture: number }>({ token: undefined, gesture: gestures.current })
  const motion = useContext(MapMotionContext), preferences = useContext(CollaborationMapPreferences)
  const width = useStore(state => state.width), height = useStore(state => state.height)
  const index = useMemo(() => new CollaborationBoundsIndex(areas.flatMap(area => area.members.flatMap(id => {
    const box = geometry.get(collaborationAgentNode(area.id, id)), agent = agents.get(id)
    const tier = agent?.tier ?? (agent?.context ? 'active' : 'unknown')
    return agent && tier === 'active' && box && collaborationCardSlot(box) ? [{ ...box, agentId: id }] : []
  }))), [geometry, areas, agents])
  const visible = useStore(useCallback((state: { transform: [number, number, number]; width: number; height: number }) => {
    if (!ready || !collaborationMapReadsSummary(state.transform[2], preferences)) return [] as string[]
    const [x, y, zoom] = state.transform, left = -x / zoom, top = -y / zoom, right = (state.width - x) / zoom, bottom = (state.height - y) / zoom
    return [...new Set(index.query({ x: left, y: top, width: right - left, height: bottom - top }).map(box => box.agentId))].sort()
  }, [index, ready, preferences]), sameItems)
  useEffect(() => { const timer = setTimeout(() => onVisibleAgents?.(visible), 120); return () => clearTimeout(timer) }, [visible, onVisibleAgents])
  if (pending.current.token !== locate?.token) pending.current = { token: locate?.token, gesture: gestures.current }
  useEffect(() => {
    if (!ready || !geometry.size || width <= 0 || height <= 0 || locate && applied.current === locate.token || !locate && initialized.current) return
    const gesture = pending.current.gesture
    const frame = requestAnimationFrame(() => {
      if (gestures.current !== gesture) { if (locate) applied.current = locate.token; initialized.current = true; return }
      // The inspector can resize the canvas before xyflow's ResizeObserver publishes it.
      // Read the actual host for this explicit intent; later ordinary resizes keep the camera.
      const bounds = canvas.current?.getBoundingClientRect()
      const viewportWidth = bounds?.width || width, viewportHeight = bounds?.height || height
      const target = collaborationCameraTarget(geometry, areas, agents, { width: viewportWidth, height: viewportHeight }, locate, preferences)
      if (!target) return
      if (target.anchor) readingAnchor.current = target.anchor
      const duration = collaborationCameraDuration(motion, !initialized.current), animation = {}
      if (duration) { cameraAnimation.current = animation; gate.begin('camera-animation') }
      void flow.setViewport({ x: viewportWidth / 2 - target.x * target.zoom, y: viewportHeight / 2 - target.y * target.zoom, zoom: target.zoom }, { duration }).finally(() => { if (cameraAnimation.current === animation) { cameraAnimation.current = null; gate.end('camera-animation') } })
      if (locate) applied.current = locate.token
      initialized.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [canvas, ready, geometry, locate, width, height, areas, agents, flow, readingAnchor, motion, cameraAnimation, gate, preferences])
  return null
}
