import { Copy } from 'lucide-react'

export type ComposerQueuedMessage = {
  id: string
  text: string
  enqueuedAt?: number
  // `deferred` 是「我们这次没投出去，Agent 还好着，还在等下一次机会」。它必须与 `queued` 分开，
  // 否则角标会照 healthy 路径念「queued for delivery」，把一次降级静默放行（store.ts 的
  // AgentSteerQueueEntry 记了为什么这一档要在模型里有名字）。
  status: 'queued' | 'restoring' | 'deferred' | 'failed'
  deliverable: boolean
  sending?: boolean
  error?: string
  turnEndUnconfirmed?: boolean
}

export function ComposerOutbox({ queued, onCopy, onRemove, onMove, onSend, onContinue }: {
  queued: readonly ComposerQueuedMessage[]
  onCopy?: (text: string) => void
  onRemove?: (id: string) => void
  onMove?: (id: string, direction: 'up' | 'down') => void
  onSend?: (id: string) => void
  onContinue?: (id: string) => void
}) {
  if (!queued.length) return <p>No pending messages.</p>
  const retryEntry = queued.find((entry) => entry.deliverable)
  const { sending, label } = summarizeQueue(queued)
  return (
    <section className="composer-outbox" aria-label="Queued messages">
        <h3>{label}</h3>
        <ol>
          {queued.map((entry, index) => {
            const recordedTime = typeof entry.enqueuedAt === 'number' && Number.isFinite(entry.enqueuedAt) && entry.enqueuedAt >= 0
              ? new Date(entry.enqueuedAt) : undefined
            const time = recordedTime && !Number.isNaN(recordedTime.getTime()) ? recordedTime : undefined
            return <li key={entry.id} data-state={entry.status}>
            <span>{entry.text}</span>
            <small>{time ? <>Queued <time dateTime={time.toISOString()} title={time.toLocaleString()}>
              {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time></> : 'Queued time unknown'}</small>
            {entry.sending ? <small>{entry.status === 'restoring'
              ? 'Restoring the Agent. This message has not been dispatched.'
              : 'Sending. Waiting for delivery confirmation.'}</small>
              : !entry.deliverable ? <small>Not sent: the bound Run is unavailable or changed. Its delivery result is unknown; it will not be replayed on another Run.</small>
              : entry.error ? <small>{entry.error}</small> : null}
            <span className="composer-outbox__actions">
              {onMove ? <>
                <button type="button" className="composer-tool" disabled={entry.sending || index === 0 || queued[index - 1]?.sending}
                  onClick={() => onMove(entry.id, 'up')}>Move up</button>
                <button type="button" className="composer-tool" disabled={entry.sending || index === queued.length - 1 || queued[index + 1]?.sending}
                  onClick={() => onMove(entry.id, 'down')}>Move down</button>
              </> : null}
              {onRemove ? <button type="button" className="composer-tool" disabled={entry.sending} onClick={() => onRemove(entry.id)}>Remove</button> : null}
            </span>
          </li>})}
        </ol>
        {onSend && retryEntry ? <button type="button" className="composer-tool" disabled={sending} onClick={() => onSend(retryEntry.id)}>Send queued message</button> : null}
        {onContinue && retryEntry?.turnEndUnconfirmed ? <>
          <p>The previous turn may still be running. Sending now can leave a draft or start another turn. This sends only the first queued message.</p>
          <button type="button" className="composer-tool" disabled={sending} onClick={() => onContinue(retryEntry.id)}>Send now — turn may still be running</button>
        </> : null}
        <p>Choose Send to execute messages restored from a previous application session. New messages for the current Run are sent in order when the Agent can accept them.</p>
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
