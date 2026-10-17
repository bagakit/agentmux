import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteResource, NotebookPage } from '@agentmux/core/notebook-catalog'
import type { NoteContentObservation, NoteGraphReference } from '@agentmux/core/notebook-observation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { noteContentMatchesGraph, type NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { api } from '../lib/api'
import { noteKnowledge } from '../lib/note-knowledge'
import { canvasSharedObservation } from '../lib/note-canvas-model'
import { sameNoteResource } from '../lib/notebook-library'
import type { NoteFileTarget } from '../lib/file-document-consumers'
import { NoteSharedDetails } from './NoteSharedDetails'
import { noteGraphReferenceKey, noteGraphReferenceLabel, projectNoteLinks } from '../lib/note-graph-references'
import { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'
import '../styles/note-links.css'

const Disclosure = semanticIconComponent('navigation.disclosure'), Refresh = semanticIconComponent('action.refresh')
const NoteIcon = semanticIconComponent('object.note'), LinkIcon = semanticIconComponent('object.link')
type OpenNote = (page: NotebookPage, blockId?: string, signal?: AbortSignal) => void | Promise<void>
type OpenFile = (file: NoteFileTarget, blockId?: string, signal?: AbortSignal) => Promise<void>
type Navigate = (noteId: string, resource: NoteResource, blockId?: string) => void
export type NoteLinksPanelProps = { noteId: string; active?: boolean; selectedBlockId?: string | undefined; onOpen: OpenNote; onOpenFile?: OpenFile | undefined }

function destination(snapshot: NotebookGraphSnapshot, noteId: string) {
  const page = snapshot.catalog.pages[noteId], shared = canvasSharedObservation(snapshot, noteId)
  return page ? { resource: page.resource, title: page.title } : shared ? { resource: shared.resource, title: 'Shared content' } : undefined
}

function LinkActions({ reference, snapshot, navigate }: { reference: NoteGraphReference; snapshot: NotebookGraphSnapshot; navigate: Navigate }) {
  const target = reference.target, to = target.kind !== 'unbound' ? destination(snapshot, target.noteId) : undefined
  return <div className="note-links-actions"><button type="button" onClick={() => navigate(reference.source.noteId, reference.sourceResource, reference.source.blockId)}>Open source block</button>
    {to && target.kind !== 'unbound' && <button type="button" onClick={() => navigate(target.noteId, to.resource, target.kind === 'block' && reference.resolution === 'resolved' ? target.blockId : undefined)}>{reference.resolution === 'resolved' ? target.kind === 'page' ? 'Open target page' : 'Open target block' : 'Inspect registered original'}</button>}</div>
}
function Occurrence({ reference, snapshot, navigate }: { reference: NoteGraphReference; snapshot: NotebookGraphSnapshot; navigate: Navigate }) {
  const target = reference.target, to = target.kind !== 'unbound' ? destination(snapshot, target.noteId) : undefined
  return <li className="note-links-occurrence"><div className="note-links-kind"><span>{noteGraphReferenceLabel(reference)}</span>
      {to && target.kind !== 'unbound' ? <button type="button" className="note-links-target" aria-label={`${reference.resolution === 'resolved' ? target.kind === 'block' ? 'Open target block' : 'Open target page' : 'Inspect registered original'}: ${to.title}`} onClick={() => navigate(target.noteId, to.resource, target.kind === 'block' && reference.resolution === 'resolved' ? target.blockId : undefined)}>{to.title}</button> : target.kind === 'unbound' ? <span>[[{target.text}]]</span> : null}
      {reference.resolution !== 'resolved' && <span data-resolution={reference.resolution}>{reference.resolution}</span>}
      {target.kind === 'unbound' && <button type="button" className="note-links-target" onClick={() => navigate(reference.source.noteId, reference.sourceResource, reference.source.blockId)}>Open written link</button>}
    </div>
    {target.kind === 'unbound' && <p className="note-links-state">The written query has no confirmed target. Choose it in its original Note.</p>}
    {target.kind !== 'unbound' && reference.resolution !== 'resolved' && <p className="note-links-state">The original target is {reference.resolution}. Its exact identity is retained.</p>}
    <details className="note-links-details"><summary aria-label="Reference details">Details</summary>
      <p className="note-links-location">From <code>{reference.source.blockId}</code>{target.kind === 'block' ? <> · To block <code>{target.blockId}</code></> : target.kind === 'unbound' ? <> · <code>[[{target.text}]]</code></> : ' · To page'}</p>
      {target.kind !== 'unbound' && <p className="note-links-location">Target Note <code>{target.noteId}</code></p>}
      <p className="note-links-location">{reference.sourceResource.path}{reference.occurrence.kind === 'text' ? <> · {reference.occurrence.revision}</> : null}</p>
      <LinkActions reference={reference} snapshot={snapshot} navigate={navigate} />
    </details>
  </li>
}

/** One expanded source reads one exact saved original; a failed/newer read never masquerades as its held graph. */
function IncomingSource({ references, snapshot, active, navigate }: { references: NoteGraphReference[]; snapshot: NotebookGraphSnapshot; active: boolean; navigate: Navigate }) {
  const sourceId = references[0]!.source.noteId, page = snapshot.catalog.pages[sourceId]
  const [expanded, expand] = useState(false), [attempt, retry] = useState(0)
  const [read, setRead] = useState<{ snapshot: NotebookGraphSnapshot; value?: NoteContentObservation; issue?: string } | null>(null)
  useEffect(() => {
    if (!active || !expanded) return
    const controller = new AbortController()
    void api.notebooks.content(sourceId, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setRead({ snapshot, value })
    }).catch(error => { if (!controller.signal.aborted) setRead({ snapshot, issue: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
  }, [active, expanded, sourceId, snapshot, attempt])
  const observed = read?.snapshot === snapshot ? read : null
  const content = observed?.value
  const confirmed = content?.status === 'read' && noteContentMatchesGraph(snapshot, content) ? content : null
  const source = useMemo(() => confirmed ? noteKnowledge([{ location: { workspaceId: confirmed.resource.workspaceId, path: confirmed.resource.path },
    document: { path: confirmed.resource.path, revision: confirmed.revision, content: confirmed.content } }]).sources[0] : undefined, [confirmed])
  const blocks = useMemo(() => {
    const grouped = new Map<string, NoteGraphReference[]>()
    for (const reference of references) { const held = grouped.get(reference.source.blockId) ?? []; held.push(reference); grouped.set(reference.source.blockId, held) }
    return [...grouped.entries()]
  }, [references])
  return <section className="note-links-source"><div className="note-links-source-heading"><button type="button" className="note-links-source-toggle" aria-expanded={expanded} onClick={() => expand(value => !value)}><Disclosure size={12} /><NoteIcon size={15} /><span>{page?.title ?? 'Shared content'}</span><small>{references.length}</small></button>
      <button type="button" className="note-links-source-open" aria-label={`Open source note: ${page?.title ?? 'Shared content'}`} onClick={() => navigate(sourceId, references[0]!.sourceResource)}>Open</button>
    </div>
    {expanded && <div className="note-links-source-body">
      {!confirmed && <p className="note-links-state" role="status">{!observed ? 'Reading saved source…' : content?.status === 'read' ? 'The saved source changed after this graph. Refresh links to read that revision.' : observed.issue ?? (content && 'message' in content ? content.message : 'Source content is unconfirmed.')}{observed && content?.status !== 'read' && <button type="button" onClick={() => retry(value => value + 1)}>Retry source</button>}</p>}
      {blocks.map(([blockId, occurrences]) => <div className="note-links-block" key={blockId}>
        {source && <button type="button" className="note-links-excerpt" title={`Open source block in ${page?.title ?? 'Shared content'}`} onClick={() => navigate(sourceId, references[0]!.sourceResource, blockId)}>{source.blocks.get(blockId)?.text || 'Empty source block'}</button>}
        <ol>{occurrences.map(reference => <Occurrence key={noteGraphReferenceKey(reference)} reference={reference} snapshot={snapshot} navigate={navigate} />)}</ol>
      </div>)}
      <details className="note-links-details note-links-source-details"><summary>Source details</summary><p className="note-links-origin">{page ? snapshot.catalog.notebooks[page.notebookId]?.name ?? page.notebookId : 'Original source'} · {references[0]!.sourceResource.path}</p>{confirmed && <p className="note-links-location">Revision {confirmed.revision}</p>}</details>
    </div>}
  </section>
}

/** One read per shared original serves all of this page's direct occurrences. */
function SharedOriginal({ references, graph, active, navigate, onOpenFile }: { references: NoteGraphReference[]; graph: ReturnType<typeof useNoteCanvasObservation>; active: boolean; navigate: Navigate; onOpenFile?: OpenFile | undefined }) {
  const snapshot = graph.snapshot!, reference = references[0]!, targetId = reference.target.kind === 'page' ? reference.target.noteId : ''
  const original = canvasSharedObservation(snapshot, targetId)
  const [read, setRead] = useState<{ snapshot: NotebookGraphSnapshot; value?: NoteContentObservation; issue?: string } | null>(null)
  useEffect(() => {
    if (!active || !original) return
    const controller = new AbortController()
    void api.notebooks.content(targetId, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setRead({ snapshot, value })
    }).catch(error => { if (!controller.signal.aborted) setRead({ snapshot, issue: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
  }, [active, targetId, snapshot, original])
  const observed = read?.snapshot === snapshot ? read : null, content = observed?.value
  const confirmed = content?.status === 'read' && noteContentMatchesGraph(snapshot, content) ? content : null
  const source = useMemo(() => confirmed ? noteKnowledge([{ location: { workspaceId: confirmed.resource.workspaceId, path: confirmed.resource.path },
    document: { path: confirmed.resource.path, revision: confirmed.revision, content: confirmed.content } }]).sources[0] : undefined, [confirmed])
  const note = source?.note.kind === 'shared-block' && source.note.noteId === targetId ? source.note : null
  const title = note?.title || (source && [...source.blocks.values()].find(block => block.text.trim())?.text.trim().slice(0, 120)) || 'Shared content'
  const target = original ? { ...original.resource, noteId: targetId } : null
  return <section className="note-links-shared-original">
    <div className="note-links-source-heading">{target ? <button type="button" className="note-links-target" onClick={() => navigate(targetId, target)}>{title}</button> : <strong>Shared content</strong>}<small>{references.length} {references.length === 1 ? 'use here' : 'uses here'}</small></div>
    {!note && <p className="note-links-state" role="status">{!original ? 'The shared original is unconfirmed. Its exact references are kept; refresh the saved sources.' : !observed ? 'Reading shared content…' : confirmed ? 'The shared content could not be read as its original Note.' : content?.status === 'read' ? 'The shared original changed after this graph. Refresh links to read its details.' : observed.issue ?? (content && 'message' in content ? content.message : 'Shared content is unconfirmed.')}</p>}
    <ol>{references.map((use, index) => <li className="note-links-shared-use" key={noteGraphReferenceKey(use)}>
      {note && target && onOpenFile && use.occurrence.kind === 'stored' && <NoteSharedDetails note={note} target={target} host={{ ...use.sourceResource, noteId: use.source.noteId }}
        include={{ referenceId: use.occurrence.referenceId, noteId: targetId, path: target.path, workspaceId: target.workspaceId }} graph={graph} active={active} onOpen={onOpenFile} />}
      <button type="button" className="note-links-target" onClick={() => navigate(use.source.noteId, use.sourceResource, use.source.blockId)}>Go to use {index + 1}</button>
      {use.resolution !== 'resolved' && <span>{use.resolution}</span>}
    </li>)}</ol>
  </section>
}

/** A visible, explicit projection of the original saved graph, including closed-page incoming links. */
export function NoteLinksPanel(props: NoteLinksPanelProps) {
  return <NoteLinksPanelSurface key={props.noteId} {...props} />
}
function NoteLinksPanelSurface({ noteId, active = true, selectedBlockId, onOpen, onOpenFile }: NoteLinksPanelProps) {
  const [expanded, expand] = useState(false), [direction, setDirection] = useState<'incoming' | 'outgoing' | 'shared'>('incoming'), [blockOnly, setBlockOnly] = useState(false)
  const graph = useNoteCanvasObservation(active && expanded), { snapshot, issue, stale, busy, refresh } = graph
  const [navigationIssue, setNavigationIssue] = useState<string | null>(null), navigation = useRef<AbortController | null>(null)
  useEffect(() => { if (!active) navigation.current?.abort(); return () => navigation.current?.abort() }, [active])
  async function openOriginal(open: (signal: AbortSignal) => void | Promise<void>, callerSignal?: AbortSignal) {
    navigation.current?.abort()
    const controller = new AbortController(); navigation.current = controller
    const cancel = () => controller.abort()
    callerSignal?.addEventListener('abort', cancel, { once: true })
    if (callerSignal?.aborted) cancel()
    setNavigationIssue(null)
    try { if (!controller.signal.aborted) await open(controller.signal) }
    catch (error) { if (!controller.signal.aborted) { setNavigationIssue(error instanceof Error ? error.message : String(error)); throw error } }
    finally { callerSignal?.removeEventListener('abort', cancel) }
  }
  const openFile: OpenFile = (file, blockId, signal) => openOriginal(cancel => onOpenFile?.(file, blockId, cancel), signal)
  const navigate: Navigate = (id, resource, blockId) => {
    const page = snapshot?.catalog.pages[id]
    if (page && sameNoteResource(page.resource, resource)) void openOriginal(signal => onOpen(page, blockId, signal)).catch(() => {})
    else if (onOpenFile) void openFile({ ...resource, noteId: id }, blockId).catch(() => {})
    else setNavigationIssue('Opening this original file is unavailable here. Its exact identity is kept; return to the original file surface.')
  }
  const links = useMemo(() => snapshot ? projectNoteLinks(snapshot, noteId, blockOnly ? selectedBlockId : undefined) : null, [snapshot, noteId, blockOnly, selectedBlockId])
  const incoming = useMemo(() => {
    const groups = new Map<string, NoteGraphReference[]>()
    for (const reference of direction === 'shared' ? links?.sharedIncoming ?? [] : links?.incoming ?? []) {
      const key = JSON.stringify([reference.source.noteId, reference.sourceResource]), held = groups.get(key) ?? []
      held.push(reference); groups.set(key, held)
    }
    return [...groups.entries()]
  }, [links, direction])
  const shared = useMemo(() => {
    const groups = new Map<string, NoteGraphReference[]>()
    for (const reference of links?.sharedOutgoing ?? []) {
      if (reference.target.kind !== 'page') continue
      const held = groups.get(reference.target.noteId) ?? []; held.push(reference); groups.set(reference.target.noteId, held)
    }
    return [...groups.entries()]
  }, [links])
  const complete = snapshot?.graph.completeness === 'complete', qualifier = stale || issue ? 'last confirmed ' : complete ? '' : 'at least '
  return <section className="note-links" aria-label="Saved Note links"><button type="button" className="note-links-toggle" aria-expanded={expanded} onClick={() => expand(value => !value)}><Disclosure size={12} /><LinkIcon size={14} /><strong>Linked references</strong>{busy ? <span>Reading…</span> : issue || stale ? <span>Needs refresh</span> : snapshot?.graph.completeness === 'partial' ? <span>Partial coverage</span> : snapshot?.graph.completeness === 'unknown' ? <span>Unconfirmed coverage</span> : null}</button>
    {expanded && <div className="note-links-body">
      <div className="note-links-controls"><div role="group" aria-label="Link direction"><button type="button" aria-pressed={direction === 'incoming'} onClick={() => setDirection('incoming')}>Links to this note{links ? ` (${qualifier}${links.incoming.length})` : ''}</button><button type="button" aria-pressed={direction === 'outgoing'} onClick={() => setDirection('outgoing')}>Links from this note{links ? ` (${qualifier}${links.outgoing.length})` : ''}</button><button type="button" aria-pressed={direction === 'shared'} onClick={() => setDirection('shared')}>Shared content</button></div>
        {selectedBlockId && <button type="button" aria-pressed={blockOnly} onClick={() => setBlockOnly(value => !value)}>Selected block only</button>}
        <button type="button" className="note-links-refresh" aria-label="Refresh saved links" aria-busy={busy} onClick={refresh}><Refresh size={12} />Refresh</button></div>
      {navigationIssue && <p className="note-links-state" role="status">{navigationIssue}</p>}
      {(issue || stale) && <p className="note-links-state" role="status">{issue ? `Links could not be observed: ${issue}. The last confirmed view is kept.` : 'Saved originals changed. Refresh links to observe them; this view is kept.'}<button type="button" onClick={refresh}>Refresh links</button></p>}
      {snapshot && !complete && <p className="note-links-state" role="status">{snapshot.graph.completeness === 'partial' ? 'Partial link coverage' : 'Link coverage is unconfirmed'} · {snapshot.graph.observations.filter(item => item.status === 'read').length}/{snapshot.graph.observations.length} originals read</p>}
      {links && snapshot && (direction === 'shared' ? <>
        {shared.length > 0 && <><h3 className="note-links-section-title">Shared content used here</h3>{shared.map(([id, references]) => <SharedOriginal key={id} references={references} graph={graph} active={active && expanded} navigate={navigate} onOpenFile={onOpenFile ? openFile : undefined} />)}</>}
        {incoming.length > 0 && <><h3 className="note-links-section-title">Uses of this content</h3>{incoming.map(([key, references]) => <IncomingSource key={key} references={references} snapshot={snapshot} active={active && expanded} navigate={navigate} />)}</>}
        {!shared.length && !incoming.length && <p className="note-links-state">{complete ? 'No shared content uses in this saved catalog.' : 'No confirmed shared content uses in this observation. Some sources or targets remain unconfirmed.'}</p>}
      </> : direction === 'incoming' ? incoming.length ? incoming.map(([key, references]) => <IncomingSource key={key} references={references} snapshot={snapshot} active={active && expanded} navigate={navigate} />)
        : <p className="note-links-state">{complete ? 'No incoming links in this saved catalog.' : 'No confirmed incoming links in this observation. Some sources or targets remain unconfirmed.'}</p>
        : links.outgoing.length ? <ol>{links.outgoing.map(reference => <Occurrence key={noteGraphReferenceKey(reference)} reference={reference} snapshot={snapshot} navigate={navigate} />)}</ol>
          : <p className="note-links-state">{complete ? 'No outgoing links in this saved catalog.' : 'No confirmed outgoing links in this observation. Some sources or targets remain unconfirmed.'}</p>)}
      {links && links.unboundElsewhere > 0 && <p className="note-links-state" role="status">{links.unboundElsewhere} written link {links.unboundElsewhere === 1 ? 'query elsewhere has' : 'queries elsewhere have'} no confirmed destination; incoming coverage is partial.</p>}
      {snapshot && links && <details className="note-links-details note-links-coverage"><summary>About these links</summary><p className="note-links-scope">Saved {complete ? 'catalog observed' : snapshot.graph.completeness === 'partial' ? 'partial catalog' : 'catalog unconfirmed'} · {snapshot.graph.observations.filter(item => item.status === 'read').length}/{snapshot.graph.observations.length} originals read · catalog r{snapshot.catalog.revision}<br />{links.incoming.length} incoming · {links.outgoing.length} outgoing · {links.sharedOutgoing.length} shared uses here</p></details>}
      {!snapshot && !busy && !issue && <button type="button" className="note-text-button" onClick={refresh}>Read saved links</button>}
    </div>}
  </section>
}
