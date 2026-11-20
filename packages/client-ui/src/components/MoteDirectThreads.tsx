import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxRpcParams, AgentMuxRpcResult, MoteDirectMessage, MoteDirectThread } from '@agentmux/core'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { Button } from './Button.js'
import * as Dialog from './Modal.js'
import { Notice } from './Notice.js'
import '../styles/mote-direct.css'

type Method = 'space.mote.direct.list' | 'space.mote.direct.inspect'
export type ReadMoteDirect = <M extends Method>(method: M, params: AgentMuxRpcParams<M>) => Promise<AgentMuxRpcResult<M>>
type List = AgentMuxRpcResult<'space.mote.direct.list'>
type Detail = AgentMuxRpcResult<'space.mote.direct.inspect'>
const STATUS = { accepted: '已接收', pending: '等待接收', failed: '交付失败', unknown: '交付待核对' } as const
const status = (message: MoteDirectMessage) => message.replyToMessageId && !message.deliveries.length ? '已回复'
  : message.deliveries[0] ? STATUS[message.deliveries[0].status] : null
const issueText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Scoped to one Mote's Main view; opening a transcript only reads its original thread. */
export function MoteDirectThreads({ mote, active, read, renderAvatar }: {
  mote: MotePreferencesTarget; active: boolean; read: ReadMoteDirect; renderAvatar?(moteId: string, name: string): ReactNode
}) {
  const [list, setList] = useState<List | null>(null)
  const [issue, setIssue] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailIssue, setDetailIssue] = useState('')
  const [report, setReport] = useState<MoteDirectMessage | null>(null)
  const [assignment, setAssignment] = useState<MoteDirectMessage | null>(null)
  const [assignmentIssue, setAssignmentIssue] = useState('')
  const [older, setOlder] = useState<MoteDirectMessage[]>([])
  const [cursor, setCursor] = useState<number | null | undefined>(undefined)
  const [more, setMore] = useState<MoteDirectThread[]>([])
  const [listCursor, setListCursor] = useState<number | null | undefined>(undefined)
  const [pageLoading, setPageLoading] = useState(false)
  const pageGeneration = useRef(0)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const returnToReport = useRef<string | null>(null)
  const reportHeading = useRef<HTMLHeadingElement | null>(null)
  const dialog = useRef<HTMLDivElement | null>(null)
  const closing = useRef<Animation | null>(null)
  useEffect(() => () => {
    const motion = closing.current
    closing.current = null
    motion?.cancel()
  }, [])

  useEffect(() => {
    if (!active) return
    let live = true, timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await read('space.mote.direct.list', { mote, limit: 12 })
        if (live) { setList(next); setIssue('') }
      } catch (error) { if (live) setIssue(issueText(error)) }
      finally { if (live) timer = setTimeout(refresh, 8000) }
    }
    void refresh()
    return () => { live = false; clearTimeout(timer) }
  }, [active, mote, read])

  useEffect(() => {
    if (!active || !open || !selected || report) return
    const threadId = selected
    let live = true, timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await read('space.mote.direct.inspect', { mote, threadId, limit: 30 })
        if (live) { setDetail(current => current ? { ...next, messages: mergeMessages(current.messages, next.messages) } : next); setDetailIssue('') }
      } catch (error) { if (live) setDetailIssue(issueText(error)) }
      finally { if (live) timer = setTimeout(refresh, 3500) }
    }
    void refresh()
    return () => { live = false; clearTimeout(timer) }
  }, [active, mote, open, read, report, selected])

  useEffect(() => {
    if (!active || !open || !report?.replyToMessageId) return
    let current = true
    reportHeading.current?.focus()
    void read('space.mote.direct.inspect', { mote, threadId: report.threadId, messageId: report.replyToMessageId })
      .then(result => {
        const original = result.messages[0]
        if (original?.id !== report.replyToMessageId) throw new Error('原作业引用暂未核对。')
        if (current) setAssignment(original ?? null)
      })
      .catch(error => { if (current) setAssignmentIssue(issueText(error)) })
    return () => { current = false }
  }, [active, mote, open, read, report])

  useEffect(() => {
    const id = returnToReport.current
    if (!report && id) {
      returnToReport.current = null
      dialog.current?.querySelector<HTMLButtonElement>(`[data-direct-message-id="${CSS.escape(id)}"] button`)?.focus()
    }
  }, [report])

  const focusReport = (message: MoteDirectMessage | null) => {
    setReport(message); setAssignment(null); setAssignmentIssue('')
  }

  const pick = (id: string | null) => {
    pageGeneration.current++
    setPageLoading(false)
    setDetail(null); setDetailIssue(''); setOlder([]); setCursor(undefined); setSelected(id); focusReport(null)
  }
  const changeOpen = (next: boolean) => {
    if (next) { setOpen(true); return }
    const panel = dialog.current
    if (!panel || panel.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOpen(false)
      return
    }
    if (closing.current) return
    // Keep the shared modal's focus lease until the visible exit finishes.
    const motion = panel.animate([{ translate: '0 0' }, { translate: '0 6px' }],
      { duration: 120, easing: 'ease-in', fill: 'both', id: 'mote-direct-exit' })
    closing.current = motion
    const finish = () => {
      if (closing.current !== motion) return
      closing.current = null
      setOpen(false)
    }
    void motion.finished.then(finish, finish)
  }
  const threads = [...list?.threads ?? [], ...more.filter(thread => !list?.threads.some(entry => entry.id === thread.id))]
  const latest = threads[0], latestPeer = latest?.participants.find(participant => participant.moteId !== mote.spaceId)
  const thread = detail?.thread ?? threads.find(value => value.id === selected)
  const currentPeer = thread?.participants.find(participant => participant.moteId !== mote.spaceId)
  const moreThreads = listCursor === undefined ? list?.nextBeforeSequence : listCursor
  const moreMessages = cursor === undefined ? detail?.nextBeforeSequence : cursor
  const loadOlder = async () => {
    const generation = pageGeneration.current
    setPageLoading(true)
    try {
      if (selected && moreMessages) {
        const past = await read('space.mote.direct.inspect', { mote, threadId: selected, beforeSequence: moreMessages, limit: 30 })
        if (generation === pageGeneration.current) {
          setOlder(previous => mergeMessages(previous, past.messages)); setCursor(past.nextBeforeSequence); setDetailIssue('')
        }
      } else if (!selected && moreThreads) {
        const past = await read('space.mote.direct.list', { mote, beforeSequence: moreThreads, limit: 12 })
        if (generation === pageGeneration.current) {
          setMore(values => [...values, ...past.threads]); setListCursor(past.nextBeforeSequence); setIssue('')
        }
      }
    } catch (error) { if (generation === pageGeneration.current) (selected ? setDetailIssue : setIssue)(issueText(error)) }
    finally { if (generation === pageGeneration.current) setPageLoading(false) }
  }
  if (!threads.length && !issue && !open) return null
  const face = (id: string, name: string) => renderAvatar?.(id, name) ?? Array.from(name)[0]
  return <Dialog.Root open={active && open} onOpenChange={changeOpen}>
    <div className="mote-direct-entry">
      <Dialog.Trigger asChild><button type="button" className="mote-direct-row mote-direct-entry__summary" onClick={event => {
        returnFocus.current = event.currentTarget
        pick(latestPeer ? latest!.id : null)
      }}>
        {latestPeer && <span aria-hidden="true" className="mote-direct-row__avatar">{face(latestPeer.moteId, latestPeer.name)}</span>}
        <span className="mote-direct-row__text">
          <strong>{latestPeer ? latestPeer.name + ' · 私聊' : 'Mote 私聊'}</strong>
          <span>{latest?.lastMessage?.body ?? (issue ? '读取待核对' : '查看私聊')}</span>
        </span>
        {latest?.lastMessage && status(latest.lastMessage) && <small>{status(latest.lastMessage)}</small>}
      </button></Dialog.Trigger>
      {(threads.length > 1 || moreThreads) && <Button onClick={event => {
        returnFocus.current = event.currentTarget
        pick(null)
        setOpen(true)
      }}>全部私聊</Button>}
    </div>
    <Dialog.Portal>
      <Dialog.Overlay className="mote-direct-overlay" />
      <Dialog.Content ref={dialog} className="mote-direct-panel" data-view={selected ? 'detail' : 'list'} aria-describedby={undefined}
        onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus() } }}>
        <header>
          <div>{report ? <Button onClick={() => { returnToReport.current = report.id; focusReport(null) }}>返回私聊</Button> : selected && <Button onClick={() => pick(null)}>全部私聊</Button>}
            <Dialog.Title ref={reportHeading} tabIndex={-1}>{report ? '作业与回报' : currentPeer?.name ?? 'Mote 私聊'}</Dialog.Title></div>
          <Dialog.Close asChild><Button aria-label="关闭私聊">关闭</Button></Dialog.Close>
        </header>
        {report ? <div className="mote-direct-panel__body mote-direct-assignment">
          {assignmentIssue && <Notice density="compact" heading="原作业暂未读到">{assignmentIssue}</Notice>}
          {!assignment && !assignmentIssue && <p role="status">正在读取原作业…</p>}
          {assignment && <DirectMessage message={assignment} ownMoteId={mote.spaceId} label="原作业" />}
          <DirectMessage message={report} ownMoteId={mote.spaceId} label="回报" />
        </div> : selected ? <div className="mote-direct-panel__body" aria-label="私聊消息">
          {detailIssue && <Notice density="compact" heading="私聊暂未更新">{detailIssue}</Notice>}
          {!detail && !detailIssue && <p role="status">正在读取私聊…</p>}
          {moreMessages && <Button disabled={pageLoading} onClick={() => void loadOlder()}>更早的消息</Button>}
          {mergeMessages(older, detail?.messages ?? []).map(message => <DirectMessage key={message.id} message={message} ownMoteId={mote.spaceId}
            onOpenAssignment={message.replyToMessageId && message.deliveries.length === 0 ? () => focusReport(message) : undefined} />)}
        </div> : <div className="mote-direct-panel__body">
          {issue && <Notice density="compact" heading="私聊列表暂未更新">{issue}</Notice>}
          {threads.map(entry => {
            const peer = entry.participants.find(person => person.moteId !== mote.spaceId)
            if (!peer) return null
            return <button type="button" key={entry.id} className="mote-direct-row" onClick={() => pick(entry.id)}>
              <span aria-hidden="true" className="mote-direct-row__avatar">{face(peer.moteId, peer.name)}</span>
              <span className="mote-direct-row__text"><strong>{peer.name}</strong>{entry.lastMessage && <span>{entry.lastMessage.body}</span>}</span>
              {entry.lastMessage && status(entry.lastMessage) && <small>{status(entry.lastMessage)}</small>}
            </button>
          })}
          {moreThreads && <Button disabled={pageLoading} onClick={() => void loadOlder()}>更多私聊</Button>}
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function mergeMessages(previous: readonly MoteDirectMessage[], next: readonly MoteDirectMessage[]) {
  const messages = new Map(previous.map(message => [message.id, message]))
  for (const message of next) messages.set(message.id, message)
  return [...messages.values()].sort((left, right) => left.sequence - right.sequence)
}

function DirectMessage({ message, ownMoteId, label, onOpenAssignment }: {
  message: MoteDirectMessage; ownMoteId: string; label?: string; onOpenAssignment?: (() => void) | undefined
}) {
  const delivered = status(message)
  return <article data-direct-message-id={message.id} className="mote-direct-message" data-own={message.author.moteId === ownMoteId || undefined}>
    {label && <h3>{label}</h3>}
    <div><strong>{message.author.name}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
    <p>{message.body}</p>
    <footer>
      {delivered && <small title={message.deliveries[0]?.issue}>{delivered}</small>}
      {onOpenAssignment && <Button onClick={onOpenAssignment}>查看原作业</Button>}
    </footer>
  </article>
}
