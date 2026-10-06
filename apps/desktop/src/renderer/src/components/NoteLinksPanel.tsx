import { useEffect, useMemo, useState } from 'react'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import type { NoteContentObservation, NoteGraphReference } from '@agentmux/core/notebook-observation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { noteContentMatchesGraph, type NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { api } from '../lib/api'
import { noteKnowledge } from '../lib/note-knowledge'
import { noteGraphReferenceKey, noteGraphReferenceLabel, projectNoteLinks } from '../lib/note-graph-references'
import { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'
import '../styles/note-links.css'

const Disclosure = semanticIconComponent('navigation.disclosure'), Refresh = semanticIconComponent('action.refresh')
type OpenNote = (page: NotebookPage, blockId?: string) => void
export type NoteLinksPanelProps = { noteId: string; active?: boolean; selectedBlockId?: string | undefined; onOpen: OpenNote }

function LinkActions({ reference, snapshot, onOpen }: { reference: NoteGraphReference; snapshot: NotebookGraphSnapshot; onOpen: OpenNote }) {
  const source = snapshot.catalog.pages[reference.source.noteId], target = reference.target
  const page = target.kind !== 'unbound' ? snapshot.catalog.pages[target.noteId] : undefined
  return <div className="note-links-actions">{source && <button type="button" onClick={() => onOpen(source, reference.source.blockId)}>Open source block</button>}
    {page && target.kind !== 'unbound' && <button type="button" onClick={() => onOpen(page, target.kind === 'block' && reference.resolution === 'resolved' ? target.blockId : undefined)}>{reference.resolution === 'resolved' ? target.kind === 'page' ? 'Open target page' : 'Open target block' : 'Inspect registered original'}</button>}</div>
}
function Occurrence({ reference, snapshot, onOpen }: { reference: NoteGraphReference; snapshot: NotebookGraphSnapshot; onOpen: OpenNote }) {
  const target = reference.target
  return <li className="note-links-occurrence"><div className="note-links-kind"><strong>{noteGraphReferenceLabel(reference)}</strong><span data-resolution={reference.resolution}>{reference.resolution === 'resolved' ? 'Confirmed' : reference.resolution}</span></div>
    <p className="note-links-location">From <code>{reference.source.blockId}</code>{target.kind === 'block' ? <> · To block <code>{target.blockId}</code></> : target.kind === 'unbound' ? <> · <code>[[{target.text}]]</code></> : ' · To page'}</p>
    {target.kind === 'unbound' && <p className="note-links-state">The written query has no confirmed target. Choose it in its original Note.</p>}
    {target.kind !== 'unbound' && reference.resolution !== 'resolved' && <p className="note-links-state">The original target is {reference.resolution}. Its exact identity is retained.</p>}
    <LinkActions reference={reference} snapshot={snapshot} onOpen={onOpen} />
  </li>
}

/** One expanded source reads one exact saved original; a failed/newer read never masquerades as its held graph. */
function IncomingSource({ references, snapshot, active, onOpen }: { references: NoteGraphReference[]; snapshot: NotebookGraphSnapshot; active: boolean; onOpen: OpenNote }) {
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
  return <section className="note-links-source"><button type="button" className="note-links-source-toggle" aria-expanded={expanded} onClick={() => expand(value => !value)}><Disclosure size={12} /><span>{page?.title ?? sourceId}</span><small>{references.length} {references.length === 1 ? 'link' : 'links'}</small></button>
    {expanded && <div className="note-links-source-body"><p className="note-links-origin">{page ? snapshot.catalog.notebooks[page.notebookId]?.name ?? page.notebookId : 'Original source'} · {references[0]!.sourceResource.path}</p>
      {!confirmed && <p className="note-links-state" role="status">{!observed ? 'Reading saved source…' : content?.status === 'read' ? 'The saved source changed after this graph. Refresh links to read that revision.' : observed.issue ?? (content && 'message' in content ? content.message : 'Source content is unconfirmed.')}{observed && content?.status !== 'read' && <button type="button" onClick={() => retry(value => value + 1)}>Retry source</button>}</p>}
      {blocks.map(([blockId, occurrences]) => <div className="note-links-block" key={blockId}>
        <p className="note-links-location">Source block <code>{blockId}</code></p>
        {source && <p className="note-links-excerpt">{source.blocks.get(blockId)?.text || 'Empty source block'}</p>}
        <ol>{occurrences.map(reference => <Occurrence key={noteGraphReferenceKey(reference)} reference={reference} snapshot={snapshot} onOpen={onOpen} />)}</ol>
      </div>)}
    </div>}
  </section>
}

/** A visible, explicit projection of the original saved graph, including closed-page incoming links. */
export function NoteLinksPanel({ noteId, active = true, selectedBlockId, onOpen }: NoteLinksPanelProps) {
  return <NoteLinksPanelSurface key={noteId} noteId={noteId} active={active} selectedBlockId={selectedBlockId} onOpen={onOpen} />
}
function NoteLinksPanelSurface({ noteId, active = true, selectedBlockId, onOpen }: NoteLinksPanelProps) {
  const [expanded, expand] = useState(false), [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming'), [blockOnly, setBlockOnly] = useState(false)
  const { snapshot, issue, stale, busy, refresh } = useNoteCanvasObservation(active && expanded)
  const links = useMemo(() => snapshot ? projectNoteLinks(snapshot, noteId, blockOnly ? selectedBlockId : undefined) : null, [snapshot, noteId, blockOnly, selectedBlockId])
  const incoming = useMemo(() => {
    const groups = new Map<string, NoteGraphReference[]>()
    for (const reference of links?.incoming ?? []) {
      const key = JSON.stringify([reference.source.noteId, reference.sourceResource]), held = groups.get(key) ?? []
      held.push(reference); groups.set(key, held)
    }
    return [...groups.entries()]
  }, [links])
  const complete = snapshot?.graph.completeness === 'complete'
  return <section className="note-links" aria-label="Saved Note links"><button type="button" className="note-links-toggle" aria-expanded={expanded} onClick={() => expand(value => !value)}><Disclosure size={12} /><strong>Linked references</strong><span>{!expanded ? 'Explore saved sources' : busy ? 'Reading…' : links ? `${links.incoming.length} incoming · ${links.outgoing.length} outgoing` : 'Not yet observed'}</span></button>
    {expanded && <div className="note-links-body">
      <div className="note-links-controls"><div role="group" aria-label="Link direction"><button type="button" aria-pressed={direction === 'incoming'} onClick={() => setDirection('incoming')}>Incoming{links ? ` (${links.incoming.length})` : ''}</button><button type="button" aria-pressed={direction === 'outgoing'} onClick={() => setDirection('outgoing')}>Outgoing{links ? ` (${links.outgoing.length})` : ''}</button></div>
        {selectedBlockId && <button type="button" aria-pressed={blockOnly} onClick={() => setBlockOnly(value => !value)}>Selected block only</button>}
        <button type="button" className="note-links-refresh" aria-label="Refresh saved links" aria-busy={busy} onClick={refresh}><Refresh size={12} />Refresh</button></div>
      {(issue || stale) && <p className="note-links-state" role="status">{issue ? `Links could not be observed: ${issue}. The last confirmed view is kept.` : 'Saved originals changed. Refresh links to observe them; this view is kept.'}<button type="button" onClick={refresh}>Refresh links</button></p>}
      {snapshot && <p className="note-links-scope">Saved {complete ? 'catalog observed' : snapshot.graph.completeness === 'partial' ? 'partial catalog' : 'catalog unconfirmed'} · {snapshot.graph.observations.filter(item => item.status === 'read').length}/{snapshot.graph.observations.length} originals read · catalog r{snapshot.catalog.revision}</p>}
      {links && snapshot && (direction === 'incoming' ? incoming.length ? incoming.map(([key, references]) => <IncomingSource key={key} references={references} snapshot={snapshot} active={active && expanded} onOpen={onOpen} />)
        : <p className="note-links-state">{complete ? 'No incoming links in this saved catalog.' : 'No confirmed incoming links in this observation. Some sources or targets remain unconfirmed.'}</p>
        : links.outgoing.length ? <ol>{links.outgoing.map(reference => <li className="note-links-outgoing" key={noteGraphReferenceKey(reference)}><p className="note-links-destination">{reference.target.kind === 'unbound' ? 'Unbound query' : snapshot.catalog.pages[reference.target.noteId]?.title ?? reference.target.noteId}</p><ol><Occurrence reference={reference} snapshot={snapshot} onOpen={onOpen} /></ol></li>)}</ol>
          : <p className="note-links-state">{complete ? 'No outgoing links in this saved catalog.' : 'No confirmed outgoing links in this observation. Some sources or targets remain unconfirmed.'}</p>)}
      {links && links.unboundElsewhere > 0 && <p className="note-links-state" role="status">{links.unboundElsewhere} written link {links.unboundElsewhere === 1 ? 'query elsewhere has' : 'queries elsewhere have'} no confirmed destination; incoming coverage is partial.</p>}
      {!snapshot && !busy && !issue && <button type="button" className="note-text-button" onClick={refresh}>Read saved links</button>}
    </div>}
  </section>
}
