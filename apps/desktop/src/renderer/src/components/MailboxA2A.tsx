import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { AgentMuxMessageDirection, AgentMuxMessageMetadata, DurableAgentMuxMessage } from '@agentmux/core'
import { ConversationMessage, type ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { MailboxCopyAction, MailboxDraftAction, MailboxEmpty, MailboxRecordRow, MailboxSourceNotice, MailboxTime } from './MailboxReading'

/** Delivery is an original transport fact; reading never accepts a task. */
function a2aDeliveryLabel(delivery: AgentMuxMessageMetadata['delivery']): string {
  if (delivery.state === 'queued') return delivery.reason ? 'Delivery unconfirmed' : 'Saved · delivery pending'
  if (delivery.state === 'delivered') return 'Delivered'
  if (delivery.state === 'failed') return 'Delivery failed'
  if (delivery.state === 'accepted') return 'Agent acceptance recorded'
  if (delivery.state === 'replied') return 'Reply recorded'
  if (delivery.state === 'timed-out') return 'Delivery timed out'
  if (delivery.state === 'cancelled') return 'Delivery cancelled'
  const unknown: never = delivery.state
  return unknown
}

type MessageDelivery = Pick<AgentMuxMessageMetadata, 'deliveryMode' | 'notification' | 'delivery'>

/** Inbox persistence and notification input do not attest original-body reading. */
export function a2aMessageDeliveryLabel(message: MessageDelivery): string {
  if (message.deliveryMode !== 'reference') return a2aDeliveryLabel(message.delivery)
  const state = message.notification?.state
  return state === 'submitted' ? 'Saved to inbox · Notification submitted'
    : state === 'unconfirmed' ? 'Saved to inbox · Notification unconfirmed'
    : state === 'pending' ? message.notification?.notificationId ? 'Saved to inbox · Notification pending' : 'Saved to inbox · Awaiting idle notification' : 'Saved to inbox'
}

/** A short list projection of the original typed fact; complete facts remain in Info. */
function a2aMessageStatus(message: MessageDelivery): string | undefined {
  if (message.deliveryMode === 'reference') {
    const state = message.notification?.state
    return state === 'unconfirmed' ? 'Notification unconfirmed'
      : state === 'pending' ? message.notification?.notificationId ? 'Notification pending' : 'Awaiting notification' : undefined
  }
  const state = message.delivery.state
  return state === 'queued' ? message.delivery.reason ? 'Delivery unconfirmed' : 'Delivery pending'
    : state === 'failed' ? 'Delivery failed' : state === 'timed-out' ? 'Delivery timed out'
    : state === 'cancelled' ? 'Delivery cancelled' : undefined
}

function a2aMessageDeliveryReason(message: MessageDelivery): string | undefined {
  return message.deliveryMode === 'reference' ? message.notification?.reason : message.delivery.reason
}

export function a2aMessageKey(message: AgentMuxMessageMetadata): string { return `a2a:${message.envelope.messageId}` }

type Props = {
  reference: SessionHistoryReference
  direction: AgentMuxMessageDirection
  items: readonly AgentMuxMessageMetadata[]
  selectedKey: string | null
  active: boolean
  loading: boolean
  error: string | null
  observationError: string | null
  nextCursor: number | null
  refresh(): void | Promise<void>
  loadEarlier(): void | Promise<void>
  readMessage(messageId: string): Promise<DurableAgentMuxMessage | null>
  onOpen(key: string, event: MouseEvent<HTMLButtonElement>): void
  reading?: ConversationReadingProps | undefined
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  onFill?: ((text: string) => Promise<string | void>) | undefined
  renderNavigation?: ((messageId: string) => ReactNode) | undefined
}

/** Original message reading, independent of input history, delivery and consumption. */
export function MailboxA2A(props: Props) {
  const { reference, direction, items, selectedKey, active, reading, onCopy, onFill } = props
  const recent = useMemo(() => [...items].sort((a, b) => b.envelope.createdAt - a.envelope.createdAt), [items])
  const selected = recent.find(item => a2aMessageKey(item) === selectedKey)
  const selectedId = selectedKey?.startsWith('a2a:') ? selectedKey.slice(4) || undefined : undefined
  const scope = JSON.stringify([reference.hostId, reference.agentSessionId, direction])
  const generation = useRef(0)
  const owner = useMemo(() => ({}), [active, scope, selectedId, props.readMessage])
  const live = useRef<object | null>(null)
  useLayoutEffect(() => { live.current = owner; return () => { live.current = null } }, [owner])
  const isCurrent = () => active && live.current === owner
  const [detail, setDetail] = useState<{ scope: string; messageId: string; record?: DurableAgentMuxMessage; loading: boolean; error?: string }>()
  const peerId = (item: AgentMuxMessageMetadata) => direction === 'incoming' ? item.envelope.senderSessionId! : item.envelope.recipientSessionId!
  const name = (id: string) => reading?.describeSpeaker?.({ role: 'agent', id }, 18)?.name || id
  async function readOriginal(messageId: string) {
    const record = await props.readMessage(messageId)
    if (!record) throw new Error('The original message was not found in this journal. Existing reading is kept.')
    const envelope = record.envelope
    if (envelope.messageId !== messageId || envelope.sender.kind !== 'agent-session' || envelope.recipient.kind !== 'agent-session' ||
      (direction === 'incoming' ? envelope.recipientSessionId : envelope.senderSessionId) !== reference.agentSessionId)
      throw new Error('The returned message does not belong to this exact Agent and direction. Existing reading is kept.')
    return record
  }
  async function loadDetail() {
    if (!isCurrent() || !selectedId) return
    const request = ++generation.current
    setDetail(previous => ({ scope, messageId: selectedId, loading: true,
      ...(previous?.scope === scope && previous.messageId === selectedId && previous.record ? { record: previous.record } : {}) }))
    try {
      const record = await readOriginal(selectedId)
      if (isCurrent() && generation.current === request) setDetail({ scope, messageId: selectedId, record, loading: false })
    } catch (error) {
      if (isCurrent() && generation.current === request) setDetail(previous => ({ ...previous, scope, messageId: selectedId, loading: false,
        error: error instanceof Error ? error.message : String(error) }))
    }
  }
  async function readForAction(messageId: string) {
    const record = await readOriginal(messageId)
    if (!isCurrent()) throw new Error('This reading surface changed. The original message is retained; repeat the action here.')
    return record
  }
  useEffect(() => {
    if (active && selectedId) void loadDetail()
    return () => { ++generation.current }
  }, [active, scope, selectedId, props.readMessage])
  const current = detail?.scope === scope && detail.messageId === selectedId ? detail : undefined
  const record = current?.record
  const deliveryMessage = selected ?? record
  const deliveryReason = deliveryMessage ? a2aMessageDeliveryReason(deliveryMessage) : undefined
  const deliveryStatus = deliveryMessage ? a2aMessageStatus(deliveryMessage) : undefined
  const issues = <>
    {props.error ? <MailboxSourceNotice title="Message reading is unconfirmed" message={props.error} action="Refresh messages" onAction={() => void props.refresh()} /> : null}
    {props.observationError ? <MailboxSourceNotice title="Automatic message updates are unavailable" message={props.observationError} action="Refresh messages" onAction={() => void props.refresh()} /> : null}
  </>
  if (selectedId) return <article className="composer-mailbox__detail" data-message-id={selectedId}>
    {issues}
    {current?.error ? <MailboxSourceNotice title="Original message reading is unconfirmed" message={current.error} action="Read original message" onAction={() => void loadDetail()} /> : null}
    {!record ? <MailboxEmpty title={current?.loading ? 'Reading original message…' : 'Original message is not yet readable'} /> : <>
      <ConversationMessage {...(reading?.describeSpeaker ? { describeSpeaker: reading.describeSpeaker } : {})}
        {...(reading?.openHttpLink ? { openHttpLink: reading.openHttpLink } : {})}
        active={active} compact recordedIdentity detailsOnlyMetadata conversationSessionId={record.envelope.recipientSessionId!}
        messageId={record.envelope.messageId} speaker={{ role: 'agent', id: record.envelope.senderSessionId! }}
        name={name(record.envelope.senderSessionId!)} content={record.envelope.body} copyText={record.envelope.body} contentBoundary="body"
        createdAt={record.envelope.createdAt} {...(onCopy ? { onCopy } : {})}
        messageActions={<>{onFill ? <MailboxDraftAction value={record.envelope.messageId} onFill={() => onFill(record.envelope.body)} /> : null}{props.renderNavigation?.(record.envelope.messageId)}</>}
        messageDetails={<dl className="composer-mailbox__record-facts">
          <dt>Source</dt><dd>Original A2A message · {reference.hostId}</dd>
          <dt>Message ID</dt><dd>{record.envelope.messageId}</dd>
          <dt>Operation</dt><dd>{record.envelope.operationId}</dd>
          <dt>From</dt><dd>{name(record.envelope.senderSessionId!)} · {record.envelope.senderSessionId}</dd>
          <dt>To</dt><dd>{name(record.envelope.recipientSessionId!)} · {record.envelope.recipientSessionId}</dd>
          <dt>Sender Run</dt><dd>{record.envelope.senderRunId ?? 'Not recorded'}</dd>
          <dt>Recipient Run</dt><dd>{record.envelope.recipientRunId ?? 'Not determined at first save'}</dd>
          <dt>Saved</dt><dd><MailboxTime value={record.envelope.createdAt} complete /></dd>
          <dt>{deliveryMessage?.deliveryMode === 'reference' ? 'Last observed notification' : 'Last observed delivery'}</dt><dd>{a2aMessageDeliveryLabel(deliveryMessage!)}{deliveryReason ? ` · ${deliveryReason}` : ''}</dd>
          {deliveryMessage?.notification?.notificationId ? <><dt>Notification input</dt><dd><code>{deliveryMessage.notification.notificationId}</code></dd></> : null}
        </dl>} />
      {deliveryStatus ? <p className="composer-mailbox__record-status" title={a2aMessageDeliveryLabel(deliveryMessage!)}>{deliveryStatus}</p> : null}
      {deliveryReason ? <p className="composer-mailbox__risk">{deliveryReason}</p> : null}
    </>}
  </article>
  return <>{issues}<div className="composer-mailbox__reading-tools"><span>{direction === 'incoming' ? 'Other Agents → this Agent' : 'This Agent → other Agents'} · {items.length} loaded</span>
    <button type="button" className="composer-tool" disabled={props.loading} onClick={() => void props.refresh()}>Refresh</button></div>
    {items.length ? <ol className="composer-mailbox__messages" aria-label={direction === 'incoming' ? 'Original A2A incoming messages' : 'Original A2A outgoing messages'}>
      {recent.map(item => {
        const speaker = { role: 'agent' as const, id: peerId(item) }
        const identity = reading?.describeSpeaker?.(speaker, 18)
        const peerName = identity?.name || speaker.id
        const status = a2aMessageStatus(item)
        return <li key={item.envelope.messageId}><MailboxRecordRow recordKey={a2aMessageKey(item)}
          label={`${direction === 'incoming' ? 'From' : 'To'} ${peerName}`} text={undefined} bodyPreview={item.bodyPreview}
          avatar={identity?.avatar ?? <ConversationMessageAvatar speaker={speaker} name={peerName} size={18} providerId={identity?.providerId} project={identity?.project} />}
          metadata={<MailboxTime value={item.envelope.createdAt} />}
          status={status ? <span title={a2aMessageDeliveryLabel(item)}>{status}</span> : null}
          onOpen={props.onOpen} actions={<>
            {onCopy ? <MailboxCopyAction value={item.envelope.messageId} onCopy={async () => onCopy((await readForAction(item.envelope.messageId)).envelope.body)} /> : null}
            {onFill ? <MailboxDraftAction value={item.envelope.messageId} onFill={async () => onFill((await readForAction(item.envelope.messageId)).envelope.body)} /> : null}
            {props.renderNavigation?.(item.envelope.messageId)}
          </>} /></li>
      })}
    </ol> : props.loading ? <MailboxEmpty title="Reading original messages…" /> : !props.error ? <MailboxEmpty title={direction === 'incoming' ? 'No A2A messages received' : 'No A2A messages sent'} /> : null}
    {props.nextCursor !== null ? <button type="button" className="composer-tool" disabled={props.loading} onClick={() => void props.loadEarlier()}>Read earlier messages</button> : null}
  </>
}
