import { Copy } from 'lucide-react'

export type ComposerQueuedMessage = {
  id: string
  text: string
  // `deferred` 是「我们这次没投出去，Agent 还好着，还在等下一次机会」。它必须与 `queued` 分开，
  // 否则角标会照 healthy 路径念「queued for delivery」，把一次降级静默放行（store.ts 的
  // AgentSteerQueueEntry 记了为什么这一档要在模型里有名字）。
  status: 'queued' | 'deferred' | 'failed'
  deliverable: boolean
  sending?: boolean
  error?: string
}

export function ComposerOutbox({ queued, onCopy, onRemove, onSend }: {
  queued: readonly ComposerQueuedMessage[]
  onCopy?: (text: string) => void
  onRemove?: (id: string) => void
  onSend?: (id: string) => void
}) {
  if (!queued.length) return <p>No pending messages.</p>
  const retryEntry = queued.find((entry) => entry.deliverable)
  const { sending, label } = summarizeQueue(queued)
  return (
    <section className="composer-outbox" aria-label="Queued messages">
        <h3>{label}</h3>
        <ol>
          {queued.map((entry) => <li key={entry.id} data-state={entry.status}>
            <span>{entry.text}</span>
            {entry.sending ? <small>Sending. Waiting for delivery confirmation.</small>
              : !entry.deliverable ? <small>Not sent: this message targets a Run that is no longer available here.</small>
              : entry.error ? <small>{entry.error}</small> : null}
            <span className="composer-outbox__actions">
              {onRemove ? <button type="button" className="composer-tool" disabled={entry.sending} onClick={() => onRemove(entry.id)}>Remove</button> : null}
            </span>
          </li>)}
        </ol>
        {onSend && retryEntry ? <button type="button" className="composer-tool" disabled={sending} onClick={() => onSend(retryEntry.id)}>Retry queue</button> : null}
        <p>Messages for the current Run are sent in order as soon as the Agent can accept them.</p>
        {onCopy ? <button type="button" className="composer-tool" onClick={() => onCopy(queued.map((entry) => entry.text).join('\n\n'))}>
          <Copy size={12} aria-hidden="true" /> Copy {queued.length === 1 ? 'message' : 'all'}
        </button> : null}
    </section>
  )
}

function summarizeQueue(queued: readonly ComposerQueuedMessage[]) {
  const unavailable = queued.filter((entry) => !entry.deliverable && !entry.sending).length
  const deferred = queued.filter((entry) => entry.deliverable && entry.status === 'deferred')
  const sending = queued.some((entry) => entry.sending)
  const label = unavailable > 0
    ? `${unavailable} of ${queued.length} messages cannot be sent to the current Run`
    : deferred.length > 0
    ? `${deferred.length} of ${queued.length} messages not delivered yet - still queued`
    : sending ? `Sending - ${queued.length} queued` : `${queued.length} message${queued.length === 1 ? '' : 's'} queued for delivery`
  return { sending, label }
}
