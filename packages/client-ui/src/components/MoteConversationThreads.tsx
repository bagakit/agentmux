import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import '../styles/mote-conversation.css'
import { conversationPresentationKey } from '../lib/conversation-record-sequence.js'
const ThreadIcon = semanticIconComponent('object.conversation')

type Work = Extract<MoteDialogueLink, { kind: 'work' }>
type Source = Extract<MoteDialogueLink, { kind: 'main' }>
type ReadWork = { source: Work; value: DispatchObservation }
export type MoteWorkEvent = { id: string; sources: Work[]; at: number | null }
export type MoteWorkReader = (source: Work) => Promise<DispatchObservation>
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
function EarlierConversation({ source, client, visible, name, geometry, describeSpeaker, mainAvatar, insertions }: {
  source: Source; client: ConversationViewClient | null; visible: boolean; name: string; geometry?: ConversationReadingGeometry | undefined; describeSpeaker?: DescribeSpeaker | undefined; mainAvatar?: ((size?: number) => ReactNode) | undefined; insertions(records: readonly ConversationRecord[], actor: ConversationRef, active: boolean): readonly ConversationRecordInsertion[]
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
    <div className="mote-conversation__handoff"><span>{name} · 此前的交流</span><details><summary>来源</summary><p>{reference.hostId} / {reference.agentSessionId}</p><p>原 Session 全段；没有推断消息切点。</p></details></div>
    {view.error || view.observationError ? <p role="status">{(view.error ?? view.observationError)?.message}<button type="button" onClick={() => void view.refresh()}>重读原对话</button></p> : null}
    {reading ? <ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={reading.records} originalRecords={reading.originalRecords}
      page={reading.historyPage ?? null} coverage={reading.timeline.coverage} coverageSummary="阅读范围与来源" insertions={insertions(reading.records, reference, work.visible)} showInputSource={false} detailsOnlyMetadata sourceLabelsInDetails
      active={work.visible} readProcessDetail={view.readProcessDetail} describeSpeaker={describe}
      {...(geometry ? { readingGeometry: { ...geometry, following: () => false } } : {})} /> : <p className="mote-conversation__muted">{work.visible ? '读取原对话…' : '向上阅读这段原对话'}</p>}
    {view.hasMore ? <button type="button" className="mote-conversation__link" onClick={() => void view.earlier()}>更早的消息</button> : null}
  </section>
}
function WorkEventCard({ event, read, visible, memberName, onOpen, expanded, onExpand, refreshSource }: {
  event: MoteWorkEvent; read: MoteWorkReader; visible: boolean; memberName?: ((source: Work) => string) | undefined; onOpen(source: Work): void
  expanded: boolean; onExpand(): void; refreshSource: MoteDialoguePage | null
}) {
  const visibility = useVisibleWork<HTMLElement>(visible)
  const key = JSON.stringify(event.sources.map(source => [source.origin.hostId, source.origin.messageId]))
  const [state, setState] = useState<{ key: string; values: ReadWork[]; issue: string | null }>({ key, values: [], issue: null })
  const [allReplies, setAllReplies] = useState(false)
  const [retry, setRetry] = useState(0), owner = useRef<object>({})
  useEffect(() => {
    const lifetime = {}; owner.current = lifetime
    if (!visibility.visible) return
    void Promise.all(event.sources.map(async source => {
      const value = await read(source), original = value.source.envelope
      if (original.messageId !== source.origin.messageId || original.threadId !== source.origin.threadId || original.senderSessionId !== source.origin.senderSessionId ||
        original.recipientSessionId !== source.origin.recipientSessionId || value.dispatch.sourceMessageId !== original.messageId) throw new Error('原工作来源未能核对；关联和原工作面已保留。')
      return { source, value }
    })).then(values => { if (owner.current === lifetime) setState({ key, values, issue: null }) })
      .catch(error => { if (owner.current === lifetime) setState(previous => ({ key, values: previous.key === key ? previous.values : [], issue: error instanceof Error ? error.message : String(error) })) })
    return () => { if (owner.current === lifetime) owner.current = {} }
  }, [key, read, visibility.visible, retry, expanded, refreshSource])
  const selected = state.key === key ? state : { values: [], issue: null }
  const first = selected.values[0]?.value, summary = first?.source.envelope.body.split('\n').find(line => line.trim())
  const hasQuestion = selected.values.some(({ value }) => value.dispatch.events.some(event => event.kind === 'question' || event.kind === 'escalation'))
  const reported = selected.values.length > 0 && selected.values.every(({ value }) => value.dispatch.events.some(event => event.kind === 'worker_done'))
  return <article ref={visibility.ref} className="mote-work-event" data-mote-work-event={event.id} data-expanded={expanded}>
    <button type="button" className="mote-work-event__summary" aria-expanded={expanded} onClick={onExpand}>
      <ThreadIcon className="mote-work-event__mark" size={16} aria-hidden="true" /><span><strong>{summary ? summary.slice(0, 180) : '工作 thread'}</strong>
        <small>{memberName?.(event.sources[0]!) ?? event.sources[0]!.origin.recipientSessionId}{event.sources.length > 1 ? ` · ${event.sources.length} 个原派工来源` : ''}
          <span> · {reported ? '执行者已回报' : hasQuestion ? '有待协调的问题记录' : first ? '原派工记录' : '原来源待读取'}</span></small></span>
      {recordedTime(event.at)}<span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {expanded ? <div className="mote-work-event__thread">
      {selected.issue ? <p role="status">{selected.issue}<button type="button" onClick={() => setRetry(value => value + 1)}>重读原来源</button></p> : null}
      {selected.values.map(({ source, value }) => {
        const replyName = (sender: string | null) => sender === source.origin.recipientSessionId ? memberName?.(source) ?? sender : sender
        return <section key={source.sequence}>
        <details className="mote-work-event__assignment"><summary>原任务</summary><p className="mote-work-event__message">{value.source.envelope.body}</p></details>
        {!allReplies && value.replies.length > 3 ? <button type="button" className="mote-conversation__link" onClick={() => setAllReplies(true)}>查看更早的 {value.replies.length - 3} 条原回复</button> : null}
        {(allReplies ? value.replies : value.replies.slice(-3)).map(reply => <div className="mote-work-event__reply" key={reply.envelope.messageId}><small>{replyName(reply.envelope.senderSessionId)} · {recordedTime(reply.envelope.createdAt)}</small><p>{reply.envelope.body}</p></div>)}
        {!value.replies.length ? <p className="mote-conversation__muted">尚未读取到该派工的回复记录。</p> : null}
      </section> })}
      {!selected.values.length && !selected.issue ? <p className="mote-conversation__muted">读取原工作 thread…</p> : null}
      <div className="mote-work-event__actions">{event.sources.map(source => <button type="button" key={source.sequence} onClick={() => onOpen(source)}>继续原工作{event.sources.length > 1 ? ` · ${memberName?.(source) ?? source.origin.recipientSessionId}` : ''}</button>)}</div>
      <details><summary>原来源</summary>{event.sources.map(source => <p key={source.sequence}>{source.origin.hostId} / {source.origin.messageId} / {source.origin.threadId}</p>)}
        {reported ? <p>执行者已回报；任务验收另见原工作记录。</p> : null}</details>
    </div> : null}
  </article>
}
export function MoteConversationThreads({ page, issue, loading, mainUnavailable = false, actor, name, visible, records, conversationClient, readWork, memberName, onRefresh, onOlder, onOpenWork, onReturnMain, renderCurrent, readingGeometry, describeSpeaker, mainAvatar }: {
  page: MoteDialoguePage | null; issue: string | null; loading: boolean; actor: ConversationRef; name: string; visible: boolean
  records: readonly ConversationRecord[]; conversationClient: ConversationViewClient | null; readWork: MoteWorkReader
  mainUnavailable?: boolean
  mainAvatar?: ((size?: number) => ReactNode) | undefined
  memberName?: ((source: Work) => string) | undefined; onRefresh(): void; onOlder?(): void; onOpenWork(source: Work): void; onReturnMain(): void
  renderCurrent(insertions: readonly ConversationRecordInsertion[]): ReactNode; readingGeometry?: ConversationReadingGeometry; describeSpeaker?: DescribeSpeaker
}) {
  const [history, setHistory] = useState(false), [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const identity = page?.main.identity ? JSON.stringify(page.main.identity) : ''
  useEffect(() => { setHistory(false); setExpanded(new Set()) }, [identity])
  const events = useMemo(() => moteWorkEvents(page?.links ?? []), [page?.links])
  const historyGroups = useMemo(() => {
    const groups = new Map<string, { title: string; events: MoteWorkEvent[] }>()
    const ordered = [...events].sort((a, b) => a.at === b.at ? b.sources[0]!.sequence - a.sources[0]!.sequence : a.at === null ? 1 : b.at === null ? -1 : b.at - a.at)
    for (const event of ordered) {
      const date = event.at === null ? null : new Date(event.at)
      const valid = date && Number.isFinite(date.getTime())
      const key = valid ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : 'unknown'
      const title = valid ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '日期未记录'
      if (!groups.has(key)) groups.set(key, { title, events: [] })
      groups.get(key)!.events.push(event)
    }
    return [...groups.entries()]
  }, [events])
  const main = page?.main.current
  const current = Boolean(main && sameActor(actor, { hostId: main.hostId, agentSessionId: main.sessionId }))
  const sources = useMemo(() => {
    const unique = new Map<string, Source>()
    for (const link of [...page?.links ?? []].reverse()) if (link.kind === 'main' && !sameActor(actor, { hostId: link.reference.hostId, agentSessionId: link.reference.sessionId })) {
      const key = JSON.stringify([link.reference.hostId, link.reference.sessionId]); if (!unique.has(key)) unique.set(key, link)
    }
    return [...unique.values()]
  }, [page?.links, actor.hostId, actor.agentSessionId])
  const card = (event: MoteWorkEvent, active: boolean) => <WorkEventCard event={event} read={readWork} visible={active} memberName={memberName} onOpen={onOpenWork} refreshSource={page}
    expanded={expanded.has(event.id)} onExpand={() => setExpanded(previous => { const next = new Set(previous); next.has(event.id) ? next.delete(event.id) : next.add(event.id); return next })} />
  const sourceInsertions = (sourceRecords: readonly ConversationRecord[], reference: ConversationRef, active: boolean): readonly ConversationRecordInsertion[] =>
    events.filter(event => sameActor(event.sources[0]!.main, reference)).map(event => {
      const before = event.at === null ? undefined : sourceRecords.find(record => record.recordedAt !== undefined && record.recordedAt > event.at!)
      return { key: 'mote-work-' + event.id, ...(before ? { beforeRecordId: conversationPresentationKey(before) } : {}), content: card(event, active) }
    })
  const insertions = sourceInsertions(records, actor, visible && !history)
  return <div className="mote-conversation" data-mote-dialogue={identity || undefined}>
    <nav className="mote-conversation__navigation" aria-label="Mote 对话视图">
      <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>{current ? mainUnavailable || page?.main.status !== 'ready' ? '主对话 · 待核对' : '主对话' : main ? '工作 thread' : '交流'}</button>
      <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>事件历史{events.length ? ` · ${events.length}` : ''}</button>
      {main && !current ? <button type="button" onClick={onReturnMain}>回到 {name}</button> : null}
      <button type="button" className="mote-conversation__refresh" onClick={onRefresh} disabled={loading}>{loading ? '正在读取…' : '刷新'}</button>
    </nav>
    {issue ? <p role="status" className="mote-conversation__issue">{issue} 原对话与输入仍可用。</p> : null}
    <div hidden={!history} className="mote-conversation__history">
      {historyGroups.map(([key, group]) => <section key={key} className="mote-conversation__day"><h3>{group.title}</h3><ol>{group.events.map(event => <li key={event.id}>{card(event, visible && history)}</li>)}</ol></section>)}
      {!events.length ? <p className="mote-conversation__muted">{loading ? '读取已关联的工作事件…' : '尚未读到已关联的工作事件；原工作面仍可从团队入口进入。'}</p> : null}
      {page?.next ? <button type="button" onClick={onOlder}>更早的事件与对话来源</button> : null}
    </div>
    <div hidden={history} className="mote-conversation__messages">
      {current ? sources.map(source => <EarlierConversation key={JSON.stringify([source.reference.hostId, source.reference.sessionId])} source={source} client={conversationClient} visible={visible && !history} name={name} geometry={readingGeometry} describeSpeaker={describeSpeaker} mainAvatar={mainAvatar} insertions={sourceInsertions} />) : null}
      {renderCurrent(insertions)}
      {current && page?.next ? <button type="button" className="mote-conversation__link" onClick={onOlder}>更早的主对话来源</button> : null}
    </div>
  </div>
}
