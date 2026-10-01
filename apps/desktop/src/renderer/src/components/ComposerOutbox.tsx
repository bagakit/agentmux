import type { MouseEvent } from 'react'
import { ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
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
  sending?: boolean
  error?: string
}

export function ComposerOutbox({ queued, selectedId, onSelect, onCopy, onRemove, onMove, onSend, reading }: {
  reading?: ConversationReadingProps | undefined
  queued: readonly ComposerQueuedMessage[]
  selectedId: string | null
  onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  onCopy?: (text: string) => Promise<boolean>
  onRemove?: (id: string) => void
  onMove?: (id: string, direction: 'up' | 'down') => void
  onSend?: (id: string) => void
}) {
  if (!queued.length) return null
  const retryEntry = queued.find(entry => entry.deliverable)
  const sending = queued.some(entry => entry.sending)
  const selected = selectedId ? queued.find(entry => entry.id === selectedId) : undefined
  const meaning = (entry: ComposerQueuedMessage) => entry.sending
    ? entry.status === 'restoring' ? 'Restoring the Agent. This message has not been dispatched.' : 'Sending. Waiting for delivery confirmation.'
    : !entry.deliverable ? 'Not sent: the bound Run is unavailable or changed. Its delivery result is unknown; it will not be replayed on another Run.'
    : entry.error ?? (entry.status === 'deferred' ? 'Not delivered yet — still queued.' : entry.status === 'failed' ? 'Delivery failed.' : 'Queued for delivery.')
  const send = (entry: ComposerQueuedMessage) => onSend && retryEntry?.id === entry.id
    ? <button type="button" className="composer-mailbox__send" disabled={sending} onClick={() => onSend(entry.id)} aria-label="Send queued message">Send</button> : null
  if (selected) {
    const index = queued.indexOf(selected)
    const working = selected.sending || selected.status === 'restoring'
    const needsAttention = !selected.deliverable || selected.error || selected.status === 'failed'
    return <article className="composer-outbox composer-mailbox__detail" data-state={selected.status} data-record-key={`queue:${selected.id}`}>
      <div className="composer-outbox__actions">
        {send(selected)}
        {onMove ? <>
          <button type="button" className="composer-tool" disabled={selected.sending || index === 0 || queued[index - 1]?.sending} onClick={() => onMove(selected.id, 'up')} title="Move up" aria-label="Move up"><ArrowUp size={14} aria-hidden="true" /></button>
          <button type="button" className="composer-tool" disabled={selected.sending || index === queued.length - 1 || queued[index + 1]?.sending} onClick={() => onMove(selected.id, 'down')} title="Move down" aria-label="Move down"><ArrowDown size={14} aria-hidden="true" /></button>
        </> : null}
        {onRemove ? <button type="button" className="composer-tool" disabled={selected.sending} onClick={() => onRemove(selected.id)} title="Remove" aria-label="Remove"><Trash2 size={14} aria-hidden="true" /></button> : null}
      </div>
      {working || needsAttention ? <p className="composer-mailbox__risk" data-kind={working ? 'working' : 'attention'}>
        {working ? selected.status === 'restoring' ? 'Restoring the Agent. This message has not been dispatched.' : 'Sending. Waiting for delivery confirmation.'
          : !selected.deliverable ? 'Bound Run unavailable. Delivery is unknown.' : 'Delivery needs attention. See Info for the recorded reason.'}
      </p> : null}
      <ConversationMessage {...reading} compact recordedIdentity messageId={`queue:${selected.id}`}
        speaker={{ role: 'unknown', id: UNKNOWN_SPEAKER_ID }} content={selected.text}
        {...(selected.enqueuedAt === undefined ? {} : { createdAt: selected.enqueuedAt })}
        {...(onCopy ? { onCopy } : {})}
        messageDetails={<dl className="composer-mailbox__record-facts"><dt>Record</dt><dd>Pending message · not a delivery receipt</dd><dt>Enqueued</dt><dd><MailboxTime value={selected.enqueuedAt} complete /></dd><dt>State</dt><dd>{selected.status}</dd><dt>Delivery</dt><dd>{meaning(selected)}</dd></dl>} />
      <details className="composer-mailbox__explanation"><summary>About queued delivery</summary><p>Send explicitly steers only this message, including during the current turn. Restored messages wait for your explicit Send; other queued messages are not sent automatically.</p></details>
    </article>
  }
  return <section className="composer-outbox" aria-label="Queued messages">
    <h3>Pending ({queued.length})</h3>
    <ol className="composer-mailbox__messages">
      {queued.map(entry => <li key={entry.id} data-state={entry.status}><MailboxRecordRow recordKey={`queue:${entry.id}`}
        label={entry.sending ? entry.status === 'restoring' ? 'Restoring' : 'Sending' : entry.id === retryEntry?.id ? 'Next to send' : 'Pending message'}
        avatar={<ConversationSpeakerAvatar speaker={{ role: 'unknown', id: UNKNOWN_SPEAKER_ID }} name="Author unknown" size={18} />}
        text={entry.text} metadata={<>{entry.status === 'failed' || entry.status === 'restoring' || entry.sending ? <span>{entry.sending ? 'In progress' : entry.status}</span> : null}<MailboxTime value={entry.enqueuedAt} />{!entry.deliverable ? <span>Bound Run unavailable</span> : null}</>}
        onOpen={(_key, event) => onSelect(entry.id, event)} /></li>)}
    </ol>
    {retryEntry ? send(retryEntry) : null}
    {onCopy ? <button type="button" className="composer-tool" onClick={() => onCopy(queued.map(entry => entry.text).join('\n\n'))}>Copy {queued.length === 1 ? 'message' : 'all'}</button> : null}
  </section>
}
