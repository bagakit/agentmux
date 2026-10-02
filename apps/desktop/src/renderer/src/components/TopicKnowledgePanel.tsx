import type { KnowledgeTopic, TopicKnowledge, TopicKnowledgeItem } from '@agentmux/core/control'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ArrowUpRight, Pencil, Plus, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { moveKnowledgeTopic, openKnowledgeSource } from '../lib/topic-knowledge-actions'
import { useAppStore } from '../store'
import { TopicKnowledgeEditor, knowledgeSourceLabel, type KnowledgeEditTarget } from './TopicKnowledgeEditor'

/** One Topic's knowledge. Whole-library navigation belongs to the Topics tree/overview. */
export function TopicKnowledgePanel({ workspace, topic }: { workspace: WorkspaceRecord; topic: ScratchTopicSnapshot }) {
  const categories = useAppStore(state => state.topicCategories)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const [fact, setFact] = useState<KnowledgeTopic | null>(null), [entries, setEntries] = useState<TopicKnowledgeItem[]>([])
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<TopicKnowledge | null>(null), [edit, setEdit] = useState<KnowledgeEditTarget | null>(null)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  useEffect(() => {
    let live = true; setLoading(true)
    void Promise.all([api.topics.call('topic.inspect', { topicId: topic.id }), search
      ? api.topics.call('topic.knowledge.search', { topicId: topic.id, query: search, limit: 100 })
      : api.topics.call('topic.knowledge.ls', { topicId: topic.id, limit: 100 })]).then(([inspection, knowledge]) => {
      if (!live) return
      setFact(inspection.topic); setEntries(knowledge.entries); setError([...inspection.unavailable, ...knowledge.unavailable].map(issue => issue.message).join(' ') || null)
      setSelected(previous => previous ? knowledge.entries.find((entry): entry is TopicKnowledge => !('readError' in entry) && entry.entryId === previous.entryId) ?? (knowledge.unavailable.length ? previous : null) : null)
    }).catch(cause => { if (live) setError(presentError(cause)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [topic.id, search, attempt, bindings])
  const current = categories.filter(category => fact?.categorySpaceIds.includes(category.spaceId))
  async function move() {
    if (!fact || !destination || busy) return
    setBusy(true); setError(null)
    try { await moveKnowledgeTopic(fact, destination); setDestination(''); setAttempt(value => value + 1) }
    catch (cause) { setError(presentError(cause)) } finally { setBusy(false) }
  }
  const rootPath = scratchTopicLogicalPath(workspace, topic)
  return <section className="topic-knowledge-panel" aria-label={`Knowledge in ${topic.title}`}>
    <header className="topic-knowledge-panel__header"><span><strong>{topic.title}</strong><small>{current.map(category => category.title).join(' · ') || 'Category not confirmed'}</small></span>
      <button type="button" className="icon-button" aria-label="Refresh knowledge" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} /></button>
      <button type="button" className="icon-button" aria-label="New knowledge" onClick={() => setEdit({ topicId: topic.id })}><Plus size={14} /></button></header>
    <details className="topic-knowledge-move"><summary>Move Topic…</summary><label>Destination category<select value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}><option value="">Choose a category…</option>{categories.filter(category => !category.readError && !current.some(item => item.categoryId === category.categoryId)).map(category => <option key={category.categoryId} value={category.categoryId}>{category.title}</option>)}</select></label><button type="button" className="small-button" disabled={busy || !destination || !fact} onClick={() => void move()}>{busy ? 'Moving…' : 'Move entire Topic'}</button></details>
    <form className="topic-knowledge-search" role="search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()) }}><Search size={13} /><input aria-label="Search this Topic" value={query} placeholder="Search knowledge…" onChange={event => { setQuery(event.target.value); if (!event.target.value) setSearch('') }} /><button className="small-button">Search</button></form>
    {error || topic.readError ? <div className="surface-inline-error" role="status">{error || topic.readError} Existing discussions and files remain available.</div> : null}
    {loading ? <p role="status" className="topic-knowledge-hint">Reading knowledge…</p> : null}
    <div className="topic-knowledge-list">{entries.map(entry => 'readError' in entry ? <p key={entry.entryId} className="surface-inline-error" role="status">{entry.readError}</p> : <button type="button" key={entry.entryId} aria-pressed={selected?.entryId === entry.entryId} className="topic-knowledge-row" onClick={() => setSelected(entry)}><strong>{entry.title}</strong><span>{entry.content.slice(0, 140) || (entry.form === 'reference' ? 'Source reference' : '')}</span><small>{entry.certainty} · {entry.sources.length} source{entry.sources.length === 1 ? '' : 's'}</small></button>)}</div>
    {!loading && !entries.length ? <p className="topic-knowledge-hint">{search ? 'No knowledge matches this search.' : 'Keep useful references and conclusions from your discussions here.'}</p> : null}
    {selected ? <article className="topic-knowledge-entry"><header><strong>{selected.title}</strong><button type="button" className="icon-button" aria-label="Edit knowledge" onClick={() => setEdit({ topicId: selected.topicId, entry: selected })}><Pencil size={13} /></button></header>
      <small>{selected.certainty}{selected.scope ? ` · ${selected.scope}` : ''}</small>
      <AgentMarkdown content={selected.content} className="topic-knowledge-prose" workspaceRoot={workspace.path} {...(rootPath ? { sourcePath: rootPath + '/knowledge/' + selected.entryId + '.json' } : {})}
        openWorkspaceFile={path => { void useAppStore.getState().openFile(path, undefined, undefined, workspace.id).catch(cause => setError(presentError(cause))) }} />
      {selected.sources.length ? <details className="topic-knowledge-sources" open><summary>Sources</summary>{selected.sources.map((source, index) => <button type="button" className="topic-knowledge-source" key={index} title={knowledgeSourceLabel(source)} onClick={() => { void openKnowledgeSource(source).catch(cause => setError(presentError(cause))) }}><ArrowUpRight size={12} /><span>{knowledgeSourceLabel(source)}</span></button>)}</details> : null}
    </article> : null}
    <TopicKnowledgeEditor target={edit} onClose={() => setEdit(null)} onSaved={entry => { setSelected(entry); setAttempt(value => value + 1) }} />
  </section>
}
