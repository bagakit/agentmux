import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { CircleHelp, Mail, Pause, Repeat2, X } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { ContinuousProgressControl, type ContinuousProgressStatus } from './ContinuousProgressControl'
import { ComposerOutbox, type ComposerQueuedMessage } from './ComposerOutbox'
import { useAppStore } from '../store'
import { useReadReceipts, type useServiceNotices } from '../lib/use-service-notices'
import { useSessionUserMessages } from '../lib/session-user-messages'
import type { AgentSessionControl } from '../../../shared/contracts'

type Folder = 'inbox' | 'outbox' | 'system' | 'progress'
const FOLDERS: readonly Folder[] = ['inbox', 'outbox', 'system']

type MailboxDisplayItem = AgentTimelineItem | AgentSessionUserMessage

function isUserMessage(item: MailboxDisplayItem): item is AgentSessionUserMessage {
  return 'source' in item && typeof item.source === 'object' && item.source !== null
}

function useMessageFingerprints(items: readonly MailboxDisplayItem[]) {
  // Activity-only revisions must not rehash unchanged mail or hide its unread state.
  const signature = useMemo(() => JSON.stringify(items.map((item) => {
    if (isUserMessage(item)) {
      return [item.id, item.author.kind === 'agent' ? item.author.agentSessionId : undefined, item.content, item.recordedAt, item.deliveryStatus]
    }
    return [item.id, item.authorAgentSessionId, item.content, item.createdAt, item.status]
  })), [items])
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

function MessageHistory({ items, incoming, onCopy }: { items: readonly MailboxDisplayItem[]; incoming: boolean; onCopy?: ((text: string) => void) | undefined }) {
  const sessions = useAppStore((state) => state.sessions)
  const names = useAppStore((state) => state.agentNames)
  const authorLabel = (id: string) => names?.[id] || sessions.find((session) => session.id === id)?.label || `Agent ${id.slice(0, 8)}`
  return items.length ? <ol className="composer-mailbox__messages" aria-label={incoming ? 'Recent Agent messages' : 'Recent outgoing messages'}>
    {items.map((item) => {
      const isUnified = isUserMessage(item)
      let headerText = ''
      let timestamp: number | undefined
      let failed = false

      if (isUnified) {
        if (incoming) {
          headerText = item.author.kind === 'agent' ? authorLabel(item.author.agentSessionId) : 'Agent'
        } else {
          headerText = item.source.kind === 'native'
            ? 'Recorded'
            : item.deliveryStatus === 'complete' ? 'Sent' : 'Delivery not confirmed'
        }
        timestamp = item.recordedAt
        failed = item.deliveryStatus === 'failed'
      } else {
        headerText = incoming ? authorLabel(item.authorAgentSessionId!) : item.status === 'complete' ? 'Sent' : 'Delivery not confirmed'
        timestamp = item.createdAt
        failed = item.status === 'failed'
      }

      const itemKey = isUnified ? `${item.source.kind}:${item.id}` : `timeline:${item.id}`
      return (
        <li key={itemKey}>
          <header>
            <strong>{headerText}</strong>
            {timestamp !== undefined ? (
              <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleString()}</time>
            ) : null}
          </header>
          <p>{item.content}</p>
          {failed ? (
            <>
              <small>Delivery not confirmed. Check the Agent’s response before sending again.</small>
              {onCopy && item.content ? (
                <button type="button" className="composer-tool" onClick={() => onCopy(item.content!)}>
                  Copy message
                </button>
              ) : null}
            </>
          ) : null}
        </li>
      )
    })}
  </ol> : incoming ? <p>No Agent messages.</p> : null
}

/** Folders project durable delivery facts; read receipts never advance delivery state. */
export function SessionMailbox({ system, queued, timeline, progressSession, control: propControl, userMessages: propUserMessages, onRemoveQueued, onMoveQueued, onSendQueued, onCopyQueued }: {
  system: ReturnType<typeof useServiceNotices>
  queued: readonly ComposerQueuedMessage[]
  timeline?: AgentTimelineSnapshot | undefined
  progressSession?: Extract<SessionSnapshot, { kind: 'agent' }> | undefined
  control?: AgentSessionControl | undefined
  userMessages?: readonly AgentSessionUserMessage[] | undefined
  onRemoveQueued?: (id: string) => void
  onMoveQueued?: (id: string, direction: 'up' | 'down') => void
  onSendQueued?: (id: string) => void
  onCopyQueued?: (text: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [folder, setFolder] = useState<Folder>('inbox')
  const folders: readonly Folder[] = progressSession ? [...FOLDERS, 'progress'] : FOLDERS
  const progressTarget = progressSession ? JSON.stringify([progressSession.hostId, progressSession.id, progressSession.providerId, progressSession.workspacePath]) : ''
  const [progress, setProgress] = useState<{ target: string; status: ContinuousProgressStatus }>()
  const onProgressStatus = useCallback((status: ContinuousProgressStatus) => setProgress({ target: progressTarget, status }), [progressTarget])
  const progressStatus = progress?.target === progressTarget ? progress.status : 'unconfirmed'
  const progressLabel = `Continuous progress: ${progressStatus}${progressStatus === 'inactive' ? ' (not enabled)' : ''}`
  const ProgressIcon = progressStatus === 'active' ? Repeat2 : progressStatus === 'paused' ? Pause : CircleHelp

  const storeSession = useAppStore((state) =>
    state.sessions.find(
      (s) => s.id === (propControl?.agentSessionId ?? timeline?.agentSessionId)
    )
  )
  const effectiveControl: AgentSessionControl | undefined =
    propControl ?? (storeSession?.kind === 'agent' ? storeSession.control : undefined)

  const {
    messages: hookUserMessages,
    hasMore,
    loadEarlier,
    refresh,
    error: historyError
  } = useSessionUserMessages(effectiveControl, { enabled: open })

  const effectiveUserMessages = propUserMessages ?? hookUserMessages

  const sessionFactsKey = storeSession?.kind === 'agent'
    ? `${storeSession.updatedAt}:${storeSession.agentSessionUpdatedAt}`
    : storeSession?.updatedAt
  const lastFactsKeyRef = useRef(sessionFactsKey)
  useEffect(() => {
    if (lastFactsKeyRef.current !== undefined && lastFactsKeyRef.current !== sessionFactsKey) {
      lastFactsKeyRef.current = sessionFactsKey
      void refresh()
    } else {
      lastFactsKeyRef.current = sessionFactsKey
    }
  }, [sessionFactsKey, refresh])

  const messages = useMemo(() => timeline?.items.filter((item) => item.agentSessionId === timeline.agentSessionId &&
    item.kind === 'user_message' && item.status !== 'streaming') ?? [], [timeline])
  const incoming = useMemo(() => messages.filter((item) => item.authorAgentSessionId !== undefined), [messages])
  const timelineSent = useMemo(() => messages.filter((item) => item.authorAgentSessionId === undefined), [messages])

  const nativeSent = useMemo(() => {
    if (!effectiveUserMessages) return []
    return effectiveUserMessages.filter((item) => item.source.kind === 'native' && item.author.kind !== 'agent')
  }, [effectiveUserMessages])

  const sent = useMemo(() => {
    return [...timelineSent, ...nativeSent]
  }, [timelineSent, nativeSent])

  const fingerprints = useMessageFingerprints(incoming)
  const receipts = useReadReceipts(`mail:${timeline?.agentSessionId ?? ''}`, fingerprints ?? {},
    timeline !== undefined && fingerprints !== undefined)
  const unread = receipts.unread.length + system.unread.length

  const deliveredIds = useMemo(() => {
    return new Set(messages.filter((item) => item.status === 'complete').map((item) => item.id))
  }, [messages])

  const pending = queued.filter((item) => !deliveredIds.has(item.id) && !deliveredIds.has(`prompt:${item.id}`))
  const counts = { inbox: incoming.length, outbox: pending.length + sent.length, system: system.notices.length }
  // Re-evaluate priority only on opening. A new arrival never moves the reader's selected folder.
  function openFolder(): Folder {
    return receipts.unread.length ? 'inbox' : system.unread.length ? 'system' : counts.outbox ? 'outbox' : 'inbox'
  }
  const acquireNativeSurfaceOverlay = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const releaseNativeSurfaceOverlay = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  useEffect(() => {
    if (!open) return
    acquireNativeSurfaceOverlay()
    return () => {
      releaseNativeSurfaceOverlay()
    }
  }, [open, acquireNativeSurfaceOverlay, releaseNativeSurfaceOverlay])
  useEffect(() => {
    if (!open) return
    if (folder === 'inbox' && receipts.unread.length) receipts.acknowledge(receipts.unread)
    if (folder === 'system' && system.unread.length) system.acknowledge(system.unread)
  }, [open, folder, receipts, system])
  return <>
    <button type="button" className="composer__mailbox" data-unread={unread > 0} data-progress-state={progressSession ? progressStatus : undefined}
      aria-label={`Mailbox: ${unread} unread, ${incoming.length} Agent messages, ${system.notices.length} notices, ${pending.length} pending${progressSession ? `. ${progressLabel}` : ''}`}
      title={progressSession ? `Mailbox · ${progressLabel}` : 'Mailbox'} popoverTarget={id} popoverTargetAction="toggle">
      <Mail size={14} aria-hidden="true" />
      {progressSession && progressStatus !== 'inactive' ? <ProgressIcon size={9} className="composer-mailbox__progress" aria-hidden="true" /> : null}
      {pending.length ? <span aria-hidden="true">{pending.length}</span> : null}
      {unread ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
    </button>
    <div id={id} popover="auto" className="composer-mailbox" aria-label="Mailbox"
      data-state={open ? 'open' : 'closed'}
      onToggle={(event) => { const opening = event.newState === 'open'; if (opening) setFolder(openFolder()); setOpen(opening) }}>
      <div className="composer-mailbox__heading"><strong>Mailbox</strong>
        <button type="button" className="composer-tool" aria-label="Close mailbox" popoverTarget={id} popoverTargetAction="hide"><X size={14} /></button></div>
      <div className="composer-mailbox__folders" role="tablist" aria-label="Mailbox folders">
        {folders.map((name, index) => <button key={name} type="button"
          id={`${id}-${name}-tab`} role="tab" aria-controls={`${id}-${name}`} aria-selected={folder === name}
          tabIndex={folder === name ? 0 : -1} onClick={() => setFolder(name)}
          {...(name === 'progress' ? { 'aria-label': progressLabel, title: progressLabel } : {})}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = folders[event.key === 'Home' ? 0 : event.key === 'End' ? folders.length - 1 :
              (index + (event.key === 'ArrowRight' ? 1 : folders.length - 1)) % folders.length]!
            setFolder(next)
            document.getElementById(`${id}-${next}-tab`)?.focus()
          }}>
          {name === 'progress' ? 'Progress' : `${name[0]!.toUpperCase()}${name.slice(1)} (${counts[name]})`}
          {(name === 'inbox' && receipts.unread.length || name === 'system' && system.unread.length) ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
        </button>)}
      </div>
      <div id={`${id}-inbox`} role="tabpanel" aria-labelledby={`${id}-inbox-tab`} hidden={folder !== 'inbox'}>
        {timeline ? <MessageHistory items={incoming} incoming onCopy={onCopyQueued} /> : <p>Waiting for message history.</p>}
      </div>
      <div id={`${id}-outbox`} role="tabpanel" aria-labelledby={`${id}-outbox-tab`} hidden={folder !== 'outbox'}>
        <ComposerOutbox queued={pending} {...(onRemoveQueued ? { onRemove: onRemoveQueued } : {})}
          {...(onMoveQueued ? { onMove: onMoveQueued } : {})}
          {...(onSendQueued ? { onSend: onSendQueued } : {})} {...(onCopyQueued ? { onCopy: onCopyQueued } : {})} />
        {hasMore ? (
          <div className="composer-mailbox__boundary" style={{ padding: '6px 12px', fontSize: '12px', opacity: 0.85 }}>
            <span>Showing latest {sent.length} records. Earlier native messages available.</span>{' '}
            <button type="button" className="composer-tool" onClick={() => void loadEarlier()}>
              Load earlier messages
            </button>
          </div>
        ) : null}
        {historyError && !historyError.message.includes('unavailable in the web preview') ? (
          <div className="composer-mailbox__error" data-kind="error">
            <div className="composer-notice__body">
              <strong>Failed to read native conversation history</strong>
              <span>{historyError.message}</span>
              <button type="button" className="composer-tool" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          </div>
        ) : null}
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
      {progressSession ? <div id={`${id}-progress`} role="tabpanel" aria-labelledby={`${id}-progress-tab`} hidden={folder !== 'progress'}>
        <ContinuousProgressControl session={progressSession} onStatusChange={onProgressStatus} />
      </div> : null}
    </div>
  </>
}
