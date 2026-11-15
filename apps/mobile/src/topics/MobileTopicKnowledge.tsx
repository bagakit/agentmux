import { MobileNotice } from '../notices/MobileNotice'
import { mintObjectId } from '@agentmux/core/object-id'
import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { TopicKnowledge, TopicKnowledgeItem, TopicKnowledgeSource } from '@agentmux/core/control'
import { AgentMarkdown, type OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { getDeviceWorkface } from '../recovery/device-workface'
import { mobileKnowledgeDraftKey, type MobileKnowledgeDraftScope } from '../recovery/knowledge-drafts'
import { knowledgePosition, type TopicsNavigationController } from './topics-navigation'
import { MobileWorkfaceFrame, MobileWorkfacePane } from '../layout/MobileWorkfaceFrame'
import { workfacePanes } from '../layout/workface-presentation'
import { mobileKnowledgeDraftSource, useKnowledgeDraft, type MobileKnowledgeEditTarget } from './useKnowledgeDraft'

export type TopicsRpc = NonNullable<AgentMuxHostedClient['forwardRpc']>
export type MobileTopicKnowledgeProps = { rpc: TopicsRpc; navigation: TopicsNavigationController; scopeTopicId: string | null; title: string; visible?: boolean;
  wide?: boolean; client?: AgentMuxHostedClient | null; connected?: boolean;
  openSource(source: TopicKnowledgeSource): void | Promise<void>; openHttpLink?: OpenHttpLink }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const certaintyLabels = { fact: '事实', inference: '推断', proposal: '提案', decision: '决定' }
function sourceLabel(source: TopicKnowledgeSource): string {
  return source.kind === 'url' ? source.url : source.kind === 'file' ? source.path
    : ({ topic: '讨论', note: '笔记 / 块', notebook: '笔记本', survey: '研究', space: '工作面' } as const)[source.kind]
}
/** Retained data/editor owners consume one canonical navigation position. */
export function MobileTopicKnowledge({ rpc, navigation, scopeTopicId, title, openSource, openHttpLink, client = null, connected,
  visible = true, wide = false }: MobileTopicKnowledgeProps) {
  const { state, send, observe } = navigation
  const position = knowledgePosition(state, scopeTopicId)
  const currentPosition = useRef(position); currentPosition.current = position
  const topicId = scopeTopicId ?? undefined
  const { query, search, reading: selection, editor } = position
  const editorVisible = position.view === 'edit'
  const source = state.sources.at(-1)?.value.source
  const sourceActive = Boolean(source && source.kind !== 'topic')
  const [entries, setEntries] = useState<TopicKnowledgeItem[]>([])
  const [body, setBody] = useState<{ entry: TopicKnowledge; scope: MobileKnowledgeDraftScope | null } | null>(null)
  const selected = selection && body?.entry.topicId === selection.topicId && body.entry.entryId === selection.entryId ? body.entry : null
  const selectedScope = selected ? body!.scope : null
  const [issue, setIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  // These are original business data, not another navigation position. The same editor
  // retains its entry/CAS baseline while a different knowledge entry is being read.
  const editorData = useRef<{ token: number; entry?: TopicKnowledge; scope: MobileKnowledgeDraftScope | null } | null>(null)
  if (editor && editorData.current?.token !== editor.token) editorData.current = { token: editor.token,
    ...(selected?.topicId === editor.topicId && selected.entryId === editor.entryId ? { entry: selected } : {}),
    scope: editor.isNew ? mobileKnowledgeDraftSource(client, getDeviceWorkface())?.scope ?? null : selectedScope }
  if (editor && selected?.topicId === editor.topicId && selected.entryId === editor.entryId)
    editorData.current = { token: editor.token, entry: selected, scope: selectedScope }
  const edit: MobileKnowledgeEditTarget | null = editor ? { topicId: editor.topicId, entryId: editor.entryId,
    ...(editor.draftKey ? { draftKey: editor.draftKey } : {}), ...(editor.isNew ? { isNew: true } : {}),
    ...(editorData.current?.entry ? { entry: editorData.current.entry } : {}), scope: editorData.current?.scope ?? null } : null
  const editorKey = editor?.mountKey
  const panes = workfacePanes({ active: visible, split: wide && !sourceActive, hasSelection: !sourceActive && Boolean(selection || editorVisible) })
  const directoryVisible = panes.navigation.observed
  const readingVisible = panes.content.observed
  const readIntent = useRef(0), latestClient = useRef(client), latestConnection = useRef(connected)
  latestClient.current = client; latestConnection.current = connected
  const backToReading = useCallback(() => send({ type: 'knowledge-back', scope: scopeTopicId, to: 'read' }), [send, scopeTopicId])
  const backToList = useCallback(() => { readIntent.current += 1; send({ type: 'knowledge-back', scope: scopeTopicId, to: 'list' }) }, [send, scopeTopicId])
  useEffect(() => {
    if (!directoryVisible || connected === false || !topicId && !search) return
    let live = true; setLoading(true)
    const request = search ? rpc('topic.knowledge.search', { ...(topicId ? { topicId } : {}), query: search })
      : rpc('topic.knowledge.ls', { topicId: topicId! })
    void request.then(result => {
      if (!live || latestConnection.current === false) return
      setEntries(result.entries); setIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n'))
    }).catch(error => { if (live && latestConnection.current !== false) setIssue(`知识读取失败：${errorText(error)}。可以重试。`) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [rpc, topicId, search, refresh, directoryVisible, connected])
  useEffect(() => {
    if (!readingVisible || connected === false || !selection || selected?.topicId === selection.topicId && selected.entryId === selection.entryId) return
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
        setIssue('没有读到这条知识，可以重试。'); return
      }
      setBody({ entry: result.entry, scope: source?.scope ?? null }); setIssue('')
    }).catch(error => { if (valid()) setIssue(`正文读取失败：${errorText(error)}。可以重试。`) })
    return () => { live = false; readIntent.current += 1 }
  }, [readingVisible, rpc, selection, selected, client, refresh, connected])
  useEffect(() => () => { readIntent.current += 1 }, [])
  function read(entry: TopicKnowledgeItem) {
    readIntent.current += 1; setBody(null)
    send({ type: 'knowledge-read', scope: scopeTopicId, target: { topicId: entry.topicId, entryId: entry.entryId } })
  }
  function startEdit(entry?: TopicKnowledge) {
    if (editor && (!entry || editor.topicId === entry.topicId && editor.entryId === entry.entryId)) {
      send({ type: 'knowledge-edit', scope: scopeTopicId, target: editor, mountKey: editor.mountKey }); return
    }
    const id = entry?.topicId ?? topicId
    if (!id) return
    const source = mobileKnowledgeDraftSource(client, getDeviceWorkface())
    const entryId = entry?.entryId ?? mintObjectId(), originalScope = entry ? selectedScope : source?.scope ?? null
    const mountKey = originalScope ? mobileKnowledgeDraftKey(id, entryId, originalScope) : `${id}:${entryId}`
    send({ type: 'knowledge-edit', scope: scopeTopicId, target: { topicId: id, entryId }, mountKey, ...(!entry ? { isNew: true } : {}) })
  }
  const draftKeyChanged = useCallback((draftKey: string) => {
    if (editor) observe({ type: 'draft-key', scope: scopeTopicId, editorToken: editor.token, target: editor, draftKey })
  }, [observe, scopeTopicId, editor?.token, editor?.topicId, editor?.entryId])
  const readIssue = connected === false ? '连接中断，知识还没重新读取。' : issue
  return <MobileWorkfaceFrame className="mobile-topic-knowledge" presentation={panes} role="region" aria-label={`${title}知识`}>
    <MobileWorkfacePane className="mobile-knowledge-directory" pane="navigation" presentation={panes.navigation} aria-label="知识导航">
    <form className="mobile-topics-search" onSubmit={event => { event.preventDefault(); send({ type: 'knowledge-search', scope: scopeTopicId }) }}>
      <TextInput aria-label="搜索知识" placeholder={topicId ? '搜索此 Topic 的知识' : '搜索 All Topics'} value={query} onChange={event => send({ type: 'knowledge-query', scope: scopeTopicId, query: event.target.value })} />
      <button type="submit">搜索</button>
    </form>
    <div className="mobile-topics-actions"><small>{topicId ? '已保存知识' : 'All Topics'}{loading ? ' · 读取中' : ''}</small>
      <button onClick={() => setRefresh(value => value + 1)}>刷新</button>
      {topicId && <button onClick={() => startEdit()}>{edit ? '继续编辑草稿' : '新建知识'}</button>}
    </div>
    {readIssue && directoryVisible && <MobileNotice identity={[readIssue]} className="mobile-topics-issue" role="status">{readIssue}</MobileNotice>}
    <ul className="mobile-topics-list">{entries.map(entry => <li key={`${entry.topicId}:${entry.entryId}`}>
      <button aria-current={selection?.topicId === entry.topicId && selection.entryId === entry.entryId ? 'page' : undefined} onClick={() => read(entry)}><strong>{'readError' in entry ? '条目读取未确认' : entry.title}</strong>
        <small>{'readError' in entry ? entry.readError : certaintyLabels[entry.certainty]}{!topicId ? ` · ${entry.topicId}` : ''}</small></button>
    </li>)}</ul>
    {connected !== false && !entries.length && !loading && <p className="mobile-topics-empty">{!topicId && !search ? '输入关键词，搜索所有 Topic 的已保存知识。' : search ? '当前已确认结果没有匹配项。' : '此 Topic 暂无已确认知识条目。'}</p>}
    </MobileWorkfacePane>
    <MobileWorkfacePane className="mobile-knowledge-content" pane="content" presentation={panes.content}>
    {readIssue && !directoryVisible && <MobileNotice identity={[readIssue]} className="mobile-topics-issue" role="status">{readIssue}</MobileNotice>}
    {selection && <article className="mobile-topic-reading" hidden={editorVisible}>
      <div className="mobile-topics-actions"><button onClick={backToList}>返回知识列表</button>
        <button onClick={() => selected ? startEdit(selected) : editor ? startEdit() : undefined}>{edit ? '继续编辑草稿' : '编辑知识'}</button></div>
      {selected ? <><h2>{selected.title}</h2><small>{certaintyLabels[selected.certainty]} · {selected.form === 'reference' ? '来源引用' : '整理成果'}</small>
        {selected.scope && <p>{selected.scope}</p>}
        <AgentMarkdown content={selected.content} documentMode {...(openHttpLink ? { openHttpLink } : {})} />
        {selected.sources.length > 0 && <details className="mobile-topic-sources" open><summary>来源 · {selected.sources.length}</summary>{selected.sources.map((source, index) =>
          <button className="mobile-topic-source" key={index} onClick={() => { void Promise.resolve().then(() => openSource(source)).catch(error => setIssue(`来源打开失败：${errorText(error)}。`)) }}>{sourceLabel(source)}</button>)}</details>}
      </> : connected !== false && <MobileNotice identity={[]} role="status">正文还没读到。</MobileNotice>}
    </article>}
    {edit && <div hidden={!editorVisible}><MobileTopicKnowledgeEditor key={editorKey} target={edit} client={client} connected={connected ?? false}
      rpc={rpc} onDraftKeyChange={draftKeyChanged} onClose={backToReading} onSaved={(entry, keepEditing) => {
        const current = currentPosition.current
        const target = current.view === 'edit' ? current.editor : current.reading
        if (target?.topicId === entry.topicId && target.entryId === entry.entryId) setBody({ entry, scope: editorData.current?.scope ?? null })
        setRefresh(value => value + 1)
        if (editor) send({ type: 'knowledge-saved', scope: scopeTopicId, editorToken: editor.token, keepEditing: Boolean(keepEditing) })
    }} /></div>}
    </MobileWorkfacePane>
  </MobileWorkfaceFrame>
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
    <h2>{original.entry ? '编辑知识' : original.isNew ? '新建知识' : '知识草稿'}</h2>
    <form onSubmit={event => { event.preventDefault(); void editor.save() }}>
      <label>标题<TextInput aria-label="知识标题" value={draft.title} maxLength={120} onChange={event => editor.edit('title', event.target.value)} /></label>
      <label>正文<ComposerTextarea syntax="markdown" aria-label="知识正文" value={draft.content} rows={10} onValueChange={value => editor.edit('content', value)} /></label>
      <div className="mobile-topics-actions"><label>形式<select value={draft.form} onChange={event => editor.edit('form', event.target.value)}><option value="derived">整理成果</option><option value="reference">来源引用</option></select></label>
        <label>性质<select value={draft.certainty} onChange={event => editor.edit('certainty', event.target.value)}>{Object.entries(certaintyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label>适用范围<TextInput aria-label="知识适用范围" value={draft.authoringScope} onChange={event => editor.edit('authoringScope', event.target.value)} /></label>
      {editor.storageIssue && <MobileNotice identity={[draft.entryId,editor.storageIssue]} className="mobile-topics-issue" role="status">{editor.storageIssue}</MobileNotice>}
      {editor.notice && <MobileNotice kind="feedback" identity={[draft.entryId,editor.notice]} className="mobile-topics-issue" role="status">{editor.notice}</MobileNotice>}
      {!draft.scope && <MobileNotice identity={[draft.entryId,JSON.stringify(draft.scope)]} role="status">还没确认当前连接的 Mac，正文还没备份；仍可编辑和复制。</MobileNotice>}
      {blocked && !saving && <div className="mobile-topics-issue"><MobileNotice identity={[draft.entryId,draft.blockedAttemptId]} role="status">保存未确认，请先检查保存结果。</MobileNotice></div>}
      {draft.attempts.length > 0 && <details><summary>保存请求与诊断 · {draft.attempts.length}</summary>{draft.attempts.map(attempt =>
        <div key={attempt.attemptId}><p>{attempt.issue ?? (saving && attempt.attemptId === blocked?.attemptId ? '此页明确保存进行中。' : '保存还没确认。')}</p><pre>{JSON.stringify(attempt.input, null, 2)}</pre></div>)}</details>}
      {(blocked && !saving || !original.isNew) && <button type="button" onClick={() => { void editor.inspect() }}>检查保存结果</button>}
      {checked && <div><p>{checked.entry ? '已读到 Mac 上保存的版本，草稿没有被替换。' : '已确认当前没有此条目；草稿仍保留。'}</p>
        {checked.entry && <details><summary>查看已保存正文</summary><pre>{checked.entry.content}</pre></details>}
        <button type="button" onClick={editor.adoptChecked}>以检查结果为基准继续编辑</button></div>}
      {editor.storageConflict && <button type="button" onClick={editor.keepDeviceConflict}>保留本页正文和两边的请求</button>}
      {[...editor.choices, ...editor.copies].map((copy, index) => <details key={index}><summary>设备上的副本 · {index + 1}</summary>
        <pre>{JSON.stringify(copy, null, 2)}</pre>{!draft.scope && <button type="button" onClick={() => editor.chooseStored(copy)}>采用这份草稿</button>}</details>)}
      {editor.localCopies.map((copy, index) => <details key={index}><summary>本页先前正文 · {index + 1}</summary><pre>{JSON.stringify(copy, null, 2)}</pre></details>)}
      <div className="mobile-topics-actions"><button type="button" onClick={onClose}>返回阅读</button><button type="submit" disabled={saving || Boolean(draft.blockedAttemptId)}>{saving ? '保存中…' : '保存知识'}</button></div>
    </form>
  </section>
}
