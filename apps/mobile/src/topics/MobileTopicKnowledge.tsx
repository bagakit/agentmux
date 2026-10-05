import { mintObjectId } from '@agentmux/core/object-id'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledge, TopicKnowledgeItem, TopicKnowledgeSource, TopicKnowledgeWrite } from '@agentmux/core/control'
import { AgentMarkdown, type OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'

export type TopicsRpc = NonNullable<AgentMuxHostedClient['forwardRpc']>
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const certaintyLabels = { fact: '事实', inference: '推断', proposal: '提案', decision: '决定' }
function sourceLabel(source: TopicKnowledgeSource): string {
  return source.kind === 'url' ? source.url : source.kind === 'file' ? source.path
    : ({ topic: '原讨论', note: '原笔记 / 块', notebook: '原笔记本', survey: '原研究', space: '原工作面' } as const)[source.kind]
}

/** Mount per scope: a late read must never replace another Topic's reading or draft. */
export function MobileTopicKnowledge(props: { rpc: TopicsRpc; topicId?: string; title: string; visible?: boolean;
  openSource(source: TopicKnowledgeSource): void | Promise<void>; openHttpLink?: OpenHttpLink }) {
  return <KnowledgeScope key={props.topicId ?? 'all-topics'} {...props} />
}
function KnowledgeScope({ rpc, topicId, title, openSource, openHttpLink, visible = true }: Parameters<typeof MobileTopicKnowledge>[0]) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [entries, setEntries] = useState<TopicKnowledgeItem[]>([]), [selected, setSelected] = useState<TopicKnowledge | null>(null)
  const [issue, setIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [edit, setEdit] = useState<{ topicId: string; entry?: TopicKnowledge } | null>(null)
  const [editorVisible, setEditorVisible] = useState(false)
  const readIntent = useRef(0)
  useEffect(() => {
    if (!visible || !topicId && !search) return
    let live = true
    setLoading(true)
    const request = search ? rpc('topic.knowledge.search', { ...(topicId ? { topicId } : {}), query: search })
      : rpc('topic.knowledge.ls', { topicId: topicId! })
    void request.then(result => {
      if (!live) return
      setEntries(result.entries); setIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n'))
    }).catch(error => { if (live) setIssue(`知识读取失败：${errorText(error)}。原阅读保留，可重试。`) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [rpc, topicId, search, refresh, visible])
  useEffect(() => () => { readIntent.current += 1 }, [])
  async function read(entry: TopicKnowledgeItem) {
    const intent = ++readIntent.current
    try {
      const result = await rpc('topic.knowledge.read', { topicId: entry.topicId, entryId: entry.entryId })
      if (intent !== readIntent.current) return
      if (!result.entry) { setIssue('原知识条目暂未找到，原阅读保留；请刷新确认。'); return }
      setSelected(result.entry)
    } catch (error) { if (intent === readIntent.current) setIssue(`正文读取失败：${errorText(error)}。原阅读保留。`) }
  }
  return <section className="mobile-topic-knowledge" aria-label={`${title}知识`}>
    <form className="mobile-topics-search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()) }}>
      <TextInput aria-label="搜索知识" placeholder={topicId ? '搜索此 Topic 的知识' : '搜索 All Topics'} value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit">搜索</button>
    </form>
    <div className="mobile-topics-actions"><small>{topicId ? title : 'All Topics'}{loading ? ' · 读取中' : ''}</small>
      <button onClick={() => setRefresh(value => value + 1)}>刷新</button>
      {topicId && <button onClick={() => { if (!edit) setEdit({ topicId }); setEditorVisible(true) }}>{edit ? '继续编辑草稿' : '新建知识'}</button>}
    </div>
    {issue && <p className="mobile-topics-issue" role="status">{issue}</p>}
    {!selected && <ul className="mobile-topics-list">{entries.map(entry => <li key={`${entry.topicId}:${entry.entryId}`}>
      <button onClick={() => { void read(entry) }}><strong>{'readError' in entry ? '条目读取未确认' : entry.title}</strong>
        <small>{'readError' in entry ? entry.readError : certaintyLabels[entry.certainty]}{!topicId ? ` · ${entry.topicId}` : ''}</small></button>
    </li>)}</ul>}
    {!selected && !entries.length && !loading && <p className="mobile-topics-empty">{!topicId && !search ? '输入关键词，搜索所有 Topic 的已保存知识。' : search ? '当前已确认结果没有匹配项。' : '此 Topic 暂无已确认知识条目。'}</p>}
    {selected && <article className="mobile-topic-reading">
      <div className="mobile-topics-actions"><button onClick={() => { readIntent.current += 1; setSelected(null) }}>返回知识列表</button>
        <button onClick={() => { if (!edit) setEdit({ topicId: selected.topicId, entry: selected }); setEditorVisible(true) }}>{edit ? '继续编辑草稿' : '编辑知识'}</button></div>
      <h2>{selected.title}</h2><small>{certaintyLabels[selected.certainty]} · {selected.form === 'reference' ? '来源引用' : '整理成果'}</small>
      {selected.scope && <p>{selected.scope}</p>}
      <AgentMarkdown content={selected.content} documentMode {...(openHttpLink ? { openHttpLink } : {})} />
      {selected.sources.length > 0 && <details open><summary>来源 · {selected.sources.length}</summary>{selected.sources.map((source, index) =>
        <button className="mobile-topic-source" key={index} onClick={() => { void Promise.resolve().then(() => openSource(source)).catch(error => setIssue(`原来源打开失败：${errorText(error)}。当前阅读保留。`)) }}>{sourceLabel(source)}</button>)}</details>}
    </article>}
    {edit && <div hidden={!editorVisible}><MobileTopicKnowledgeEditor rpc={rpc} target={edit} onClose={() => setEditorVisible(false)} onSaved={entry => {
      setSelected(entry); setEdit(null); setEditorVisible(false); setRefresh(value => value + 1)
    }} /></div>}
  </section>
}

/** Original target/revision and one new entry ID are held for the entire edit intent. */
export function MobileTopicKnowledgeEditor({ rpc, target, onClose, onSaved }: { rpc: TopicsRpc;
  target: { topicId: string; entry?: TopicKnowledge }; onClose(): void; onSaved(entry: TopicKnowledge): void }) {
  const [original] = useState(() => ({ ...target, entryId: target.entry?.entryId ?? mintObjectId() }))
  const [title, setTitle] = useState(original.entry?.title ?? ''), [content, setContent] = useState(original.entry?.content ?? '')
  const [scope, setScope] = useState(original.entry?.scope ?? '')
  const [certainty, setCertainty] = useState<TopicKnowledge['certainty']>(original.entry?.certainty ?? 'proposal')
  const [form, setForm] = useState<TopicKnowledge['form']>(original.entry?.form ?? 'derived')
  const [revision, setRevision] = useState<string | null>(original.entry?.revision ?? null)
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState('')
  const [unknown, setUnknown] = useState(false), [checked, setChecked] = useState<{ entry: TopicKnowledge | null } | null>(null)
  const lock = useRef(false), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  async function save() {
    if (lock.current || unknown) return
    if (!title.trim()) { setIssue('请输入知识标题，草稿保留。'); return }
    lock.current = true; setBusy(true)
    const input: TopicKnowledgeWrite = { topicId: original.topicId, entryId: original.entryId, title: title.trim(), content,
      form, certainty, sources: original.entry?.sources ?? [], ...(scope.trim() ? { scope: scope.trim() } : {}), expectedRevision: revision }
    try {
      const result = await rpc('topic.knowledge.write', input)
      if (live.current) onSaved(result.entry)
    } catch (error) {
      if (live.current) { setIssue(`保存未确认：${errorText(error)}。草稿保留；先检查同一条目再决定继续。`); setUnknown(true); setChecked(null) }
    } finally { lock.current = false; if (live.current) setBusy(false) }
  }
  async function inspect() {
    try {
      const result = await rpc('topic.knowledge.read', { topicId: original.topicId, entryId: original.entryId })
      if (live.current) setChecked({ entry: result.entry })
    } catch (error) { if (live.current) setIssue(`检查原保存结果失败：${errorText(error)}。草稿仍保留。`) }
  }
  return <section className="mobile-topic-editor" aria-label="知识编辑">
    <h2>{original.entry ? '编辑知识' : '新建知识'}</h2>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label>标题<TextInput aria-label="知识标题" value={title} maxLength={120} readOnly={busy} onChange={event => setTitle(event.target.value)} /></label>
      <label>正文<ComposerTextarea aria-label="知识正文" value={content} rows={10} readOnly={busy} onValueChange={setContent} /></label>
      <div className="mobile-topics-actions"><label>形式<select value={form} disabled={busy} onChange={event => setForm(event.target.value as TopicKnowledge['form'])}><option value="derived">整理成果</option><option value="reference">来源引用</option></select></label>
        <label>性质<select value={certainty} disabled={busy} onChange={event => setCertainty(event.target.value as TopicKnowledge['certainty'])}>{Object.entries(certaintyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label>适用范围<TextInput value={scope} readOnly={busy} onChange={event => setScope(event.target.value)} /></label>
      {issue && <p className="mobile-topics-issue" role="status">{issue}</p>}
      {unknown && <button type="button" onClick={() => { void inspect() }}>检查原保存结果</button>}
      {checked && <div><p>{checked.entry ? '已读回原条目的当前保存版本；草稿尚未替换。' : '已确认当前没有此条目；草稿仍保留。'}</p>
        {checked.entry && <details><summary>查看已保存正文</summary><pre>{checked.entry.content}</pre></details>}
        <button type="button" onClick={() => { setRevision(checked.entry?.revision ?? null); setUnknown(false); setChecked(null); setIssue('已采用刚读回的 revision，下一次保存须明确提交。') }}>以检查结果为基准继续编辑</button></div>}
      <div className="mobile-topics-actions"><button type="button" onClick={onClose}>返回阅读</button><button type="submit" disabled={busy || unknown}>{busy ? '保存中…' : '保存知识'}</button></div>
    </form>
  </section>
}
