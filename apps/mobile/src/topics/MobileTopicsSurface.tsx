import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KnowledgeTopic, TopicCategory, TopicKnowledgeSource } from '@agentmux/core/control'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { MobileTopicKnowledge, type TopicsRpc } from './MobileTopicKnowledge'
import { MobileTopicOrganization } from './MobileTopicOrganization'
import './topics.css'

export type MobileTopicsSurfaceProps = { rpc: TopicsRpc; visible?: boolean; topicId?: string | null; onOpenTopic(topic: KnowledgeTopic): void | Promise<void>;
  renderWorkface(topic: KnowledgeTopic, visible: boolean): ReactNode; openSource(source: TopicKnowledgeSource): void | Promise<void>;
  openHttpLink?: OpenHttpLink }
/** Content discovery only; the host callback owns exact workface navigation and lifecycle. */
export function MobileTopicsSurface({ rpc, onOpenTopic, renderWorkface, openSource, openHttpLink, visible = true, topicId }: MobileTopicsSurfaceProps) {
  const [categories, setCategories] = useState<TopicCategory[]>([]), [category, setCategory] = useState<TopicCategory | null>(null)
  const [topics, setTopics] = useState<KnowledgeTopic[]>([]), [topic, setTopic] = useState<KnowledgeTopic | null>(null)
  const [visited, setVisited] = useState<KnowledgeTopic[]>([])
  const [inTopic, setInTopic] = useState(false)
  const [mode, setMode] = useState<'topics' | 'knowledge'>('topics'), [query, setQuery] = useState('')
  const [categoryIssue, setCategoryIssue] = useState(''), [topicsIssue, setTopicsIssue] = useState(''), [openIssue, setOpenIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const navigationIntent = useRef(0)
  const [deepLinkIssue, setDeepLinkIssue] = useState(''), [deepLinkRetry, setDeepLinkRetry] = useState(0)
  useEffect(() => {
    if (!visible || topicId === undefined) return
    const intent = ++navigationIntent.current
    if (topicId === null) { setInTopic(false); setDeepLinkIssue(''); return }
    let live = true
    void rpc('topic.inspect', { topicId }).then(result => {
      if (!live || intent !== navigationIntent.current) return
      if (!result.topic) { setDeepLinkIssue('原 Topic 尚未确认，原工作面保留。'); return }
      const value = result.topic
      setTopic(value); setInTopic(true); setMode('topics')
      setVisited(values => values.some(item => item.topicId === value.topicId) ? values : [...values, value])
      setDeepLinkIssue('')
      setDeepLinkIssue(result.unavailable.map(item => `${item.message} ${item.recovery}`).join('\n'))
    }).catch(error => { if (live && intent === navigationIntent.current) setDeepLinkIssue(`原 Topic 读取失败：${error instanceof Error ? error.message : String(error)}。原工作面保留。`) })
    return () => { live = false }
  }, [rpc, topicId, visible, deepLinkRetry])
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
    if (!visible || !category) return
    let live = true
    void rpc('topic.ls', { categoryId: category.categoryId }).then(result => {
      if (live) { setTopics(result.topics); setTopicsIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setTopicsIssue(`Topic 读取失败：${error instanceof Error ? error.message : String(error)}。原工作面保留，可重试。`) })
    return () => { live = false }
  }, [rpc, category, refresh, visible])
  function open(value: KnowledgeTopic) {
    navigationIntent.current += 1; setDeepLinkIssue('')
    setTopic(value); setInTopic(true); setMode('topics'); setVisited(values => values.some(item => item.topicId === value.topicId) ? values : [...values, value])
    const failed = (error: unknown) => setOpenIssue(`原 Topic 打开未确认：${error instanceof Error ? error.message : String(error)}。原身份与工作面保留。`)
    try { void Promise.resolve(onOpenTopic(value)).catch(failed) } catch (error) { failed(error) }
  }
  return <section className="mobile-topics" aria-label="Topics" hidden={!visible}>
    <header className="mobile-topics-actions">
      {inTopic ? <button aria-label="返回分类目录" onClick={() => { navigationIntent.current += 1; setInTopic(false); setMode('topics') }}>返回</button>
        : category && <button aria-label="返回所有分类" onClick={() => { navigationIntent.current += 1; setCategory(null); setQuery('') }}>返回</button>}
      <h1>{inTopic ? topic?.title : category?.title ?? 'Topics'}</h1>
      <MobileTopicOrganization rpc={rpc} categories={categories} category={category} topic={inTopic ? topic : null} onRefresh={() => setRefresh(value => value + 1)} onChanged={() => setRefresh(value => value + 1)} />
    </header>
    {[categoryIssue, topicsIssue, openIssue].filter(Boolean).map((value, index) => <p key={index} className="mobile-topics-issue" role="status">{value}</p>)}
    {deepLinkIssue && <p className="mobile-topics-issue" role="status">{deepLinkIssue}<button onClick={() => setDeepLinkRetry(value => value + 1)}>重试原 Topic</button></p>}
    <div className="mobile-topics-tabs" role="group" aria-label="Topic 内容"><button aria-pressed={mode === 'topics'} onClick={() => setMode('topics')}>{inTopic ? '讨论' : 'Topics'}</button><button aria-pressed={mode === 'knowledge'} onClick={() => setMode('knowledge')}>知识</button></div>
    <div hidden={inTopic || mode !== 'topics'}>
      <label className="mobile-topics-search"><input aria-label="查找 Topic 或分类" value={query} placeholder={category ? '查找此分类的 Topic' : '查找分类'} onChange={event => setQuery(event.target.value)} /></label>
      <ul className="mobile-topics-list">{!category ? categories.filter(value => value.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(value => <li key={value.categoryId}>
        <button onClick={() => { setCategory(value); setTopics([]); setQuery('') }}><strong>{value.title}</strong>{value.readError && <small>{value.readError}</small>}</button></li>)
        : topics.filter(value => `${value.title} ${value.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(value => <li key={value.topicId}>
          <button aria-current={topic?.topicId === value.topicId ? 'page' : undefined} onClick={() => open(value)}><strong>{value.title}</strong><small>{value.readError ?? value.summary}</small></button></li>)}</ul>
      {!loading && !(category ? topics.length : categories.length) && <p className="mobile-topics-empty">{(category ? topicsIssue : categoryIssue) ? '目录尚未确认，原工作面仍保留。' : category ? '此分类暂无已确认 Topic。' : '暂无已确认分类。'}</p>}
    </div>
    <div hidden={mode !== 'knowledge' || inTopic}><MobileTopicKnowledge visible={visible && mode === 'knowledge' && !inTopic} rpc={rpc} title="All Topics" openSource={openSource} {...(openHttpLink ? { openHttpLink } : {})} /></div>
    {visited.map(value => <div key={value.topicId} hidden={mode !== 'knowledge' || !inTopic || topic?.topicId !== value.topicId}><MobileTopicKnowledge visible={visible && inTopic && mode === 'knowledge' && topic?.topicId === value.topicId} rpc={rpc} topicId={value.topicId} title={value.title} openSource={openSource} {...(openHttpLink ? { openHttpLink } : {})} /></div>)}
    {topic && <div className="mobile-topic-workface" hidden={!inTopic || mode !== 'topics'}>{renderWorkface(topic, visible && inTopic && mode === 'topics')}</div>}
  </section>
}
