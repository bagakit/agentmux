import type { KnowledgeTopic, TopicKnowledge, TopicKnowledgeItem } from '@agentmux/core/control'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ArrowRightLeft, ArrowUpRight, Pencil, Plus, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { openKnowledgeSource } from '../lib/topic-knowledge-actions'
import { useAppStore } from '../store'
import { TopicKnowledgeEditor, knowledgeSourceLabel, type KnowledgeEditTarget } from './TopicKnowledgeEditor'
import { TopicMoveDialog, type TopicMoveTarget } from './TopicMoveDialog'

/** Existing exact-Topic or global search; results retain their actual source Topic. */
export function TopicKnowledgePanel({ workspace, topic, topics = [] }: {
  workspace: WorkspaceRecord; topic?: ScratchTopicSnapshot | undefined; topics?: readonly ScratchTopicSnapshot[] | undefined
}) {
  const categories = useAppStore(state => state.topicCategories)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const [fact, setFact] = useState<KnowledgeTopic | null>(null), [entries, setEntries] = useState<TopicKnowledgeItem[]>([])
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<TopicKnowledge | null>(null), [edit, setEdit] = useState<KnowledgeEditTarget | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<TopicMoveTarget | null>(null)
  useEffect(() => { setMoveTarget(null) }, [topic?.id])
  useEffect(() => {
    let live = true
    if (!topic && !search) { setEntries([]); setSelected(null); setError(null); setLoading(false); return }
    setLoading(true)
    void Promise.all([topic ? api.topics.call('topic.inspect', { topicId: topic.id }) : Promise.resolve(null), search
      ? api.topics.call('topic.knowledge.search', { ...(topic ? { topicId: topic.id } : {}), query: search, limit: 100 })
      : api.topics.call('topic.knowledge.ls', { topicId: topic!.id, limit: 100 })]).then(([inspection, knowledge]) => {
      if (!live) return
      setFact(inspection?.topic ?? null); setEntries(knowledge.entries); setError([...(inspection?.unavailable ?? []), ...knowledge.unavailable].map(issue => issue.message).join(' ') || null)
      setSelected(previous => previous ? knowledge.entries.find((entry): entry is TopicKnowledge => !('readError' in entry) && entry.topicId === previous.topicId && entry.entryId === previous.entryId) ?? (knowledge.unavailable.length ? previous : null) : null)
    }).catch(cause => { if (live) setError(presentError(cause)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [topic?.id, search, attempt, bindings])
  const current = categories.filter(category => fact?.categorySpaceIds.includes(category.spaceId))
  const sourceTopic = selected ? topics.find(candidate => candidate.id === selected.topicId) ?? (topic?.id === selected.topicId ? topic : undefined) : topic
  const rootPath = sourceTopic ? scratchTopicLogicalPath(workspace, sourceTopic) : null
  const title = topic?.title ?? 'All Topics'
  return <section className="topic-knowledge-panel" aria-label={`Knowledge in ${title}`}>
    <header className="topic-knowledge-panel__header"><span><strong>{title}</strong><small>{topic ? current.map(category => category.title).join(' · ') || 'Category not confirmed' : 'Search across all Topics'}</small></span>
      {topic ? <button type="button" className="icon-button" aria-label="Move to category…" title="Move to category…" onClick={() => setMoveTarget({ topicId: topic.id, title: topic.title })}><ArrowRightLeft size={14} /></button> : null}
      <button type="button" className="icon-button" aria-label="Refresh knowledge" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} /></button>
      {topic ? <button type="button" className="icon-button" aria-label="New knowledge" onClick={() => setEdit({ topicId: topic.id })}><Plus size={14} /></button> : null}</header>
    <form className="topic-knowledge-search" role="search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()) }}><Search size={13} /><input aria-label={topic ? 'Search this Topic' : 'Search all Topics'} value={query} placeholder="Search knowledge…" onChange={event => { setQuery(event.target.value); if (!event.target.value) setSearch('') }} /><button className="small-button">Search</button></form>
    {error || topic?.readError ? <div className="surface-inline-error" role="status">{error || topic?.readError} Existing discussions and files remain available.</div> : null}
    {loading ? <p role="status" className="topic-knowledge-hint">Reading knowledge…</p> : null}
    <div className="topic-knowledge-list">{entries.map(entry => 'readError' in entry ? <p key={entry.topicId + ":" + entry.entryId} className="surface-inline-error" role="status">{entry.readError}</p> : <button type="button" key={entry.topicId + ":" + entry.entryId} data-knowledge-topic-id={entry.topicId} aria-pressed={selected?.topicId === entry.topicId && selected.entryId === entry.entryId} className="topic-knowledge-row" onClick={() => setSelected(entry)}><strong>{entry.title}</strong><span>{entry.content.slice(0, 140) || (entry.form === 'reference' ? 'Source reference' : '')}</span><small>{!topic ? (topics.find(candidate => candidate.id === entry.topicId)?.title ?? entry.topicId) + ' · ' : ''}{entry.certainty} · {entry.sources.length} source{entry.sources.length === 1 ? '' : 's'}</small></button>)}</div>
    {!loading && !entries.length ? <p className="topic-knowledge-hint">{search ? 'No knowledge matches this search.' : topic ? 'Keep useful references and conclusions from your discussions here.' : 'Search across all Topics to find saved knowledge.'}</p> : null}
    {selected ? <article className="topic-knowledge-entry"><header><strong>{selected.title}</strong><button type="button" className="icon-button" aria-label="Edit knowledge" onClick={() => setEdit({ topicId: selected.topicId, entry: selected })}><Pencil size={13} /></button></header>
      <small>{selected.certainty}{selected.scope ? ` · ${selected.scope}` : ''}</small>
      {!rootPath ? <div className="surface-inline-error" role="status">The source Topic directory is not confirmed. Text, sources and editing remain available; refresh the directory to open its file links.
        <button type="button" className="icon-button" aria-label="Refresh source Topic directory" title="Refresh source Topic directory" onClick={() => void useAppStore.getState().refreshScratchTopics(workspace.id, true)}><RefreshCw size={13} /></button>
      </div> : null}
      <AgentMarkdown content={selected.content} className="topic-knowledge-prose" workspaceRoot={workspace.path} {...(rootPath ? {
        sourcePath: rootPath + '/knowledge/' + selected.entryId + '.json',
        openWorkspaceFile: (path: string) => { void useAppStore.getState().openFile(path, undefined, undefined, workspace.id).catch(cause => setError(presentError(cause))) }
      } : {})} />
      {selected.sources.length ? <details className="topic-knowledge-sources" open><summary>Sources</summary>{selected.sources.map((source, index) => <button type="button" className="topic-knowledge-source" key={index} title={knowledgeSourceLabel(source)} onClick={() => { void openKnowledgeSource(source).catch(cause => setError(presentError(cause))) }}><ArrowUpRight size={12} /><span>{knowledgeSourceLabel(source)}</span></button>)}</details> : null}
    </article> : null}
    <TopicKnowledgeEditor target={edit} onClose={() => setEdit(null)} onSaved={entry => { setSelected(entry); setAttempt(value => value + 1) }} />
    <TopicMoveDialog target={moveTarget} onClose={() => setMoveTarget(null)} onMoved={() => setAttempt(value => value + 1)} />
  </section>
}
