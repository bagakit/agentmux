import { useEffect, useId, useState, type ReactNode } from 'react'
import { Mail } from 'lucide-react'
import { ComposerOutbox, type ComposerQueuedMessage } from './ComposerOutbox'
import { useServiceNotices } from '../lib/use-service-notices'

type NoticeInbox = ReturnType<typeof useServiceNotices>

export function SessionMailbox({ inbox, queued, identity, onRemoveQueued, onSendQueued, onCopyQueued }: {
  identity?: { name: string; avatar: ReactNode; context?: string }
  inbox: NoticeInbox
  queued: readonly ComposerQueuedMessage[]
  onRemoveQueued?: (id: string) => void
  onSendQueued?: (id: string) => void
  onCopyQueued?: (text: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState<'inbox' | 'outbox'>(() => inbox.notices.length === 0 && queued.length > 0 ? 'outbox' : 'inbox')
  // Only visible incoming notices are read. Opening the outbox never acknowledges unseen notices.
  useEffect(() => {
    if (open && folder === 'inbox' && inbox.unread.length) inbox.acknowledge(inbox.unread)
  }, [open, folder, inbox])
  return <>
    <button type="button" className="composer__mailbox" data-unread={inbox.unread.length > 0}
      aria-label={`${identity ? `${identity.name} · ` : ''}Mailbox: ${inbox.unread.length} unread, ${inbox.notices.length} notices, ${queued.length} pending`}
      title={identity ? `${identity.context ? `${identity.name} · ${identity.context}` : identity.name} · Mailbox` : 'Mailbox'} popoverTarget={id} popoverTargetAction="toggle">
      <Mail size={14} aria-hidden="true" />
      {queued.length ? <span aria-hidden="true">{queued.length}</span> : null}
      {identity ? <span className="composer__identity" title={identity.context ? `${identity.name} · ${identity.context}` : identity.name}>{identity.avatar}</span> : null}
      {inbox.unread.length ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
    </button>
    <div id={id} popover="auto" className="composer-mailbox" aria-label="Mailbox"
      onToggle={(event) => setOpen(event.newState === 'open')}>
      <div className="composer-mailbox__folders" role="tablist" aria-label="Mailbox folders">
        {(['inbox', 'outbox'] as const).map((name) => <button key={name} type="button"
          id={`${id}-${name}-tab`} role="tab" aria-controls={`${id}-${name}`} aria-selected={folder === name}
          tabIndex={folder === name ? 0 : -1} onClick={() => setFolder(name)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'inbox' : event.key === 'End' ? 'outbox' : name === 'inbox' ? 'outbox' : 'inbox'
            setFolder(next)
            document.getElementById(`${id}-${next}-tab`)?.focus()
          }}>
          {name === 'inbox' ? `Inbox (${inbox.notices.length})` : `Outbox (${queued.length})`}
          {name === 'inbox' && inbox.unread.length ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
        </button>)}
      </div>
      <div id={`${id}-inbox`} role="tabpanel" aria-labelledby={`${id}-inbox-tab`} hidden={folder !== 'inbox'}>
        {inbox.notices.length ? inbox.notices.map((item) => <div key={item.id} className="composer-notice" data-kind={item.notice.kind}>
          <div className="composer-notice__body">
            <strong>{item.notice.notice.step}</strong>
            <span>{item.notice.notice.mode}</span>
            <span>{item.notice.notice.restore}</span>
            {item.id === 'queue' ? <button type="button" className="composer-tool" onClick={() => setFolder('outbox')}>View outbox</button> : null}
            {item.action ? <button type="button" className="composer-tool" onClick={item.action.run}>{item.action.label}</button> : null}
          </div>
        </div>) : <p>{inbox.available ? 'No current notices.' : 'Waiting for Session status.'}</p>}
      </div>
      <div id={`${id}-outbox`} role="tabpanel" aria-labelledby={`${id}-outbox-tab`} hidden={folder !== 'outbox'}>
        <ComposerOutbox queued={queued} {...(onRemoveQueued ? { onRemove: onRemoveQueued } : {})}
          {...(onSendQueued ? { onSend: onSendQueued } : {})} {...(onCopyQueued ? { onCopy: onCopyQueued } : {})} />
      </div>
    </div>
  </>
}
