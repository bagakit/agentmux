import type { MouseEvent } from 'react'
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

export function ComposerOutbox({ queued, selectedId, onSelect, onCopy, onRemove, onMove, onSend }: {
  queued: readonly ComposerQueuedMessage[]
  selectedId: string | null
  onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  onCopy?: (text: string) => void
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
    ? <button type="button" className="composer-tool" disabled={sending} onClick={() => onSend(entry.id)}>Send queued message</button> : null
  if (selected) {
    const index = queued.indexOf(selected)
    return <article className="composer-outbox composer-mailbox__detail" data-state={selected.status} data-record-key={`queue:${selected.id}`}>
      <header><strong>Pending message</strong><div className="composer-mailbox__metadata"><span>{selected.status}</span><MailboxTime value={selected.enqueuedAt} complete /></div></header>
      <p className="composer-mailbox__full-text">{selected.text}</p><p>{meaning(selected)}</p>
      <p>Send explicitly steers this message, including during the current turn. It does not send the other queued messages. Messages restored from a previous application session wait for your explicit Send.</p>
      <div className="composer-outbox__actions">
        {send(selected)}
        {onCopy ? <button type="button" className="composer-tool" onClick={() => onCopy(selected.text)}>Copy message</button> : null}
        {onMove ? <>
          <button type="button" className="composer-tool" disabled={selected.sending || index === 0 || queued[index - 1]?.sending} onClick={() => onMove(selected.id, 'up')}>Move up</button>
          <button type="button" className="composer-tool" disabled={selected.sending || index === queued.length - 1 || queued[index + 1]?.sending} onClick={() => onMove(selected.id, 'down')}>Move down</button>
        </> : null}
        {onRemove ? <button type="button" className="composer-tool" disabled={selected.sending} onClick={() => onRemove(selected.id)}>Remove</button> : null}
      </div>
    </article>
  }
  return <section className="composer-outbox" aria-label="Queued messages">
    <h3>Pending ({queued.length})</h3>
    <ol className="composer-mailbox__messages">
      {queued.map(entry => <li key={entry.id} data-state={entry.status}><MailboxRecordRow recordKey={`queue:${entry.id}`}
        label={entry.sending ? entry.status === 'restoring' ? 'Restoring' : 'Sending' : entry.id === retryEntry?.id ? 'Next to send' : 'Pending message'}
        text={entry.text} metadata={<><span>{entry.status}</span><MailboxTime value={entry.enqueuedAt} />{!entry.deliverable ? <span>Bound Run unavailable</span> : null}</>}
        onOpen={(_key, event) => onSelect(entry.id, event)} /></li>)}
    </ol>
    {retryEntry ? send(retryEntry) : null}
    {onCopy ? <button type="button" className="composer-tool" onClick={() => onCopy(queued.map(entry => entry.text).join('\n\n'))}>Copy {queued.length === 1 ? 'message' : 'all'}</button> : null}
  </section>
}
