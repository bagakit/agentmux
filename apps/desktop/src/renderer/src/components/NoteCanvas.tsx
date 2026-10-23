import { mintObjectId } from '@agentmux/core/object-id'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, applyNodeChanges, useStore, useUpdateNodeInternals, type Edge, type EdgeProps, type Node, type NodeProps, type NodeChange, type Viewport, type ReactFlowInstance } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { NoteReader, type NoteLinkOpenRequest } from '@agentmux/client-ui/components/NoteReader'
import { NoteFileLinkContext } from '@agentmux/client-ui/components/NoteFileContext'
import { useDesktopNoteLinkOpener } from '../lib/note-file-link'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import type { NotebookPage, NoteResource } from '@agentmux/core/notebook-catalog'
import { noteKnowledge, parseNoteFile, projectNoteBlocks, type NoteFileDocument, type NoteSource } from '@agentmux/client-ui/note/note-knowledge'
import { useNoteCanvasDraftIncludes } from '../lib/use-note-canvas-draft-includes'
import { useNoteCanvasContent, type CanvasContent } from '../lib/use-note-canvas-content'
import { noteContentMatchesGraph, type NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { projectNoteCanvas, canvasSharedObservation, canvasNoteTitle, initialCanvasPositions, attachNoteCanvasRelationships, noteCanvasBlockHandle, noteCanvasBlockNodeId, noteCanvasFocusNeighborhood, type CanvasNote, type CanvasAttachedRelationship, type CanvasReference, type CanvasFocusTarget } from '../lib/note-canvas-model'
import { collaborationEnvelope } from '../lib/collaboration-map-geometry'
import type { CollaborationLayoutBox } from '../lib/collaboration-layout-engine'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { api } from '../lib/api'
import { fileNavigationSelection, useAppStore } from '../store'
import { documentKey } from '../lib/workbench-tabs'
import type { CanvasLayoutInput } from '../lib/note-canvas-layout-engine'
import { noteCanvasScopeKey, type NoteCanvasScope } from '../lib/note-canvas-state'
import { useNoteCanvasLayout } from '../lib/use-note-canvas-layout'
import { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'
import { noteGraphReferenceKey, noteGraphReferenceSelectionKey, noteGraphReferenceLabel } from '../lib/note-graph-references'
import { NotebookDirectoryContextMenu, type NoteTalkHandler } from './NotebookDirectoryContextMenu'
import '@xyflow/react/dist/base.css'
import '../styles/note-canvas.css'

const NotebookIcon = semanticIconComponent('object.notebook'), NoteIcon = semanticIconComponent('object.note')
const NoteBlockIcon = semanticIconComponent('object.note-block'), SharedBlockIcon = semanticIconComponent('object.shared-block')
const FullNoteIcon = semanticIconComponent('action.show-full-note'), RelatedBlocksIcon = semanticIconComponent('action.show-related-blocks')
const RelationshipsIcon = semanticIconComponent('object.relationships')
const RefreshIcon = semanticIconComponent('action.refresh'), FitIcon = semanticIconComponent('layout.expand')
const ArrangeIcon = semanticIconComponent('action.arrange-graph'), PlusIcon = semanticIconComponent('action.zoom-in'), MinusIcon = semanticIconComponent('action.zoom-out')
const OpenIcon = semanticIconComponent('action.open-external'), CloseIcon = semanticIconComponent('action.close')
type OpenNote = (page: NotebookPage, blockId?: string) => void
type OpenOriginal = (noteId: string, blockId?: string, resource?: NoteResource) => void
export type CanvasFileTarget = Pick<NotebookPage, 'noteId' | 'resource'>
export const NOTE_CANVAS_OVERVIEW_ZOOM = 0.45
type CanvasEmphasis = 'normal' | 'related' | 'muted'

const AREA_PAD_X = 16, AREA_HEADER_H = 112, AREA_FOOTER_H = 82
const BLOCK_W = 288, BLOCK_H = 140, BLOCK_GAP_X = 16, BLOCK_GAP_Y = 14
const NO_BLOCK_IDS: readonly string[] = []

type NoteAreaBodyStatus = {
  dirty: boolean
  draftView: boolean
  readingMode: 'document' | 'summary' | 'related'
  headingLabel: string
  savedBadge: string | null
  emptyMessage: string | null
  stateMessage: string | null
  stateActionLabel: string | null
  onStateAction?: (() => void) | undefined
  onChooseVersion(saved: boolean): void
  remainingCount: number
  onShowAll(): void
}

type NoteNodeData = {
  selectedBlockIds: readonly string[]
  focusedBlockIds: readonly string[]
  pageSelected: boolean
  emphasis: CanvasEmphasis
  content?: CanvasContent | undefined
  documents: Parameters<typeof NoteReader>[0]['documents']
  source?: NoteSource | undefined
  onRead(id: string): void
  onVisible(id: string, visible: boolean): void
  item: CanvasNote
  snapshot: NotebookGraphSnapshot
  active: boolean
  expanded: boolean
  preview: boolean
  blockIds: readonly string[]
  areaWidth: number
  areaHeight: number
  stageHeight: number
  envelope: string
  bodyStatus: NoteAreaBodyStatus | null
  sharedReadable?: NoteFileDocument | null | undefined
  sharedResource?: NoteResource | undefined
  sharedPortBlockIds: readonly string[]
  onBlockPorts(noteId: string, blockNodeId: string, snapshot: NotebookGraphSnapshot, blockIds: readonly string[]): void
  onOpen: OpenOriginal
  onOpenLink(link: NoteLinkOpenRequest): void
  onNeighbors(id: string): void
  onPreview(id: string): void
  onUnbound(id: string): void
  onFocusBlock(noteId: string, blockId: string | undefined): void
  onPeekNote(noteId: string | null): void
  refresh(): void
}

type BlockNodeData = {
  noteId: string
  blockId: string
  topBlockIndex?: number | undefined
  coveredBlockIds: readonly string[]
  portBlockIds: readonly string[]
  desired: boolean
  active: boolean
  draftView: boolean
  readingMode: 'document' | 'summary' | 'related'
  previewBlockCount?: number | undefined
  emphasis: CanvasEmphasis
  highlightedBlockIds: readonly string[]
  resource: NoteResource
  readable: NoteFileDocument
  source?: NoteSource | undefined
  openable: boolean
  snapshot: NotebookGraphSnapshot
  documents: Parameters<typeof NoteReader>[0]['documents']
  onBlockPorts(noteId: string, blockNodeId: string, snapshot: NotebookGraphSnapshot, blockIds: readonly string[]): void
  onRead(id: string): void
  onOpen: OpenOriginal
  onOpenLink(link: NoteLinkOpenRequest): void
  onFocusBlock(noteId: string, blockId: string | undefined): void
  onPeekBlock(noteId: string | null, blockId?: string): void
}

type CanvasNoteNode = Node<NoteNodeData, 'note'>
type CanvasBlockNode = Node<BlockNodeData, 'block'>
type CanvasNode = CanvasNoteNode | CanvasBlockNode
type CanvasEdge = Edge<{ selected: boolean; focused: boolean; emphasis: CanvasEmphasis; relationship: CanvasAttachedRelationship; inspect(relationship: CanvasAttachedRelationship): void; offset: number; labelBaseline: number; sourceTitle: string; targetTitle: string; targetShared: boolean }, 'relationship'>

function EndpointHandles({ kind, blockId }: { kind: 'page' | 'block'; blockId?: string }) {
  return <>{(['left', 'right'] as const).flatMap(side => (['in', 'out'] as const).map(direction => <Handle key={`${direction}-${side}`} id={blockId ? noteCanvasBlockHandle(blockId, direction, side) : `${kind}-${direction}-${side}`} type={direction === 'in' ? 'target' : 'source'} position={side === 'left' ? Position.Left : Position.Right} isConnectable={false} />))}</>
}

const NoteBlockCard = memo(function NoteBlockCard({ id, data, selected }: NodeProps<CanvasBlockNode>) {
  const agentNames = useAppStore(state => state.agentNames)
  const updateInternals = useUpdateNodeInternals()
  const overview = useStore(state => state.transform[2] < NOTE_CANVAS_OVERVIEW_ZOOM)
  const bounds = useStore(state => state.nodeLookup.get(id)?.internals.handleBounds)
  const usedHandles = useStore(state => JSON.stringify(state.edges.flatMap(edge => [
    ...edge.source === id && edge.sourceHandle ? [edge.sourceHandle] : [],
    ...edge.target === id && edge.targetHandle ? [edge.targetHandle] : [],
  ]).sort()))
  const draftTarget = useMemo(() => ({ ...data.resource, noteId: data.noteId }), [data.resource, data.noteId])
  const draftIncludes = useNoteCanvasDraftIncludes(data.active && data.draftView, draftTarget, data.readable.content)
  const readerBlockIds = useMemo(() => data.topBlockIndex !== undefined ? undefined : [data.blockId], [data.blockId, data.topBlockIndex])
  const [selectedBlock, setSelectedBlock] = useState<string | undefined>()
  const activePorts = data.active && data.desired && !overview && !data.draftView ? data.portBlockIds : NO_BLOCK_IDS
  const activePortsKey = JSON.stringify(activePorts)
  const [mountedPorts, setMountedPorts] = useState<readonly string[]>(activePorts)
  useLayoutEffect(() => {
    const used = new Set<string>(JSON.parse(usedHandles)), visible = new Set(activePorts)
    setMountedPorts(held => {
      const keep = held.filter(blockId => visible.has(blockId) || (['left', 'right'] as const).some(side => (['in', 'out'] as const).some(direction => used.has(noteCanvasBlockHandle(blockId, direction, side)))))
      const next = [...new Set([...keep, ...activePorts])]
      return held.length === next.length && held.every((blockId, index) => blockId === next[index]) ? held : next
    })
  }, [activePortsKey, usedHandles])
  useLayoutEffect(() => { updateInternals(id) }, [id, mountedPorts, updateInternals])
  useLayoutEffect(() => {
    if (!activePorts.length) {
      data.onBlockPorts(data.noteId, id, data.snapshot, NO_BLOCK_IDS)
      return
    }
    const registered = new Set([...bounds?.source ?? [], ...bounds?.target ?? []].map(handle => handle.id))
    const available = activePorts.filter(blockId => (['left', 'right'] as const).every(side => (['in', 'out'] as const).every(direction => registered.has(noteCanvasBlockHandle(blockId, direction, side)))))
    data.onBlockPorts(data.noteId, id, data.snapshot, available)
  }, [activePortsKey, bounds, id, data.noteId, data.snapshot, data.onBlockPorts])
  useLayoutEffect(() => () => data.onBlockPorts(data.noteId, id, data.snapshot, NO_BLOCK_IDS), [id, data.noteId, data.snapshot, data.onBlockPorts])
  if (overview && !mountedPorts.length) return null
  return <section className="note-canvas-block-node" data-note-id={data.noteId} data-block-node-id={data.blockId} data-reading-mode={data.readingMode} data-body-version={data.draftView ? 'draft' : 'saved'} data-emphasis={data.emphasis} data-selected={selected} style={data.desired && !overview ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    onMouseEnter={() => data.onPeekBlock(data.noteId, data.topBlockIndex !== undefined ? undefined : data.blockId)}
    onMouseLeave={() => data.onPeekBlock(null, undefined)}
    onDoubleClick={event => event.stopPropagation()}>
    <header className="note-canvas-block-drag">
      <span className="note-canvas-block-badge"><NoteBlockIcon size={12} /><span>{data.topBlockIndex !== undefined ? `Block ${data.topBlockIndex + 1}` : data.blockId}</span></span>
      {data.openable && data.topBlockIndex === undefined && data.source?.blocks.has(data.blockId) ? <button type="button" className="note-canvas-block-open nodrag" aria-label={`Open block ${data.blockId}`} onClick={() => data.onOpen(data.noteId, data.blockId)}><OpenIcon size={11} /></button> : null}
    </header>
    {mountedPorts.map(blockId => <div key={blockId} className="note-canvas-row-endpoint note-canvas-endpoint" data-port-block-id={blockId} title={`Original block: ${blockId}`} style={{ visibility: activePorts.includes(blockId) ? 'visible' : 'hidden' }}><EndpointHandles kind="block" blockId={blockId} /></div>)}
    <div className="note-canvas-reader nodrag nopan nowheel" data-selected-block={selectedBlock} onClick={event => {
      const block = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-id]') : null
      if (block && block.closest('.mobile-note-body') === event.currentTarget.querySelector('.mobile-note-body')) {
        setSelectedBlock(block.dataset.blockId)
        data.onFocusBlock(data.noteId, block.dataset.blockId)
      }
    }}>
      <NoteReader key={data.draftView ? 'draft' : 'saved'} resource={data.resource} agentNames={agentNames} noteProvenance={data.readable.noteProvenance} content={data.readable.content} path={data.resource.path} workspaceId={data.resource.workspaceId} revision={data.readable.revision} documents={data.documents} graph={data.snapshot.graph} draftIncludes={data.draftView ? draftIncludes : undefined} onOpenDraftSource={target => data.onOpen(target.noteId, target.blockId, target.resource)} readInclude={target => data.onRead(target.noteId)} blockIds={readerBlockIds} topBlockIndex={data.topBlockIndex} previewBlockCount={data.previewBlockCount} compactIncludes highlightBlockIds={data.draftView ? NO_BLOCK_IDS : data.highlightedBlockIds} readReference={target => data.onRead(target.noteId)} onOpenLink={data.onOpenLink} />
    </div>
    {selectedBlock && data.source?.blocks.has(selectedBlock) && data.openable ? <button type="button" className="note-canvas-open-block nodrag" onClick={() => data.onOpen(data.noteId, selectedBlock)}><OpenIcon size={12} />Open selected block</button> : null}
  </section>
})

const NoteCard = memo(function NoteCard({ data, selected }: NodeProps<CanvasNoteNode>) {
  const { item, bodyStatus } = data
  const agentNames = useAppStore(state => state.agentNames)
  const updateInternals = useUpdateNodeInternals()
  const title = canvasNoteTitle(item, data.source), readable = Boolean(item.page || item.kind === 'shared-block'), openable = Boolean(item.page || canvasSharedObservation(data.snapshot, item.id))
  const canvasRole = item.kind === 'shared-block' ? (item.sharedPlacement === 'area-member' ? 'shared-member' : 'shared-bridge') : 'note-area'
  const overview = useStore(state => state.transform[2] < NOTE_CANVAS_OVERVIEW_ZOOM)
  const inView = useStore(state => {
    const node = state.nodeLookup.get(item.id), [x, y, zoom] = state.transform
    if (!node || !state.width || !state.height) return false
    const point = node.internals.positionAbsolute, left = point.x * zoom + x, top = point.y * zoom + y
    return left < state.width && top < state.height && left + (node.measured.width ?? data.areaWidth) * zoom > 0 && top + (node.measured.height ?? data.areaHeight) * zoom > 0
  })
  useEffect(() => { data.onVisible(item.id, data.active && inView && !overview); return () => data.onVisible(item.id, false) }, [item.id, data.active, inView, overview, data.onVisible])
  const bounds = useStore(state => state.nodeLookup.get(item.id)?.internals.handleBounds)
  const usedHandles = useStore(state => JSON.stringify(state.edges.flatMap(edge => [
    ...edge.source === item.id && edge.sourceHandle ? [edge.sourceHandle] : [],
    ...edge.target === item.id && edge.targetHandle ? [edge.targetHandle] : [],
  ]).sort()))
  const activeSharedPorts = data.active && inView && !overview ? data.sharedPortBlockIds : NO_BLOCK_IDS
  const activeSharedPortsKey = JSON.stringify(activeSharedPorts)
  const [mountedSharedPorts, setMountedSharedPorts] = useState<readonly string[]>(activeSharedPorts)
  useLayoutEffect(() => {
    const used = new Set<string>(JSON.parse(usedHandles)), visible = new Set(activeSharedPorts)
    setMountedSharedPorts(held => {
      const keep = held.filter(blockId => visible.has(blockId) || (['left', 'right'] as const).some(side => (['in', 'out'] as const).some(direction => used.has(noteCanvasBlockHandle(blockId, direction, side)))))
      const next = [...new Set([...keep, ...activeSharedPorts])]
      return held.length === next.length && held.every((blockId, index) => blockId === next[index]) ? held : next
    })
  }, [activeSharedPortsKey, usedHandles])
  useLayoutEffect(() => { if (item.kind === 'shared-block') updateInternals(item.id) }, [item.id, item.kind, mountedSharedPorts, updateInternals])
  useLayoutEffect(() => {
    if (item.kind !== 'shared-block') return
    if (!activeSharedPorts.length) {
      data.onBlockPorts(item.id, item.id, data.snapshot, NO_BLOCK_IDS)
      return
    }
    const registered = new Set([...bounds?.source ?? [], ...bounds?.target ?? []].map(handle => handle.id))
    const available = activeSharedPorts.filter(blockId => (['left', 'right'] as const).every(side => (['in', 'out'] as const).every(direction => registered.has(noteCanvasBlockHandle(blockId, direction, side)))))
    data.onBlockPorts(item.id, item.id, data.snapshot, available)
  }, [item.id, item.kind, activeSharedPortsKey, bounds, data.snapshot, data.onBlockPorts])
  useLayoutEffect(() => () => { if (item.kind === 'shared-block') data.onBlockPorts(item.id, item.id, data.snapshot, NO_BLOCK_IDS) }, [item.id, item.kind, data.snapshot, data.onBlockPorts])
  const [selectedSharedBlock, setSelectedSharedBlock] = useState<string | undefined>()
  const hostCount = item.hostNoteIds?.length ?? 0
  return <article className="note-canvas-card" data-kind={item.kind ?? 'note'} data-canvas-role={canvasRole} data-host-note-id={item.hostNoteId} data-shared-placement={item.sharedPlacement} data-canvas-lod={overview ? 'overview' : 'reading'} data-emphasis={data.emphasis} data-root={item.root} data-context={item.context} data-selected={selected} data-page-selected={data.pageSelected} data-relationship-selected={data.pageSelected || data.selectedBlockIds.length > 0} data-preview={data.preview}
    style={canvasRole === 'note-area' && !overview ? { width: data.areaWidth, minHeight: data.areaHeight } : undefined}
    onMouseEnter={() => data.onPeekNote(item.id)} onMouseLeave={() => data.onPeekNote(null)}>
    {canvasRole === 'note-area' && !overview ? <svg className="note-canvas-area__envelope" width={data.areaWidth} height={data.areaHeight} aria-hidden="true"><path d={data.envelope} /></svg> : null}
    <header className="note-canvas-drag note-canvas-endpoint" data-endpoint-kind="page"><EndpointHandles kind="page" /><span className="note-canvas-book">{item.page ? <NotebookIcon size={12} /> : item.kind === 'shared-block' ? <SharedBlockIcon size={12} /> : <NoteIcon size={12} />}<span title={item.notebook}>{item.kind === 'shared-block' && hostCount > 1 ? `Shared bridge · ${hostCount} notes` : item.notebook}</span>{item.context && <em>Related</em>}{item.unbound.length > 0 && <button type="button" className="note-canvas-unbound nodrag" aria-label={`Inspect ${item.unbound.length} unbound links in ${item.title}`} onClick={() => data.onUnbound(item.id)}>{item.unbound.length} unbound</button>}</span>
      {openable ? <button type="button" className="note-canvas-title nodrag" data-note-id={item.id} title={title} onClick={() => data.onOpen(item.id)}><span>{title}</span><OpenIcon size={12} /></button>
        : <strong className="note-canvas-title" title={item.id}>{title}</strong>}
      {!openable || item.observation?.status !== 'read' ? <span className="note-canvas-note-state" title={item.observation && 'message' in item.observation ? item.observation.message : item.id}>{item.observation?.status ?? 'Target not observed'}</span> : null}
    </header>
    {mountedSharedPorts.map(blockId => <div key={blockId} className="note-canvas-row-endpoint note-canvas-endpoint" data-port-block-id={blockId} title={`Original block: ${blockId}`} style={{ top: '50%', visibility: activeSharedPorts.includes(blockId) ? 'visible' : 'hidden' }}><EndpointHandles kind="block" blockId={blockId} /></div>)}
    {overview ? <div className="note-canvas-overview-meta" role="status"><span>{item.kind === 'shared-block' ? 'Shared block' : `${data.blockIds.length} linked ${data.blockIds.length === 1 ? 'block' : 'blocks'}`}</span></div>
      : !readable ? <p className="note-canvas-page-target">Original file identity unconfirmed</p>
      : bodyStatus ? <div className="note-canvas-saved-body">
        <div className="note-canvas-body nodrag nopan" data-reading-mode={bodyStatus.readingMode} data-body-version={bodyStatus.draftView ? 'draft' : 'saved'} onDoubleClick={event => event.stopPropagation()}>
          {bodyStatus.dirty ? <>
            <p className="note-canvas-draft" role="status">{bodyStatus.draftView ? 'Unsaved draft · links show saved relationships' : 'Unsaved draft retained · viewing saved original'}</p>
            <div className="note-canvas-versions" role="group" aria-label="Compare original versions">
              <button type="button" aria-label="Current draft" aria-pressed={bodyStatus.draftView} onClick={() => bodyStatus.onChooseVersion(false)}>Current draft</button>
              <button type="button" aria-label="Saved original" aria-pressed={!bodyStatus.draftView} onClick={() => bodyStatus.onChooseVersion(true)}>Saved original</button>
            </div>
          </> : null}
          {bodyStatus.stateMessage ? <div className="note-canvas-body-state" role="status">
            {bodyStatus.stateMessage}
            {bodyStatus.stateActionLabel && bodyStatus.onStateAction ? <button type="button" onClick={bodyStatus.onStateAction}>{bodyStatus.stateActionLabel}</button> : null}
          </div> : <>
            <div className="note-canvas-saved-heading">
              <span>{bodyStatus.headingLabel}</span>
              {bodyStatus.savedBadge ? <span>{bodyStatus.savedBadge}</span> : null}
            </div>
            {bodyStatus.emptyMessage ? <p className="note-canvas-empty-body">{bodyStatus.emptyMessage}</p>
              : data.sharedReadable && data.sharedResource ? <>
                <div className="note-canvas-reader" data-selected-block={selectedSharedBlock} onClick={event => {
                  const block = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-id]') : null
                  if (block && block.closest('.mobile-note-body') === event.currentTarget.querySelector('.mobile-note-body')) {
                    setSelectedSharedBlock(block.dataset.blockId)
                    data.onFocusBlock(item.id, block.dataset.blockId)
                  }
                }}>
                  <NoteReader key={bodyStatus.draftView ? 'draft' : 'saved'} resource={data.sharedResource} agentNames={agentNames} noteProvenance={data.sharedReadable.noteProvenance} content={data.sharedReadable.content} path={data.sharedResource.path} workspaceId={data.sharedResource.workspaceId} revision={data.sharedReadable.revision} documents={data.documents} graph={data.snapshot.graph} readInclude={target => data.onRead(target.noteId)} previewBlockCount={item.kind !== 'shared-block' && bodyStatus.readingMode === 'summary' ? 3 : undefined} compactIncludes highlightBlockIds={data.selectedBlockIds.length ? data.selectedBlockIds : data.focusedBlockIds} readReference={target => data.onRead(target.noteId)} onOpenLink={data.onOpenLink} />
                </div>
                {selectedSharedBlock && data.source?.blocks.has(selectedSharedBlock) ? <button type="button" className="note-canvas-open-block" onClick={() => data.onOpen(item.id, selectedSharedBlock)}><OpenIcon size={12} />Open selected block</button> : null}
              </>
              : <div className="note-canvas-area-stage" style={{ height: data.stageHeight }} />}
          </>}
        </div>
        {bodyStatus.remainingCount > 0 ? <div className="note-canvas-reading-actions nodrag nopan"><button type="button" className="note-canvas-more" onClick={bodyStatus.onShowAll}>More {bodyStatus.remainingCount} related blocks</button></div> : null}
      </div> : null}
    <div className="note-canvas-block-summary note-canvas-endpoint" data-empty={data.blockIds.length === 0} aria-hidden={data.blockIds.length === 0} data-endpoint-kind="block" title="Some relationships attach here until their exact passage is visible. Inspect a relationship to read its original content."><EndpointHandles kind="block" /><span>Referenced passages</span><span>{data.blockIds.length}</span></div>
    <div className="note-canvas-degrees" aria-label={`${item.incoming} incoming, ${item.outgoing} outgoing occurrences in the saved graph`} title="Saved links and references, including notes outside this view. Unmatched links count only as outgoing."><span><SemanticIcon name="note.reference-incoming" size={10} /> {item.incoming} incoming</span><span><SemanticIcon name="note.reference-outgoing" size={10} /> {item.outgoing} outgoing</span></div>
    <footer className="nodrag">{item.kind === 'shared-block' ? <button type="button" onClick={() => data.onOpen(item.id)} disabled={!openable}><OpenIcon size={12} />Open original</button> : <button type="button" aria-expanded={data.preview} aria-label={`${data.preview ? 'Show related blocks' : 'Full note'}: ${title}`} onClick={() => { if (!data.content?.pending && (!data.content?.value || data.content.value.status !== 'read')) data.onRead(item.id); data.onPreview(item.id) }} disabled={!readable}>{data.preview ? <RelatedBlocksIcon size={12} /> : <FullNoteIcon size={12} />}{data.preview ? 'Related blocks' : 'Full note'}</button>}
      <button type="button" aria-expanded={data.expanded} aria-label={`${data.expanded ? 'Collapse' : 'Expand'} relationships: ${item.title}`} onClick={() => data.onNeighbors(item.id)} disabled={!item.neighbors}><RelationshipsIcon size={12} />{data.expanded ? 'Collapse' : 'Explore'}<small>{item.neighbors}</small></button>
    </footer>
  </article>
})

const RelationshipEdge = memo(function RelationshipEdge(props: EdgeProps<CanvasEdge>) {
  const { sourceX, sourceY, targetX, targetY, id, markerEnd, data } = props
  const inViewport = useStore(state => {
    const [x, y, zoom] = state.transform
    if (!state.width || !state.height) return true
    const margin = 1200
    const left = Math.min(sourceX, targetX) * zoom + x, right = Math.max(sourceX, targetX) * zoom + x
    const top = Math.min(sourceY, targetY, data?.labelBaseline ?? sourceY) * zoom + y, bottom = Math.max(sourceY, targetY, data?.labelBaseline ?? targetY) * zoom + y
    return right >= -margin && left <= state.width + margin && bottom >= -margin && top <= state.height + margin
  })
  if (!data) return null
  const { relationship, offset } = data, self = props.source === props.target || relationship.source === relationship.target, loopOffset = Math.abs(offset)
  // One baseline per Note pair prevents different page/block handle heights from cancelling lane spacing.
  const midX = (sourceX + targetX) / 2, labelY = data.labelBaseline + (self ? -loopOffset : offset)
  const controlY = labelY * 4 / 3 - (sourceY + targetY) / 6
  const path = self ? `M ${sourceX},${sourceY} C ${sourceX + 100},${controlY} ${targetX - 100},${controlY} ${targetX},${targetY}`
    : `M ${sourceX},${sourceY} C ${midX},${controlY} ${midX},${controlY} ${targetX},${targetY}`
  const linked = relationship.kind !== 'hierarchy', count = relationship.references.length, noun = relationship.kind === 'embed' ? 'embed' : relationship.kind === 'link' ? 'link' : 'reference'
  const label = relationship.kind === 'hierarchy' ? 'Subpage' : relationship.kind === 'embed' ? data.targetShared ? 'Uses shared content' : 'Includes content' : relationship.kind === 'link' ? relationship.targetKind === 'block' ? 'Links to passage' : 'Links to note' : 'References passage'
  const endpoints = `${relationship.sourceKind === 'block' ? 'Block' : 'Page'} → ${relationship.targetKind === 'page' && data.targetShared ? 'shared block' : relationship.targetKind}`
  const muted = data.emphasis === 'muted' || (data.focused && !data.selected)
  return <><BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} className={`note-canvas-edge-${relationship.kind}${muted ? ' is-muted' : ''}${data.selected ? ' is-selected' : ''}`} interactionWidth={20} />
    {inViewport ? <EdgeLabelRenderer><button type="button" data-edge-id={id} data-source-note={relationship.source} data-target-note={relationship.target} data-source-kind={relationship.sourceKind} data-target-kind={relationship.targetKind} data-source-block={relationship.sourceBlockId} data-target-block={relationship.targetBlockId} data-source-attachment={relationship.sourceKind === 'page' ? 'page' : relationship.sourceBlockId ? 'block' : 'summary'} data-target-attachment={relationship.targetKind === 'page' ? 'page' : relationship.targetBlockId ? 'block' : 'summary'} data-source-handle={props.sourceHandleId} data-target-handle={props.targetHandleId} data-relationship-kind={relationship.kind} data-lane={offset} data-emphasis={data.emphasis} title={`${data.sourceTitle} → ${data.targetTitle} · ${endpoints}${relationship.sourceBlockId ? ` · From ${relationship.sourceBlockId}` : ''}${relationship.targetBlockId ? ` · To ${relationship.targetBlockId}` : ''}`} className={`note-canvas-edge-label nodrag nopan is-${relationship.kind}`} data-selected={data.selected} data-muted={muted} style={{ transform: `translate(-50%, -50%) translate(${midX}px,${labelY}px)` }}
      aria-label={linked ? `Inspect ${count} ${noun}${count === 1 ? '' : 's'}: ${endpoints}` : 'Inspect parent and subpage relationship: Page → page'} onClick={() => data.inspect(relationship)}><span>{label}</span>{count > 1 && <small>{count} places</small>}</button></EdgeLabelRenderer> : null}
  </>
})
const nodeTypes = { note: NoteCard, block: NoteBlockCard }, edgeTypes = { relationship: RelationshipEdge }

type CanvasBodies = ReturnType<typeof useNoteCanvasContent>
function EndpointContent({ noteId, blockId, snapshot, bodies, refresh, onOpenLink, complete = false }: { noteId: string; blockId?: string; complete?: boolean; snapshot: NotebookGraphSnapshot; bodies: CanvasBodies; refresh(): void; onOpenLink(link: NoteLinkOpenRequest): void }) {
  const agentNames = useAppStore(state => state.agentNames)
  const held = bodies.results[noteId], value = held?.snapshot === snapshot ? held.value : undefined
  const confirmed = value?.status === 'read' && noteContentMatchesGraph(snapshot, value) && !snapshot.graph.duplicateNoteIds.includes(noteId) && (value.kind !== 'shared-block' || canvasSharedObservation(snapshot, noteId)) ? value : null
  return confirmed ? <div className="note-canvas-reader note-canvas-comparison-content"><NoteReader resource={confirmed.resource} agentNames={agentNames} noteProvenance={confirmed.noteProvenance} content={confirmed.content} path={confirmed.resource.path} workspaceId={confirmed.resource.workspaceId} revision={confirmed.revision} documents={bodies.documents} graph={snapshot.graph} readInclude={target => bodies.request(target.noteId)} blockIds={blockId ? [blockId] : undefined} highlightBlockIds={blockId ? [blockId] : undefined} clipBlocks={!complete} readReference={target => bodies.request(target.noteId)} onOpenLink={onOpenLink} /></div>
    : <div className="note-canvas-body-state" role="status">{value?.status === 'read' ? 'Saved snapshot changed. Refresh the graph to compare this original.' : held?.pending ? 'Reading original block…' : held?.issue ?? (value && 'message' in value ? value.message : 'This original has not been confirmed in the current reading window.')}
      {!held?.pending && <button type="button" onClick={value?.status === 'read' ? refresh : () => bodies.request(noteId)}>{value?.status === 'read' ? 'Refresh graph' : 'Read original block'}</button>}
    </div>
}

function ReferenceDetails({ references, notes, snapshot, bodies, onOpen, refresh, onOpenLink }: { notes: readonly CanvasNote[]; references: readonly CanvasReference[]; snapshot: NotebookGraphSnapshot; bodies: CanvasBodies; onOpen: OpenOriginal; refresh(): void; onOpenLink(link: NoteLinkOpenRequest): void }) {
  const reference = references[0]!
  const original = (id: string) => { const item = notes.find(note => note.id === id); return { title: item ? canvasNoteTitle(item, bodies.knowledge.sources.find(source => source.note.noteId === id)) : 'Unconfirmed original', shared: item?.kind === 'shared-block', openable: Boolean(item?.page || canvasSharedObservation(snapshot, id)) } }
  const source = original(reference.source.noteId)
  const destinations = new Map<string, CanvasReference[]>()
  for (const item of references) {
    const key = JSON.stringify([item.mode, item.target, item.resolution]), group = destinations.get(key) ?? []
    group.push(item); destinations.set(key, group)
  }
  return <li className="note-canvas-comparison"><div className="note-canvas-comparison-heading"><strong>{references.length > 1 ? `${references.length} links from this block` : noteGraphReferenceLabel(reference)}</strong></div>
    <section className="note-canvas-comparison-from"><h4><span>From</span>{source.title}</h4>
      {source.openable && <div className="note-canvas-inspector-actions"><button type="button" onClick={() => onOpen(reference.source.noteId, reference.source.blockId)}>Open source block</button></div>}
      <EndpointContent noteId={reference.source.noteId} blockId={reference.source.blockId} snapshot={snapshot} bodies={bodies} refresh={refresh} onOpenLink={onOpenLink} complete />
    </section>
    {[...destinations].map(([key, items]) => {
      const item = items[0]!, target = item.target, destination = target.kind === 'unbound' ? undefined : original(target.noteId)
      return <section className="note-canvas-comparison-to" key={key}><h4><span>To</span>{destination?.title ?? (target.kind === 'unbound' ? 'Unconfirmed destination' : 'Outside this directory')}<small>{items.length > 1 ? `${items.length} occurrences · ` : ''}{noteGraphReferenceLabel(item)}</small></h4>
        <div className="note-canvas-inspector-actions">{destination?.openable && target.kind !== 'unbound' ? <button type="button" onClick={() => onOpen(target.noteId, item.resolution === 'resolved' && target.kind === 'block' ? target.blockId : undefined)}>{item.resolution === 'resolved' ? target.kind === 'page' ? destination.shared ? 'Open shared original' : 'Open target page' : 'Open target block' : 'Inspect registered original'}</button> : null}</div>
        {target.kind === 'block' && item.resolution === 'resolved' ? <EndpointContent noteId={target.noteId} blockId={target.blockId} snapshot={snapshot} bodies={bodies} refresh={refresh} onOpenLink={onOpenLink} />
          : target.kind === 'page' && item.resolution === 'resolved' ? destination?.shared ? <EndpointContent noteId={target.noteId} snapshot={snapshot} bodies={bodies} refresh={refresh} onOpenLink={onOpenLink} /> : <p className="note-canvas-whole-page">Whole page · no specific block</p>
            : <p className="note-canvas-reference-issue">{target.kind === 'unbound' ? 'This written link has no confirmed target' : 'Target ' + item.resolution + '.'} The original reference is kept; inspect the registered source to confirm its destination.</p>}
        {item.query !== undefined ? <p className="note-canvas-reference-query"><strong>[[{item.query}]]</strong><span>{item.resolution === 'resolved' ? 'Matched in this snapshot. Open the source note to confirm a permanent target.' : 'Saved query kept. Choose an exact target in the source Note.'}</span></p> : null}
      </section>
    })}
    <details className="note-canvas-location-details"><summary>Location details · {references.length} occurrence{references.length === 1 ? '' : 's'}</summary>
      {references.map(item => <dl key={noteGraphReferenceKey(item)}><dt>From block</dt><dd>{item.source.blockId}</dd><dt>To</dt><dd>{item.target.kind === 'block' ? item.target.noteId + ' / ' + item.target.blockId : item.target.kind === 'page' ? item.target.noteId : `[[${item.target.text}]]`}</dd><dt>Occurrence</dt><dd>{item.occurrence.kind === 'stored' ? item.occurrence.referenceId : `${item.occurrence.revision} · ${item.occurrence.from}–${item.occurrence.to}`}</dd><dt>Source file</dt><dd>{item.sourceResource.path}</dd><dt>Revision</dt><dd>{(() => { const observation = snapshot.graph.observations.find(value => value.noteId === item.source.noteId); return observation?.status === 'read' ? observation.revision : 'Unconfirmed' })()}</dd></dl>)}
    </details>
  </li>
}

export type NoteCanvasProps = { scope: NoteCanvasScope; active?: boolean; onOpen: OpenNote; onOpenFile?: ((file: CanvasFileTarget, blockId: string | undefined, signal: AbortSignal) => Promise<boolean>) | undefined; onTalk?: NoteTalkHandler | undefined; seedNoteIds?: readonly string[] | undefined; expandOnFirstView?: boolean }
export function NoteCanvas(props: NoteCanvasProps) {
  const openAttachment = useDesktopNoteLinkOpener()
  // Scope owns a separate viewport and asynchronous lifetime; changing it never repurposes an old request.
  return <NoteFileLinkContext.Provider value={openAttachment}><NoteCanvasSurface key={noteCanvasScopeKey(props.scope)} {...props} /></NoteFileLinkContext.Provider>
}

function NoteCanvasSurface({ scope, active = true, onOpen, onOpenFile, onTalk, seedNoteIds, expandOnFirstView = true }: NoteCanvasProps) {
  const { snapshot, issue, stale, busy, refresh } = useNoteCanvasObservation(active)
  const seedKey = seedNoteIds ? JSON.stringify(seedNoteIds) : undefined
  const stableSeedNoteIds = useMemo(() => seedNoteIds ? [...seedNoteIds] : undefined, [seedKey])
  const seeds = useMemo(() => snapshot ? stableSeedNoteIds ?? Object.values(snapshot.catalog.pages).filter(page => page.notebookId === scope.notebookId && !page.archivedAt).map(page => page.noteId) : [], [snapshot, scope.notebookId, stableSeedNoteIds])
  // Only the first unfiltered view gets a default neighborhood. Saved collapse choices remain authoritative.
  const initialExpanded = useMemo(() => expandOnFirstView ? seeds : [], [expandOnFirstView, seeds])
  const { layout, save, issue: storageIssue, retry } = useNoteCanvasLayout(scope, initialExpanded)
  const projection = useMemo(() => snapshot ? projectNoteCanvas(snapshot, scope, layout.expandedNoteIds, stableSeedNoteIds) : { notes: [], relationships: [], unbound: [] }, [snapshot, scope.notebookId, layout.expandedNoteIds, stableSeedNoteIds])
  const linkNavigation = useNoteLinkNavigation(onOpen, snapshot?.catalog, active)
  const [nodes, setNodes] = useState<CanvasNode[]>([]), [flow, setFlow] = useState<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const [inspected, inspect] = useState<{ kind: 'relationship'; id: string; occurrences: readonly string[] } | { kind: 'unbound'; noteId: string; occurrences: readonly string[] } | null>(null), [layoutIssue, setLayoutIssue] = useState<string | null>(null), [arranging, setArranging] = useState(false), [arrangeAttempt, arrange] = useState(0)
  const [focusedTarget, setFocusedTarget] = useState<CanvasFocusTarget | null>(null)
  const [peekedTarget, setPeekedTarget] = useState<CanvasFocusTarget | null>(null)
  const [versionChoices, setVersionChoices] = useState<Record<string, { selection: string; saved: boolean }>>({})
  const [expandedAllBlocks, setExpandedAllBlocks] = useState<Record<string, boolean>>({})
  const focusBlock = useCallback((noteId: string, blockId: string | undefined) => {
    setFocusedTarget(blockId ? { kind: 'block', noteId, blockId } : { kind: 'note', noteId })
  }, [])
  const peekNote = useCallback((noteId: string | null) => {
    setPeekedTarget(noteId ? { kind: 'note', noteId } : null)
  }, [])
  const peekBlock = useCallback((noteId: string | null, blockId?: string) => {
    setPeekedTarget(noteId ? (blockId ? { kind: 'block', noteId, blockId } : { kind: 'note', noteId }) : null)
  }, [])
  const inspectRelationship = useCallback((relationship: CanvasAttachedRelationship) => inspect({ kind: 'relationship', id: relationship.aggregateId, occurrences: relationship.references.map(noteGraphReferenceSelectionKey) }), [])
  const inspectUnbound = useCallback((noteId: string) => inspect({ kind: 'unbound', noteId, occurrences: (projection.notes.find(note => note.id === noteId)?.unbound ?? []).map(noteGraphReferenceSelectionKey) }), [projection.notes])
  const cancelArrangement = useRef<(() => void) | null>(null)
  const refs = useRef({ layout, save, nodes, projection }); refs.current = { layout, save, nodes, projection }
  const toggleNeighbors = useCallback((id: string) => { const { layout, save } = refs.current; save({ expandedNoteIds: layout.expandedNoteIds.includes(id) ? layout.expandedNoteIds.filter(value => value !== id) : [...layout.expandedNoteIds, id] }) }, [])
  const togglePreview = useCallback((id: string) => { const { layout, save } = refs.current; save({ previewNoteIds: layout.previewNoteIds.includes(id) ? layout.previewNoteIds.filter(value => value !== id) : [...layout.previewNoteIds, id] }) }, [])
  const expanded = useMemo(() => new Set(layout.expandedNoteIds), [layout.expandedNoteIds]), previews = useMemo(() => new Set(layout.previewNoteIds), [layout.previewNoteIds])
  const [registeredBlockPorts, setRegisteredBlockPorts] = useState<Record<string, { snapshot: NotebookGraphSnapshot; noteId: string; ids: readonly string[] }>>({})
  const recordBlockPorts = useCallback((noteId: string, blockNodeId: string, observed: NotebookGraphSnapshot, ids: readonly string[]) => setRegisteredBlockPorts(held => {
    const previous = held[blockNodeId]
    if (!ids.length) {
      if (!previous) return held
      const next = { ...held }; delete next[blockNodeId]; return next
    }
    return previous?.snapshot === observed && previous.noteId === noteId && previous.ids.length === ids.length && previous.ids.every((id, index) => id === ids[index])
      ? held : { ...held, [blockNodeId]: { snapshot: observed, noteId, ids } }
  }), [])
  const requestedBlocks = useMemo(() => {
    const result = new Map<string, Set<string>>()
    const add = (noteId: string, blockId: string) => { const held = result.get(noteId) ?? new Set<string>(); held.add(blockId); result.set(noteId, held) }
    for (const relationship of projection.relationships) for (const reference of relationship.references) {
      add(reference.source.noteId, reference.source.blockId)
      if (reference.target.kind === 'block') add(reference.target.noteId, reference.target.blockId)
    }
    for (const reference of projection.unbound) add(reference.source.noteId, reference.source.blockId)
    return new Map([...result].map(([id, ids]) => [id, [...ids].sort()]))
  }, [projection.relationships, projection.unbound])
  const [visibleNotes, setVisibleNotes] = useState<readonly string[]>([])
  const reportVisibility = useCallback((id: string, visible: boolean) => setVisibleNotes(held => held.includes(id) === visible ? held : visible ? [...held, id] : held.filter(value => value !== id)), [])
  const visibleNoteSet = useMemo(() => new Set(visibleNotes), [visibleNotes])
  const dirtyFlags = useAppStore(useShallow(state => {
    const flags: Record<string, boolean> = {}
    for (const item of projection.notes) {
      const resource = item.page?.resource ?? (item.observation?.status === 'read' ? item.observation.resource : undefined)
      if (!resource) continue
      const key = documentKey(resource.workspaceId, resource.path)
      if (!state.dirtyDocuments[key]) continue
      const workspace = state.config?.workspaces.find(value => value.id === resource.workspaceId)
      flags[item.id] = Boolean(workspace?.hostId === resource.hostId && workspace.path === resource.workspacePath)
    }
    return flags
  }))
  const dirtyDocs = useAppStore(useShallow(state => {
    const docs: Record<string, typeof state.documents[string] | undefined> = {}
    if (!active) return docs
    for (const item of projection.notes) {
      if (!visibleNoteSet.has(item.id)) continue
      const resource = item.page?.resource ?? (item.observation?.status === 'read' ? item.observation.resource : undefined)
      if (!resource) continue
      const key = documentKey(resource.workspaceId, resource.path)
      if (state.dirtyDocuments[key]) docs[item.id] = state.documents[key]
    }
    return docs
  }))
  const relationship = inspected?.kind === 'relationship' ? projection.relationships.find(edge => edge.id === inspected.id) : undefined
  const unboundNote = inspected?.kind === 'unbound' ? projection.notes.find(note => note.id === inspected.noteId) : undefined
  const inspectedReferences = useMemo(() => {
    const candidates = relationship?.references ?? unboundNote?.unbound ?? []
    return inspected ? candidates.filter(reference => inspected.occurrences.includes(noteGraphReferenceSelectionKey(reference))) : []
  }, [relationship, unboundNote, inspected])
  const expiredCount = inspected ? inspected.occurrences.length - inspectedReferences.length : 0
  const selectionExpired = expiredCount > 0 && inspectedReferences.length === 0
  const selectedBlocks = useMemo(() => {
    const result = new Map<string, string[]>()
    const add = (note: string, block: string) => result.set(note, [...new Set([...(result.get(note) ?? []), block])])
    for (const reference of inspectedReferences) { add(reference.source.noteId, reference.source.blockId); if (reference.target.kind === 'block') add(reference.target.noteId, reference.target.blockId) }
    return result
  }, [inspectedReferences])
  const selectedPages = useMemo(() => new Set(relationship?.kind === 'hierarchy' ? [relationship.source, relationship.target] : inspectedReferences.flatMap(reference => reference.resolution === 'resolved' && reference.target.kind === 'page' ? [reference.target.noteId] : [])), [relationship, inspectedReferences])
  const priority = useMemo(() => inspectedReferences.length ? [...new Set(inspectedReferences.flatMap(reference => [reference.source.noteId, ...reference.resolution === 'resolved' && reference.target.kind !== 'unbound' ? [reference.target.noteId] : []]))]
    : seeds[0] && visibleNotes.includes(seeds[0]) ? [seeds[0]] : NO_BLOCK_IDS, [inspectedReferences, seeds, visibleNotes])
  const bodies = useNoteCanvasContent(snapshot, active, visibleNotes, priority)
  const [navigationIssue, setNavigationIssue] = useState<string | null>(null)
  const navigation = useRef<AbortController | null>(null)
  useEffect(() => () => navigation.current?.abort(), [active, snapshot])
  const openOriginal = useCallback((noteId: string, blockId?: string, expectedResource?: NoteResource) => {
    navigation.current?.abort()
    if (!active) return
    const page = snapshot?.catalog.pages[noteId]
    if (page && (!expectedResource || (['hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(field => page.resource[field] === expectedResource[field]))) {
      if (blockId !== undefined) onOpen(page, blockId)
      else onOpen(page)
      return
    }
    const observation = snapshot && canvasSharedObservation(snapshot, noteId)
    if (!observation && !expectedResource) { setNavigationIssue('The exact original file is unconfirmed. Refresh the graph and retry; its reference is kept.'); return }
    const controller = new AbortController(); navigation.current = controller
    const resource = expectedResource ?? observation!.resource, before = useAppStore.getState(), selected = fileNavigationSelection(before)
    const matches = () => { const workspace = useAppStore.getState().config?.workspaces.find(value => value.id === resource.workspaceId); return workspace?.hostId === resource.hostId && workspace.path === resource.workspacePath }
    if (!matches()) { setNavigationIssue('The original workspace mapping changed. Refresh its directory before opening this shared file.'); return }
    setNavigationIssue(null)
    void (async () => {
      try {
        const read = await api.files.read(resource.workspaceId, resource.path)
        if (controller.signal.aborted) return
        if (read.status !== 'read') throw new Error('The original shared file could not be read. Its reference is kept; retry after reconnecting its Host.')
        const parsed = readNoteDocument(read.document.content)
        if (read.document.path !== resource.path || parsed.status !== 'valid' || parsed.note.noteId !== noteId || !expectedResource && parsed.note.kind !== 'shared-block') throw new Error('The shared file identity changed. Refresh the graph to confirm its original.')
        if (!matches()) throw new Error('The original workspace mapping changed. Refresh its directory before opening this shared file.')
        if (fileNavigationSelection(useAppStore.getState()) !== selected) throw new Error('Your later navigation is kept. Select this original again to open it.')
        if (onOpenFile) {
          const opened = await onOpenFile({ noteId, resource }, blockId, controller.signal)
          if (!opened && !controller.signal.aborted) throw new Error('The original File view could not be confirmed. Your current view and draft are kept; retry opening it.')
          return
        }
        const state = useAppStore.getState(), layout = state.prepareWorkbenchLayout(resource.workspaceId)
        const opened = await state.openFile(resource.path, layout.activeGroupId, blockId ? { line: 1, noteBlock: { noteId, blockId } } : undefined, resource.workspaceId, true, undefined, controller.signal)
        if (opened && !controller.signal.aborted) useAppStore.getState().setMainSurface('workbench')
        if (!opened && !controller.signal.aborted) throw new Error('The original File view could not be confirmed. Your current view and draft are kept; retry opening it.')
      } catch (error) { if (!controller.signal.aborted) setNavigationIssue(error instanceof Error ? error.message : String(error)) }
    })()
  }, [snapshot, active, onOpen, onOpenFile])
  const onOpenLink = useCallback((link: NoteLinkOpenRequest) => {
    if (link.target && snapshot?.graph.observations.some(item => item.noteId === link.target!.noteId && item.kind === 'shared-block')) openOriginal(link.target.noteId, link.target.blockId)
    else void linkNavigation.openLink(link)
  }, [snapshot, openOriginal, linkNavigation.openLink])
  useEffect(() => { if (active && inspected) for (const id of priority) bodies.request(id) }, [active, snapshot, inspected, bodies.request])

  // Compute per-Note area content, independent Block node specifications, and desired block ports.
  const areaProjections = useMemo(() => {
    if (!snapshot) return new Map<string, {
      bodyStatus: NoteAreaBodyStatus | null
      sharedReadable?: NoteFileDocument | null
      sharedResource?: NoteResource
      blocks: { blockNodeId: string; blockId: string; topBlockIndex?: number; coveredBlockIds: string[]; portBlockIds: string[]; readingMode: 'document' | 'summary' | 'related'; previewBlockCount?: number; draftView: boolean; resource: NoteResource; readable: NoteFileDocument; source?: NoteSource; openable: boolean }[]
      desiredPortBlockIds: Set<string>
    }>()
    const result = new Map<string, {
      bodyStatus: NoteAreaBodyStatus | null
      sharedReadable?: NoteFileDocument | null
      sharedResource?: NoteResource
      blocks: { blockNodeId: string; blockId: string; topBlockIndex?: number; coveredBlockIds: string[]; portBlockIds: string[]; readingMode: 'document' | 'summary' | 'related'; previewBlockCount?: number; draftView: boolean; resource: NoteResource; readable: NoteFileDocument; source?: NoteSource; openable: boolean }[]
      desiredPortBlockIds: Set<string>
    }>()
    for (const item of projection.notes) {
      const readable = Boolean(item.page || item.kind === 'shared-block')
      const openable = Boolean(item.page || canvasSharedObservation(snapshot, item.id))
      if (!readable) {
        result.set(item.id, { bodyStatus: null, blocks: [], desiredPortBlockIds: new Set() })
        continue
      }
      const resource = item.page?.resource ?? (item.observation?.status === 'read' ? item.observation.resource : undefined)
      const dirty = Object.hasOwn(dirtyFlags, item.id)
      const mapped = Boolean(dirtyFlags[item.id])
      const draftDocument = dirtyDocs[item.id]
      let draft: { document: NoteFileDocument; source: NoteSource } | { issue: string } | null = null
      if (dirty) {
        if (!mapped || !draftDocument || draftDocument.path !== resource?.path || snapshot.graph.duplicateNoteIds.includes(item.id)) {
          draft = { issue: 'Current draft resource is unconfirmed. Open the original to inspect its retained input.' }
        } else {
          const original = draftDocument
          const { noteProvenance, ...bytes } = original
          const doc: NoteFileDocument = !noteProvenance || (['hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(field => noteProvenance.resource[field] === resource![field]) ? original : bytes
          const parsed = parseNoteFile(doc)
          if (parsed.status !== 'valid') draft = { issue: 'Current draft is invalid for rich reading. Open the original Source to inspect the retained bytes.' }
          else if (parsed.note.noteId !== item.id) draft = { issue: 'Current draft has a different Note identity. Open the original to inspect its retained input.' }
          else draft = { document: doc, source: noteKnowledge([{ location: { workspaceId: resource!.workspaceId, path: resource!.path }, document: doc }]).sources[0]! }
        }
      }
      const itemSelectedBlocks = selectedBlocks.get(item.id) ?? NO_BLOCK_IDS
      const itemPageSelected = selectedPages.has(item.id)
      const selectionKey = JSON.stringify([itemPageSelected, itemSelectedBlocks])
      const choice = dirty ? versionChoices[item.id] : undefined
      const savedView = choice?.selection === selectionKey ? choice.saved : itemPageSelected || itemSelectedBlocks.length > 0
      const draftView = dirty && !savedView
      const heldResult = bodies.results[item.id]
      const ready = heldResult?.snapshot === snapshot ? heldResult : null
      const content = ready?.value
      const ambiguous = snapshot.graph.duplicateNoteIds.includes(item.id)
      const confirmed = content?.status === 'read' && noteContentMatchesGraph(snapshot, content) && !ambiguous && (item.kind !== 'shared-block' || item.observation?.status === 'read' && item.observation.fileIdentity === 'confirmed') ? content : null
      const confirmedDoc: NoteFileDocument | null = confirmed ? { path: confirmed.resource.path, content: confirmed.content, revision: confirmed.revision, ...(confirmed.noteProvenance ? { noteProvenance: confirmed.noteProvenance } : {}) } : null
      const savedSource = bodies.knowledge.sources.find(source => source.note.noteId === item.id)
        ?? (confirmedDoc && resource ? noteKnowledge([{ location: { workspaceId: resource.workspaceId, path: resource.path.endsWith('.note.md') ? resource.path : `${resource.path}.note.md` }, document: confirmedDoc }]).sources[0] : undefined)
      const readingSource = draftView ? (draft && 'source' in draft ? draft.source : undefined) : savedSource
      const readableDoc = draftView ? (draft && 'document' in draft ? draft.document : null) : confirmedDoc
      const empty = Boolean(readableDoc && readingSource && (readingSource.note.content.content ?? []).every(node => node.type === 'paragraph' && !node.content?.length))
      const whole = previews.has(item.id) || item.kind === 'shared-block'
      const itemBlockIds = requestedBlocks.get(item.id) ?? NO_BLOCK_IDS
      const summary = draftView || !whole && itemSelectedBlocks.length === 0 && (itemBlockIds.length === 0 || Boolean(savedSource) && itemBlockIds.every(id => savedSource!.blocks.get(id)?.content.type === 'noteInclude'))
      const readingMode: 'document' | 'summary' | 'related' = whole ? 'document' : summary ? 'summary' : 'related'
      const related = savedSource ? projectNoteBlocks(savedSource, itemBlockIds).rootBlockIds : NO_BLOCK_IDS
      const showAll = Boolean(expandedAllBlocks[item.id])
      const shown = [...new Set([...(showAll ? related : related.slice(0, 3)), ...itemSelectedBlocks])]
      const displayedIds = savedSource ? projectNoteBlocks(savedSource, shown).shownBlockIds : NO_BLOCK_IDS
      const remaining = confirmed && !draftView && !whole && !summary ? related.filter(id => !displayedIds.includes(id)) : NO_BLOCK_IDS
      const headingLabel = draftView ? whole ? 'Full note' : 'Summary' : whole ? item.kind === 'shared-block' ? 'Saved original' : 'Full saved note' : summary ? 'Summary' : `${related.length} related block${related.length === 1 ? '' : 's'}`
      const savedBadge = item.kind !== 'shared-block' ? (draftView ? 'Not saved' : 'Saved original') : null
      let stateMessage: string | null = null, stateActionLabel: string | null = null, onStateAction: (() => void) | undefined
      if (!readableDoc) {
        stateMessage = draftView
          ? (draft && 'issue' in draft ? draft.issue : 'Current draft is unavailable. Open the original to inspect its retained input.')
          : ambiguous
            ? 'Multiple original files share this Note identity. Open the registered original or refresh to confirm the source.'
            : item.kind === 'shared-block' && !canvasSharedObservation(snapshot, item.id)
              ? 'The shared file identity is unconfirmed. Refresh the graph to confirm its original.'
              : ready?.pending
                ? 'Reading saved original…'
                : !ready
                  ? 'This original is outside the automatic reading window for the current view. Read it to continue.'
                  : content?.status === 'read'
                    ? 'Saved snapshot changed. Refresh the graph to read the current original.'
                    : ready.issue ?? (content && 'message' in content ? content.message : 'Original body is unconfirmed.')
        if (draftView) {
          stateActionLabel = 'Open original'
          onStateAction = () => openOriginal(item.id)
        } else if (!ready?.pending) {
          stateActionLabel = content?.status === 'read' ? 'Refresh graph' : itemBlockIds.length ? 'Read related blocks' : 'Read original'
          onStateAction = content?.status === 'read' ? refresh : () => bodies.request(item.id)
        }
      }
      const bodyStatus: NoteAreaBodyStatus = {
        dirty,
        draftView,
        readingMode,
        headingLabel,
        savedBadge,
        emptyMessage: readableDoc && empty ? (draftView ? 'No content in current draft.' : 'No saved content yet.') : null,
        stateMessage,
        stateActionLabel,
        onStateAction,
        onChooseVersion: (saved: boolean) => setVersionChoices(prev => ({ ...prev, [item.id]: { selection: selectionKey, saved } })),
        remainingCount: remaining.length,
        onShowAll: () => setExpandedAllBlocks(prev => ({ ...prev, [item.id]: true })),
      }
      const blocks: { blockNodeId: string; blockId: string; topBlockIndex?: number; coveredBlockIds: string[]; portBlockIds: string[]; readingMode: 'document' | 'summary' | 'related'; previewBlockCount?: number; draftView: boolean; resource: NoteResource; readable: NoteFileDocument; source?: NoteSource; openable: boolean }[] = []
      const desiredPortBlockIds = new Set<string>()
      let unanchoredReadable: NoteFileDocument | null = null
      if (item.kind !== 'shared-block' && readableDoc && resource && !empty) {
        const allRootIds = readingSource ? projectNoteBlocks(readingSource, [...readingSource.blocks.keys()]).rootBlockIds : []
        if (!dirty && allRootIds.length === 0) {
          unanchoredReadable = readableDoc
        } else if (readingSource) {
          if (!whole && !summary) {
            const targetRoots = projectNoteBlocks(readingSource, shown).rootBlockIds
            for (const rootId of targetRoots) {
              const covered = projectNoteBlocks(readingSource, [rootId]).shownBlockIds
              const ports = !draftView && confirmed ? itemBlockIds.filter(id => covered.includes(id)) : []
              ports.forEach(id => desiredPortBlockIds.add(id))
              blocks.push({
                blockNodeId: noteCanvasBlockNodeId(item.id, rootId),
                blockId: rootId,
                coveredBlockIds: covered,
                portBlockIds: ports,
                readingMode,
                draftView,
                resource,
                readable: readableDoc,
                source: readingSource,
                openable,
              })
            }
          } else {
            const topNodes = readingSource.note.content.content ?? []
            const limit = whole ? topNodes.length : 3
            const collectIds = (node: typeof topNodes[number]): string[] => {
              const id = typeof node.attrs?.blockId === 'string' ? [node.attrs.blockId] : []
              return [...id, ...(node.content ?? []).flatMap(collectIds)]
            }
            for (const [topIndex, topNode] of topNodes.entries()) {
              const alwaysShow = topNode.type === 'noteInclude' || topNode.type === 'blockReference'
              if (topIndex >= limit && !alwaysShow) continue
              const directId = typeof topNode.attrs?.blockId === 'string' ? topNode.attrs.blockId : undefined
              const subtreeIds = collectIds(topNode), subtreeSet = new Set(subtreeIds)
              const subRoots = allRootIds.filter(id => subtreeSet.has(id))
              if (directId && readingSource.blocks.has(directId)) {
                const covered = projectNoteBlocks(readingSource, [directId]).shownBlockIds
                const ports = !draftView && confirmed ? itemBlockIds.filter(id => covered.includes(id)) : []
                ports.forEach(id => desiredPortBlockIds.add(id))
                blocks.push({
                  blockNodeId: noteCanvasBlockNodeId(item.id, directId),
                  blockId: directId,
                  coveredBlockIds: covered,
                  portBlockIds: ports,
                  readingMode,
                  draftView,
                  resource,
                  readable: readableDoc,
                  source: readingSource,
                  openable,
                })
              } else if (subRoots.length > 0 && ['bulletList', 'orderedList', 'taskList'].includes(topNode.type ?? '') && (topNode.content ?? []).every(itemNode => typeof itemNode.attrs?.blockId === 'string')) {
                for (const rootId of subRoots) {
                  const covered = projectNoteBlocks(readingSource, [rootId]).shownBlockIds
                  const ports = !draftView && confirmed ? itemBlockIds.filter(id => covered.includes(id)) : []
                  ports.forEach(id => desiredPortBlockIds.add(id))
                  blocks.push({
                    blockNodeId: noteCanvasBlockNodeId(item.id, rootId),
                    blockId: rootId,
                    coveredBlockIds: covered,
                    portBlockIds: ports,
                    readingMode,
                    draftView,
                    resource,
                    readable: readableDoc,
                    source: readingSource,
                    openable,
                  })
                }
              } else {
                const syntheticId = `block-${topIndex + 1}`
                const ports = !draftView && confirmed ? itemBlockIds.filter(id => subtreeSet.has(id)) : []
                ports.forEach(id => desiredPortBlockIds.add(id))
                blocks.push({
                  blockNodeId: noteCanvasBlockNodeId(item.id, syntheticId),
                  blockId: syntheticId,
                  topBlockIndex: topIndex,
                  coveredBlockIds: subtreeIds,
                  portBlockIds: ports,
                  readingMode,
                  draftView,
                  resource,
                  readable: readableDoc,
                  source: readingSource,
                  openable,
                })
              }
            }
          }
        }
      } else if (item.kind === 'shared-block' && confirmedDoc && savedSource && resource && !empty) {
        for (const id of itemBlockIds) if (savedSource.blocks.has(id)) desiredPortBlockIds.add(id)
      }
      result.set(item.id, {
        bodyStatus,
        ...(item.kind === 'shared-block' || unanchoredReadable ? { sharedReadable: item.kind === 'shared-block' ? readableDoc : unanchoredReadable, ...(resource ? { sharedResource: resource } : {}) } : {}),
        blocks,
        desiredPortBlockIds,
      })
    }
    return result
  }, [snapshot, projection.notes, dirtyFlags, dirtyDocs, selectedBlocks, selectedPages, versionChoices, bodies.knowledge.sources, bodies.results, bodies.request, previews, requestedBlocks, expandedAllBlocks, openOriginal, refresh])

  const visibleBlockMap = useMemo(() => {
    const map = new Map<string, Map<string, string>>()
    if (!active || !snapshot) return map
    for (const [blockNodeId, entry] of Object.entries(registeredBlockPorts)) {
      if (entry.snapshot !== snapshot || snapshot.graph.duplicateNoteIds.includes(entry.noteId)) continue
      const desired = areaProjections.get(entry.noteId)?.desiredPortBlockIds
      if (!desired) continue
      for (const blockId of entry.ids) {
        if (!desired.has(blockId)) continue
        const byBlock = map.get(entry.noteId) ?? new Map<string, string>()
        byBlock.set(blockId, blockNodeId)
        map.set(entry.noteId, byBlock)
      }
    }
    return map
  }, [active, snapshot, registeredBlockPorts, areaProjections])

  const attachedRelationships = useMemo(() => attachNoteCanvasRelationships(projection.relationships, visibleBlockMap), [projection.relationships, visibleBlockMap])
  const effectiveFocusTarget = useMemo<CanvasFocusTarget | null>(() => {
    if (inspected?.kind === 'relationship' && (inspectedReferences.length > 0 || relationship?.kind === 'hierarchy')) {
      return { kind: 'relationship', relationshipId: inspected.id, occurrences: inspected.occurrences }
    }
    return focusedTarget ?? peekedTarget
  }, [inspected, inspectedReferences.length, relationship?.kind, focusedTarget, peekedTarget])
  const neighborhood = useMemo(() => noteCanvasFocusNeighborhood(projection, attachedRelationships, effectiveFocusTarget), [projection, attachedRelationships, effectiveFocusTarget])

  useEffect(() => {
    if (!snapshot) return
    setNodes(held => {
      const byId = new Map(held.map(node => [node.id, node]))
      const positions = initialCanvasPositions(projection.notes.map(item => item.id), refs.current.layout.positions)
      const visibleNoteIds = new Set(projection.notes.map(item => item.id))
      const usedBlockNodeIds = new Set<string>()
      for (const edge of attachedRelationships) {
        if (edge.sourceNodeId !== edge.source) usedBlockNodeIds.add(edge.sourceNodeId)
        if (edge.targetNodeId !== edge.target) usedBlockNodeIds.add(edge.targetNodeId)
      }
      const nextNodes: CanvasNode[] = []
      const childBlockNodes: CanvasBlockNode[] = []
      for (const item of projection.notes) {
        const emphasis: CanvasEmphasis = !neighborhood.active ? 'normal' : neighborhood.noteIds.has(item.id) ? 'related' : 'muted'
        const focusedBlockIds = neighborhood.blockIdsByNote.get(item.id) ? [...neighborhood.blockIdsByNote.get(item.id)!] : NO_BLOCK_IDS
        const itemSelectedBlocks = selectedBlocks.get(item.id) ?? NO_BLOCK_IDS
        const highlightedBlockIds = itemSelectedBlocks.length ? itemSelectedBlocks : focusedBlockIds
        const areaInfo = areaProjections.get(item.id)
        const blockSpecs = areaInfo?.blocks ?? []
        const headerOffset = areaInfo?.bodyStatus?.dirty ? 184 : 116
        const cols = blockSpecs.length >= 2 ? 2 : 1
        const rowHeights: number[] = []
        for (const [index, spec] of blockSpecs.entries()) {
          const row = Math.floor(index / cols)
          const existing = byId.get(spec.blockNodeId)
          const h = existing?.measured?.height ?? BLOCK_H
          rowHeights[row] = Math.max(rowHeights[row] ?? BLOCK_H, h)
        }
        const rowTops: number[] = []
        let cursorY = headerOffset
        for (let r = 0; r < rowHeights.length; r++) {
          rowTops[r] = cursorY
          cursorY += rowHeights[r]! + BLOCK_GAP_Y
        }
        const memberBoxes: CollaborationLayoutBox[] = []
        for (const [index, spec] of blockSpecs.entries()) {
          const existing = byId.get(spec.blockNodeId)
          const savedPos = refs.current.layout.positions[spec.blockNodeId]
          const row = Math.floor(index / cols), col = index % cols
          const defaultPos = {
            x: AREA_PAD_X + col * (BLOCK_W + BLOCK_GAP_X),
            y: rowTops[row] ?? headerOffset,
          }
          const pos = existing?.dragging && existing.position ? existing.position : savedPos ?? defaultPos
          const width = existing?.measured?.width ?? BLOCK_W
          const height = existing?.measured?.height ?? BLOCK_H
          memberBoxes.push({ id: spec.blockNodeId, areaId: item.id, kind: 'agent', folded: false, x: pos.x, y: pos.y, width, height })
          const blockEmphasis: CanvasEmphasis = !neighborhood.active ? 'normal'
            : spec.coveredBlockIds.some(id => highlightedBlockIds.includes(id)) || neighborhood.noteIds.has(item.id) ? 'related' : 'muted'
          const blockSelected = spec.coveredBlockIds.filter(id => itemSelectedBlocks.includes(id))
          childBlockNodes.push({
            ...(existing as CanvasBlockNode | undefined),
            id: spec.blockNodeId,
            type: 'block',
            parentId: item.id,
            position: pos,
            dragHandle: '.note-canvas-block-drag',
            data: {
              noteId: item.id,
              blockId: spec.blockId,
              ...(spec.topBlockIndex !== undefined ? { topBlockIndex: spec.topBlockIndex } : {}),
              coveredBlockIds: spec.coveredBlockIds,
              portBlockIds: spec.portBlockIds,
              desired: true,
              active,
              draftView: spec.draftView,
              readingMode: spec.readingMode,
              ...(spec.previewBlockCount !== undefined ? { previewBlockCount: spec.previewBlockCount } : {}),
              emphasis: blockEmphasis,
              highlightedBlockIds: blockSelected.length ? blockSelected : NO_BLOCK_IDS,
              resource: spec.resource,
              readable: spec.readable,
              source: spec.source,
              openable: spec.openable,
              snapshot,
              documents: bodies.documents,
              onBlockPorts: recordBlockPorts,
              onRead: bodies.request,
              onOpen: openOriginal,
              onOpenLink,
              onFocusBlock: focusBlock,
              onPeekBlock: peekBlock,
            },
          })
        }
        const stageWidth = memberBoxes.length ? Math.max(BLOCK_W, Math.max(...memberBoxes.map(b => b.x + b.width)) - AREA_PAD_X) : BLOCK_W
        const stageBottom = memberBoxes.length ? Math.max(...memberBoxes.map(b => b.y + b.height)) : headerOffset
        const stageHeight = memberBoxes.length ? Math.max(BLOCK_H, stageBottom - headerOffset + 16) : 0
        const areaWidth = stageWidth + AREA_PAD_X * 2
        const areaHeight = stageBottom + AREA_FOOTER_H
        const envelope = collaborationEnvelope(
          { id: item.id, areaId: item.id, kind: 'area', folded: false, x: 0, y: 0, width: areaWidth, height: areaHeight, heading: { x: AREA_PAD_X, y: 12, width: areaWidth - AREA_PAD_X * 2, height: headerOffset - 16 } },
          memberBoxes.length ? [...memberBoxes, { id: `${item.id}:footer`, areaId: item.id, kind: 'agent', folded: false, x: AREA_PAD_X, y: stageBottom + 8, width: areaWidth - AREA_PAD_X * 2, height: AREA_FOOTER_H - 16 }] : [],
        )
        const existingNote = byId.get(item.id) as CanvasNoteNode | undefined
        nextNodes.push({
          ...existingNote,
          id: item.id,
          type: 'note',
          position: existingNote?.position ?? positions[item.id]!,
          dragHandle: '.note-canvas-drag',
          data: {
            item,
            snapshot,
            active,
            selectedBlockIds: itemSelectedBlocks,
            focusedBlockIds,
            pageSelected: selectedPages.has(item.id),
            emphasis,
            content: bodies.results[item.id],
            source: bodies.knowledge.sources.find(source => source.note.noteId === item.id),
            documents: bodies.documents,
            onRead: bodies.request,
            onVisible: reportVisibility,
            expanded: expanded.has(item.id),
            preview: previews.has(item.id),
            blockIds: requestedBlocks.get(item.id) ?? NO_BLOCK_IDS,
            areaWidth,
            areaHeight,
            stageHeight,
            envelope,
            bodyStatus: areaInfo?.bodyStatus ?? null,
            ...(areaInfo?.sharedReadable !== undefined ? { sharedReadable: areaInfo.sharedReadable } : {}),
            ...(areaInfo?.sharedResource !== undefined ? { sharedResource: areaInfo.sharedResource } : {}),
            sharedPortBlockIds: item.kind === 'shared-block' && areaInfo ? [...areaInfo.desiredPortBlockIds] : NO_BLOCK_IDS,
            onBlockPorts: recordBlockPorts,
            onOpen: openOriginal,
            onOpenLink,
            onNeighbors: toggleNeighbors,
            onPreview: togglePreview,
            onUnbound: inspectUnbound,
            onFocusBlock: focusBlock,
            onPeekNote: peekNote,
            refresh,
          },
        })
      }
      // Retain any retiring Block node for one frame while an edge is still attached to it.
      const mountedBlockIds = new Set(childBlockNodes.map(node => node.id))
      for (const old of held) {
        if (old.type === 'block' && !mountedBlockIds.has(old.id) && visibleNoteIds.has(old.data.noteId) && usedBlockNodeIds.has(old.id)) {
          childBlockNodes.push({ ...old, data: { ...old.data, desired: false, portBlockIds: NO_BLOCK_IDS } })
        }
      }
      return [...nextNodes, ...childBlockNodes]
    })
  }, [projection, snapshot, active, expanded, previews, requestedBlocks, areaProjections, attachedRelationships, recordBlockPorts, openOriginal, onOpenLink, inspectUnbound, focusBlock, peekNote, peekBlock, toggleNeighbors, togglePreview, refresh, bodies.results, bodies.knowledge, bodies.documents, bodies.request, reportVisibility, selectedBlocks, selectedPages, neighborhood])

  const edges = useMemo<CanvasEdge[]>(() => {
    const pairs = new Map<string, CanvasAttachedRelationship[]>(), pairKey = (source: string, target: string) => JSON.stringify([source, target].sort())
    for (const relationship of attachedRelationships) {
      const key = pairKey(relationship.source, relationship.target), held = pairs.get(key) ?? []
      held.push(relationship); pairs.set(key, held)
    }
    const byId = new Map(nodes.map(node => [node.id, node]))
    const worldBox = (id: string) => {
      const node = byId.get(id)
      if (!node) return { x: 0, y: 0, height: 154 }
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      return {
        x: (parent?.position.x ?? 0) + node.position.x,
        y: (parent?.position.y ?? 0) + node.position.y,
        height: node.measured?.height ?? (node.type === 'block' ? BLOCK_H : 154),
      }
    }
    return attachedRelationships.map(relationship => {
      // Both directions and every relation kind share one lane allocator, so reciprocal labels never coincide.
      const peers = pairs.get(pairKey(relationship.source, relationship.target))!.sort((a, b) => a.id.localeCompare(b.id))
      const lane = peers.findIndex(peer => peer.id === relationship.id)
      const offset = relationship.source === relationship.target ? (lane + 1) * 58 : (lane - (peers.length - 1) / 2) * 58
      const sourceBox = worldBox(relationship.sourceNodeId), targetBox = worldBox(relationship.targetNodeId)
      const rightward = sourceBox.x <= targetBox.x
      const sourceNote = byId.get(relationship.source) as CanvasNoteNode | undefined
      const targetNote = byId.get(relationship.target) as CanvasNoteNode | undefined
      const labelBaseline = relationship.source === relationship.target ? (sourceNote?.position.y ?? sourceBox.y) - 50
        : ((sourceNote?.position.y ?? sourceBox.y) + (sourceNote?.measured?.height ?? 154) / 2 + (targetNote?.position.y ?? targetBox.y) + (targetNote?.measured?.height ?? 154) / 2) / 2
      const selected = relationship.references.some(reference => inspectedReferences.some(selected => noteGraphReferenceSelectionKey(reference) === noteGraphReferenceSelectionKey(selected)))
        || (inspected?.kind === 'relationship' && inspected.id === relationship.aggregateId && relationship.kind === 'hierarchy')
      const emphasis: CanvasEmphasis = !neighborhood.active ? 'normal' : selected || neighborhood.relationshipIds.has(relationship.id) ? 'related' : 'muted'
      return {
        id: relationship.id,
        source: relationship.sourceNodeId,
        target: relationship.targetNodeId,
        type: 'relationship',
        sourceHandle: relationship.sourceBlockId ? noteCanvasBlockHandle(relationship.sourceBlockId, 'out', rightward ? 'right' : 'left') : `${relationship.sourceKind}-out-${rightward ? 'right' : 'left'}`,
        targetHandle: relationship.targetBlockId ? noteCanvasBlockHandle(relationship.targetBlockId, 'in', rightward ? 'left' : 'right') : `${relationship.targetKind}-in-${rightward ? 'left' : 'right'}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: relationship.kind === 'hierarchy' ? 'var(--text-3)' : relationship.kind === 'embed' ? 'var(--green)' : 'var(--blue)' },
        data: {
          selected,
          focused: inspectedReferences.length > 0,
          emphasis,
          relationship,
          inspect: inspectRelationship,
          offset,
          labelBaseline,
          sourceTitle: sourceNote ? canvasNoteTitle(sourceNote.data.item, sourceNote.data.source) : 'Uncatalogued note',
          targetTitle: targetNote ? canvasNoteTitle(targetNote.data.item, targetNote.data.source) : 'Uncatalogued note',
          targetShared: targetNote?.data.item.kind === 'shared-block',
        },
        selectable: false,
        deletable: false,
      }
    })
  }, [attachedRelationships, nodes, snapshot, inspectRelationship, inspected, inspectedReferences, neighborhood])

  const topology = JSON.stringify([projection.notes.map(item => item.id), projection.relationships.map(edge => edge.id)])
  const stage = useRef<HTMLDivElement>(null)
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
        const root = seeds[0] ?? projection.notes[0]!.id
        const node = flow.getNode(root)
        if (!node) { initialized.current = false; return }
        // Read the seed Note first. Explicit Fit remains available for an overview of every node.
        const neighbors = projection.relationships.flatMap(edge => edge.source === root ? [edge.target] : edge.target === root ? [edge.source] : [])
        const nearest = [...new Set(neighbors)].filter(id => id !== root).flatMap(id => { const candidate = flow.getNode(id); return candidate ? [candidate] : [] })
          .sort((a, b) => Math.hypot(a.position.x - node.position.x, a.position.y - node.position.y) - Math.hypot(b.position.x - node.position.x, b.position.y - node.position.y))[0]
        let left = node.position.x, top = node.position.y
        if (nearest && stage.current) {
          const width = Math.max(node.position.x + (node.measured?.width ?? 320), nearest.position.x + (nearest.measured?.width ?? 320)) - Math.min(node.position.x, nearest.position.x)
          const height = Math.max(node.position.y + (node.measured?.height ?? 480), nearest.position.y + (nearest.measured?.height ?? 480)) - Math.min(node.position.y, nearest.position.y)
          left = Math.min(left, nearest.position.x); top = Math.min(top, nearest.position.y)
          if (width + 48 > stage.current.clientWidth || height + 48 > stage.current.clientHeight) {
            const zoom = Math.max(.85, Math.min(1, (stage.current.clientWidth - 48) / width, (stage.current.clientHeight - 48) / height))
            const x = Math.max(24 - node.position.x * zoom, Math.min((stage.current.clientWidth - width * zoom) / 2 - left * zoom, stage.current.clientWidth - 24 - (node.position.x + (node.measured?.width ?? 320)) * zoom))
            const y = Math.max(24 - node.position.y * zoom, Math.min((stage.current.clientHeight - height * zoom) / 2 - top * zoom, stage.current.clientHeight - 24 - (node.position.y + (node.measured?.height ?? 480)) * zoom))
            if (nearest.position.x * zoom + x < stage.current.clientWidth && (nearest.position.x + (nearest.measured?.width ?? 320)) * zoom + x > 0 && nearest.position.y * zoom + y < stage.current.clientHeight && (nearest.position.y + (nearest.measured?.height ?? 480)) * zoom + y > 0) {
              void flow.setViewport({ x, y, zoom }); return
            }
            left = node.position.x; top = node.position.y
          }
        }
        void flow.setViewport({ x: 24 - left, y: 24 - top, zoom: 1 })
      })
    }
    if (!force && projection.notes.every(note => held[note.id])) { frameInitial(); return }
    let worker: Worker
    try { worker = new Worker(new URL('../lib/note-canvas-layout.worker.ts', import.meta.url), { type: 'module' }) }
    catch { setLayoutIssue('Automatic layout could not start. You can still move Notes; retry Arrange.'); frameInitial(); return }
    const id = mintObjectId(), input: CanvasLayoutInput = { nodes: projection.notes.map(note => {
      const node = refs.current.nodes.find((candidate): candidate is CanvasNoteNode => candidate.type === 'note' && candidate.id === note.id)
      return { id: note.id, width: node?.data.areaWidth ?? node?.measured?.width ?? 320, height: node?.data.areaHeight ?? node?.measured?.height ?? 480, ...(note.hostNoteId ? { areaId: note.hostNoteId } : {}) }
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
      if (force) for (const key of Object.keys(positions)) if (key.startsWith('block:')) delete positions[key]
      const heldPoints = Object.entries(fresh).filter(([key]) => !key.startsWith('block:')).map(([, point]) => point)
      const missing = projection.notes.filter(note => !fresh[note.id])
      const offsetY = !force && heldPoints.length && missing.length ? Math.max(...heldPoints.map(point => point.y)) + 480 - Math.min(...missing.map(note => next[note.id]!.y)) : 0
      for (const note of projection.notes) if (force || !fresh[note.id]) positions[note.id] = { x: next[note.id]!.x, y: next[note.id]!.y + offsetY }
      setNodes(values => values.map(node => node.type === 'note' ? ({ ...node, position: positions[node.id] ?? node.position }) : node))
      refs.current.save({ positions }); setLayoutIssue(null); arranged.current = arrangeAttempt
      frameInitial()
    }
    worker.onerror = () => { worker.terminate(); if (current) { setArranging(false); setLayoutIssue('Automatic layout stopped. Move Notes freely or retry Arrange.') } }
    worker.postMessage({ id, input })
    return () => { cancel(); if (cancelArrangement.current === cancel) cancelArrangement.current = null }
    // Layout runs only for topology changes or an explicit Arrange, never body measurement or dragging.
  }, [active, topology, arrangeAttempt, flow, seeds])
  const sourceGroups = new Map<string, CanvasReference[]>()
  for (const reference of inspectedReferences) {
    const key = JSON.stringify([reference.sourceResource, reference.source]), group = sourceGroups.get(key) ?? []
    group.push(reference); sourceGroups.set(key, group)
  }
  const pageFor = (id: string) => snapshot?.catalog.pages[id]
  const visiblePages = projection.notes.flatMap(item => item.page ? [item.page] : [])
  const titleFor = (id: string) => { const node = nodes.find((candidate): candidate is CanvasNoteNode => candidate.type === 'note' && candidate.id === id); return node ? canvasNoteTitle(node.data.item, node.data.source) : pageFor(id)?.title ?? 'Unconfirmed original' }
  function persistViewport() { if (flow) save({ viewport: flow.getViewport() }) }
  return <section className="note-canvas" aria-label="Note relationship canvas" data-scope={scope.kind} data-active={active}>
    <div className="note-canvas-toolbar"><div className="note-canvas-summary"><RelationshipsIcon size={14} /><strong>Relationships</strong><span>{projection.notes.filter(item => item.kind !== 'shared-block').length} note{projection.notes.filter(item => item.kind !== 'shared-block').length === 1 ? '' : 's'}{projection.notes.some(item => item.kind === 'shared-block') && ` · ${projection.notes.filter(item => item.kind === 'shared-block').length} shared block${projection.notes.filter(item => item.kind === 'shared-block').length === 1 ? '' : 's'}`}</span></div>
      <div className="note-canvas-tools" role="group" aria-label="Canvas tools"><button type="button" className="note-canvas-tool-text" aria-label="Show related notes" title="Show incoming and outgoing neighbors of the notes in this view" onClick={() => save({ expandedNoteIds: [...new Set([...layout.expandedNoteIds, ...seeds])] })}><RelationshipsIcon size={14} /><span>Show related</span></button><button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => { void flow?.zoomOut({ duration: 150 }).then(persistViewport) }}><MinusIcon size={15} /></button><button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => { void flow?.zoomIn({ duration: 150 }).then(persistViewport) }}><PlusIcon size={15} /></button>
        <button type="button" title="Fit visible notes" aria-label="Fit visible notes" onClick={() => { void flow?.fitView({ padding: .15, maxZoom: 1, duration: 200 }).then(persistViewport) }}><FitIcon size={14} /></button>
        <button type="button" className="note-canvas-tool-text" aria-label="Arrange notes" onClick={() => arrange(value => value + 1)} aria-busy={arranging}><ArrangeIcon size={14} /><span>{arranging ? 'Arranging…' : 'Arrange'}</span></button>
        <button type="button" title="Refresh saved graph" aria-label="Refresh saved graph" aria-busy={busy} onClick={refresh}><RefreshIcon size={14} /></button></div></div>
    {issue || stale || storageIssue || layoutIssue || navigationIssue ? <div className="note-canvas-notice" role="status">{issue ? `Graph observation failed: ${issue}. Your last view is kept.` : stale ? 'The directory changed. This saved graph is kept until you refresh.' : null}
      {navigationIssue && <span>{navigationIssue}</span>}{storageIssue && <span>{storageIssue}</span>}{layoutIssue && <span>{layoutIssue}</span>}
      {issue || stale ? <button type="button" onClick={refresh}>Refresh graph</button> : null}{storageIssue && <button type="button" onClick={retry}>Retry saving layout</button>}{layoutIssue && <button type="button" onClick={() => arrange(value => value + 1)}>Retry Arrange</button>}</div> : null}
    <NotebookDirectoryContextMenu pages={visiblePages} onTalk={onTalk}><div className="note-canvas-stage" ref={stage}>
      <ReactFlow<CanvasNode, CanvasEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onEdgeClick={(_event, edge) => { if (edge.data) inspectRelationship(edge.data.relationship) }}
        onPaneClick={() => setFocusedTarget(null)}
        onNodesChange={(changes: NodeChange<CanvasNode>[]) => {
          // A newer manual gesture supersedes even a queued worker reply from an explicit Arrange.
          if (changes.some(change => change.type === 'position' && change.position)) { cancelArrangement.current?.(); cancelArrangement.current = null; arranged.current = arrangeAttempt }
          const selectedChange = changes.find((change): change is Extract<NodeChange<CanvasNode>, { type: 'select' }> => change.type === 'select' && change.selected)
          if (selectedChange) {
            const targetNode = refs.current.nodes.find(node => node.id === selectedChange.id)
            if (targetNode?.type === 'block') setFocusedTarget({ kind: 'block', noteId: targetNode.data.noteId, blockId: targetNode.data.blockId })
            else if (targetNode?.type === 'note') setFocusedTarget({ kind: 'note', noteId: targetNode.id })
          }
          const currentById = new Map(refs.current.nodes.map(node => [node.id, node]))
          const movingIds = new Set(changes.flatMap(change => change.type === 'position' && change.position ? [change.id] : []))
          const memberShifts = new Map<string, { x: number; y: number }>()
          for (const change of changes) {
            if (change.type !== 'position' || !change.position) continue
            const previous = currentById.get(change.id)
            if (!previous) continue
            const dx = change.position.x - previous.position.x, dy = change.position.y - previous.position.y
            if (!dx && !dy) continue
            for (const item of refs.current.projection.notes) {
              if (item.hostNoteId === change.id && !movingIds.has(item.id)) {
                const member = currentById.get(item.id)
                if (member) memberShifts.set(item.id, { x: member.position.x + dx, y: member.position.y + dy })
              }
            }
          }
          setNodes(held => {
            const updated = applyNodeChanges(changes, held)
            const shifted = memberShifts.size ? updated.map(node => memberShifts.has(node.id) ? { ...node, position: memberShifts.get(node.id)! } : node) : updated
            const blockMoved = changes.some(change => change.type === 'position' && currentById.get(change.id)?.type === 'block')
            if (!blockMoved && !changes.some(change => change.type === 'dimensions')) return shifted
            const blocksByNote = new Map<string, CanvasBlockNode[]>()
            for (const node of shifted) {
              if (node.type === 'block' && node.data.desired) {
                const list = blocksByNote.get(node.data.noteId) ?? []
                list.push(node); blocksByNote.set(node.data.noteId, list)
              }
            }
            const nextBlockPos = new Map<string, { x: number; y: number }>()
            const nextAreaMetrics = new Map<string, { areaWidth: number; areaHeight: number; stageHeight: number; envelope: string }>()
            for (const [noteId, blocks] of blocksByNote) {
              const noteNode = shifted.find((n): n is CanvasNoteNode => n.type === 'note' && n.id === noteId)
              if (!noteNode) continue
              const headerOffset = noteNode.data.bodyStatus?.dirty ? 184 : 116
              const cols = blocks.length >= 2 ? 2 : 1
              const rowHeights: number[] = []
              blocks.forEach((b, idx) => {
                const r = Math.floor(idx / cols), h = b.measured?.height ?? BLOCK_H
                rowHeights[r] = Math.max(rowHeights[r] ?? BLOCK_H, h)
              })
              const rowTops: number[] = []
              let cursorY = headerOffset
              for (let r = 0; r < rowHeights.length; r++) { rowTops[r] = cursorY; cursorY += rowHeights[r]! + BLOCK_GAP_Y }
              const memberBoxes: CollaborationLayoutBox[] = []
              blocks.forEach((b, idx) => {
                const savedPos = refs.current.layout.positions[b.id]
                const pos = b.dragging ? b.position : savedPos ?? { x: AREA_PAD_X + (idx % cols) * (BLOCK_W + BLOCK_GAP_X), y: rowTops[Math.floor(idx / cols)] ?? headerOffset }
                nextBlockPos.set(b.id, pos)
                memberBoxes.push({ id: b.id, areaId: noteId, kind: 'agent', folded: false, x: pos.x, y: pos.y, width: b.measured?.width ?? BLOCK_W, height: b.measured?.height ?? BLOCK_H })
              })
              const stageWidth = Math.max(BLOCK_W, Math.max(...memberBoxes.map(b => b.x + b.width)) - AREA_PAD_X)
              const stageBottom = Math.max(...memberBoxes.map(b => b.y + b.height))
              const stageHeight = Math.max(BLOCK_H, stageBottom - headerOffset + 16)
              const areaWidth = stageWidth + AREA_PAD_X * 2
              const areaHeight = stageBottom + AREA_FOOTER_H
              const envelope = collaborationEnvelope(
                { id: noteId, areaId: noteId, kind: 'area', folded: false, x: 0, y: 0, width: areaWidth, height: areaHeight, heading: { x: AREA_PAD_X, y: 12, width: areaWidth - AREA_PAD_X * 2, height: headerOffset - 16 } },
                [...memberBoxes, { id: `${noteId}:footer`, areaId: noteId, kind: 'agent', folded: false, x: AREA_PAD_X, y: stageBottom + 8, width: areaWidth - AREA_PAD_X * 2, height: AREA_FOOTER_H - 16 }],
              )
              nextAreaMetrics.set(noteId, { areaWidth, areaHeight, stageHeight, envelope })
            }
            return shifted.map(node => {
              if (node.type === 'block' && nextBlockPos.has(node.id)) return { ...node, position: nextBlockPos.get(node.id)! }
              if (node.type === 'note' && nextAreaMetrics.has(node.id)) return { ...node, data: { ...node.data, ...nextAreaMetrics.get(node.id)! } }
              return node
            })
          })
          const completed = changes.filter(change => change.type === 'position' && change.position && change.dragging === false)
          if (completed.length) {
            const positions = { ...refs.current.layout.positions }
            for (const change of completed) {
              if (change.type !== 'position' || !change.position) continue
              positions[change.id] = change.position
              for (const item of refs.current.projection.notes) {
                if (item.hostNoteId === change.id) {
                  const memberPos = memberShifts.get(item.id) ?? currentById.get(item.id)?.position
                  if (memberPos) positions[item.id] = memberPos
                }
              }
            }
            save({ positions })
          }
        }}
        onMoveStart={event => { if (event) viewportTouched.current = true }}
        onMoveEnd={(event: globalThis.MouseEvent | TouchEvent | null, viewport: Viewport) => { if (event) { viewportTouched.current = true; save({ viewport }) } }} defaultViewport={layout.viewport ?? { x: 32, y: 40, zoom: 1 }}
        minZoom={.15} maxZoom={1.8} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} panOnDrag={[0, 1]} selectionOnDrag={false} zoomOnDoubleClick={false}
        onlyRenderVisibleElements={false} proOptions={{ hideAttribution: false }} aria-label="Infinite note canvas">
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--line)" />
      </ReactFlow>
      {!snapshot ? <div className="note-canvas-empty" role="status"><RelationshipsIcon size={24} /><strong>{busy ? 'Reading saved relationships…' : 'Graph not yet observed'}</strong><span>Original Notes stay in their files.</span>{!busy && <button type="button" onClick={refresh}>Read graph</button>}</div> : !projection.notes.length ? <div className="note-canvas-empty" role="status"><strong>No notes in this view</strong><span>Clear the page filter or choose another Notebook.</span></div> : null}
      {(relationship || unboundNote || selectionExpired) && snapshot ? <aside className="note-canvas-inspector nodrag nopan nowheel" aria-label="Relationship details"><header><strong>{selectionExpired ? 'Selection changed' : relationship?.kind === 'hierarchy' ? 'Directory hierarchy' : unboundNote ? 'Unbound links' : `${inspectedReferences.length}${relationship?.kind === 'link' ? '' : ' block'} ${relationship?.kind}${inspectedReferences.length === 1 ? '' : 's'}`}</strong><button type="button" aria-label="Close relationship details" onClick={() => inspect(null)}><CloseIcon size={14} /></button></header>
        {relationship ? <p>{titleFor(relationship.source)}<span>→</span>{titleFor(relationship.target)}</p> : unboundNote ? <p>{unboundNote.title}<span>No destination identity confirmed</span></p> : null}
        {expiredCount > 0 && !selectionExpired && <p role="status">{expiredCount} selected occurrence{expiredCount === 1 ? '' : 's'} changed or disappeared. {inspectedReferences.length} unchanged occurrence{inspectedReferences.length === 1 ? '' : 's'} remain selected.</p>}
        {selectionExpired ? <p role="status">The selected original occurrence is no longer in this saved graph. Select a relationship again.</p> : relationship?.kind === 'hierarchy' ? <div className="note-canvas-inspector-actions"><button type="button" onClick={() => openOriginal(relationship.source)}>Open parent</button><button type="button" onClick={() => openOriginal(relationship.target)}>Open subpage</button></div> : <ol>{[...sourceGroups].map(([key, references]) => <ReferenceDetails key={key} notes={projection.notes} references={references} snapshot={snapshot} bodies={bodies} onOpen={openOriginal} refresh={refresh} onOpenLink={onOpenLink} />)}</ol>}
      </aside> : null}
    </div></NotebookDirectoryContextMenu>
    <div className="note-canvas-caption"><span className="note-canvas-legend"><i />Subpage<i data-link />Link<i data-reference />Reference<i data-embed />Included content</span><span role="status">{snapshot ? `${snapshot.graph.completeness === 'complete' ? 'Saved relationships' : `${snapshot.graph.completeness === 'partial' ? 'Partial' : 'Unconfirmed'} coverage`}${projection.unbound.length > 0 ? ` · ${projection.unbound.length} visible unbound links` : ''}${busy ? ' · Refreshing…' : ''}` : 'Saved-file graph'}</span>{snapshot && <details className="note-canvas-source-details"><summary>Source details</summary><span>{snapshot.graph.observations.filter(value => value.status === 'read').length}/{snapshot.graph.observations.length} originals read · catalog r{snapshot.catalog.revision}</span></details>}</div>
    {linkNavigation.dialog}
  </section>
}
