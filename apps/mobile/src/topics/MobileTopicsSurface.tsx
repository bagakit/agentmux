import { MobileHeaderMenu } from '../navigation/MobileHeaderMenu'
import { MobileAvatarNoticeOutlet, MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import type { KnowledgeTopic, TopicCategory, TopicKnowledgeSource } from '@agentmux/core/control'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { MobileTopicKnowledge, type TopicsRpc } from './MobileTopicKnowledge'
import { MobileTopicOrganization } from './MobileTopicOrganization'
import { knowledgePosition, type TopicsNavigationController } from './topics-navigation'
import './topics.css'

const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')
const ThemeObjectTopicIcon = semanticIconComponent('object.topic')

export type MobileTopicsSurfaceProps = { rpc: TopicsRpc; navigation: TopicsNavigationController; visible?: boolean;
  wide?: boolean; client?: AgentMuxHostedClient | null; connected?: boolean;
  renderWorkface(topic: KnowledgeTopic, visible: boolean): ReactNode; openSource(source: TopicKnowledgeSource): void | Promise<void>;
  openHttpLink?: OpenHttpLink; onBackChange?(back: (() => void) | null): void }
/** Content facts stay local; all navigation positions come from the original controller. */
export function MobileTopicsSurface({ rpc, navigation, client, connected, renderWorkface, openSource, openHttpLink, onBackChange, visible = true, wide = false }: MobileTopicsSurfaceProps) {
  const { state, send } = navigation
  const { categoryId, topicId: selectedTopicId } = state.context
  const topicId = selectedTopicId, mode = state.context.mode === 'knowledge' ? 'knowledge' : 'topics'
  const query = state.directoryQuery
  const source = state.sources.at(-1)?.value.source
  const sourceActive = Boolean(source && source.kind !== 'topic')
  const topicBackLabel = source?.kind === 'topic' ? '返回知识' : undefined
  const [categories, setCategories] = useState<TopicCategory[]>([])
  const category = categories.find(value => value.categoryId === categoryId) ?? null
  const [topicDirectories, setTopicDirectories] = useState<Record<string, KnowledgeTopic[]>>({})
  const [topicFacts, setTopicFacts] = useState<KnowledgeTopic[]>([])
  const inTopic = selectedTopicId !== null
  const currentTopic = topicFacts.find(value => value.topicId === selectedTopicId) ?? null
  const contextRef = useRef(state.context); contextRef.current = state.context
  const [topicIssues, setTopicIssues] = useState<Record<string, string>>({}), [topicLoading, setTopicLoading] = useState<string | null>(null)
  const [categoryIssue, setCategoryIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const [organizationBack, setOrganizationBack] = useState<(() => void) | null>(null)
  const directoryVisible = visible && !organizationBack && mode === 'topics' && (wide || !inTopic) && (wide || !sourceActive)
  const metadataVisible = visible && (wide || !sourceActive)
  const readingVisible = visible && !organizationBack && !sourceActive
  const reportOrganizationBack = useCallback((back: (() => void) | null) => setOrganizationBack(() => back), [])
  const backToDiscussion = useCallback(() => send({ type: 'mode', scope: selectedTopicId, mode: 'discussion' }), [send, selectedTopicId])
  const backToCategory = useCallback(() => send({ type: 'topic-back' }), [send])
  const backToAllCategories = useCallback(() => send({ type: 'category', categoryId: null }), [send])
  const position = knowledgePosition(state, selectedTopicId)
  const backInKnowledge = useCallback(() => send({ type: 'knowledge-back', scope: selectedTopicId, to: position.view === 'edit' ? 'read' : 'list' }), [send, selectedTopicId, position.view])
  const activeBack = organizationBack ?? (mode === 'knowledge' ? position.view !== 'list' ? backInKnowledge : backToDiscussion
    : inTopic ? backToCategory : categoryId ? backToAllCategories : null)
  useLayoutEffect(() => {
    if (!visible || sourceActive || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, sourceActive, onBackChange, activeBack])
  const [deepLinkIssue, setDeepLinkIssue] = useState(''), [deepLinkRetry, setDeepLinkRetry] = useState(0)
  useEffect(() => {
    if (!readingVisible || !selectedTopicId || currentTopic && deepLinkRetry === 0) return
    let live = true
    const target = selectedTopicId
    void rpc('topic.inspect', { topicId: target }).then(result => {
      if (!live || contextRef.current.topicId !== target) return
      if (!result.topic || result.topic.topicId !== target) { setDeepLinkIssue('还没确认这个 Topic，可以重试。'); return }
      const value = result.topic
      setTopicFacts(values => values.some(item => item.topicId === value.topicId) ? values.map(item => item.topicId === value.topicId ? value : item) : [...values, value])
      setDeepLinkIssue('')
      setDeepLinkIssue(result.unavailable.map(item => `${item.message} ${item.recovery}`).join('\n'))
    }).catch(error => { if (live && contextRef.current.topicId === target) setDeepLinkIssue(`Topic 读取失败：${error instanceof Error ? error.message : String(error)}。可以重试。`) })
    return () => { live = false }
  }, [rpc, selectedTopicId, readingVisible, deepLinkRetry])
  useEffect(() => {
    if (!metadataVisible) return
    let live = true; setLoading(true)
    void rpc('topic.category.ls', {}).then(result => {
      if (live) { setCategories(previous => result.unavailable.length && !result.categories.length ? previous : result.categories); setCategoryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setCategoryIssue(`分类读取失败：${error instanceof Error ? error.message : String(error)}。可以重试。`) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [rpc, refresh, metadataVisible])
  useEffect(() => {
    if (!metadataVisible || !categoryId) return
    let live = true
    const requestedCategoryId = categoryId
    setTopicLoading(requestedCategoryId)
    void rpc('topic.ls', { categoryId: requestedCategoryId }).then(result => {
      if (live) { setTopicDirectories(previous => ({ ...previous, [requestedCategoryId]: result.unavailable.length && !result.topics.length ? previous[requestedCategoryId] ?? [] : result.topics })); setTopicIssues(previous => ({ ...previous, [requestedCategoryId]: result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n') })) }
    }).catch(error => { if (live) setTopicIssues(previous => ({ ...previous, [requestedCategoryId]: `Topic 读取失败：${error instanceof Error ? error.message : String(error)}。可以重试。` })) })
      .finally(() => { if (live) setTopicLoading(null) })
    return () => { live = false }
  }, [rpc, categoryId, refresh, metadataVisible])
  function open(value: KnowledgeTopic) {
    setDeepLinkIssue('')
    setTopicFacts(values => values.some(item => item.topicId === value.topicId) ? values.map(item => item.topicId === value.topicId ? value : item) : [...values, value])
    send({ type: 'topic', topicId: value.topicId })
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchesCategory = (value: TopicCategory) => value.title.toLocaleLowerCase().includes(normalizedQuery)
  const matchesTopic = (value: KnowledgeTopic) => `${value.title} ${value.summary}`.toLocaleLowerCase().includes(normalizedQuery)
  const matchingCategories = categories.filter(value => matchesCategory(value) || (topicDirectories[value.categoryId] ?? []).some(matchesTopic))
  return <MobileNoticeScope owner={client} identity={[categoryId,topicId]}><section className="mobile-topics mobile-topics-primary" aria-label="Topics" hidden={!visible}>
    <header className="mobile-topics-actions mobile-page-header">
      <MobileHeaderMenu hidden={Boolean(inTopic || categoryId)} />
      {inTopic ? <button aria-label={topicBackLabel ?? '返回分类目录'} onClick={backToCategory}>{topicBackLabel ?? '返回'}</button>
        : categoryId && <button aria-label="返回所有分类" onClick={backToAllCategories}>返回</button>}
      <div className="mobile-topics-heading">{(inTopic || category) && <small>{category?.title ?? 'Topics'}</small>}<h1>{inTopic ? currentTopic?.title ?? 'Topic 未确认' : 'Topics'}</h1></div>
      {visible && <MobileAvatarNoticeOutlet header />}
    </header>
    <MobileTopicOrganization rpc={rpc} categories={categories} category={category} topic={currentTopic} visible={visible && !sourceActive} onBackChange={reportOrganizationBack} onRefresh={() => setRefresh(value => value + 1)} onChanged={() => setRefresh(value => value + 1)} />
    {[categoryIssue].filter(Boolean).map((value, index) => <MobileNotice identity={[categoryId,topicId,value]} key={index} className="mobile-topics-issue" role="status">{value}</MobileNotice>)}
    {deepLinkIssue && <MobileNotice identity={[topicId,deepLinkIssue]} className="mobile-topics-issue" role="status">{deepLinkIssue}<button onClick={() => setDeepLinkRetry(value => value + 1)}>重试读取 Topic</button></MobileNotice>}
    <div className="mobile-topics-tabs" hidden={Boolean(organizationBack) || sourceActive && !wide} role="group" aria-label="Topic 内容"><button aria-pressed={mode === 'topics'} onClick={() => send({ type: 'mode', scope: selectedTopicId, mode: 'discussion' })}>{inTopic ? '讨论' : 'Topics'}</button><button aria-pressed={mode === 'knowledge'} onClick={() => send({ type: 'mode', scope: selectedTopicId, mode: 'knowledge' })}>知识</button></div>
    <div className="mobile-topics-workspace" data-wide={wide || undefined} data-source-active={sourceActive || undefined} hidden={Boolean(organizationBack)}>
    <div className="mobile-topics-directory" aria-label="Topic 导航" hidden={!directoryVisible}>
      <label className="mobile-topics-search"><TextInput aria-label="查找 Topic 或分类" value={query} placeholder="查找 Topic 或分类" onChange={event => send({ type: 'directory-query', query: event.target.value })} /></label>
      <ul className="mobile-topics-list mobile-topics-tree" aria-label="Topic 分类目录">{matchingCategories.map(value => {
        const expanded = categoryId === value.categoryId
        const children = topicDirectories[value.categoryId] ?? []
        const issue = topicIssues[value.categoryId]
        const matchingTopics = matchesCategory(value) ? children : children.filter(matchesTopic)
        return <li key={value.categoryId} data-topic-category={value.categoryId}>
          <button className="mobile-topics-category" aria-expanded={expanded} onClick={() => send({ type: 'category', categoryId: expanded ? null : value.categoryId })}>
            <ThemeNavigationSubmenuIcon size={14} aria-hidden="true" /><span><strong>{value.title}</strong>{value.readError && <small>{value.readError}</small>}</span>
          </button>
          {expanded && <div className="mobile-topics-branch" data-topic-branch={value.categoryId}>
            {issue && <details className="mobile-topics-service"><summary>此分类更新未确认</summary><p className="mobile-topics-issue" role="status">{issue}</p><button type="button" onClick={() => setRefresh(current => current + 1)}>重试此分类</button></details>}
            <ul aria-label={`${value.title}的 Topics`}>{matchingTopics.map(child => <li key={child.topicId}>
              <button className="mobile-topics-topic" aria-current={selectedTopicId === child.topicId ? 'page' : undefined} onClick={() => open(child)}><ThemeObjectTopicIcon size={15} aria-hidden="true" /><span><strong>{child.title}</strong><small>{child.readError ?? child.summary}</small></span></button>
            </li>)}</ul>
            {topicLoading === value.categoryId && <p className="mobile-topics-empty" role="status">读取此分类的 Topics…</p>}
            {topicLoading !== value.categoryId && !matchingTopics.length && <p className="mobile-topics-empty">{issue ? '目录还没确认。' : children.length ? '没有匹配的 Topic。' : '此分类暂无已确认 Topic。'}</p>}
          </div>}
        </li>
      })}</ul>
      {!loading && !matchingCategories.length && <p className="mobile-topics-empty">{categoryIssue ? '目录还没确认。' : categories.length ? '没有匹配的分类或已读取 Topic。' : '暂无已确认分类。'}</p>}
      {categoryId && !category && !loading && <MobileNotice identity={[categoryId]} className="mobile-topics-issue" role="status">还没确认这个分类。可刷新目录或返回所有分类。</MobileNotice>}
    </div>
    <div className="mobile-topics-knowledge-scope" hidden={mode !== 'knowledge' || inTopic || sourceActive && !wide}><MobileTopicKnowledge navigation={navigation} scopeTopicId={null} wide={wide} client={client ?? null} {...(connected !== undefined ? { connected } : {})}
      visible={visible && !organizationBack && mode === 'knowledge' && !inTopic} rpc={rpc} title="All Topics" openSource={openSource} {...(openHttpLink ? { openHttpLink } : {})} /></div>
    {topicFacts.filter(value => state.positions.has(value.topicId)).map(value => <div key={value.topicId} className="mobile-topics-knowledge-scope" hidden={mode !== 'knowledge' || selectedTopicId !== value.topicId || sourceActive && !wide}><MobileTopicKnowledge navigation={navigation} scopeTopicId={value.topicId} wide={wide} client={client ?? null} {...(connected !== undefined ? { connected } : {})}
      visible={visible && !organizationBack && mode === 'knowledge' && selectedTopicId === value.topicId} rpc={rpc} title={value.title} openSource={openSource} {...(openHttpLink ? { openHttpLink } : {})} /></div>)}
    {topicFacts.filter(value => state.positions.has(value.topicId)).map(value => <div key={value.topicId} className="mobile-topic-workface" hidden={selectedTopicId !== value.topicId || mode !== 'topics' || sourceActive}>{renderWorkface(value, readingVisible && selectedTopicId === value.topicId && mode === 'topics')}</div>)}
    </div>
  </section></MobileNoticeScope>
}

