import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { consumeConversationWindowPage, projectConversationWindow, CONVERSATION_MAX_READ_BYTES,
  type ConversationCheckpoint, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import type { ConversationViewClient } from '../lib/use-conversation-view.js'
import { readConversationProcessDetail } from '../lib/read-conversation-process-detail.js'
import { describeConversationWindow } from '../lib/conversation-records.js'
import { createSpeakerResolver, type DescribeSpeaker } from '../lib/conversation-speaker.js'
import type { ConversationReadingGeometry } from '../lib/conversation-body-work.js'
import { ConversationView } from './ConversationView.js'
import { moteConversationPeriodLabel, moteConversationTransitionLabel } from './MoteConversationStart.js'
import '../styles/mote-conversation.css'

type Source = Extract<MoteDialogueLink, { kind: 'main' }>
type Props = { source: Source; client: ConversationViewClient | null; visible: boolean; name: string
  geometry?: ConversationReadingGeometry | undefined; describeSpeaker?: DescribeSpeaker | undefined
  mainAvatar?: ((size?: number) => ReactNode) | undefined; onOpenOriginal?: (() => void) | undefined }

/** Reads one original period through the public Reader. Wire fragments are assembled,
 * never time-filtered or joined in the client. A closed period needs no live watch. */
export function MotePeriodConversation(props: Props) {
  const range = props.source.period?.range
  const connection = useRef({ client: props.client, revision: 0 })
  if (connection.current.client !== props.client) connection.current = { client: props.client, revision: connection.current.revision + 1 }
  const key = JSON.stringify([connection.current.revision, props.source.period?.id, props.source.reference, range])
  return range?.kind === 'bounded' && range.through
    ? <BoundedPeriod key={key} {...props} after={range.after} through={range.through} />
    : <section className="mote-conversation__earlier" data-mote-period={props.source.period?.id}>
      <PeriodHeading source={props.source} name={props.name} />
      <p className="mote-conversation__muted">{range?.kind === 'unconfirmed' ? range.issue : '这段历史没有完整的消息边界记录。原 Agent 对话仍保留。'}</p>
      {props.onOpenOriginal && <button type="button" className="mote-conversation__link" onClick={props.onOpenOriginal}>打开原 Agent 对话</button>}
    </section>
}
function PeriodHeading({ source, name }: Pick<Props, 'source' | 'name'>) {
  return <header className="mote-conversation__handoff"><span>{name} · 此前的交流</span>
    <small>{moteConversationPeriodLabel(source.period)} · {moteConversationTransitionLabel(source.period)}</small>
    <details><summary>来源</summary><p>{source.reference.hostId} / {source.reference.sessionId}</p>
      <p>{source.period?.range.kind === 'bounded' ? '按原主对话的消息边界读取。' : '原历史范围未确认；完整 Session 可能包含其他时期的工作。'}</p></details>
  </header>
}
function BoundedPeriod({ source, client, visible, name, geometry, describeSpeaker, mainAvatar, onOpenOriginal, after, through }: Props & {
  after: ConversationCheckpoint; through: ConversationCheckpoint
}) {
  const reference = useMemo(() => ({ hostId: source.reference.hostId, agentSessionId: source.reference.sessionId }), [source.reference.hostId, source.reference.sessionId])
  const [snapshot, setSnapshot] = useState<ConversationWindowSnapshot | null>(null), [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null), [more, setMore] = useState(true)
  const owner = useRef({ alive: true, request: null as AbortController | null, snapshot: null as ConversationWindowSnapshot | null,
    checkpoint: after, more: true, initialized: false, views: new Set<string>() })
  const read = useCallback(async () => {
    const current = owner.current
    if (!client || !visible || current.request || !current.more) return
    const controller = new AbortController(); current.request = controller
    setBusy(true); setIssue(null)
    let assembly: ConversationWindowAssembly | undefined, cursor: string | undefined
    try {
      do {
        const page = await client.readConversationChanges({ ...reference, checkpoint: current.checkpoint, through,
          ...(current.snapshot?.window.view ? { view: current.snapshot.window.view } : {}), ...(cursor ? { cursor } : {}),
          processDetails: 'deferred', limit: 100, maxBytes: CONVERSATION_MAX_READ_BYTES }, { signal: controller.signal })
        const view = page.window.view ?? page.window.replay
        if (!current.alive) { void client.releaseConversationView({ ...reference, view }).catch(() => {}); return }
        current.views.add(view)
        if (controller.signal.aborted) {
          if (view !== current.snapshot?.window.view) { current.views.delete(view); void client.releaseConversationView({ ...reference, view }).catch(() => {}) }
          return
        }
        const consumed = consumeConversationWindowPage(page, assembly)
        if (consumed.kind === 'complete') {
          current.snapshot = consumed.snapshot; current.checkpoint = page.checkpoint; current.more = page.more; current.initialized = true
          setSnapshot(consumed.snapshot); setMore(page.more); break
        }
        assembly = consumed.pending
        if (!page.nextCursor || page.nextCursor === cursor) throw new Error('这次原消息读取尚未完整，已保留上一段内容。请重新读取。')
        cursor = page.nextCursor
      } while (true)
    } catch (error) { if (current.alive && !controller.signal.aborted) setIssue(error instanceof Error ? error.message : String(error)) }
    finally { if (current.request === controller) { current.request = null; if (current.alive) setBusy(false) } }
  }, [client, reference, through, visible])
  useEffect(() => {
    if (visible && !owner.current.initialized) void read()
    return () => {
      const request = owner.current.request; request?.abort()
      // A hidden consumer releases its read lease immediately. A late response
      // still belongs to that cancelled lease and cannot strand a reopened view.
      if (owner.current.request === request) owner.current.request = null
    }
  }, [visible, read])
  useEffect(() => {
    const current = owner.current; current.alive = true
    return () => { current.alive = false; current.request?.abort(); if (client) for (const view of current.views) void client.releaseConversationView({ ...reference, view }).catch(() => {}) }
  }, [client, reference])
  const reading = useMemo(() => snapshot ? describeConversationWindow(projectConversationWindow(snapshot)) : null, [snapshot])
  const describe = useMemo<DescribeSpeaker>(() => {
    const original = describeSpeaker ?? createSpeakerResolver()
    return (speaker, size) => speaker.role === 'agent' && speaker.id === reference.agentSessionId
      ? { ...original(speaker, size), name, ...(mainAvatar ? { avatar: mainAvatar(size) } : {}) } : original(speaker, size)
  }, [describeSpeaker, reference.agentSessionId, name, mainAvatar])
  const detail = useCallback((...args: Parameters<typeof readConversationProcessDetail> extends [unknown, ...infer Rest] ? Rest : never) => {
    if (!client) return Promise.reject(new Error('原 Host 暂不可用，已保留这段历史。'))
    return readConversationProcessDetail(client, ...args)
  }, [client])
  return <section className="mote-conversation__earlier" data-mote-period={source.period?.id} aria-busy={busy}>
    <PeriodHeading source={source} name={name} />
    {issue && <p role="status">{issue}<button type="button" onClick={() => void read()}>重新读取这段对话</button></p>}
    {reading ? <ConversationView sessionId={reference.agentSessionId} executionHostId={reference.hostId} records={reading.records} originalRecords={reading.originalRecords}
      page={reading.historyPage ?? null} coverage={reading.timeline.coverage} coverageSummary="阅读范围与来源" showInputSource={false} detailsOnlyMetadata sourceLabelsInDetails
      active={visible} readProcessDetail={detail} describeSpeaker={describe} {...(geometry ? { readingGeometry: { ...geometry, following: () => false } } : {})} />
      : <p className="mote-conversation__muted">{busy ? '读取这段对话…' : client ? '这段对话尚未载入。' : '原 Host 暂不可用，历史仍保留。'}</p>}
    {more && snapshot && <button type="button" className="mote-conversation__link" disabled={busy || !client} onClick={() => void read()}>{busy ? '正在读取…' : '继续读取这段对话'}</button>}
    {onOpenOriginal && <details><summary>原 Agent</summary><button type="button" onClick={onOpenOriginal}>打开原 Agent 对话</button></details>}
  </section>
}
