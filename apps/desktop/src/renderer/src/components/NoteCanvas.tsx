import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, applyNodeChanges, useStore, useUpdateNodeInternals, type Edge, type EdgeProps, type Node, type NodeProps, type NodeChange, type Viewport, type ReactFlowInstance } from '@xyflow/react'
import { NoteReader, type NoteLinkOpenRequest } from '@agentmux/client-ui/components/NoteReader'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { projectNoteBlocks, type NoteSource } from '@agentmux/client-ui/note/note-knowledge'
import { useNoteCanvasContent, type CanvasContent } from '../lib/use-note-canvas-content'
import { noteContentMatchesGraph, type NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { projectNoteCanvas, initialCanvasPositions, attachNoteCanvasRelationships, noteCanvasBlockHandle, type CanvasNote, type CanvasAttachedRelationship, type CanvasReference } from '../lib/note-canvas-model'
import type { NoteCanvasBlockPort } from '../lib/note-canvas-block-geometry'
import { useNoteCanvasBlockPorts } from '../lib/use-note-canvas-block-ports'
import type { CanvasLayoutInput } from '../lib/note-canvas-layout-engine'
import { noteCanvasScopeKey, type NoteCanvasScope } from '../lib/note-canvas-state'
import { useNoteCanvasLayout } from '../lib/use-note-canvas-layout'
import { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'
import { noteGraphReferenceKey, noteGraphReferenceLabel } from '../lib/note-graph-references'
import { NotebookDirectoryContextMenu, type NoteTalkHandler } from './NotebookDirectoryContextMenu'
import '@xyflow/react/dist/base.css'
import '../styles/note-canvas.css'

const FileIcon = semanticIconComponent('file.text'), BranchIcon = semanticIconComponent('object.branch')
const RefreshIcon = semanticIconComponent('action.refresh'), FitIcon = semanticIconComponent('layout.expand')
const ArrangeIcon = semanticIconComponent('layout.balance'), PlusIcon = semanticIconComponent('action.zoom-in'), MinusIcon = semanticIconComponent('action.zoom-out')
const FocusIcon = semanticIconComponent('action.focus')
const OpenIcon = semanticIconComponent('action.open-external'), CloseIcon = semanticIconComponent('action.close')
type OpenNote = (page: NotebookPage, blockId?: string) => void
type NoteNodeData = { content?: CanvasContent | undefined; documents: Parameters<typeof NoteReader>[0]['documents']; source?: NoteSource | undefined; onRead(id: string): void; onVisible(id: string, visible: boolean): void; item: CanvasNote; snapshot: NotebookGraphSnapshot; active: boolean; expanded: boolean; preview: boolean; blockIds: readonly string[]; onPorts(noteId: string, snapshot: NotebookGraphSnapshot, blockIds: readonly string[]): void; onOpen: OpenNote; onOpenLink(link: NoteLinkOpenRequest): void; onNeighbors(id: string): void; onPreview(id: string): void; onUnbound(id: string): void; refresh(): void }
type CanvasNode = Node<NoteNodeData, 'note'>
type CanvasEdge = Edge<{ relationship: CanvasAttachedRelationship; inspect(relationship: CanvasAttachedRelationship): void; offset: number; labelBaseline: number; sourceTitle: string; targetTitle: string }, 'relationship'>
const NO_BLOCK_IDS: readonly string[] = [], NO_PORTS: NoteCanvasBlockPort[] = []

function SavedBody({ item, snapshot, active, blockIds, source, content: result, documents, preview, onRead, onPorts, onOpen, onOpenLink, refresh }: Pick<NoteNodeData, 'item' | 'snapshot' | 'active' | 'blockIds' | 'source' | 'content' | 'documents' | 'preview' | 'onRead' | 'onOpen' | 'onOpenLink' | 'refresh'> & { onPorts(ports: NoteCanvasBlockPort[]): void }) {
  const body = useRef<HTMLDivElement>(null)
  const [all, showAll] = useState(false), [selected, setSelected] = useState<string | undefined>()
  const ready = result?.snapshot === snapshot ? result : null, content = ready?.value
  const ambiguous = snapshot.graph.duplicateNoteIds.includes(item.id)
  const confirmed = content?.status === 'read' && noteContentMatchesGraph(snapshot, content) && !ambiguous ? content : null
  const related = useMemo(() => source ? projectNoteBlocks(source, blockIds).rootBlockIds : NO_BLOCK_IDS, [source, blockIds])
  const shown = useMemo(() => all ? related : related.slice(0, 3), [related, all])
  const confirmedIds = useMemo(() => {
    if (!confirmed || !source) return NO_BLOCK_IDS
    if (preview) return blockIds
    const displayed = new Set(projectNoteBlocks(source, shown).shownBlockIds)
    return blockIds.filter(id => displayed.has(id))
  }, [confirmed, source, preview, blockIds, shown])
  useNoteCanvasBlockPorts(body, active && Boolean(confirmed), confirmedIds, onPorts)
  return <div className="note-canvas-saved-body"><div ref={body} className="note-canvas-body nodrag nopan nowheel" data-reading-mode={preview ? 'document' : 'related'} onDoubleClick={event => event.stopPropagation()}>
    {confirmed ? <><div className="note-canvas-saved-heading"><span>{preview ? 'Full saved note' : `${related.length} related block${related.length === 1 ? '' : 's'}`}</span><span>Saved original</span></div>
      <div className="note-canvas-reader" data-selected-block={selected} onClick={event => {
        const block = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-id]') : null
        if (block && block.closest('.mobile-note-body') === event.currentTarget.querySelector('.mobile-note-body')) setSelected(block.dataset.blockId)
      }}><NoteReader content={confirmed.content} path={confirmed.resource.path} workspaceId={confirmed.resource.workspaceId} revision={confirmed.revision} documents={documents} blockIds={preview ? undefined : shown} readReference={target => onRead(target.noteId)} onOpenLink={onOpenLink} /></div>
      {selected && item.page ? <button type="button" className="note-canvas-open-block" onClick={() => onOpen(item.page!, selected)}><OpenIcon size={12} />Open selected block</button> : null}</>
      : <div className="note-canvas-body-state" role="status">{ambiguous ? 'Multiple original files share this Note identity. Open the registered original or refresh to confirm the source.' : ready?.pending ? 'Reading related original blocks…' : !ready ? 'Automatic reading covers up to 6 notes in this saved graph. Read these related blocks to continue.' : content?.status === 'read' ? 'Saved snapshot changed. Refresh the graph to read the current original.' : ready.issue ?? (content && 'message' in content ? content.message : 'Original body is unconfirmed.')}
        {!ready?.pending && <button type="button" onClick={content?.status === 'read' ? refresh : () => onRead(item.id)}>{content?.status === 'read' ? 'Refresh graph' : 'Read related blocks'}</button>}
      </div>}
  </div>{confirmed && !preview && related.length > shown.length && <div className="note-canvas-reading-actions nodrag nopan"><button type="button" className="note-canvas-more" onClick={() => showAll(true)}>More {related.length - shown.length} related blocks</button></div>}</div>
}

function EndpointHandles({ kind, blockId }: { kind: 'page' | 'block'; blockId?: string }) {
  return <>{(['left', 'right'] as const).flatMap(side => (['in', 'out'] as const).map(direction => <Handle key={`${direction}-${side}`} id={blockId ? noteCanvasBlockHandle(blockId, direction, side) : `${kind}-${direction}-${side}`} type={direction === 'in' ? 'target' : 'source'} position={side === 'left' ? Position.Left : Position.Right} isConnectable={false} />))}</>
}

const NoteCard = memo(function NoteCard({ data, selected }: NodeProps<CanvasNode>) {
  const { item } = data
  const updateInternals = useUpdateNodeInternals()
  const [portState, setPortState] = useState<{ snapshot: NotebookGraphSnapshot; ports: NoteCanvasBlockPort[] } | null>(null)
  const inView = useStore(state => {
    const node = state.nodeLookup.get(item.id), [x, y, zoom] = state.transform
    if (!node || !state.width || !state.height) return false
    const point = node.internals.positionAbsolute, left = point.x * zoom + x, top = point.y * zoom + y
    return left < state.width && top < state.height && left + (node.measured.width ?? 288) * zoom > 0 && top + (node.measured.height ?? 180) * zoom > 0
  })
  useEffect(() => { data.onVisible(item.id, data.active && inView && data.blockIds.length > 0); return () => data.onVisible(item.id, false) }, [item.id, data.active, inView, data.blockIds.length, data.onVisible])
  const ports = data.active && portState?.snapshot === data.snapshot ? portState.ports : NO_PORTS
  const [mountedPorts, setMountedPorts] = useState<NoteCanvasBlockPort[]>([])
  const bounds = useStore(state => state.nodeLookup.get(item.id)?.internals.handleBounds)
  const usedHandles = useStore(state => JSON.stringify(state.edges.flatMap(edge => [
    ...edge.source === item.id && edge.sourceHandle ? [edge.sourceHandle] : [],
    ...edge.target === item.id && edge.targetHandle ? [edge.targetHandle] : [],
  ]).sort()))
  const reportPorts = useCallback((next: NoteCanvasBlockPort[]) => {
    setPortState(held => held?.snapshot === data.snapshot && held.ports.length === next.length && held.ports.every((port, index) => port.blockId === next[index]!.blockId && port.top === next[index]!.top) ? held : { snapshot: data.snapshot, ports: next })
  }, [item.id, data.snapshot, data.onPorts])
  useLayoutEffect(() => {
    const used = new Set<string>(JSON.parse(usedHandles)), visible = new Set(ports.map(port => port.blockId))
    setMountedPorts(held => {
      // Retire old DOM/bounds only after the real edge store has switched away from them.
      const keep = held.filter(port => visible.has(port.blockId) || (['left', 'right'] as const).some(side => (['in', 'out'] as const).some(direction => used.has(noteCanvasBlockHandle(port.blockId, direction, side)))))
      const next = [...new Map([...keep, ...ports].map(port => [port.blockId, port])).values()]
      return held.length === next.length && held.every((port, index) => port.blockId === next[index]!.blockId && port.top === next[index]!.top) ? held : next
    })
  }, [ports, usedHandles])
  useLayoutEffect(() => { updateInternals(item.id) }, [item.id, mountedPorts, updateInternals])
  useLayoutEffect(() => {
    // React Flow registers DOM handles in a later frame; publish only its confirmed registration.
    const registered = new Set([...bounds?.source ?? [], ...bounds?.target ?? []].map(handle => handle.id))
    const available = ports.filter(port => (['left', 'right'] as const).every(side => (['in', 'out'] as const).every(direction => registered.has(noteCanvasBlockHandle(port.blockId, direction, side)))))
    data.onPorts(item.id, data.snapshot, available.map(port => port.blockId))
  }, [ports, bounds, item.id, data.snapshot, data.onPorts])
  useLayoutEffect(() => () => data.onPorts(item.id, data.snapshot, NO_BLOCK_IDS), [item.id, data.snapshot, data.onPorts])
  return <article className="note-canvas-card" data-root={item.root} data-context={item.context} data-selected={selected} data-preview={data.preview}>
    <header className="note-canvas-drag note-canvas-endpoint" data-endpoint-kind="page"><EndpointHandles kind="page" /><span className="note-canvas-book"><FileIcon size={12} /><span title={item.notebook}>{item.notebook}</span>{item.context && <em>Related</em>}{item.unbound.length > 0 && <button type="button" className="note-canvas-unbound nodrag" aria-label={`Inspect ${item.unbound.length} unbound links in ${item.title}`} onClick={() => data.onUnbound(item.id)}>{item.unbound.length} unbound</button>}</span>
      {item.page ? <button type="button" className="note-canvas-title nodrag" data-note-id={item.id} title={item.title} onClick={() => data.onOpen(item.page!)}><span>{item.title}</span><OpenIcon size={12} /></button>
        : <strong className="note-canvas-title" title={item.id}>{item.title}</strong>}
      {!item.page || item.observation?.status !== 'read' ? <span className="note-canvas-note-state" title={item.observation && 'message' in item.observation ? item.observation.message : item.id}>{item.observation?.status ?? 'Target not observed'}</span> : null}
    </header>
    {item.page && (data.blockIds.length > 0 || data.preview) ? <SavedBody {...data} onPorts={reportPorts} /> : <p className="note-canvas-page-target">Page relationship · no specific block</p>}
    {mountedPorts.map(port => <div key={port.blockId} className="note-canvas-row-endpoint note-canvas-endpoint" data-port-block-id={port.blockId} title={`Original block: ${port.blockId}`} style={{ top: port.top, visibility: ports.some(visible => visible.blockId === port.blockId) ? 'visible' : 'hidden' }}><EndpointHandles kind="block" blockId={port.blockId} /></div>)}
    <div className="note-canvas-block-summary note-canvas-endpoint" data-endpoint-kind="block" title="Block endpoints are grouped here. Inspect a relationship to see its exact original blocks."><EndpointHandles kind="block" /><span>Blocks</span><span>Grouped endpoints</span></div>
    <div className="note-canvas-degrees" aria-label={`${item.incoming} incoming, ${item.outgoing} outgoing occurrences in the saved graph`} title="Saved links and references, including notes outside this view. Unmatched links count only as outgoing."><span>↓ {item.incoming} incoming</span><span>↑ {item.outgoing} outgoing</span></div>
    <footer className="nodrag"><button type="button" aria-expanded={data.preview} aria-label={`${data.preview ? 'Show related blocks' : 'Full note'}: ${item.title}`} onClick={() => { if (!data.content?.pending && (!data.content?.value || data.content.value.status !== 'read')) data.onRead(item.id); data.onPreview(item.id) }} disabled={!item.page}><FileIcon size={12} />{data.preview ? 'Related blocks' : 'Full note'}</button>
      <button type="button" aria-expanded={data.expanded} aria-label={`${data.expanded ? 'Collapse' : 'Expand'} relationships: ${item.title}`} onClick={() => data.onNeighbors(item.id)} disabled={!item.neighbors}><BranchIcon size={12} />{data.expanded ? 'Collapse' : 'Explore'}<small>{item.neighbors}</small></button>
    </footer>
  </article>
})

const RelationshipEdge = memo(function RelationshipEdge(props: EdgeProps<CanvasEdge>) {
  const { sourceX, sourceY, targetX, targetY, id, markerEnd, data } = props
  if (!data) return null
  const self = props.source === props.target, { relationship, offset } = data, loopOffset = Math.abs(offset)
  // One baseline per Note pair prevents different page/block handle heights from cancelling lane spacing.
  const midX = (sourceX + targetX) / 2, labelY = data.labelBaseline + (self ? -loopOffset : offset)
  const controlY = labelY * 4 / 3 - (sourceY + targetY) / 6
  const path = self ? `M ${sourceX},${sourceY} C ${sourceX + 100},${controlY} ${targetX - 100},${controlY} ${targetX},${targetY}`
    : `M ${sourceX},${sourceY} C ${midX},${controlY} ${midX},${controlY} ${targetX},${targetY}`
  const linked = relationship.kind !== 'hierarchy', count = relationship.references.length, noun = relationship.kind === 'embed' ? 'embed' : relationship.kind === 'link' ? 'link' : 'reference'
  const endpoints = `${relationship.sourceKind === 'block' ? 'Block' : 'Page'} → ${relationship.targetKind}`
  return <><BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} className={`note-canvas-edge-${relationship.kind}`} interactionWidth={20} />
    <EdgeLabelRenderer><button type="button" data-edge-id={id} data-source-note={relationship.source} data-target-note={relationship.target} data-source-kind={relationship.sourceKind} data-target-kind={relationship.targetKind} data-source-block={relationship.sourceBlockId} data-target-block={relationship.targetBlockId} data-source-attachment={relationship.sourceKind === 'page' ? 'page' : relationship.sourceBlockId ? 'block' : 'summary'} data-target-attachment={relationship.targetKind === 'page' ? 'page' : relationship.targetBlockId ? 'block' : 'summary'} data-source-handle={props.sourceHandleId} data-target-handle={props.targetHandleId} data-relationship-kind={relationship.kind} data-lane={offset} title={`${data.sourceTitle} → ${data.targetTitle} · ${endpoints}${relationship.sourceBlockId ? ` · From ${relationship.sourceBlockId}` : ''}${relationship.targetBlockId ? ` · To ${relationship.targetBlockId}` : ''}`} className={`note-canvas-edge-label nodrag nopan is-${relationship.kind}`} style={{ transform: `translate(-50%, -50%) translate(${midX}px,${labelY}px)` }}
      aria-label={linked ? `Inspect ${count} ${noun}${count === 1 ? '' : 's'}: ${endpoints}` : 'Inspect parent and subpage relationship: Page → page'} onClick={() => data.inspect(relationship)}><span>{linked ? `${count} ${noun}${count === 1 ? '' : 's'}` : 'Subpage'}</span><small>{endpoints}</small></button></EdgeLabelRenderer>
  </>
})
const nodeTypes = { note: NoteCard }, edgeTypes = { relationship: RelationshipEdge }

function ReferenceDetails({ reference, snapshot, onOpen }: { reference: CanvasReference; snapshot: NotebookGraphSnapshot; onOpen: OpenNote }) {
  const source = snapshot.catalog.pages[reference.source.noteId], target = reference.target
  const destination = target.kind === 'unbound' ? undefined : snapshot.catalog.pages[target.noteId]
  return <li><div><strong>{noteGraphReferenceLabel(reference)}</strong><span data-resolution={reference.resolution}>{reference.resolution === 'resolved' ? 'Confirmed' : reference.resolution}</span></div>
    {reference.query !== undefined ? <p className="note-canvas-reference-query"><strong>[[{reference.query}]]</strong><span>{reference.resolution === 'resolved' ? 'Matched in this snapshot. Open the source note to confirm a permanent target.' : 'Saved query kept. Choose an exact target in the source Note.'}</span></p> : null}
    <dl><dt>From block</dt><dd>{reference.source.blockId}</dd><dt>{target.kind === 'block' ? 'To block' : target.kind === 'page' ? 'To page' : 'Written query'}</dt><dd>{target.kind === 'block' ? target.blockId : target.kind === 'page' ? destination?.title ?? target.noteId : `[[${target.text}]]`}</dd></dl>
    <div className="note-canvas-inspector-actions">{source && <button type="button" onClick={() => onOpen(source, reference.source.blockId)}>Open source block</button>}
      {destination && target.kind !== 'unbound' ? <button type="button" onClick={() => onOpen(destination, reference.resolution === 'resolved' && target.kind === 'block' ? target.blockId : undefined)}>{reference.resolution === 'resolved' ? target.kind === 'page' ? 'Open target page' : 'Open target block' : 'Inspect registered original'}</button> : target.kind !== 'unbound' ? <span>Target is outside this directory</span> : null}</div>
    {target.kind === 'unbound' ? <p className="note-canvas-reference-issue">This written link has no confirmed target ({reference.resolution}). Open its source to select an exact page or block.</p>
      : reference.resolution !== 'resolved' && <p className="note-canvas-reference-issue">Target {reference.resolution}. The original reference is kept; inspecting the registered file does not confirm this target.</p>}
  </li>
}

export type NoteCanvasProps = { scope: NoteCanvasScope; active?: boolean; onOpen: OpenNote; onTalk?: NoteTalkHandler | undefined; seedNoteIds?: readonly string[] | undefined; expandOnFirstView?: boolean }
export function NoteCanvas(props: NoteCanvasProps) {
  // Scope owns a separate viewport and asynchronous lifetime; changing it never repurposes an old request.
  return <NoteCanvasSurface key={noteCanvasScopeKey(props.scope)} {...props} />
}
function NoteCanvasSurface({ scope, active = true, onOpen, onTalk, seedNoteIds, expandOnFirstView = true }: NoteCanvasProps) {
  const { snapshot, issue, stale, busy, refresh } = useNoteCanvasObservation(active)
  const seeds = useMemo(() => snapshot ? scope.kind === 'note' ? [scope.noteId] : seedNoteIds ?? Object.values(snapshot.catalog.pages).filter(page => page.notebookId === scope.notebookId && !page.archivedAt).map(page => page.noteId) : [], [snapshot, scope, seedNoteIds])
  // Only the first unfiltered view gets a default neighborhood. Saved collapse choices remain authoritative.
  const initialExpanded = useMemo(() => scope.kind === 'notebook' && expandOnFirstView ? seeds : [], [scope.kind, expandOnFirstView, seeds])
  const { layout, save, issue: storageIssue, retry } = useNoteCanvasLayout(scope, initialExpanded)
  const projection = useMemo(() => snapshot ? projectNoteCanvas(snapshot, scope, layout.expandedNoteIds, seedNoteIds) : { notes: [], relationships: [], unbound: [] }, [snapshot, scope, layout.expandedNoteIds, seedNoteIds])
  const linkNavigation = useNoteLinkNavigation(onOpen, snapshot?.catalog, active)
  const [nodes, setNodes] = useState<CanvasNode[]>([]), [flow, setFlow] = useState<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const [inspected, inspect] = useState<{ kind: 'relationship'; id: string; occurrences: readonly string[] } | { kind: 'unbound'; noteId: string } | null>(null), [layoutIssue, setLayoutIssue] = useState<string | null>(null), [arranging, setArranging] = useState(false), [arrangeAttempt, arrange] = useState(0)
  const inspectRelationship = useCallback((relationship: CanvasAttachedRelationship) => inspect({ kind: 'relationship', id: relationship.aggregateId, occurrences: relationship.references.map(noteGraphReferenceKey) }), [])
  const inspectUnbound = useCallback((noteId: string) => inspect({ kind: 'unbound', noteId }), [])
  const cancelArrangement = useRef<(() => void) | null>(null)
  const refs = useRef({ layout, save, nodes, projection }); refs.current = { layout, save, nodes, projection }
  const toggleNeighbors = useCallback((id: string) => { const { layout, save } = refs.current; save({ expandedNoteIds: layout.expandedNoteIds.includes(id) ? layout.expandedNoteIds.filter(value => value !== id) : [...layout.expandedNoteIds, id] }) }, [])
  const togglePreview = useCallback((id: string) => { const { layout, save } = refs.current; save({ previewNoteIds: layout.previewNoteIds.includes(id) ? layout.previewNoteIds.filter(value => value !== id) : [...layout.previewNoteIds, id] }) }, [])
  const expanded = useMemo(() => new Set(layout.expandedNoteIds), [layout.expandedNoteIds]), previews = useMemo(() => new Set(layout.previewNoteIds), [layout.previewNoteIds])
  const [visibleBlocks, setVisibleBlocks] = useState<Record<string, { snapshot: NotebookGraphSnapshot; ids: readonly string[] }>>({})
  const recordPorts = useCallback((noteId: string, observed: NotebookGraphSnapshot, ids: readonly string[]) => setVisibleBlocks(held => {
    const previous = held[noteId]
    return previous?.snapshot === observed && previous.ids.length === ids.length && previous.ids.every((id, index) => id === ids[index]) ? held : { ...held, [noteId]: { snapshot: observed, ids } }
  }), [])
  const requestedBlocks = useMemo(() => {
    const result = new Map<string, Set<string>>()
    const add = (noteId: string, blockId: string) => { const held = result.get(noteId) ?? new Set<string>(); held.add(blockId); result.set(noteId, held) }
    for (const relationship of projection.relationships) for (const reference of relationship.references) {
      add(reference.source.noteId, reference.source.blockId)
      if (reference.resolution === 'resolved' && reference.target.kind === 'block') add(reference.target.noteId, reference.target.blockId)
    }
    for (const reference of projection.unbound) add(reference.source.noteId, reference.source.blockId)
    return new Map([...result].map(([id, ids]) => [id, [...ids].sort()]))
  }, [projection.relationships, projection.unbound])
  const [visibleNotes, setVisibleNotes] = useState<readonly string[]>([])
  const reportVisibility = useCallback((id: string, visible: boolean) => setVisibleNotes(held => held.includes(id) === visible ? held : visible ? [...held, id] : held.filter(value => value !== id)), [])
  const priority = useMemo(() => {
    const edge = inspected?.kind === 'relationship' ? projection.relationships.find(edge => edge.id === inspected.id) : undefined
    return edge ? [edge.source, edge.target] : scope.kind === 'note' && visibleNotes.includes(scope.noteId) ? [scope.noteId] : NO_BLOCK_IDS
  }, [inspected, projection.relationships, scope, visibleNotes])
  const bodies = useNoteCanvasContent(snapshot, active, visibleNotes, priority)
  const attachedRelationships = useMemo(() => attachNoteCanvasRelationships(projection.relationships, new Map(Object.entries(visibleBlocks)
    .filter(([id, value]) => active && value.snapshot === snapshot && !snapshot?.graph.duplicateNoteIds.includes(id))
    .map(([id, value]) => [id, new Set(value.ids)]))), [projection.relationships, visibleBlocks, active, previews, snapshot])
  useEffect(() => {
    if (!snapshot) return
    setNodes(held => {
      const byId = new Map(held.map(node => [node.id, node])), positions = initialCanvasPositions(projection.notes.map(item => item.id), refs.current.layout.positions)
      return projection.notes.map(item => ({ ...byId.get(item.id), id: item.id, type: 'note', position: byId.get(item.id)?.position ?? positions[item.id]!, dragHandle: '.note-canvas-drag',
        data: { item, snapshot, active, content: bodies.results[item.id], source: bodies.knowledge.sources.find(source => source.note.noteId === item.id), documents: bodies.documents, onRead: bodies.request, onVisible: reportVisibility, expanded: expanded.has(item.id), preview: previews.has(item.id), blockIds: requestedBlocks.get(item.id) ?? NO_BLOCK_IDS, onPorts: recordPorts, onOpen, onOpenLink: linkNavigation.openLink, onNeighbors: toggleNeighbors, onPreview: togglePreview, onUnbound: inspectUnbound, refresh } }))
    })
  }, [projection, snapshot, active, expanded, previews, requestedBlocks, recordPorts, onOpen, linkNavigation.openLink, inspectUnbound, toggleNeighbors, togglePreview, refresh, bodies.results, bodies.knowledge, bodies.documents, bodies.request, reportVisibility])
  const edges = useMemo<CanvasEdge[]>(() => {
    const pairs = new Map<string, CanvasAttachedRelationship[]>(), pairKey = (source: string, target: string) => JSON.stringify([source, target].sort())
    for (const relationship of attachedRelationships) {
      const key = pairKey(relationship.source, relationship.target), held = pairs.get(key) ?? []
      held.push(relationship); pairs.set(key, held)
    }
    const byId = new Map(nodes.map(node => [node.id, node]))
    return attachedRelationships.map(relationship => {
      // Both directions and every relation kind share one lane allocator, so reciprocal labels never coincide.
      const peers = pairs.get(pairKey(relationship.source, relationship.target))!.sort((a, b) => a.id.localeCompare(b.id))
      const lane = peers.findIndex(peer => peer.id === relationship.id)
      const offset = relationship.source === relationship.target ? (lane + 1) * 58 : (lane - (peers.length - 1) / 2) * 58
      const rightward = (byId.get(relationship.source)?.position.x ?? 0) <= (byId.get(relationship.target)?.position.x ?? 0)
      const source = byId.get(relationship.source), target = byId.get(relationship.target)
      const labelBaseline = relationship.source === relationship.target ? (source?.position.y ?? 0) - 50
        : ((source?.position.y ?? 0) + (source?.measured?.height ?? 154) / 2 + (target?.position.y ?? 0) + (target?.measured?.height ?? 154) / 2) / 2
      return { id: relationship.id, source: relationship.source, target: relationship.target, type: 'relationship',
        sourceHandle: relationship.sourceBlockId ? noteCanvasBlockHandle(relationship.sourceBlockId, 'out', rightward ? 'right' : 'left') : `${relationship.sourceKind}-out-${rightward ? 'right' : 'left'}`,
        targetHandle: relationship.targetBlockId ? noteCanvasBlockHandle(relationship.targetBlockId, 'in', rightward ? 'left' : 'right') : `${relationship.targetKind}-in-${rightward ? 'left' : 'right'}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: relationship.kind === 'hierarchy' ? 'var(--text-3)' : relationship.kind === 'embed' ? 'var(--green)' : 'var(--blue)' },
        data: { relationship, inspect: inspectRelationship, offset, labelBaseline, sourceTitle: snapshot?.catalog.pages[relationship.source]?.title ?? 'Uncatalogued note', targetTitle: snapshot?.catalog.pages[relationship.target]?.title ?? 'Uncatalogued note' }, selectable: false, deletable: false }
    })
  }, [attachedRelationships, nodes, snapshot, inspectRelationship])
  const topology = JSON.stringify([projection.notes.map(item => item.id), projection.relationships.map(edge => edge.id)])
  const arranged = useRef(0), initialized = useRef(false), hadViewport = useRef(Boolean(layout.viewport)), viewportTouched = useRef(false)
  useEffect(() => {
    if (!active || !snapshot || !projection.notes.length) return
    const force = arrangeAttempt > arranged.current
    const held = refs.current.layout.positions
    const frameInitial = () => {
      if (!flow || initialized.current || hadViewport.current || viewportTouched.current) return
      initialized.current = true
      requestAnimationFrame(() => {
        if (viewportTouched.current || refs.current.layout.viewport) return
        const root = scope.kind === 'note' ? scope.noteId : projection.notes[0]!.id
        const node = flow.getNode(root)
        if (!node) { initialized.current = false; return }
        // Read the current Note first. Explicit Fit remains available for an overview of every node.
        void flow.setViewport({ x: 24 - node.position.x, y: 24 - node.position.y, zoom: 1 })
      })
    }
    if (!force && projection.notes.every(note => held[note.id])) { frameInitial(); return }
    let worker: Worker
    try { worker = new Worker(new URL('../lib/note-canvas-layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch { setLayoutIssue('Automatic layout could not start. You can still move Notes; retry Arrange.'); frameInitial(); return }
    const id = crypto.randomUUID(), input: CanvasLayoutInput = { nodes: projection.notes.map(note => {
      const node = refs.current.nodes.find(node => node.id === note.id)
      return { id: note.id, width: node?.measured?.width ?? 320, height: node?.measured?.height ?? 480 }
    }), edges: projection.relationships }
    let current = true
    const cancel = () => { current = false; worker.terminate(); setArranging(false) }
    cancelArrangement.current = cancel
    setArranging(true)
    worker.onmessage = (event: MessageEvent<{ id: string; positions?: Record<string, { x: number; y: number }>; error?: string }>) => {
      if (!current || event.data.id !== id) return
      worker.terminate(); setArranging(false)
      if (!event.data.positions || event.data.error) { setLayoutIssue(event.data.error ?? 'Layout is unconfirmed. Your positions are kept.'); return }
      const fresh = refs.current.layout.positions, positions = { ...fresh }, next = event.data.positions
      const heldPoints = Object.values(fresh), missing = projection.notes.filter(note => !fresh[note.id])
      const offsetY = !force && heldPoints.length && missing.length ? Math.max(...heldPoints.map(point => point.y)) + 480 - Math.min(...missing.map(note => next[note.id]!.y)) : 0
      for (const note of projection.notes) if (force || !fresh[note.id]) positions[note.id] = { x: next[note.id]!.x, y: next[note.id]!.y + offsetY }
      setNodes(values => values.map(node => ({ ...node, position: positions[node.id] ?? node.position })))
      refs.current.save({ positions }); setLayoutIssue(null); arranged.current = arrangeAttempt
      frameInitial()
    }
    worker.onerror = () => { worker.terminate(); if (current) { setArranging(false); setLayoutIssue('Automatic layout stopped. Move Notes freely or retry Arrange.') } }
    worker.postMessage({ id, input })
    return () => { cancel(); if (cancelArrangement.current === cancel) cancelArrangement.current = null }
    // Layout runs only for topology changes or an explicit Arrange, never body measurement or dragging.
  }, [active, topology, arrangeAttempt, flow])
  const relationship = inspected?.kind === 'relationship' ? projection.relationships.find(edge => edge.id === inspected.id) : undefined
  const unboundNote = inspected?.kind === 'unbound' ? projection.notes.find(note => note.id === inspected.noteId) : undefined
  const inspectedReferences = relationship ? relationship.references.filter(reference => inspected?.kind === 'relationship' && inspected.occurrences.includes(noteGraphReferenceKey(reference))) : unboundNote?.unbound ?? []
  const selectionExpired = inspected?.kind === 'relationship' && inspected.occurrences.length > 0 && inspectedReferences.length === 0
  const pageFor = (id: string) => snapshot?.catalog.pages[id]
  const visiblePages = projection.notes.flatMap(item => item.page ? [item.page] : [])
  function openEndpoint(id: string, blockId?: string) { const page = pageFor(id); if (page) onOpen(page, blockId) }
  function persistViewport() { if (flow) save({ viewport: flow.getViewport() }) }
  return <section className="note-canvas" aria-label="Note relationship canvas" data-scope={scope.kind} data-active={active}>
    <div className="note-canvas-toolbar"><div className="note-canvas-summary"><BranchIcon size={14} /><strong>{scope.kind === 'note' ? 'Related notes' : 'Relationships'}</strong><span>{projection.notes.length} notes</span></div>
      <div className="note-canvas-tools" role="group" aria-label="Canvas tools"><button type="button" className="note-canvas-tool-text" aria-label="Show related notes" title="Show incoming and outgoing neighbors of the notes in this view" onClick={() => save({ expandedNoteIds: [...new Set([...layout.expandedNoteIds, ...seeds])] })}><BranchIcon size={14} /><span>Show related</span></button><button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => { void flow?.zoomOut({ duration: 150 }).then(persistViewport) }}><MinusIcon size={15} /></button><button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => { void flow?.zoomIn({ duration: 150 }).then(persistViewport) }}><PlusIcon size={15} /></button>
        <button type="button" title="Fit visible notes" aria-label="Fit visible notes" onClick={() => { void flow?.fitView({ padding: .15, maxZoom: 1, duration: 200 }).then(persistViewport) }}><FitIcon size={14} /></button>
        {scope.kind === 'note' && <button type="button" title="Center this note" aria-label="Center this note" onClick={() => { const node = flow?.getNode(scope.noteId); if (node) void flow?.setCenter(node.position.x + (node.measured?.width ?? 288) / 2, node.position.y + (node.measured?.height ?? 180) / 2, { zoom: 1, duration: 200 }).then(persistViewport) }}><FocusIcon size={14} /></button>}
        <button type="button" className="note-canvas-tool-text" aria-label="Arrange notes" onClick={() => arrange(value => value + 1)} aria-busy={arranging}><ArrangeIcon size={14} /><span>{arranging ? 'Arranging…' : 'Arrange'}</span></button>
        <button type="button" title="Refresh saved graph" aria-label="Refresh saved graph" aria-busy={busy} onClick={refresh}><RefreshIcon size={14} /></button></div></div>
    {issue || stale || storageIssue || layoutIssue ? <div className="note-canvas-notice" role="status">{issue ? `Graph observation failed: ${issue}. Your last view is kept.` : stale ? 'The directory changed. This saved graph is kept until you refresh.' : null}
      {storageIssue && <span>{storageIssue}</span>}{layoutIssue && <span>{layoutIssue}</span>}
      {issue || stale ? <button type="button" onClick={refresh}>Refresh graph</button> : null}{storageIssue && <button type="button" onClick={retry}>Retry saving layout</button>}{layoutIssue && <button type="button" onClick={() => arrange(value => value + 1)}>Retry Arrange</button>}</div> : null}
    <NotebookDirectoryContextMenu pages={visiblePages} onTalk={onTalk}><div className="note-canvas-stage">
      <ReactFlow<CanvasNode, CanvasEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow}
        onNodesChange={(changes: NodeChange<CanvasNode>[]) => {
          // A newer manual gesture supersedes even a queued worker reply from an explicit Arrange.
          if (changes.some(change => change.type === 'position' && change.position)) { cancelArrangement.current?.(); cancelArrangement.current = null; arranged.current = arrangeAttempt }
          setNodes(held => applyNodeChanges(changes, held))
          const completed = changes.filter(change => change.type === 'position' && change.position && change.dragging === false)
          if (completed.length) { const positions = { ...refs.current.layout.positions }; for (const change of completed) if (change.type === 'position' && change.position) positions[change.id] = change.position; save({ positions }) }
        }}
        onMoveStart={event => { if (event) viewportTouched.current = true }}
        onMoveEnd={(event: globalThis.MouseEvent | TouchEvent | null, viewport: Viewport) => { if (event) { viewportTouched.current = true; save({ viewport }) } }} defaultViewport={layout.viewport ?? { x: 32, y: 40, zoom: 1 }}
        minZoom={.15} maxZoom={1.8} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} panOnDrag={[0, 1]} selectionOnDrag={false} zoomOnDoubleClick={false}
        onlyRenderVisibleElements={false} proOptions={{ hideAttribution: false }} aria-label="Infinite note canvas">
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--line)" />
      </ReactFlow>
      {!snapshot ? <div className="note-canvas-empty" role="status"><BranchIcon size={24} /><strong>{busy ? 'Reading saved relationships…' : 'Graph not yet observed'}</strong><span>Original Notes stay in their files.</span>{!busy && <button type="button" onClick={refresh}>Read graph</button>}</div> : !projection.notes.length ? <div className="note-canvas-empty" role="status"><strong>No notes in this view</strong><span>Clear the page filter or choose another Notebook.</span></div> : null}
      {(relationship || unboundNote || selectionExpired) && snapshot ? <aside className="note-canvas-inspector nodrag nopan nowheel" aria-label="Relationship details"><header><strong>{selectionExpired ? 'Selection changed' : relationship?.kind === 'hierarchy' ? 'Directory hierarchy' : unboundNote ? 'Unbound links' : `${inspectedReferences.length}${relationship?.kind === 'link' ? '' : ' block'} ${relationship?.kind}${inspectedReferences.length === 1 ? '' : 's'}`}</strong><button type="button" aria-label="Close relationship details" onClick={() => inspect(null)}><CloseIcon size={14} /></button></header>
        {relationship ? <p>{pageFor(relationship.source)?.title ?? relationship.source}<span>→</span>{pageFor(relationship.target)?.title ?? relationship.target}</p> : unboundNote ? <p>{unboundNote.title}<span>No destination identity confirmed</span></p> : null}
        {selectionExpired ? <p role="status">The selected original occurrence is no longer in this saved graph. Select a relationship again.</p> : relationship?.kind === 'hierarchy' ? <div className="note-canvas-inspector-actions"><button type="button" onClick={() => openEndpoint(relationship.source)}>Open parent</button><button type="button" onClick={() => openEndpoint(relationship.target)}>Open subpage</button></div> : <ol>{inspectedReferences.map(reference => <ReferenceDetails key={noteGraphReferenceKey(reference)} reference={reference} snapshot={snapshot} onOpen={onOpen} />)}</ol>}
      </aside> : null}
    </div></NotebookDirectoryContextMenu>
    <div className="note-canvas-caption"><span className="note-canvas-legend"><i />Subpage<i data-link />Link<i data-reference />Reference<i data-embed />Embed</span><span role="status">{snapshot ? `${snapshot.graph.completeness === 'complete' ? 'Saved catalog observed' : `${snapshot.graph.completeness === 'partial' ? 'Partial' : 'Unconfirmed'} coverage`} · ${snapshot.graph.observations.filter(value => value.status === 'read').length}/${snapshot.graph.observations.length} originals read · catalog r${snapshot.catalog.revision}` : 'Saved-file graph'}{projection.unbound.length > 0 && ` · ${projection.unbound.length} visible unbound links`}{busy && snapshot ? ' · Refreshing…' : ''}</span></div>
    {linkNavigation.dialog}
  </section>
}
