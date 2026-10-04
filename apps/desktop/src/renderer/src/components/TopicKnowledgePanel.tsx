import type { KnowledgeTopic, TopicKnowledge, TopicKnowledgeDocument, TopicKnowledgeItem } from '@agentmux/core/control'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ArrowRightLeft, ArrowUpRight, CornerDownLeft, FileText, NotebookText, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { openKnowledgeSource } from '../lib/topic-knowledge-actions'
import { topicKnowledgeObservationKey } from '../lib/topic-knowledge-observation'
import { useAppStore } from '../store'
import { TopicKnowledgeEditor, knowledgeSourceLabel, type KnowledgeEditTarget } from './TopicKnowledgeEditor'
import { TopicMoveDialog, type TopicMoveTarget } from './TopicMoveDialog'
import { TopicKnowledgeDocumentReader } from './TopicKnowledgeDocumentReader'

function documentKey(document: TopicKnowledgeDocument): string {
  const { target } = document
  return [document.topicId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId,
    target.expectedResource.workspacePath, target.path].join('\0')
}

/** Existing exact-Topic or global search; results retain their actual source Topic. */
export function TopicKnowledgePanel({ workspace, topic, topics = [], active = true }: {
  active?: boolean | undefined; workspace: WorkspaceRecord; topic?: ScratchTopicSnapshot | undefined; topics?: readonly ScratchTopicSnapshot[] | undefined
}) {
  const categories = useAppStore(state => state.topicCategories)
  const observationKey = useAppStore(state => active ? topicKnowledgeObservationKey(state.spaceZoneBindings, topic?.id) : null)
  const [fact, setFact] = useState<KnowledgeTopic | null>(null), [entries, setEntries] = useState<TopicKnowledgeItem[]>([])
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<TopicKnowledge | null>(null), [edit, setEdit] = useState<KnowledgeEditTarget | null>(null)
  const [documents, setDocuments] = useState<TopicKnowledgeDocument[]>([])
  const [selectedDocument, setSelectedDocument] = useState<TopicKnowledgeDocument | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null)
  const [historyIssue, setHistoryIssue] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<TopicMoveTarget | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const selectedRow = useRef<HTMLButtonElement>(null)
  useEffect(() => { setMoveTarget(null); setHistoryIssue(null) }, [topic?.id])
  useEffect(() => {
    if (!active) return
    let live = true
    if (!topic && !search) { setEntries([]); setDocuments([]); setSelected(null); setSelectedDocument(null); setError(null); setLoading(false); return }
    setLoading(true)
    void Promise.all([topic ? api.topics.call('topic.inspect', { topicId: topic.id }) : Promise.resolve(null), search
      ? api.topics.call('topic.knowledge.search', { ...(topic ? { topicId: topic.id } : {}), query: search, limit: 100 }).then(knowledge => ({ knowledge, historyUnavailable: knowledge.observation.unavailable }))
      : api.topics.call('topic.knowledge.ls', { topicId: topic!.id, limit: 100 }).then(knowledge => ({ knowledge, historyUnavailable: null }))]).then(([inspection, { knowledge, historyUnavailable }]) => {
      if (!live) return
      setFact(inspection?.topic ?? null); setEntries(knowledge.entries); setDocuments(knowledge.documents); setError([...(inspection?.unavailable ?? []), ...knowledge.unavailable].map(issue => issue.message).join(' ') || null)
      if (historyUnavailable !== null) setHistoryIssue(historyUnavailable.map(issue => issue.message).join(' ') || null)
      setSelected(previous => previous ? knowledge.entries.find((entry): entry is TopicKnowledge => !('readError' in entry) && entry.topicId === previous.topicId && entry.entryId === previous.entryId) ?? (knowledge.unavailable.length ? previous : null) : null)
      setSelectedDocument(previous => previous ? knowledge.documents.find(document => documentKey(document) === documentKey(previous)) ?? (knowledge.unavailable.length ? previous : null) : null)
    }).catch(cause => { if (live) setError(presentError(cause)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [active, topic?.id, workspace.id, workspace.hostId, workspace.path, search, attempt, observationKey])
  const current = categories.filter(category => fact?.categorySpaceIds.includes(category.spaceId))
  const sourceTopic = selected ? topics.find(candidate => candidate.id === selected.topicId) ?? (topic?.id === selected.topicId ? topic : undefined) : topic
  const rootPath = sourceTopic ? scratchTopicLogicalPath(workspace, sourceTopic) : null
  const title = topic?.title ?? 'All Topics'
  const readableCount = entries.filter(entry => !('readError' in entry)).length + documents.length
  const hasResults = entries.length > 0 || documents.length > 0
  const resultNoun = search ? (readableCount === 1 ? 'result' : 'results') : (readableCount === 1 ? 'item' : 'items')
  const resultLabel = loading ? 'Reading knowledge…'
    : hasResults ? `${readableCount} ${resultNoun}`
    : error ? 'Search incomplete' : search ? 'No results' : 'Saved knowledge and files'
  function clearSearch() {
    setQuery(''); setSearch(''); setSelected(null); setSelectedDocument(null)
    if (!topic) { setEntries([]); setDocuments([]) }
    searchInput.current?.focus()
  }
  function closeDetail() {
    const target = selectedRow.current ?? searchInput.current
    setSelected(null); setSelectedDocument(null)
    target?.focus()
  }
  return <section className="topic-knowledge-panel" aria-label={`Knowledge in ${title}`}>
    <header className="topic-knowledge-panel__header"><span className="topic-knowledge-scope" title={topic ? [title, current.map(category => category.title).join(' · ') || 'Category not confirmed'].join(' · ') : 'Search across all Topics'}><NotebookText size={13} aria-hidden="true" /><strong>{title}</strong></span>
      {topic ? <button type="button" className="icon-button" aria-label="Move to category…" title="Move to category…" onClick={() => setMoveTarget({ topicId: topic.id, title: topic.title })}><ArrowRightLeft size={14} /></button> : null}
      <button type="button" className="icon-button" aria-label="Refresh knowledge" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} /></button>
      {topic ? <button type="button" className="icon-button" aria-label="New knowledge" onClick={() => setEdit({ topicId: topic.id })}><Plus size={14} /></button> : null}</header>
    <form className="topic-knowledge-search" role="search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setAttempt(value => value + 1) }}>
      <Search size={14} aria-hidden="true" />
      <input ref={searchInput} type="text" aria-label={topic ? 'Search this Topic' : 'Search all Topics'} value={query} placeholder="Search knowledge and files…" onChange={event => { setQuery(event.target.value); if (!event.target.value) clearSearch() }} onKeyDown={event => { if (event.key === 'Escape' && query && !isImeCompositionKeyDown(event)) { event.preventDefault(); event.stopPropagation(); clearSearch() } }} />
      {query ? <button type="button" className="icon-button" aria-label="Clear search" title="Clear search" onClick={clearSearch}><X size={12} /></button> : null}
      <button type="submit" className="icon-button topic-knowledge-search__submit" aria-label="Search" title="Search · Enter"><CornerDownLeft size={14} /></button>
    </form>
    {error || topic?.readError ? <div className="surface-inline-error" role="status">{error || topic?.readError} Existing discussions and files remain available.</div> : null}
    {historyIssue ? <div className="surface-inline-error" role="status" aria-label="Search history unavailable">{historyIssue} {search ? 'Refresh to retry.' : 'Submit a search to retry.'}</div> : null}
    <div className="topic-knowledge-results" data-detail-open={selected || selectedDocument ? '' : undefined}>
      <p className="topic-knowledge-results__label" role="status">{resultLabel}</p>
      <div className="topic-knowledge-list" aria-label="Knowledge results">{entries.map(entry => {
        const key = `${entry.topicId}:${entry.entryId}`
        if ('readError' in entry) return <p key={key} className="surface-inline-error" role="status">{entry.readError}</p>
        const rowSelected = selected?.topicId === entry.topicId && selected.entryId === entry.entryId
        const sourceTitle = !topic ? topics.find(candidate => candidate.id === entry.topicId)?.title ?? entry.topicId : undefined
        return <button type="button" key={key} ref={rowSelected ? selectedRow : undefined}
          data-knowledge-topic-id={entry.topicId} aria-pressed={rowSelected} className="topic-knowledge-row" onClick={() => { setSelectedDocument(null); setSelected(entry) }}>
          <strong>{entry.title}</strong>
          <span>{entry.content.slice(0, 140) || (entry.form === 'reference' ? 'Source reference' : '')}</span>
          <small><span title={sourceTitle}>{sourceTitle ?? entry.certainty}</span>
            {entry.sources.length ? <span>{entry.sources.length} source{entry.sources.length === 1 ? '' : 's'}</span> : null}
          </small>
        </button>
      })}{documents.map(document => {
        const key = documentKey(document), rowSelected = selectedDocument !== null && documentKey(selectedDocument) === key
        const sourceTitle = !topic ? topics.find(candidate => candidate.id === document.topicId)?.title ?? document.topicId : undefined
        return <button type="button" key={key} ref={rowSelected ? selectedRow : undefined} className="topic-knowledge-row"
          data-document-topic-id={document.topicId} data-document-path={document.target.path} aria-pressed={rowSelected}
          onClick={() => { setSelected(null); setSelectedDocument(document) }}>
          <strong>{document.title}</strong>
          {document.snippet ? <span>{document.snippet}</span> : null}
          <small><FileText size={11} aria-hidden="true" /><span title={[sourceTitle, document.target.path].filter(Boolean).join(' · ')}>{sourceTitle ? `${sourceTitle} · ` : ''}{document.target.path}</span></small>
        </button>
      })}</div>
      {!loading && !hasResults ? <div className="topic-knowledge-empty"><Search size={20} aria-hidden="true" /><strong>{error ? 'Some sources could not be searched' : search ? 'No matches' : topic ? 'A place for useful knowledge' : 'Find something worth keeping'}</strong><p className="topic-knowledge-hint">{error ? 'Refresh or search one Topic to continue. Existing files remain available.' : search ? 'No saved knowledge or text documents match this search.' : topic ? 'Keep useful references and conclusions from your discussions here.' : 'Search across all Topics to find saved knowledge and original text documents.'}</p></div> : null}
    </div>
    {selected ? <article className="topic-knowledge-entry" aria-label="Knowledge detail" onKeyDown={event => { if (event.key === 'Escape' && !isImeCompositionKeyDown(event)) { event.preventDefault(); event.stopPropagation(); closeDetail() } }}>
      <header><span><strong title={selected.title}>{selected.title}</strong><small>{selected.certainty}{selected.scope ? ` · ${selected.scope}` : ''}</small></span><button type="button" className="icon-button" aria-label="Edit knowledge" title="Edit knowledge" onClick={() => setEdit({ topicId: selected.topicId, entry: selected })}><Pencil size={13} /></button><button type="button" className="icon-button" aria-label="Close knowledge detail" title="Back to results" onClick={closeDetail}><X size={13} /></button></header>
      <div className="topic-knowledge-entry__body">
      {!rootPath ? <div className="surface-inline-error" role="status">The source Topic directory is not confirmed. Text, sources and editing remain available; refresh the directory to open its file links.
        <button type="button" className="icon-button" aria-label="Refresh source Topic directory" title="Refresh source Topic directory" onClick={() => void useAppStore.getState().refreshScratchTopics(workspace.id, true)}><RefreshCw size={13} /></button>
      </div> : null}
      <AgentMarkdown content={selected.content} className="topic-knowledge-prose" workspaceRoot={workspace.path} {...(rootPath ? {
        sourcePath: rootPath + '/knowledge/' + selected.entryId + '.json',
        openWorkspaceFile: (path: string) => { void useAppStore.getState().openFile(path, undefined, undefined, workspace.id).catch(cause => setError(presentError(cause))) }
      } : {})} />
      {selected.sources.length ? <details className="topic-knowledge-sources" open><summary>Sources</summary>{selected.sources.map((source, index) => <button type="button" className="topic-knowledge-source" key={index} title={knowledgeSourceLabel(source)} onClick={() => { void openKnowledgeSource(source).catch(cause => setError(presentError(cause))) }}><ArrowUpRight size={12} /><span>{knowledgeSourceLabel(source)}</span></button>)}</details> : null}
      </div>
    </article> : null}
    {selectedDocument ? <TopicKnowledgeDocumentReader key={JSON.stringify(selectedDocument.target)} document={selectedDocument} refresh={attempt} onClose={closeDetail} /> : null}
    <TopicKnowledgeEditor target={edit} onClose={() => setEdit(null)} onSaved={entry => { setSelectedDocument(null); setSelected(entry); setAttempt(value => value + 1) }} />
    <TopicMoveDialog target={moveTarget} onClose={() => setMoveTarget(null)} onMoved={() => setAttempt(value => value + 1)} />
  </section>
}
