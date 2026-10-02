import { ArrowUp, Clock3, LoaderCircle, MoreHorizontal } from 'lucide-react'
import { queuedMessageState, type ComposerQueuedMessage } from './ComposerOutbox'

/** A summary of the original Outbox, with actions for its exact current operation. */
export function ComposerPendingDelivery({ queued, pendingInteraction, onSend, onMore }: {
  queued: readonly ComposerQueuedMessage[]
  pendingInteraction: boolean
  onSend?: ((id: string) => void) | undefined
  onMore: () => void
}) {
  if (!queued.length) return null
  const active = queued.find(entry => entry.preparing || entry.sending)
  const next = queued.find(entry => entry.deliverable)
  const entry = active ?? next ?? queued[0]!
  const state = queuedMessageState(entry, pendingInteraction)
  const canSend = !active && !pendingInteraction && entry.deliverable && Boolean(onSend)
  const preview = entry.text.replace(/\s+/g, ' ').trim().slice(0, 240)
  const Icon = state.busy ? LoaderCircle : Clock3
  return <section className="composer-pending" aria-label="待发消息" data-operation-id={entry.id} data-busy={state.busy}>
    <span className="composer-pending__count" title={`${queued.length} 条待发消息`}>待发 {queued.length}</span>
    <span className="composer-pending__preview" title={preview}>{preview}</span>
    <span className="composer-pending__state" role="status" title={state.detail}>
      <Icon size={12} aria-hidden="true" /><span>{state.label}</span>
    </span>
    <button type="button" className="composer-pending__send" aria-label="发送这条待发消息"
      title={canSend ? '发送这条消息（仅此条）' : !onSend ? '此显示面只读，原文仍可在 Outbox 复制' : state.detail}
      disabled={!canSend} onClick={() => onSend?.(entry.id)}><ArrowUp size={14} aria-hidden="true" /></button>
    <button type="button" className="composer-tool" aria-label="在 Outbox 查看待发消息和操作"
      title="查看全文、复制及队列操作" onClick={onMore}><MoreHorizontal size={14} aria-hidden="true" /></button>
  </section>
}
