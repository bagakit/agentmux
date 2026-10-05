import { mintObjectId } from '@agentmux/core/object-id'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledge, TopicKnowledgeItem, TopicKnowledgeSource } from '@agentmux/core/control'
import { AgentMarkdown, type OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { getDeviceWorkface } from '../recovery/device-workface'
import { mobileKnowledgeDraftKey, type MobileKnowledgeDraftScope } from '../recovery/knowledge-drafts'
import type { MobileKnowledgeReference } from '../recovery/presentation-route'
import { mobileKnowledgeDraftSource, useKnowledgeDraft, type MobileKnowledgeEditTarget } from './useKnowledgeDraft'

export type TopicsRpc = NonNullable<AgentMuxHostedClient['forwardRpc']>
export type MobileTopicKnowledgeProps = { rpc: TopicsRpc; topicId?: string; title: string; visible?: boolean;
  client?: AgentMuxHostedClient | null; connected?: boolean;
  initialReference?: MobileKnowledgeReference; onReferenceChange?(reference: MobileKnowledgeReference): void;
  openSource(source: TopicKnowledgeSource): void | Promise<void>; openHttpLink?: OpenHttpLink; onBackChange?(back: (() => void) | null): void }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const certaintyLabels = { fact: '事实', inference: '推断', proposal: '提案', decision: '决定' }
function sourceLabel(source: TopicKnowledgeSource): string {
  return source.kind === 'url' ? source.url : source.kind === 'file' ? source.path
    : ({ topic: '原讨论', note: '原笔记 / 块', notebook: '原笔记本', survey: '原研究', space: '原工作面' } as const)[source.kind]
}
const referenceKey = (value: MobileKnowledgeReference) => JSON.stringify({ topicId: value.topicId, entryId: value.entryId,
  view: value.view, ...(value.query ? { query: value.query } : {}), ...(value.draftKey ? { draftKey: value.draftKey } : {}) })
const targetReference = (value: MobileKnowledgeReference | undefined) => value?.topicId && value.entryId && value.view !== 'list'
  ? { topicId: value.topicId, entryId: value.entryId, ...(value.draftKey ? { draftKey: value.draftKey } : {}) } : null
const editReference = (value: MobileKnowledgeReference | undefined): MobileKnowledgeEditTarget | null => value && (value.view === 'edit' || value.view === 'read' && value.draftKey) && value.topicId && value.entryId
  ? { topicId: value.topicId, entryId: value.entryId, ...(value.draftKey ? { draftKey: value.draftKey } : {}) } : null

/** Mount per Topic, preserving visited editors while only the visible scope reads. */
export function MobileTopicKnowledge(props: MobileTopicKnowledgeProps) {
  return <KnowledgeScope key={props.topicId ?? 'all-topics'} {...props} />
}
function KnowledgeScope({ rpc, topicId, title, openSource, openHttpLink, onBackChange, client = null, connected,
  initialReference, onReferenceChange, visible = true }: MobileTopicKnowledgeProps) {
  const [query, setQuery] = useState(initialReference?.query ?? ''), [search, setSearch] = useState(initialReference?.query ?? '')
  const [entries, setEntries] = useState<TopicKnowledgeItem[]>([]), [selected, setSelected] = useState<TopicKnowledge | null>(null)
  const [selection, setSelection] = useState(targetReference(initialReference)), [selectedScope, setSelectedScope] = useState<MobileKnowledgeDraftScope | null>(null)
  const [issue, setIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [edit, setEdit] = useState<MobileKnowledgeEditTarget | null>(editReference(initialReference))
  const [editorKey, setEditorKey] = useState(initialReference?.draftKey ?? `${initialReference?.topicId ?? ''}:${initialReference?.entryId ?? ''}`)
  const [editorVisible, setEditorVisible] = useState(initialReference?.view === 'edit')
  const readIntent = useRef(0), latestClient = useRef(client), latestConnection = useRef(connected)
  latestClient.current = client; latestConnection.current = connected
  const receivedReference = useRef(initialReference ? referenceKey(initialReference) : null), pendingReference = useRef<string | null>(null)
  const backToReading = useCallback(() => setEditorVisible(false), [])
  const backToList = useCallback(() => { readIntent.current += 1; setSelected(null); setSelection(null) }, [])
  const activeBack = editorVisible ? backToReading : selection ? backToList : null
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  useLayoutEffect(() => {
    if (!initialReference) return
    const key = referenceKey(initialReference)
    if (key === receivedReference.current) return
    receivedReference.current = key; pendingReference.current = key; readIntent.current += 1
    const target = targetReference(initialReference)
    setQuery(initialReference.query ?? ''); setSearch(initialReference.query ?? ''); setSelection(target)
    setSelected(previous => previous?.topicId === target?.topicId && previous?.entryId === target?.entryId ? previous : null)
    setEditorVisible(initialReference.view === 'edit')
    if (initialReference.view === 'edit' || initialReference.view === 'read' && initialReference.draftKey) {
      setEdit(editReference(initialReference)); setEditorKey(initialReference.draftKey ?? `${initialReference.topicId}:${initialReference.entryId}`)
    }
  }, [initialReference])
  const reference: MobileKnowledgeReference = editorVisible && edit ? { topicId: edit.topicId, entryId: edit.entryId, view: 'edit',
    ...(edit.draftKey ? { draftKey: edit.draftKey } : {}), ...(query ? { query } : {}) }
    : selection ? { ...selection, view: 'read', ...(edit?.topicId === selection.topicId && edit.entryId === selection.entryId && edit.draftKey ? { draftKey: edit.draftKey } : {}), ...(query ? { query } : {}) }
      : { topicId: topicId ?? null, entryId: null, view: 'list', ...(query ? { query } : {}) }
  const referenceSignature = referenceKey(reference)
  useEffect(() => {
    if (!visible || !onReferenceChange || pendingReference.current && pendingReference.current !== referenceSignature) return
    pendingReference.current = null
    if (receivedReference.current === referenceSignature) return
    receivedReference.current = referenceSignature; onReferenceChange(reference)
  }, [visible, referenceSignature, onReferenceChange])
  useEffect(() => {
    if (!visible || connected === false || !topicId && !search) return
    let live = true; setLoading(true)
    const request = search ? rpc('topic.knowledge.search', { ...(topicId ? { topicId } : {}), query: search })
      : rpc('topic.knowledge.ls', { topicId: topicId! })
    void request.then(result => {
      if (!live || latestConnection.current === false) return
      setEntries(result.entries); setIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n'))
    }).catch(error => { if (live && latestConnection.current !== false) setIssue(`知识读取失败：${errorText(error)}。原阅读保留，可重试。`) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [rpc, topicId, search, refresh, visible, connected])
  useEffect(() => {
    if (!visible || connected === false || !selection || selected?.topicId === selection.topicId && selected.entryId === selection.entryId) return
    const token = ++readIntent.current, originalClient = client, source = mobileKnowledgeDraftSource(client, getDeviceWorkface())
    let live = true
    const valid = () => {
      const now = mobileKnowledgeDraftSource(latestClient.current, getDeviceWorkface())
      return live && latestConnection.current !== false && token === readIntent.current && latestClient.current === originalClient
        && (!source || now && source.scope.origin === now.scope.origin && source.scope.runtimeId === now.scope.runtimeId
          && source.scope.deviceHostId === now.scope.deviceHostId && source.ownerInstanceId === now.ownerInstanceId)
    }
    void rpc('topic.knowledge.read', { topicId: selection.topicId, entryId: selection.entryId }).then(result => {
      if (!valid()) return
      if (!result.entry || result.entry.topicId !== selection.topicId || result.entry.entryId !== selection.entryId) {
        setIssue('原知识条目尚未确认；准确引用和本机草稿保留，可重试读取。'); return
      }
      setSelected(result.entry); setSelectedScope(source?.scope ?? null); setIssue('')
      setEdit(previous => previous?.topicId === result.entry!.topicId && previous.entryId === result.entry!.entryId
        ? { ...previous, entry: result.entry!, scope: source?.scope ?? null } : previous)
    }).catch(error => { if (valid()) setIssue(`正文读取失败：${errorText(error)}。原引用与草稿保留。`) })
    return () => { live = false; readIntent.current += 1 }
  }, [visible, rpc, selection, selected, client, refresh, connected])
  useEffect(() => () => { readIntent.current += 1 }, [])
  function read(entry: TopicKnowledgeItem) {
    readIntent.current += 1; setSelected(null); setSelectedScope(null); setSelection({ topicId: entry.topicId, entryId: entry.entryId })
  }
  function startEdit(entry?: TopicKnowledge) {
    if (edit && (!entry || edit.topicId === entry.topicId && edit.entryId === entry.entryId)) { setEditorVisible(true); return }
    const id = entry?.topicId ?? topicId
    if (!id) return
    const source = mobileKnowledgeDraftSource(client, getDeviceWorkface())
    const entryId = entry?.entryId ?? mintObjectId(), originalScope = entry ? selectedScope : source?.scope ?? null
    setEditorKey(selection?.draftKey ?? (originalScope ? mobileKnowledgeDraftKey(id, entryId, originalScope) : `${id}:${entryId}`))
    setEdit({ topicId: id, entryId, ...(entry ? { entry, scope: selectedScope,
      ...(selection?.draftKey ? { draftKey: selection.draftKey } : {}) } : { isNew: true, scope: source?.scope ?? null }) })
    setEditorVisible(true)
  }
  const draftKeyChanged = useCallback((draftKey: string) => setEdit(previous => previous && previous.draftKey !== draftKey ? { ...previous, draftKey } : previous), [])
  const readIssue = connected === false ? '原知识目录与正文尚未重新读取；准确引用与本机草稿保留。' : issue
  return <section className="mobile-topic-knowledge" aria-label={`${title}知识`}>
    <form className="mobile-topics-search" hidden={Boolean(selection) || editorVisible} onSubmit={event => { event.preventDefault(); setSearch(query.trim()) }}>
      <TextInput aria-label="搜索知识" placeholder={topicId ? '搜索此 Topic 的知识' : '搜索 All Topics'} value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit">搜索</button>
    </form>
    <div className="mobile-topics-actions" hidden={Boolean(selection) || editorVisible}><small>{topicId ? '已保存知识' : 'All Topics'}{loading ? ' · 读取中' : ''}</small>
      <button onClick={() => setRefresh(value => value + 1)}>刷新</button>
      {topicId && <button onClick={() => startEdit()}>{edit ? '继续编辑草稿' : '新建知识'}</button>}
    </div>
    {readIssue && <p className="mobile-topics-issue" role="status">{readIssue}</p>}
    {!selection && !editorVisible && <ul className="mobile-topics-list">{entries.map(entry => <li key={`${entry.topicId}:${entry.entryId}`}>
      <button onClick={() => read(entry)}><strong>{'readError' in entry ? '条目读取未确认' : entry.title}</strong>
        <small>{'readError' in entry ? entry.readError : certaintyLabels[entry.certainty]}{!topicId ? ` · ${entry.topicId}` : ''}</small></button>
    </li>)}</ul>}
    {connected !== false && !selection && !editorVisible && !entries.length && !loading && <p className="mobile-topics-empty">{!topicId && !search ? '输入关键词，搜索所有 Topic 的已保存知识。' : search ? '当前已确认结果没有匹配项。' : '此 Topic 暂无已确认知识条目。'}</p>}
    {selection && <article className="mobile-topic-reading" hidden={editorVisible}>
      <div className="mobile-topics-actions"><button onClick={backToList}>返回知识列表</button>
        <button onClick={() => selected ? startEdit(selected) : setEditorVisible(Boolean(edit))}>{edit ? '继续编辑草稿' : '编辑知识'}</button></div>
      {selected ? <><h2>{selected.title}</h2><small>{certaintyLabels[selected.certainty]} · {selected.form === 'reference' ? '来源引用' : '整理成果'}</small>
        {selected.scope && <p>{selected.scope}</p>}
        <AgentMarkdown content={selected.content} documentMode {...(openHttpLink ? { openHttpLink } : {})} />
        {selected.sources.length > 0 && <details className="mobile-topic-sources" open><summary>来源 · {selected.sources.length}</summary>{selected.sources.map((source, index) =>
          <button className="mobile-topic-source" key={index} onClick={() => { void Promise.resolve().then(() => openSource(source)).catch(error => setIssue(`原来源打开失败：${errorText(error)}。当前阅读保留。`)) }}>{sourceLabel(source)}</button>)}</details>}
      </> : connected !== false && <p role="status">原条目正文待重新读取；准确引用与本机草稿保留。</p>}
    </article>}
    {edit && <div hidden={!editorVisible}><MobileTopicKnowledgeEditor key={editorKey} target={edit} client={client} connected={connected ?? false}
      rpc={rpc} onDraftKeyChange={draftKeyChanged} onClose={backToReading} onSaved={(entry, keepEditing) => {
        setSelected(entry); setSelection({ topicId: entry.topicId, entryId: entry.entryId }); setRefresh(value => value + 1)
        if (!keepEditing) setEditorVisible(false)
      }} /></div>}
  </section>
}

export function MobileTopicKnowledgeEditor({ rpc: _rpc, target, onClose, onSaved, client = null, connected = false, onDraftKeyChange }: {
  rpc: TopicsRpc; target: { topicId: string; entry?: TopicKnowledge; entryId?: string; scope?: MobileKnowledgeDraftScope | null; draftKey?: string; isNew?: boolean };
  client?: AgentMuxHostedClient | null; connected?: boolean; onDraftKeyChange?(key: string): void;
  onClose(): void; onSaved(entry: TopicKnowledge, keepEditing?: boolean): void
}) {
  const [original] = useState(() => ({ ...target, entryId: target.entryId ?? target.entry?.entryId ?? mintObjectId(), isNew: target.isNew ?? (!target.entryId && !target.entry) }))
  const editor = useKnowledgeDraft({ ...original, ...(target.entry ? { entry: target.entry } : {}),
    ...(target.scope !== undefined ? { scope: target.scope } : {}) }, client, connected, onSaved)
  const { draft, saving, checked } = editor
  const key = draft.scope ? mobileKnowledgeDraftKey(draft.topicId, draft.entryId, draft.scope) : null
  useEffect(() => { if (key) onDraftKeyChange?.(key) }, [key, onDraftKeyChange])
  const blocked = draft.attempts.find(value => value.attemptId === draft.blockedAttemptId)
  return <section className="mobile-topic-editor" aria-label="知识编辑">
    <h2>{original.entry ? '编辑知识' : original.isNew ? '新建知识' : '原知识草稿'}</h2>
    <form onSubmit={event => { event.preventDefault(); void editor.save() }}>
      <label>标题<TextInput aria-label="知识标题" value={draft.title} maxLength={120} onChange={event => editor.edit('title', event.target.value)} /></label>
      <label>正文<ComposerTextarea aria-label="知识正文" value={draft.content} rows={10} onValueChange={value => editor.edit('content', value)} /></label>
      <div className="mobile-topics-actions"><label>形式<select value={draft.form} onChange={event => editor.edit('form', event.target.value)}><option value="derived">整理成果</option><option value="reference">来源引用</option></select></label>
        <label>性质<select value={draft.certainty} onChange={event => editor.edit('certainty', event.target.value)}>{Object.entries(certaintyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label>适用范围<TextInput aria-label="知识适用范围" value={draft.authoringScope} onChange={event => editor.edit('authoringScope', event.target.value)} /></label>
      {editor.storageIssue && <p className="mobile-topics-issue" role="status">{editor.storageIssue}</p>}
      {editor.notice && <p className="mobile-topics-issue" role="status">{editor.notice}</p>}
      {!draft.scope && <p role="status">原 Host 身份尚未核实；本页正文可编辑和复制，尚未确认持久保全。</p>}
      {blocked && !saving && <div className="mobile-topics-issue"><p role="status">保存未确认；原请求与后来正文保留，先检查同一条目。</p></div>}
      {draft.attempts.length > 0 && <details><summary>原保存请求与诊断 · {draft.attempts.length}</summary>{draft.attempts.map(attempt =>
        <div key={attempt.attemptId}><p>{attempt.issue ?? (saving && attempt.attemptId === blocked?.attemptId ? '此页明确保存进行中。' : '原保存回执尚未确认，重开不会重发。')}</p><pre>{JSON.stringify(attempt.input, null, 2)}</pre></div>)}</details>}
      {(blocked && !saving || !original.isNew) && <button type="button" onClick={() => { void editor.inspect() }}>检查原保存结果</button>}
      {checked && <div><p>{checked.entry ? '已读回原条目的当前保存版本；草稿尚未替换。' : '已确认当前没有此条目；草稿仍保留。'}</p>
        {checked.entry && <details><summary>查看已保存正文</summary><pre>{checked.entry.content}</pre></details>}
        <button type="button" onClick={editor.adoptChecked}>以检查结果为基准继续编辑</button></div>}
      {editor.storageConflict && <button type="button" onClick={editor.keepDeviceConflict}>明确保留本页正文与双方原请求</button>}
      {[...editor.choices, ...editor.copies].map((copy, index) => <details key={index}><summary>原设备保全副本 · {index + 1}</summary>
        <pre>{JSON.stringify(copy, null, 2)}</pre>{!draft.scope && <button type="button" onClick={() => editor.chooseStored(copy)}>明确采用这份原草稿</button>}</details>)}
      {editor.localCopies.map((copy, index) => <details key={index}><summary>本页先前正文 · {index + 1}</summary><pre>{JSON.stringify(copy, null, 2)}</pre></details>)}
      <div className="mobile-topics-actions"><button type="button" onClick={onClose}>返回阅读</button><button type="submit" disabled={saving || Boolean(draft.blockedAttemptId)}>{saving ? '保存中…' : '保存知识'}</button></div>
    </form>
  </section>
}
