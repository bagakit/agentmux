import { useEffect, useId, useMemo, useState } from 'react'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { Mail, X } from 'lucide-react'
import { ComposerOutbox, type ComposerQueuedMessage } from './ComposerOutbox'
import { useAppStore } from '../store'
import { useReadReceipts, type useServiceNotices } from '../lib/use-service-notices'

type Folder = 'inbox' | 'outbox' | 'system'
const FOLDERS: readonly Folder[] = ['inbox', 'outbox', 'system']

function useMessageFingerprints(items: readonly AgentTimelineItem[]) {
  // Activity-only revisions must not rehash unchanged mail or hide its unread state.
  const signature = useMemo(() => JSON.stringify(items.map((item) =>
    [item.id, item.authorAgentSessionId, item.content, item.createdAt, item.status])), [items])
  const [result, setResult] = useState<{ signature: string; values: Record<string, string> }>()
  useEffect(() => {
    let current = true
    const messages = JSON.parse(signature) as [string, ...unknown[]][]
    void Promise.all(messages.map(async ([id, ...fields]) => {
      const content = JSON.stringify(fields)
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
      return [id, Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')] as const
    })).then((entries) => {
      if (current) setResult({ signature, values: Object.fromEntries(entries) })
    })
    return () => { current = false }
  }, [signature])
  return result?.signature === signature ? result.values : undefined
}

function MessageHistory({ items, incoming, onCopy }: { items: readonly AgentTimelineItem[]; incoming: boolean; onCopy?: ((text: string) => void) | undefined }) {
  const sessions = useAppStore((state) => state.sessions)
  const names = useAppStore((state) => state.agentNames)
  const authorLabel = (id: string) => names?.[id] || sessions.find((session) => session.id === id)?.label || `Agent ${id.slice(0, 8)}`
  return items.length ? <ol className="composer-mailbox__messages" aria-label={incoming ? 'Recent Agent messages' : 'Recent outgoing messages'}>
    {items.map((item) => <li key={item.id}>
      <header><strong>{incoming ? authorLabel(item.authorAgentSessionId!) : item.status === 'complete' ? 'Sent' : 'Delivery not confirmed'}</strong>
        <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time></header>
      <p>{item.content}</p>
      {item.status === 'failed' ? <><small>Delivery not confirmed. Check the Agent’s response before sending again.</small>
        {onCopy && item.content ? <button type="button" className="composer-tool" onClick={() => onCopy(item.content!)}>Copy message</button> : null}</> : null}
    </li>)}
  </ol> : incoming ? <p>No Agent messages.</p> : null
}

/** Folders project durable delivery facts; read receipts never advance delivery state. */
export function SessionMailbox({ system, queued, timeline, onRemoveQueued, onSendQueued, onCopyQueued }: {
  system: ReturnType<typeof useServiceNotices>
  queued: readonly ComposerQueuedMessage[]
  timeline?: AgentTimelineSnapshot | undefined
  onRemoveQueued?: (id: string) => void
  onSendQueued?: (id: string) => void
  onCopyQueued?: (text: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState<Folder>('inbox')
  const messages = useMemo(() => timeline?.items.filter((item) => item.agentSessionId === timeline.agentSessionId &&
    item.kind === 'user_message' && item.status !== 'streaming') ?? [], [timeline])
  const incoming = useMemo(() => messages.filter((item) => item.authorAgentSessionId !== undefined), [messages])
  const sent = messages.filter((item) => item.authorAgentSessionId === undefined)
  const fingerprints = useMessageFingerprints(incoming)
  const receipts = useReadReceipts(`mail:${timeline?.agentSessionId ?? ''}`, fingerprints ?? {},
    timeline !== undefined && fingerprints !== undefined)
  const unread = receipts.unread.length + system.unread.length
  const deliveredIds = new Set(messages.filter((item) => item.status === 'complete').map((item) => item.id))
  const pending = queued.filter((item) => !deliveredIds.has(`prompt:${item.id}`))
  const counts = { inbox: incoming.length, outbox: pending.length + sent.length, system: system.notices.length }
  // Re-evaluate priority only on opening. A new arrival never moves the reader's selected folder.
  function openFolder(): Folder {
    return receipts.unread.length ? 'inbox' : system.unread.length ? 'system' : counts.outbox ? 'outbox' : 'inbox'
  }
  useEffect(() => {
    if (!open) return
    if (folder === 'inbox' && receipts.unread.length) receipts.acknowledge(receipts.unread)
    if (folder === 'system' && system.unread.length) system.acknowledge(system.unread)
  }, [open, folder, receipts, system])
  return <>
    <button type="button" className="composer__mailbox" data-unread={unread > 0}
      aria-label={`Mailbox: ${unread} unread, ${incoming.length} Agent messages, ${system.notices.length} notices, ${pending.length} pending`}
      title="Mailbox" popoverTarget={id} popoverTargetAction="toggle">
      <Mail size={14} aria-hidden="true" />
      {pending.length ? <span aria-hidden="true">{pending.length}</span> : null}
      {unread ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
    </button>
    <div id={id} popover="auto" className="composer-mailbox" aria-label="Mailbox"
      onToggle={(event) => { const opening = event.newState === 'open'; if (opening) setFolder(openFolder()); setOpen(opening) }}>
      <div className="composer-mailbox__heading"><strong>Mailbox</strong>
        <button type="button" className="composer-tool" aria-label="Close mailbox" popoverTarget={id} popoverTargetAction="hide"><X size={14} /></button></div>
      <div className="composer-mailbox__folders" role="tablist" aria-label="Mailbox folders">
        {FOLDERS.map((name, index) => <button key={name} type="button"
          id={`${id}-${name}-tab`} role="tab" aria-controls={`${id}-${name}`} aria-selected={folder === name}
          tabIndex={folder === name ? 0 : -1} onClick={() => setFolder(name)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = FOLDERS[event.key === 'Home' ? 0 : event.key === 'End' ? FOLDERS.length - 1 :
              (index + (event.key === 'ArrowRight' ? 1 : FOLDERS.length - 1)) % FOLDERS.length]!
            setFolder(next)
            document.getElementById(`${id}-${next}-tab`)?.focus()
          }}>
          {`${name[0]!.toUpperCase()}${name.slice(1)} (${counts[name]})`}
          {(name === 'inbox' && receipts.unread.length || name === 'system' && system.unread.length) ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
        </button>)}
      </div>
      <div id={`${id}-inbox`} role="tabpanel" aria-labelledby={`${id}-inbox-tab`} hidden={folder !== 'inbox'}>
        {timeline ? <MessageHistory items={incoming} incoming onCopy={onCopyQueued} /> : <p>Waiting for message history.</p>}
      </div>
      <div id={`${id}-outbox`} role="tabpanel" aria-labelledby={`${id}-outbox-tab`} hidden={folder !== 'outbox'}>
        <ComposerOutbox queued={pending} {...(onRemoveQueued ? { onRemove: onRemoveQueued } : {})}
          {...(onSendQueued ? { onSend: onSendQueued } : {})} {...(onCopyQueued ? { onCopy: onCopyQueued } : {})} />
        <MessageHistory items={sent} incoming={false} onCopy={onCopyQueued} />
      </div>
      <div id={`${id}-system`} role="tabpanel" aria-labelledby={`${id}-system-tab`} hidden={folder !== 'system'}>
        {system.notices.length ? system.notices.map((item) => <div key={item.id} className="composer-notice" data-kind={item.notice.kind}>
          <div className="composer-notice__body">
            <strong>{item.notice.notice.step}</strong><span>{item.notice.notice.mode}</span><span>{item.notice.notice.restore}</span>
            {item.id === 'queue' ? <button type="button" className="composer-tool" onClick={() => setFolder('outbox')}>View outbox</button> : null}
            {item.action ? <button type="button" className="composer-tool" onClick={item.action.run}>{item.action.label}</button> : null}
          </div>
        </div>) : <p>{system.available ? 'No current notices.' : 'Waiting for Session status.'}</p>}
      </div>
    </div>
  </>
}
