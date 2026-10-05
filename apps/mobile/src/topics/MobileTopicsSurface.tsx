import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { TextInput } from '@agentmux/client-ui/input'
import type { KnowledgeTopic, TopicCategory, TopicKnowledgeSource } from '@agentmux/core/control'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { MobileTopicKnowledge, type TopicsRpc } from './MobileTopicKnowledge'
import { MobileTopicOrganization } from './MobileTopicOrganization'
import type { MobileKnowledgeReference } from '../recovery/presentation-route'
import './topics.css'

export type MobileTopicsSurfaceProps = { rpc: TopicsRpc; visible?: boolean; topicId?: string | null; onOpenTopic(topic: KnowledgeTopic): void | Promise<void>;
  client?: AgentMuxHostedClient | null; connected?: boolean;
  initialKnowledge?: MobileKnowledgeReference; onKnowledgeChange?(reference: MobileKnowledgeReference): void;
  renderWorkface(topic: KnowledgeTopic, visible: boolean): ReactNode; openSource(source: TopicKnowledgeSource): void | Promise<void>;
  openHttpLink?: OpenHttpLink; onBackChange?(back: (() => void) | null): void;
  initialContext?: MobileTopicsContext; onContextChange?(context: MobileTopicsContext): void;
  onLeaveTopic?(): void; topicBackLabel?: string }
/** Presentation references only; all category and Topic facts still come from their original owner. */
export type MobileTopicsContext = { categoryId: string | null; topicId: string | null; mode: 'discussion' | 'knowledge' }
/** Content discovery only; the host callback owns exact workface navigation and lifecycle. */
export function MobileTopicsSurface({ rpc, client, connected, onOpenTopic, renderWorkface, openSource, openHttpLink, onBackChange, initialContext, onContextChange, initialKnowledge, onKnowledgeChange, onLeaveTopic, topicBackLabel, visible = true, topicId }: MobileTopicsSurfaceProps) {
  const initial = useRef(initialContext ?? { categoryId: null, topicId: null, mode: 'discussion' as const })
  const [categories, setCategories] = useState<TopicCategory[]>([]), [categoryId, setCategoryId] = useState(initial.current.categoryId)
  const category = categories.find(value => value.categoryId === categoryId) ?? null
  const [topicDirectories, setTopicDirectories] = useState<Record<string, KnowledgeTopic[]>>({})
  const topics = categoryId ? topicDirectories[categoryId] ?? [] : []
  const [visited, setVisited] = useState<KnowledgeTopic[]>([])
  const [selectedTopicId, setSelectedTopicId] = useState(initial.current.topicId)
  const inTopic = selectedTopicId !== null
  const currentTopic = visited.find(value => value.topicId === selectedTopicId) ?? null
  const [mode, setMode] = useState<'topics' | 'knowledge'>(initial.current.mode === 'knowledge' ? 'knowledge' : 'topics'), [query, setQuery] = useState('')
  const context: MobileTopicsContext = { categoryId, topicId: selectedTopicId, mode: mode === 'knowledge' ? 'knowledge' : 'discussion' }
  const contextRef = useRef(context); contextRef.current = context
  const referenceCallback = useRef(onKnowledgeChange); referenceCallback.current = onKnowledgeChange
  const reportKnowledgeReference = useCallback((scopeId: string, reference: MobileKnowledgeReference) => {
    if ((contextRef.current.topicId ?? 'all-topics') === scopeId) referenceCallback.current?.(reference)
  }, [])
  const [categoryIssue, setCategoryIssue] = useState(''), [topicsIssue, setTopicsIssue] = useState(''), [openIssue, setOpenIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [knowledgeBack, setKnowledgeBack] = useState<{ scopeId: string; back: () => void } | null>(null)
  const [organizationBack, setOrganizationBack] = useState<(() => void) | null>(null)
  const leaveTopicRef = useRef(onLeaveTopic); leaveTopicRef.current = onLeaveTopic
  const reportOrganizationBack = useCallback((back: (() => void) | null) => setOrganizationBack(() => back), [])
  const reportKnowledgeBack = useCallback((scopeId: string, back: (() => void) | null) => {
    setKnowledgeBack(previous => back ? previous?.scopeId === scopeId && previous.back === back ? previous : { scopeId, back }
      : previous?.scopeId === scopeId ? null : previous)
  }, [])
  const backToDiscussion = useCallback(() => setMode('topics'), [])
  const backToCategory = useCallback(() => {
    if (leaveTopicRef.current) { leaveTopicRef.current(); return }
    setSelectedTopicId(null); setMode('topics')
  }, [])
  const backToAllCategories = useCallback(() => { setCategoryId(null); setQuery('') }, [])
  const activeScope = selectedTopicId ?? 'all-topics'
  const activeBack = organizationBack ?? (mode === 'knowledge' ? knowledgeBack && knowledgeBack.scopeId === activeScope ? knowledgeBack.back : backToDiscussion
    : inTopic ? backToCategory : categoryId ? backToAllCategories : null)
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  const [deepLinkIssue, setDeepLinkIssue] = useState(''), [deepLinkRetry, setDeepLinkRetry] = useState(0)
  useEffect(() => {
    if (!initialContext) return
    const current = contextRef.current
    if (current.categoryId === initialContext.categoryId && current.topicId === initialContext.topicId && current.mode === initialContext.mode) return
    setCategoryId(initialContext.categoryId); setSelectedTopicId(initialContext.topicId)
    setMode(initialContext.mode === 'knowledge' ? 'knowledge' : 'topics'); setDeepLinkIssue('')
  }, [initialContext?.categoryId, initialContext?.topicId, initialContext?.mode])
  useEffect(() => {
    if (topicId === undefined) return
    setSelectedTopicId(topicId); setDeepLinkIssue('')
    if (!initialContext || initialContext.topicId !== topicId) setMode('topics')
  }, [topicId])
  useEffect(() => {
    if (!visible || !selectedTopicId || currentTopic && deepLinkRetry === 0) return
    let live = true
    const target = selectedTopicId
    void rpc('topic.inspect', { topicId: target }).then(result => {
      if (!live || contextRef.current.topicId !== target) return
      if (!result.topic || result.topic.topicId !== target) { setDeepLinkIssue('原 Topic 尚未确认，原工作面保留。'); return }
      const value = result.topic
      setVisited(values => values.some(item => item.topicId === value.topicId) ? values.map(item => item.topicId === value.topicId ? value : item) : [...values, value])
      setDeepLinkIssue('')
      setDeepLinkIssue(result.unavailable.map(item => `${item.message} ${item.recovery}`).join('\n'))
    }).catch(error => { if (live && contextRef.current.topicId === target) setDeepLinkIssue(`原 Topic 读取失败：${error instanceof Error ? error.message : String(error)}。原工作面保留。`) })
    return () => { live = false }
  }, [rpc, selectedTopicId, visible, deepLinkRetry])
  useEffect(() => { onContextChange?.(contextRef.current) }, [categoryId, selectedTopicId, mode, onContextChange])
  useEffect(() => {
    if (!visible) return
    let live = true; setLoading(true)
    void rpc('topic.category.ls', {}).then(result => {
      if (live) { setCategories(result.categories); setCategoryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setCategoryIssue(`分类读取失败：${error instanceof Error ? error.message : String(error)}。原目录保留，可重试。`) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [rpc, refresh, visible])
  useEffect(() => {
    if (!visible || !categoryId) return
    let live = true
    void rpc('topic.ls', { categoryId }).then(result => {
      if (live) { setTopicDirectories(previous => ({ ...previous, [categoryId]: result.topics })); setTopicsIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setTopicsIssue(`Topic 读取失败：${error instanceof Error ? error.message : String(error)}。原工作面保留，可重试。`) })
    return () => { live = false }
  }, [rpc, categoryId, refresh, visible])
  function open(value: KnowledgeTopic) {
    setDeepLinkIssue('')
    setSelectedTopicId(value.topicId); setMode('topics'); setVisited(values => values.some(item => item.topicId === value.topicId) ? values.map(item => item.topicId === value.topicId ? value : item) : [...values, value])
    const failed = (error: unknown) => setOpenIssue(`原 Topic 打开未确认：${error instanceof Error ? error.message : String(error)}。原身份与工作面保留。`)
    try { void Promise.resolve(onOpenTopic(value)).catch(failed) } catch (error) { failed(error) }
  }
  return <section className="mobile-topics" aria-label="Topics" hidden={!visible}>
    <header className="mobile-topics-actions">
      {inTopic ? <button aria-label={topicBackLabel ?? '返回分类目录'} onClick={backToCategory}>{topicBackLabel ?? '返回'}</button>
        : categoryId && <button aria-label="返回所有分类" onClick={backToAllCategories}>返回</button>}
      <div className="mobile-topics-heading"><small>{inTopic ? category?.title ?? 'Topics' : categoryId ? 'Topics' : '知识与讨论'}</small><h1>{inTopic ? currentTopic?.title ?? '原 Topic 尚未确认' : category?.title ?? (categoryId ? '原分类尚未确认' : 'Topics')}</h1></div>
    </header>
    <MobileTopicOrganization rpc={rpc} categories={categories} category={category} topic={currentTopic} visible={visible} onBackChange={reportOrganizationBack} onRefresh={() => setRefresh(value => value + 1)} onChanged={() => setRefresh(value => value + 1)} />
    {[categoryIssue, topicsIssue, openIssue].filter(Boolean).map((value, index) => <p key={index} className="mobile-topics-issue" role="status">{value}</p>)}
    {deepLinkIssue && <p className="mobile-topics-issue" role="status">{deepLinkIssue}<button onClick={() => setDeepLinkRetry(value => value + 1)}>重试原 Topic</button></p>}
    <div hidden={Boolean(organizationBack)}>
    <div className="mobile-topics-tabs" role="group" aria-label="Topic 内容"><button aria-pressed={mode === 'topics'} onClick={() => setMode('topics')}>{inTopic ? '讨论' : 'Topics'}</button><button aria-pressed={mode === 'knowledge'} onClick={() => setMode('knowledge')}>知识</button></div>
    <div hidden={inTopic || mode !== 'topics'}>
      <label className="mobile-topics-search"><TextInput aria-label="查找 Topic 或分类" value={query} placeholder={categoryId ? '查找此分类的 Topic' : '查找分类'} onChange={event => setQuery(event.target.value)} /></label>
      <ul className="mobile-topics-list">{!categoryId ? categories.filter(value => value.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(value => <li key={value.categoryId}>
        <button onClick={() => { setCategoryId(value.categoryId); setQuery('') }}><strong>{value.title}</strong>{value.readError && <small>{value.readError}</small>}</button></li>)
        : topics.filter(value => `${value.title} ${value.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(value => <li key={value.topicId}>
          <button onClick={() => open(value)}><strong>{value.title}</strong><small>{value.readError ?? value.summary}</small></button></li>)}</ul>
      {!loading && !(categoryId ? topics.length : categories.length) && <p className="mobile-topics-empty">{(categoryId ? topicsIssue : categoryIssue) ? '目录尚未确认，原工作面仍保留。' : categoryId ? '此分类暂无已确认 Topic。' : '暂无已确认分类。'}</p>}
    </div>
    <div hidden={mode !== 'knowledge' || inTopic}><ScopedKnowledge reportBack={reportKnowledgeBack} reportReference={reportKnowledgeReference} client={client ?? null} {...(connected !== undefined ? { connected } : {})}
      {...(initialContext?.topicId === null && initialKnowledge ? { initialReference: initialKnowledge } : {})}
      visible={visible && !organizationBack && mode === 'knowledge' && !inTopic} rpc={rpc} title="All Topics" openSource={openSource} {...(openHttpLink ? { openHttpLink } : {})} /></div>
    {visited.map(value => <div key={value.topicId} hidden={mode !== 'knowledge' || selectedTopicId !== value.topicId}><ScopedKnowledge reportBack={reportKnowledgeBack} reportReference={reportKnowledgeReference} client={client ?? null} {...(connected !== undefined ? { connected } : {})}
      {...(initialKnowledge?.topicId === value.topicId ? { initialReference: initialKnowledge } : {})}
      visible={visible && !organizationBack && mode === 'knowledge' && selectedTopicId === value.topicId} rpc={rpc} topicId={value.topicId} title={value.title} openSource={openSource} {...(openHttpLink ? { openHttpLink } : {})} /></div>)}
    {visited.map(value => <div key={value.topicId} className="mobile-topic-workface" hidden={selectedTopicId !== value.topicId || mode !== 'topics'}>{renderWorkface(value, visible && selectedTopicId === value.topicId && mode === 'topics' && !organizationBack)}</div>)}
    </div>
  </section>
}

/** Each retained reader reports only its own callback; hiding one cannot clear another scope. */
function ScopedKnowledge({ reportBack, reportReference, ...props }: Parameters<typeof MobileTopicKnowledge>[0] & {
  reportBack(scopeId: string, back: (() => void) | null): void;
  reportReference(scopeId: string, reference: MobileKnowledgeReference): void
}) {
  const scopeId = props.topicId ?? 'all-topics'
  const onBackChange = useCallback((back: (() => void) | null) => reportBack(scopeId, back), [scopeId, reportBack])
  const onReferenceChange = useCallback((reference: MobileKnowledgeReference) => reportReference(scopeId, reference), [scopeId, reportReference])
  return <MobileTopicKnowledge {...props} onBackChange={onBackChange} onReferenceChange={onReferenceChange} />
}
