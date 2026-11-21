import { useEffect, useState } from 'react'
import type { AgentMuxRpcParams, AgentMuxRpcResult, MoteDirectMessage, MoteGroupMessage } from '@agentmux/core'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { Button } from './Button.js'
import * as Dialog from './Modal.js'
import { Notice } from './Notice.js'
import '../styles/mote-direct.css'

type DirectRead = 'space.mote.direct.inspect' | 'space.mote.direct.image.read'
type ReadDirect = <M extends DirectRead>(method: M, params: AgentMuxRpcParams<M>) => Promise<AgentMuxRpcResult<M>>
type ReadGroup = (method: 'space.mote.group.inspect', params: AgentMuxRpcParams<'space.mote.group.inspect'>) => Promise<AgentMuxRpcResult<'space.mote.group.inspect'>>
export type MoteAssignmentTarget = { conversationId: string; messageId: string } &
  ({ kind: 'group'; read: ReadGroup } | { kind: 'direct'; mote: MotePreferencesTarget; read: ReadDirect })
type Message = MoteGroupMessage | MoteDirectMessage
type AssignmentSource = {
  original: Message
  recipientNames: Map<string, string>
}
type ReplyPage = { messages: Message[]; nextBeforeSequence: number | null }
type ReadImage = (message: MoteDirectMessage, operationId: string) => Promise<AgentMuxRpcResult<'space.mote.direct.image.read'>>
export const moteAssignmentDeliveryLabel = { accepted: '已接收', pending: '等待接收', failed: '交付失败', unknown: '交付待核对' } as const
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

async function assignmentSource(target: MoteAssignmentTarget): Promise<AssignmentSource> {
  const { conversationId, messageId } = target
  if (target.kind === 'direct') {
    const source = await target.read('space.mote.direct.inspect', { threadId: conversationId, mote: target.mote, messageId })
    return { original: source.messages[0]!,
      recipientNames: new Map(source.thread.participants.map(member => [member.moteId, member.name])) }
  }
  const source = await target.read('space.mote.group.inspect', { groupId: conversationId, messageId })
  return { original: source.messages[0]!, recipientNames: new Map(source.group.members.map(member => [member.moteId, member.name])) }
}

async function assignmentReplies(target: MoteAssignmentTarget, beforeSequence?: number): Promise<ReplyPage> {
  const page = { replyToMessageId: target.messageId, limit: 12, ...(beforeSequence === undefined ? {} : { beforeSequence }) }
  return target.kind === 'direct'
    ? target.read('space.mote.direct.inspect', { ...page, threadId: target.conversationId, mote: target.mote })
    : target.read('space.mote.group.inspect', { ...page, groupId: target.conversationId })
}

export function MoteAssignmentDetails({ target, initialReply }: { target: MoteAssignmentTarget; initialReply?: MoteDirectMessage | undefined }) {
  const [source, setSource] = useState<AssignmentSource>()
  const [page, setPage] = useState<ReplyPage>()
  const [older, setOlder] = useState<Message[]>([])
  const [cursor, setCursor] = useState<number | null>()
  const [sourceIssue, setSourceIssue] = useState('')
  const [replyIssue, setReplyIssue] = useState('')
  const [earlierIssue, setEarlierIssue] = useState('')
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      await Promise.all([
        assignmentSource(target).then(result => { if (live) { setSource(result); setSourceIssue('') } },
          error => { if (live) setSourceIssue(errorText(error)) }),
        assignmentReplies(target).then(result => { if (live) { setPage(result); setReplyIssue('') } },
          error => { if (live) setReplyIssue(errorText(error)) })
      ])
      if (live) timer = setTimeout(refresh, 5000)
    }
    void refresh()
    return () => { live = false; clearTimeout(timer) }
  }, [target])
  const next = cursor === undefined ? page?.nextBeforeSequence : cursor
  async function loadEarlier(beforeSequence: number) {
    setLoadingEarlier(true)
    try {
      const earlier = await assignmentReplies(target, beforeSequence)
      setOlder(current => [...earlier.messages, ...current])
      setCursor(earlier.nextBeforeSequence)
      setEarlierIssue('')
    } catch (error) { setEarlierIssue(errorText(error)) }
    finally { setLoadingEarlier(false) }
  }
  const readImage: ReadImage | undefined = target.kind === 'direct' ? (message, operationId) =>
    target.read('space.mote.direct.image.read', { mote: target.mote, threadId: message.threadId, messageId: message.id, imageOperationId: operationId }) : undefined
  const replies = new Map<string, Message>()
  if (initialReply?.replyToMessageId === target.messageId) replies.set(initialReply.id, initialReply)
  for (const reply of [...older, ...(page?.messages ?? [])]) replies.set(reply.id, reply)
  return <div className="mote-direct-panel__body mote-direct-assignment">
    {sourceIssue ? <Notice density="compact" heading="原作业暂未更新">{sourceIssue}</Notice> : null}
    {!source && !sourceIssue ? <p role="status">正在读取原作业…</p> : null}
    {source ? <MoteAssignmentMessage message={source.original} readImage={readImage} label="原作业" recipientNames={source.recipientNames} /> : null}
    {next ? <Button disabled={loadingEarlier} onClick={() => void loadEarlier(next)}>更早的回报</Button> : null}
    {earlierIssue ? <Notice density="compact" heading="较早的回报暂未读到">{earlierIssue}</Notice> : null}
    {[...replies.values()].sort((a, b) => a.sequence - b.sequence).map(reply =>
      <MoteAssignmentMessage key={reply.id} message={reply} readImage={readImage} label="回报" />)}
    {replyIssue ? <Notice density="compact" heading="回报暂未更新">{replyIssue}</Notice> : null}
    {!replyIssue && page && !replies.size ? <p className="mote-direct-assignment__empty">暂无回报</p> : null}
  </div>
}

export function MoteAssignmentButton({ target }: { target: MoteAssignmentTarget }) {
  const [selection, setSelection] = useState<MoteAssignmentTarget | null>(null)
  return <Dialog.Root open={selection !== null} onOpenChange={open => setSelection(open ? target : null)}>
    <Dialog.Trigger asChild><Button type="button">查看作业与回报</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="mote-direct-overlay" />
      <Dialog.Content className="mote-direct-panel" data-view="assignment" aria-describedby={undefined}>
        <header><Dialog.Title>作业与回报</Dialog.Title><Dialog.Close asChild><Button aria-label="关闭作业详情">关闭</Button></Dialog.Close></header>
        {selection ? <MoteAssignmentDetails target={selection} /> : null}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function MoteAssignmentMessage({ message, own, readImage, label, recipientNames, onOpenAssignment, opensFromReply }: {
  message: Message; own?: boolean; readImage?: ReadImage | undefined; label?: string; recipientNames?: ReadonlyMap<string, string>;
  onOpenAssignment?: (() => void) | undefined; opensFromReply?: boolean
}) {
  const author = message.author.kind === 'mote' ? message.author.name : message.author.kind === 'human' ? '用户' : '群公告'
  const priority = 'priority' in message && message.priority
  return <article data-direct-message-id={message.id} className="mote-direct-message" data-own={own || undefined}>
    {label ? <h3>{label}</h3> : null}
    <div><strong>{author}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
    <p>{message.body}</p>
    {'threadId' in message && readImage ? message.images?.map(image =>
      <AssignmentImage key={image.operationId} image={image} load={async () => {
        const original = await readImage(message, image.operationId)
        if (original.image.revision !== image.revision) throw new Error('图片版本暂未核对。')
        return `data:${original.image.mimeType};base64,${original.dataBase64}`
      }} />) : null}
    <footer>
      <div className="mote-direct-message__receipts">
        {priority ? <small>优先投递</small> : null}
        {message.deliveries.map(delivery => <small key={delivery.moteId} title={delivery.issue}>
          {recipientNames?.has(delivery.moteId) ? recipientNames.get(delivery.moteId) + ' · ' : ''}{moteAssignmentDeliveryLabel[delivery.status]}
        </small>)}
        {message.replyToMessageId && !message.deliveries.length ? <small>已回复</small> : null}
      </div>
      {onOpenAssignment ? <Button data-open-assignment onClick={onOpenAssignment}>{opensFromReply ? '查看原作业' : '查看作业与回报'}</Button> : null}
    </footer>
  </article>
}

function AssignmentImage({ image, load }: { image: NonNullable<MoteDirectMessage['images']>[number]; load(): Promise<string> }) {
  const [source, setSource] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [issue, setIssue] = useState('')
  const toggle = async () => {
    if (source) { setSource(null); return }
    setLoading(true); setIssue('')
    try { setSource(await load()) }
    catch (error) { setIssue(errorText(error)) }
    finally { setLoading(false) }
  }
  return <figure className="mote-direct-image">
    <Button aria-expanded={Boolean(source)} disabled={loading} onClick={() => void toggle()}>{image.name}</Button>
    {loading && <small role="status">读取图片中…</small>}
    {issue && <small role="status">{issue}</small>}
    {source && <img src={source} alt={image.name} onError={() => { setSource(null); setIssue('图片格式暂时无法预览。') }} />}
  </figure>
}
