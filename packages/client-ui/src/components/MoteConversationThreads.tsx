import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DispatchObservation } from '@agentmux/core'
import type { MoteDialogueLink, MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import type { ConversationRef } from '@agentmux/core/conversation'
import { useConversationView, type ConversationViewClient } from '../lib/use-conversation-view.js'
import { describeConversationWindow, type ConversationRecord } from '../lib/conversation-records.js'
import { useVisibleWork } from '../lib/use-visible-work.js'
import { ConversationView } from './ConversationView.js'
import type { ConversationRecordInsertion } from './ConversationRecordSequence.js'
import type { ConversationReadingGeometry } from '../lib/conversation-body-work.js'
import { createSpeakerResolver, type DescribeSpeaker } from '../lib/conversation-speaker.js'
import { semanticIconComponent } from '../theme/icons.js'
import { TextInput } from '../input/index.js'
import { AgentMarkdown } from './AgentMarkdown.js'
import '../styles/mote-conversation.css'
import { MotePeriodConversation } from './MotePeriodConversation.js'
export { MotePeriodConversation } from './MotePeriodConversation.js'
import { moteConversationPeriodLabel, moteConversationTransitionLabel } from './MoteConversationStart.js'
const ThreadIcon = semanticIconComponent('object.conversations')
const SearchIcon = semanticIconComponent('action.search')
const DisclosureIcon = semanticIconComponent('navigation.disclosure')

type Work = Extract<MoteDialogueLink, { kind: 'work' }>
type Source = Extract<MoteDialogueLink, { kind: 'main' }>
type ReadWork = { source: Work; value: DispatchObservation }
export type MoteWorkEvent = { id: string; sources: Work[]; at: number | null }
export type MoteWorkReader = (source: Work) => Promise<DispatchObservation>
type ThreadSummary = { key: string; search: string; read: boolean; reported: boolean; question: boolean; replies: number }
type ThreadFilter = 'all' | 'question' | 'reported' | 'unconfirmed'
const workKey = (event: MoteWorkEvent) => JSON.stringify(event.sources.map(source => [source.origin.hostId, source.origin.messageId]))
const sameActor = (a: ConversationRef, b: ConversationRef) => a.hostId === b.hostId && a.agentSessionId === b.agentSessionId
/** Multiple workers and repeated role generations retain one original event/source identity. */
export function moteWorkEvents(links: readonly MoteDialogueLink[]): MoteWorkEvent[] {
  const events = new Map<string, MoteWorkEvent>()
  for (const link of links) if (link.kind === 'work') {
    const prior = events.get(link.eventId)
    if (prior) { prior.sources.push(link); if (link.origin.createdAt !== null && (prior.at === null || link.origin.createdAt < prior.at)) prior.at = link.origin.createdAt }
    else events.set(link.eventId, { id: link.eventId, sources: [link], at: link.origin.createdAt })
  }
  for (const event of events.values()) event.sources.sort((a, b) => a.origin.createdAt === b.origin.createdAt ? a.sequence - b.sequence : a.origin.createdAt === null ? 1 : b.origin.createdAt === null ? -1 : a.origin.createdAt - b.origin.createdAt)
  return [...events.values()].sort((a, b) => a.at === b.at ? a.sources[0]!.sequence - b.sources[0]!.sequence : a.at === null ? 1 : b.at === null ? -1 : a.at - b.at)
}
function recordedTime(at: number | null) {
  const date = at === null ? null : new Date(at)
  return date && Number.isFinite(date.getTime()) ? <time className="mote-work-event__time" dateTime={date.toISOString()}>{date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : <span className="mote-work-event__time">时间未记录</span>
}
function EarlierConversation({ source, client, visible, name, geometry, describeSpeaker, mainAvatar }: {
  source: Source; client: ConversationViewClient | null; visible: boolean; name: string; geometry?: ConversationReadingGeometry | undefined; describeSpeaker?: DescribeSpeaker | undefined; mainAvatar?: ((size?: number) => ReactNode) | undefined
}) {
  const work = useVisibleWork<HTMLElement>(visible)
  const reference = useMemo(() => ({ hostId: source.reference.hostId, agentSessionId: source.reference.sessionId }), [source.reference.hostId, source.reference.sessionId])
  const view = useConversationView(client, reference, work.visible, { identity: 'mote-earlier-source' })
  const reading = useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])
  const describe = useMemo<DescribeSpeaker>(() => {
    const original = describeSpeaker ?? createSpeakerResolver()
    return (speaker, size) => speaker.role === 'agent' && speaker.id === reference.agentSessionId
      ? { ...original(speaker, size), name, ...(mainAvatar ? { avatar: mainAvatar(size) } : {}) } : original(speaker, size)
  }, [describeSpeaker, reference.agentSessionId, name, mainAvatar])
  return <section ref={work.ref} className="mote-conversation__earlier" data-mote-earlier-source={JSON.stringify(reference)}>
    <div className="mote-conversation__handoff"><span>{name} · 原 Agent 对话</span><small>完整 Session，可能包含其他时期的工作</small><details><summary>来源</summary><p>{reference.hostId} / {reference.agentSessionId}</p><p>原 Session 全段；没有推断消息切点。</p></details></div>
    {view.error || view.observationError ? <p role="status">{(view.error ?? view.observationError)?.message}<button type="button" onClick={() => void view.refresh()}>重读原对话</button></p> : null}
    {reading ? <ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={reading.records} originalRecords={reading.originalRecords}
      page={reading.historyPage ?? null} coverage={reading.timeline.coverage} coverageSummary="阅读范围与来源" showInputSource={false} detailsOnlyMetadata sourceLabelsInDetails
      active={work.visible} readProcessDetail={view.readProcessDetail} describeSpeaker={describe}
      {...(geometry ? { readingGeometry: { ...geometry, following: () => false } } : {})} /> : <p className="mote-conversation__muted">{work.visible ? '读取原对话…' : '向上阅读这段原对话'}</p>}
    {view.hasMore ? <button type="button" className="mote-conversation__link" onClick={() => void view.earlier()}>更早的消息</button> : null}
  </section>
}
export { EarlierConversation as MoteOriginalConversation }
function WorkEventCard({ event, read, visible, memberName, onOpen, expanded, onExpand, refreshSource, discovering = false, onSummary }: {
  event: MoteWorkEvent; read: MoteWorkReader; visible: boolean; memberName?: ((source: Work) => string) | undefined; onOpen?: ((source: Work) => void) | undefined
  expanded: boolean; onExpand(): void; refreshSource: MoteDialoguePage | null; discovering?: boolean
  onSummary?: ((id: string, summary: ThreadSummary) => void) | undefined
}) {
  const visibility = useVisibleWork<HTMLElement>(visible)
  const key = workKey(event)
  const [state, setState] = useState<{ key: string; values: ReadWork[]; issue: string | null }>({ key, values: [], issue: null })
  const [allReplies, setAllReplies] = useState(false)
  const [retry, setRetry] = useState(0), owner = useRef<object>({})
  const observed = useRef<{ key: string; read: MoteWorkReader; page: MoteDialoguePage | null; retry: number } | null>(null)
  useEffect(() => {
    const lifetime = {}; owner.current = lifetime
    if (!visible || !visibility.visible && !discovering) return
    if (observed.current?.key === key && observed.current.read === read && observed.current.page === refreshSource && observed.current.retry === retry) return
    void Promise.all(event.sources.map(async source => {
      const value = await read(source), original = value.source.envelope
      if (original.messageId !== source.origin.messageId || original.threadId !== source.origin.threadId || original.senderSessionId !== source.origin.senderSessionId ||
        original.recipientSessionId !== source.origin.recipientSessionId || value.dispatch.sourceMessageId !== original.messageId) throw new Error('原工作来源未能核对；关联和原工作面已保留。')
      return { source, value }
    })).then(values => { if (owner.current === lifetime) { observed.current = { key, read, page: refreshSource, retry }; setState({ key, values, issue: null }) } })
      .catch(error => { if (owner.current === lifetime) setState(previous => ({ key, values: previous.key === key ? previous.values : [], issue: error instanceof Error ? error.message : String(error) })) })
    return () => { if (owner.current === lifetime) owner.current = {} }
  }, [key, read, visible, visibility.visible, discovering, retry, refreshSource])
  const selected = state.key === key ? state : { values: [], issue: null }
  const first = selected.values[0]?.value, summary = first?.source.envelope.body.split('\n').find(line => line.trim())
  const hasQuestion = selected.values.some(({ value }) => value.dispatch.events.some(event => event.kind === 'question' || event.kind === 'escalation'))
  const reported = selected.values.length > 0 && selected.values.every(({ value }) => value.dispatch.events.some(event => event.kind === 'worker_done'))
  const workerCount = new Set(event.sources.map(source => JSON.stringify([source.origin.hostId, source.origin.recipientSessionId]))).size
  const replies = new Set(selected.values.flatMap(({ source, value }) => value.replies.map(reply => JSON.stringify([source.origin.hostId, reply.envelope.messageId])))).size
  const search = [summary ?? '', ...event.sources.map(source => memberName?.(source) ?? '')].join(' ').toLocaleLowerCase()
  useEffect(() => { onSummary?.(event.id, { key, search, read: selected.values.length === event.sources.length && !selected.issue, reported, question: hasQuestion, replies }) },
    [event.id, key, search, selected.values.length, selected.issue, event.sources.length, reported, hasQuestion, replies, onSummary])
  return <article ref={visibility.ref} className="mote-work-event" data-mote-work-event={event.id} data-expanded={expanded}>
    <button type="button" className="mote-work-event__summary" aria-expanded={expanded} onClick={onExpand}>
      <ThreadIcon className="mote-work-event__mark" size={16} aria-hidden="true" /><span><strong>{summary || '工作 Thread'}</strong>
        <small>{memberName?.(event.sources[0]!) ?? '执行者未确认'}{workerCount > 1 ? ` · ${workerCount} 位执行者` : ''}
          <span> · {reported ? '已回报' : hasQuestion ? '含问题记录' : first ? '已派出' : '待核对'}{replies ? ` · ${replies} 条回复` : ''}</span></small></span>
      {recordedTime(event.at)}<span className="mote-work-event__disclosure" aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {expanded ? <div className="mote-work-event__thread">
      {selected.issue ? <p role="status">{selected.issue}<button type="button" onClick={() => setRetry(value => value + 1)}>重读原来源</button></p> : null}
      {selected.values.map(({ source, value }) => {
        const replyName = (sender: string | null) => sender === source.origin.recipientSessionId ? memberName?.(source) ?? sender : sender
        return <section key={source.sequence}>
        <details className="mote-work-event__assignment"><summary>原任务</summary><AgentMarkdown content={value.source.envelope.body} visible={visible && expanded} readOnly /></details>
        {!allReplies && value.replies.length > 3 ? <button type="button" className="mote-conversation__link" onClick={() => setAllReplies(true)}>查看更早的 {value.replies.length - 3} 条原回复</button> : null}
        {(allReplies ? value.replies : value.replies.slice(-3)).map(reply => <div className="mote-work-event__reply" key={reply.envelope.messageId}><small>{replyName(reply.envelope.senderSessionId)} · {recordedTime(reply.envelope.createdAt)}</small><AgentMarkdown content={reply.envelope.body} visible={visible && expanded} readOnly /></div>)}
        {!value.replies.length ? <p className="mote-conversation__muted">尚未读取到该派工的回复记录。</p> : null}
      </section> })}
      {!selected.values.length && !selected.issue ? <p className="mote-conversation__muted">读取原工作 thread…</p> : null}
      {onOpen ? <div className="mote-work-event__actions">{event.sources.map(source => <button type="button" key={source.sequence} onClick={() => onOpen(source)}>继续原工作{event.sources.length > 1 ? ` · ${memberName?.(source) ?? '执行者未确认'}` : ''}</button>)}</div> : null}
      <details><summary>原来源</summary>{event.sources.map(source => <p key={source.sequence}>{source.origin.hostId} / {source.origin.messageId} / {source.origin.threadId}</p>)}
        {reported ? <p>执行者已回报；任务验收另见原工作记录。</p> : null}</details>
    </div> : null}
  </article>
}
/** Original dispatch threads, independent of the Main Agent's native reader. */
export function MoteWorkThreads({ page, issue, loading, visible, readWork, memberName, onRefresh, onOlder, onOpenWork }: {
  page: MoteDialoguePage | null; issue: string | null; loading: boolean; visible: boolean; readWork: MoteWorkReader
  memberName?: ((source: Work) => string) | undefined; onRefresh(): void; onOlder?(): void; onOpenWork(source: Work): void
}) {
  const viewport = useVisibleWork<HTMLElement>(visible)
  const [history, setHistory] = useState(false), [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<ThreadFilter>('all')
  const [summaries, setSummaries] = useState<Record<string, ThreadSummary>>({})
  const identity = page?.main.identity ? JSON.stringify(page.main.identity) : ''
  useEffect(() => { setExpanded(new Set()); setQuery(''); setFilter('all'); setSummaries({}) }, [identity])
  const events = useMemo(() => moteWorkEvents(page?.links ?? []), [page?.links])
  const onSummary = useCallback((id: string, summary: ThreadSummary) => setSummaries(previous =>
    JSON.stringify(previous[id]) === JSON.stringify(summary) ? previous : { ...previous, [id]: summary }), [])
  const search = query.trim().toLocaleLowerCase(), discovering = Boolean(search || filter !== 'all')
  const knownSummary = (event: MoteWorkEvent) => summaries[event.id]?.key === workKey(event) ? summaries[event.id] : undefined
  const matches = (event: MoteWorkEvent) => {
    const summary = knownSummary(event)
    if (!summary) return true // Keep the exact unread source discoverable until its own read returns.
    return (!search || summary.search.includes(search)) && (filter === 'all' || filter === 'question' && summary.question ||
      filter === 'reported' && summary.reported || filter === 'unconfirmed' && !summary.read)
  }
  const pending = events.filter(event => !knownSummary(event)?.read).length
  const matched = events.filter(matches).length
  let previousDay = ''
  return <section ref={viewport.ref} className="mote-conversation mote-threads" data-mote-threads={identity || undefined}>
    <label className="mote-threads__search"><SearchIcon size={16} aria-hidden="true" /><TextInput aria-label="查找工作标题或执行者" placeholder="查找工作标题或执行者" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <nav className="mote-conversation__navigation" aria-label="Threads 浏览方式">
      <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>工作列表</button>
      <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>事件历史</button>
      <button type="button" className="mote-conversation__refresh" onClick={onRefresh} disabled={loading}>{loading ? '正在读取…' : '刷新'}</button>
    </nav>
    <div className="mote-threads__filters" role="group" aria-label="按回报记录筛选">{([
      ['all', '全部'], ['question', '含问题'], ['reported', '已回报'], ['unconfirmed', '待核对']
    ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {issue ? <p role="status" className="mote-conversation__issue">{issue} 原工作与输入仍保留。</p> : null}
    {discovering ? <p className="mote-threads__scope" role="status">在已载入的 {events.length} 项工作中查找{pending ? ` · ${pending} 项资料待核对` : ''}{page?.next ? ' · 可继续读取更早工作' : ''}</p> : null}
    <ol className={`mote-threads__list${history ? ' mote-threads__list--history' : ''}`}>{[...events].reverse().map(event => {
      const date = event.at === null ? null : new Date(event.at), valid = date && Number.isFinite(date.getTime())
      const day = valid ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '日期未记录'
      const shown = matches(event), heading = history && shown && previousDay !== day
      if (shown) previousDay = day
      return <li key={event.id} hidden={!shown}>{heading ? <h3 className="mote-threads__day">{day}</h3> : null}
        <WorkEventCard key={event.id} event={event} read={readWork} visible={visible} discovering={discovering && viewport.visible} memberName={memberName} onOpen={onOpenWork} refreshSource={page} onSummary={onSummary}
          expanded={expanded.has(event.id)} onExpand={() => setExpanded(previous => { const next = new Set(previous); next.has(event.id) ? next.delete(event.id) : next.add(event.id); return next })} />
      </li>
    })}</ol>
    {events.length > 0 && !matched ? <p className="mote-conversation__muted">没有匹配的已载入工作。{pending ? '部分原资料尚未确认，可重新读取。' : page?.next ? '可继续读取更早的工作。' : '试试其他标题或执行者。'}</p> : null}
    {!events.length ? <p className="mote-conversation__muted">{loading ? '读取工作 threads…' : '还没有已关联的工作事件。其他 Agent 的原对话在下方。'}</p> : null}
    {page?.next ? <button type="button" className="mote-conversation__link" onClick={onOlder}>更早的工作事件</button> : null}
  </section>
}

function EarlierSource({ source, ...props }: Parameters<typeof EarlierConversation>[0]) {
  const [open, setOpen] = useState(false), [original, setOriginal] = useState(false)
  return <details className="mote-conversation__source" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>此前的主对话 <span>{moteConversationPeriodLabel(source.period)} · {moteConversationTransitionLabel(source.period)}</span></summary>
    {source.period ? <><MotePeriodConversation {...props} source={source} visible={props.visible && open} onOpenOriginal={() => setOriginal(true)} />
      {original && <details open><summary>原 Agent 对话 · 完整 Session</summary><EarlierConversation {...props} source={source} visible={props.visible && open} /></details>}</> : <>
      <p className="mote-conversation__muted">此来源未记录主角色的消息切点。展开查看原 Session 全段；轮转后的其他工作也可能在内。</p>
      <EarlierConversation {...props} source={source} visible={props.visible && open} /></>}
  </details>
}

export type MoteInlineWork = {
  readWork: MoteWorkReader
  memberName?(source: Work): string
  onOpenWork?(source: Work): void
  onShowThreads?(): void
}

/** Related work is a disclosure after this original dialogue, never a fabricated message/time anchor. */
function InlineWorkThreads({ page, actor, visible, work }: { page: MoteDialoguePage; actor: ConversationRef; visible: boolean; work: MoteInlineWork }) {
  const events = useMemo(() => moteWorkEvents(page.links).filter(event => event.sources.some(source => sameActor(source.main, actor))), [page.links, actor.hostId, actor.agentSessionId])
  const [open, setOpen] = useState(false), [presented, setPresented] = useState(false), [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const identity = JSON.stringify([page.main.identity, actor])
  useEffect(() => { setOpen(false); setPresented(false); setExpanded(new Set()) }, [identity])
  if (!events.length) return null
  return <details className="mote-conversation__related" data-mote-related-work={identity} open={open} onToggle={event => {
    setOpen(event.currentTarget.open); if (event.currentTarget.open) setPresented(true)
  }}>
    <summary><ThreadIcon size={16} aria-hidden="true" /><span>相关工作 Threads</span><span className="mote-conversation__related-count">{events.length}</span><DisclosureIcon className="mote-conversation__related-chevron" size={14} aria-hidden="true" /></summary>
    {presented ? <div className="mote-conversation__related-body" hidden={!open}>{events.map(event => <WorkEventCard key={event.id} event={event} read={work.readWork} visible={visible && open}
      memberName={work.memberName} onOpen={work.onOpenWork} refreshSource={page} expanded={expanded.has(event.id)} onExpand={() => setExpanded(previous => {
        const next = new Set(previous); next.has(event.id) ? next.delete(event.id) : next.add(event.id); return next
      })} />)}
      {work.onShowThreads ? <button type="button" className="mote-conversation__link" onClick={work.onShowThreads}>查看全部 Threads</button> : null}
    </div> : null}
  </details>
}

/** Discussion retains Main sources and a compact disclosure of exactly linked work. */
export function MoteConversationThreads({ page, issue, actor, name, visible, conversationClient, renderCurrent, onOlder, readingGeometry, describeSpeaker, mainAvatar, work }: {
  page: MoteDialoguePage | null; issue: string | null; actor: ConversationRef; name: string; visible: boolean
  conversationClient: ConversationViewClient | null
  mainAvatar?: ((size?: number) => ReactNode) | undefined
  work?: MoteInlineWork | undefined
  onOlder?(): void
  renderCurrent(insertions: readonly ConversationRecordInsertion[]): ReactNode; readingGeometry?: ConversationReadingGeometry; describeSpeaker?: DescribeSpeaker
}) {
  const main = page?.main.current
  const current = Boolean(main && sameActor(actor, { hostId: main.hostId, agentSessionId: main.sessionId }))
  const sources = useMemo(() => {
    const unique = new Map<string, Source>()
    for (const link of [...page?.links ?? []].reverse()) if (link.kind === 'main' && (link.period ? link.period.roleRevision !== page?.main.roleRevision : !sameActor(actor, { hostId: link.reference.hostId, agentSessionId: link.reference.sessionId }))) {
      const key = link.period?.id ?? JSON.stringify([link.roleRevision, link.operationId]); if (!unique.has(key)) unique.set(key, link)
    }
    return [...unique.values()]
  }, [page?.links, actor.hostId, actor.agentSessionId])
  return <div className="mote-conversation" data-mote-discussion={page?.main.identity?.moteId}>
    {issue ? <p role="status" className="mote-conversation__issue">{issue} 原对话与输入仍可用。</p> : null}
    {current ? sources.map(source => <EarlierSource key={source.period?.id ?? JSON.stringify([source.roleRevision, source.operationId])} source={source} client={conversationClient} visible={visible} name={name} geometry={readingGeometry} describeSpeaker={describeSpeaker} mainAvatar={mainAvatar} />) : null}
    {renderCurrent([])}
    {current && page && work ? <InlineWorkThreads page={page} actor={actor} visible={visible} work={work} /> : null}
    {current && page?.next ? <button type="button" className="mote-conversation__link" onClick={onOlder}>更早的主对话来源</button> : null}
  </div>
}
