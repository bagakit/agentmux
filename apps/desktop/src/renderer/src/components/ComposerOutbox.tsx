import { MailboxLocationContext } from './MailboxLocationContext'
import { useState, type MouseEvent } from 'react'
import { ComposerQueuedMessageEditor, type EditQueuedMessage } from './ComposerQueuedMessageEditor'
import { ArrowUp, ArrowDown, Pencil, Trash2 } from 'lucide-react'
import { ConversationMessage, type ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { UNKNOWN_SPEAKER_ID } from '@agentmux/client-ui/conversation-speaker'
import { MailboxRecordRow, MailboxTime } from './MailboxReading'

export type ComposerQueuedMessage = {
  id: string
  text: string
  enqueuedAt?: number
  status: 'queued' | 'restoring' | 'deferred' | 'failed'
  deliverable: boolean
  editable?: boolean
  immediateSend?: boolean
  preparing?: boolean
  sending?: boolean
  unconfirmed?: boolean
  errorCode?: string
  error?: string
}

/** Labels describe the queue owner's facts, not native CLI rendering or model progress. */
export function queuedMessageState(entry: ComposerQueuedMessage, pendingInteraction = false) {
  if (entry.preparing) return { label: entry.status === 'restoring' ? '恢复中' : '准备发送', detail: '正在准备原消息的投递，尚未提交。', busy: true }
  if (entry.sending) return { label: '发送中', detail: '正在提交原消息，等待投递确认。', busy: true }
  if (pendingInteraction) return { label: '等待回答', detail: '先回答 Agent 当前请求；消息与原文会保留。', busy: false }
  if (entry.unconfirmed) return { label: '投递未确认', detail: entry.error ?? '结果尚未确认；只可按原操作检查或重试，不会自动重放。', busy: false }
  if (!entry.deliverable) return { label: '原 Run 不可投递', detail: entry.error ?? '绑定的 Run 不可用或已改变，不会投递到其他 Run。', busy: false }
  if (entry.errorCode === 'AGENT_EXECUTION_NOT_REQUESTED') return { label: '待手动发送', detail: entry.error ?? '恢复的消息等待明确发送，只授权这条原消息。', busy: false }
  if (entry.errorCode === 'AGENT_TURN_END_UNCONFIRMED') return { label: '等待当轮确认', detail: entry.error ?? '上一轮尚未确认结束；消息已保留，可明确发送这条消息。', busy: false }
  if (entry.errorCode === 'AGENT_PROMPT_SUBMISSION_BUSY') return { label: '等待前条提交', detail: entry.error ?? '原 Run 的前条提交尚未完成，消息已保留。', busy: false }
  if (entry.error || entry.status === 'failed') return { label: '待处理', detail: entry.error ?? '投递失败，原文已保留。', busy: false }
  return { label: '排队中', detail: '尚未发送。点击发送只提交这条消息；其他消息继续保留。', busy: false }
}

/** A retained queue record is not a submission receipt or a conversation position. */
export function queuedMessageLocation(entry: ComposerQueuedMessage) {
  if (entry.preparing) return '准备发送，对话位置暂不可用'
  if (entry.sending) return '正在提交，对话位置等待确认'
  if (entry.unconfirmed) return '投递未确认，对话位置暂不可用'
  if (!entry.deliverable || entry.error || entry.status === 'failed') return '暂无已确认的对话位置'
  return '尚未发送，暂无对话位置'
}

export function ComposerOutbox({ queued, selectedId, onSelect, onCopy, onRemove, onMove, onSend, onEdit, sendImmediately = false, reading, sessionId, pendingInteraction = false }: {
  pendingInteraction?: boolean
  reading?: ConversationReadingProps | undefined
  sessionId?: string | undefined
  queued: readonly ComposerQueuedMessage[]
  selectedId: string | null
  onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  onCopy?: (text: string) => Promise<boolean>
  onRemove?: (id: string) => void
  onMove?: (id: string, direction: 'up' | 'down') => void
  onSend?: (id: string) => void
  onEdit?: EditQueuedMessage
  sendImmediately?: boolean
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  if (!queued.length) return null
  const retryEntry = queued.find(entry => entry.deliverable)
  const sending = queued.some(entry => entry.sending || entry.preparing)
  const selected = selectedId ? queued.find(entry => entry.id === selectedId) : undefined
  const meaning = (entry: ComposerQueuedMessage) => queuedMessageState(entry, pendingInteraction).detail
  const send = (entry: ComposerQueuedMessage) => onSend && entry.deliverable
    ? <button type="button" className="composer-mailbox__send" disabled={sending || pendingInteraction || editingId === entry.id} onClick={() => onSend(entry.id)} aria-label={(entry.immediateSend ?? sendImmediately) ? 'Send queued message immediately' : 'Send queued message'}>{(entry.immediateSend ?? sendImmediately) ? 'Send now' : 'Send'}</button> : null
  if (selected) {
    const index = queued.indexOf(selected)
    const working = queuedMessageState(selected, pendingInteraction).busy
    const needsAttention = !selected.deliverable || selected.error || selected.status === 'failed'
    return <MailboxLocationContext sessionId={sessionId} pending>{(_summary, executionDetails) => <article className="composer-outbox composer-mailbox__detail" data-state={selected.status} data-record-key={`queue:${selected.id}`}>
      <div className="composer-outbox__actions">
        {send(selected)}
        {onEdit ? <button type="button" className="composer-tool" aria-label="编辑这条待发消息" title={selected.editable ? '编辑原消息，保存不会发送' : '投递状态不允许编辑；保留原文与原操作身份'} disabled={!selected.editable || Boolean(editingId)} onClick={() => setEditingId(selected.id)}><Pencil size={14} aria-hidden="true" /></button> : null}
        {onMove ? <>
          <button type="button" className="composer-tool" disabled={selected.sending || selected.preparing || index === 0 || queued[index - 1]?.sending || queued[index - 1]?.preparing} onClick={() => onMove(selected.id, 'up')} title="Move up" aria-label="Move up"><ArrowUp size={14} aria-hidden="true" /></button>
          <button type="button" className="composer-tool" disabled={selected.sending || selected.preparing || index === queued.length - 1 || queued[index + 1]?.sending || queued[index + 1]?.preparing} onClick={() => onMove(selected.id, 'down')} title="Move down" aria-label="Move down"><ArrowDown size={14} aria-hidden="true" /></button>
        </> : null}
        {onRemove ? <button type="button" className="composer-tool" disabled={selected.sending || selected.preparing} onClick={() => onRemove(selected.id)} title="Remove" aria-label="Remove"><Trash2 size={14} aria-hidden="true" /></button> : null}
      </div>
      {editingId === selected.id && onEdit ? <ComposerQueuedMessageEditor key={selected.id} entry={selected} onSave={onEdit} onCancel={() => setEditingId(null)} /> : null}
      {working || needsAttention ? <p className="composer-mailbox__risk" data-kind={working ? 'working' : 'attention'}>
        {working ? meaning(selected)
          : !selected.deliverable ? 'Bound Run unavailable. Delivery is unknown.' : 'Delivery needs attention. See Info for the recorded reason.'}
      </p> : null}
      <ConversationMessage {...reading} compact recordedIdentity messageId={`queue:${selected.id}`}
        messageActions={<span className="composer-mailbox__pending-location"><button type="button" className="composer-mailbox__reveal" disabled>在对话中查看</button><span>{queuedMessageLocation(selected)}</span></span>}
        speaker={{ role: 'unknown', id: UNKNOWN_SPEAKER_ID }} content={selected.text}
        {...(selected.enqueuedAt === undefined ? {} : { createdAt: selected.enqueuedAt })}
        {...(onCopy ? { onCopy } : {})}
        messageDetails={<><dl className="composer-mailbox__record-facts"><dt>Record</dt><dd>Pending message · not a delivery receipt</dd><dt>Enqueued</dt><dd><MailboxTime value={selected.enqueuedAt} complete /></dd><dt>State</dt><dd>{selected.status}</dd><dt>Delivery</dt><dd>{meaning(selected)}</dd></dl>{executionDetails}</>} />
      <details className="composer-mailbox__explanation"><summary>About queued delivery</summary><p>Send submits only this message; the button shows whether immediate execution is available. Restored messages wait for your explicit Send. Other messages stay queued.</p></details>
    </article>}</MailboxLocationContext>
  }
  return <section className="composer-outbox" aria-label="Queued messages">
    <h3>Pending ({queued.length})</h3>
    <ol className="composer-mailbox__messages">
      {queued.map(entry => <li key={entry.id} data-state={entry.status}><MailboxRecordRow recordKey={`queue:${entry.id}`}
        label={queuedMessageState(entry, pendingInteraction).label}
        avatar={<ConversationSpeakerAvatar speaker={{ role: 'unknown', id: UNKNOWN_SPEAKER_ID }} name="Author unknown" size={18} />}
        text={entry.text} metadata={<>{entry.status === 'failed' || entry.status === 'restoring' || entry.sending || entry.preparing ? <span>{entry.sending ? 'In progress' : entry.status}</span> : null}<MailboxTime value={entry.enqueuedAt} />{!entry.deliverable ? <span>Bound Run unavailable</span> : null}</>}
        onOpen={(_key, event) => onSelect(entry.id, event)} /><div className="composer-mailbox__record-actions composer-mailbox__pending-location"><button type="button" className="composer-mailbox__reveal" disabled>在对话中查看</button><span>{queuedMessageLocation(entry)}</span></div></li>)}
    </ol>
    {retryEntry ? send(retryEntry) : null}
    {onCopy ? <button type="button" className="composer-tool" onClick={() => onCopy(queued.map(entry => entry.text).join('\n\n'))}>Copy {queued.length === 1 ? 'message' : 'all'}</button> : null}
  </section>
}
