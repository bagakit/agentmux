import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { CircleHelp, Mail, Pause, Repeat2, X } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { ContinuousProgressControl, type ContinuousProgressStatus } from './ContinuousProgressControl'
import { ComposerOutbox, type ComposerQueuedMessage } from './ComposerOutbox'
import { useAppStore } from '../store'
import { serviceNoticeFingerprint, useReadReceipts, type useServiceNotices } from '../lib/use-service-notices'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { isImeOwnedKeyboardEvent } from '../lib/ime-composition-keyboard-event'
import type { AgentSessionControl } from '../../../shared/contracts'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { MailboxRecordRow, MailboxTime } from './MailboxReading'

type Folder = 'inbox' | 'outbox' | 'system' | 'progress'
const FOLDERS: readonly Folder[] = ['inbox', 'outbox', 'system']

type MailboxDisplayItem = AgentTimelineItem | AgentSessionUserMessage

function isUserMessage(item: MailboxDisplayItem): item is AgentSessionUserMessage {
  return 'source' in item && typeof item.source === 'object' && item.source !== null
}

function latestFirst(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return b - a
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

function messageKey(item: MailboxDisplayItem) { return `${isUserMessage(item) ? item.source.kind : 'timeline'}:${item.id}` }

function MessageHistory({ items, incoming, selectedKey, onOpen, onCopy }: {
  items: readonly MailboxDisplayItem[]; incoming: boolean; selectedKey: string | null
  onOpen: (key: string, event: MouseEvent<HTMLButtonElement>) => void; onCopy?: ((text: string) => void) | undefined
}) {
  // This component only mounts for the current reading page; rows have no individual Store observers.
  const sessions = useAppStore(state => state.sessions)
  const names = useAppStore(state => state.agentNames)
  const recent = useMemo(() => [...items].sort((a, b) => latestFirst(
    isUserMessage(a) ? a.recordedAt : a.createdAt, isUserMessage(b) ? b.recordedAt : b.createdAt)), [items])
  const authorLabel = (item: MailboxDisplayItem) => {
    const author = isUserMessage(item) ? item.author.kind === 'agent' ? item.author.agentSessionId : undefined : item.authorAgentSessionId
    return author ? names?.[author] || sessions.find(s => s.id === author)?.label || `Agent ${author.slice(0, 8)}`
      : (isUserMessage(item) ? item.author.kind === 'human' : item.authorHuman === true) ? 'Human' : 'Author unknown'
  }
  const label = (item: MailboxDisplayItem) => {
    return incoming ? authorLabel(item)
      : isUserMessage(item) && item.source.kind === 'native' ? 'Recorded' : (isUserMessage(item) ? item.deliveryStatus : item.status) === 'complete' ? 'Sent' : 'Delivery not confirmed'
  }
  const metadata = (item: MailboxDisplayItem, complete = false) => <>
    <span>{isUserMessage(item) && item.source.kind === 'native' ? 'Native record' : 'Captured input'}</span>
    {!incoming ? <span>{authorLabel(item)}</span> : null}
    <MailboxTime value={isUserMessage(item) ? item.recordedAt : item.createdAt} complete={complete} />
    {incoming ? <span>{(isUserMessage(item) ? item.deliveryStatus : item.status) === 'complete' ? 'Delivered' : 'Delivery not confirmed'}</span> : null}
  </>
  const selected = selectedKey ? recent.find(item => messageKey(item) === selectedKey) : undefined
  if (selected) return <article className="composer-mailbox__detail" data-record-key={messageKey(selected)}>
    <header><strong>{label(selected)}</strong><div className="composer-mailbox__metadata">{metadata(selected, true)}</div></header>
    <p className="composer-mailbox__full-text">{selected.content ?? 'No text recorded.'}</p>
    {(isUserMessage(selected) ? selected.deliveryStatus : selected.status) === 'failed'
      ? <p>Delivery not confirmed. Check the Agent’s response before sending again.</p> : null}
    {onCopy && selected.content ? <button type="button" className="composer-tool" onClick={() => onCopy(selected.content!)}>Copy message</button> : null}
  </article>
  return recent.length ? <ol className="composer-mailbox__messages" aria-label={incoming ? 'Recent Agent messages' : 'Recent outgoing messages'}>
    {recent.map(item => <li key={messageKey(item)}><MailboxRecordRow recordKey={messageKey(item)} label={label(item)} text={item.content}
      metadata={metadata(item)} onOpen={onOpen} /></li>)}
  </ol> : <p>{incoming ? 'No Agent messages.' : 'No recorded messages.'}</p>
}

/** Folders project durable delivery facts; read receipts never advance delivery state. */
export function SessionMailbox({ system, queued, timeline, progressSession, visible = true, control: propControl, userMessages: propUserMessages, onRemoveQueued, onMoveQueued, onSendQueued, onCopyQueued }: {
  system: ReturnType<typeof useServiceNotices>
  queued: readonly ComposerQueuedMessage[]
  timeline?: AgentTimelineSnapshot | undefined
  progressSession?: Extract<SessionSnapshot, { kind: 'agent' }> | undefined
  visible?: boolean
  control?: AgentSessionControl | undefined
  userMessages?: readonly AgentSessionUserMessage[] | undefined
  onRemoveQueued?: (id: string) => void
  onMoveQueued?: (id: string, direction: 'up' | 'down') => void
  onSendQueued?: (id: string) => void
  onCopyQueued?: (text: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [viewed, setViewed] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const preview = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function cancelClose() { clearTimeout(closeTimer.current) }
  useEffect(() => () => cancelClose(), [])
  function pin() { cancelClose(); preview.current = false; setViewed(true) }
  function enter(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    cancelClose()
    if (open) return
    preview.current = true
    setViewed(false)
    // Native source retains the trigger relationship and implicit anchor. TS's DOM declaration
    // has not yet included this platform option; there is no alternate popover implementation.
    ;(popover.current!.showPopover as (options: { source: HTMLButtonElement }) => void)
      .call(popover.current, { source: trigger.current! })
  }
  function leave(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || !preview.current) return
    cancelClose()
    closeTimer.current = setTimeout(() => popover.current?.hidePopover(), 180)
  }
  useEffect(() => {
    if (!open) return
    // The current editor may consume Escape before native light-dismiss. Only a hover preview
    // handles it here; no focus moves and composing Escape remains owned by the editor/IME.
    const dismissPreview = (event: KeyboardEvent) => {
      if (!preview.current || event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return
      event.preventDefault(); event.stopPropagation(); popover.current!.hidePopover()
    }
    document.addEventListener('keydown', dismissPreview, true)
    return () => document.removeEventListener('keydown', dismissPreview, true)
  }, [open])
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

  const scope = JSON.stringify([effectiveControl?.hostId, effectiveControl?.agentSessionId, effectiveControl?.run.runId, timeline?.agentSessionId])
  const previousScope = useRef(scope)
  const [selection, setSelection] = useState<{ scope: string; folder: Folder; key: string } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const positions = useRef<Partial<Record<Folder, { scroll: number; key: string }>>>({})
  const focusAfter = useRef<'back' | 'row' | null>(null)
  const lastReadingFocus = useRef<Element | null>(null)
  function selectRecord(key: string, event: MouseEvent<HTMLButtonElement>) {
    positions.current[folder] = { scroll: body.current?.scrollTop ?? 0, key }
    focusAfter.current = document.activeElement === event.currentTarget ? 'back' : null
    setSelection({ scope, folder, key })
  }
  function leaveRecord(event: MouseEvent<HTMLButtonElement>) {
    focusAfter.current = document.activeElement === event.currentTarget ? 'row' : null
    setSelection(null)
  }
  function chooseFolder(next: Folder) {
    focusAfter.current = null; setSelection(null); setFolder(next)
    if (body.current) body.current.scrollTop = 0
  }

  const {
    messages: hookUserMessages,
    hasMore,
    loadEarlier,
    refresh,
    error: historyError,
    observationError,
    windowFrozen
  } = useSessionUserMessages(effectiveControl, { enabled: open && visible })

  const effectiveUserMessages = propUserMessages ?? hookUserMessages

  const messages = useMemo(() => timeline?.items.filter((item) => item.agentSessionId === timeline.agentSessionId &&
    item.kind === 'user_message') ?? [], [timeline])
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
  const notices = useMemo(() => [...system.notices].sort((a, b) => latestFirst(a.observedAt, b.observedAt)), [system.notices])

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
    if (!open || !viewed) return
    if (folder === 'inbox' && receipts.unread.length) receipts.acknowledge(receipts.unread)
    if (folder === 'system' && system.unread.length) system.acknowledge(system.unread)
  }, [open, viewed, folder, receipts, system])
  const wanted = selection?.scope === scope && selection.folder === folder ? selection.key : null
  const selectedNotice = wanted && folder === 'system' ? notices.find(item => `notice:${item.id}:${serviceNoticeFingerprint(item)}` === wanted) : undefined
  const selectedQueue = wanted && folder === 'outbox' ? pending.find(item => `queue:${item.id}` === wanted) : undefined
  const selectedMessage = wanted ? (folder === 'inbox' ? incoming : folder === 'outbox' ? sent : []).find(item => messageKey(item) === wanted) : undefined
  const detail = Boolean(selectedNotice || selectedQueue || selectedMessage)
  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope
      const ownedFocus = document.activeElement === document.body && lastReadingFocus.current && !lastReadingFocus.current.isConnected
      positions.current = {}; lastReadingFocus.current = null; focusAfter.current = null
      if (body.current) body.current.scrollTop = 0
      if (selection) setSelection(null)
      if (ownedFocus) document.getElementById(`${id}-${folder}-tab`)?.focus({ preventScroll: true })
      return
    }
    if (selection && !detail) {
      if (document.activeElement === document.body && lastReadingFocus.current) focusAfter.current = 'row'
      setSelection(null)
    }
    if (!open) { focusAfter.current = null; return }
    const target = focusAfter.current
    focusAfter.current = null
    if (detail) {
      if (body.current) body.current.scrollTop = 0
      if (target === 'back') back.current?.focus({ preventScroll: true })
    } else if (target === 'row') {
      const saved = positions.current[folder]
      if (body.current && saved) body.current.scrollTop = saved.scroll
      const row = saved ? Array.from(body.current?.querySelectorAll<HTMLButtonElement>('button[data-record-key]') ?? []).find(row => row.dataset.recordKey === saved.key) : null
      ;(row ?? document.getElementById(`${id}-${folder}-tab`))?.focus({ preventScroll: true })
    }
  }, [open, detail, selection, scope, folder, id])
  useLayoutEffect(() => {
    if (!open) return
    const panel = popover.current!, editor = trigger.current!.closest<HTMLElement>('.composer')
    if (!editor) return
    const region = editor.closest<HTMLElement>('[data-workbench-region-id]') ?? editor
    const measure = () => {
      const c = editor.getBoundingClientRect(), r = region.getBoundingClientRect()
      if (c.width <= 0) return
      // The native CSS anchor is the whole editor; bound only this open surface to its actual available space.
      panel.style.maxWidth = `${Math.max(1, Math.min(380, r.width - 12))}px`
      panel.style.maxHeight = `${Math.max(1, Math.min(480, c.top - 12))}px`
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(editor); observer.observe(region)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [open])
  const mailboxLabel = `Mailbox: ${unread} unread, ${incoming.length} Agent messages, ${system.notices.length} notices, ${pending.length} pending${progressSession ? `. ${progressLabel}` : ''}`
  return <>
    <button ref={trigger} type="button" className="composer__mailbox" data-unread={unread > 0} data-progress-state={progressSession ? progressStatus : undefined}
      aria-label={mailboxLabel}
      title={mailboxLabel} popoverTarget={id} popoverTargetAction="toggle"
      onPointerEnter={enter} onPointerLeave={leave}
      onClick={(event) => { if (preview.current && open) { event.preventDefault(); pin() } }}>
      <Mail size={14} aria-hidden="true" />
      {progressSession && progressStatus !== 'inactive' ? <ProgressIcon size={9} className="composer-mailbox__progress" aria-hidden="true" /> : null}
      {pending.length ? <span aria-hidden="true">{pending.length}</span> : null}
      {unread ? <span className="composer-mailbox__unread" aria-hidden="true">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
    <div ref={popover} id={id} popover="auto" className="composer-mailbox" aria-label="Mailbox"
      data-state={open ? 'open' : 'closed'}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') { cancelClose(); setViewed(true) } }}
      onPointerLeave={leave} onPointerDownCapture={pin} onFocusCapture={event => { lastReadingFocus.current = event.target; pin() }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return
        event.preventDefault(); event.stopPropagation()
        popover.current!.hidePopover(); trigger.current!.focus({ preventScroll: true })
      }}
      onToggle={(event) => {
        const opening = event.newState === 'open'
        if (opening) { setFolder(openFolder()); if (!preview.current) setViewed(true) }
        else { cancelClose(); preview.current = false; setViewed(false); setSelection(null); focusAfter.current = null }
        setOpen(opening)
      }}>
      <div className="composer-mailbox__heading"><strong>Mailbox</strong>
        <button type="button" className="composer-tool" aria-label="Close mailbox" popoverTarget={id} popoverTargetAction="hide"
          onClick={() => trigger.current!.focus({ preventScroll: true })}><X size={14} /></button></div>
      <div className="composer-mailbox__folders" role="tablist" aria-label="Mailbox folders">
        {folders.map((name, index) => <button key={name} type="button"
          id={`${id}-${name}-tab`} role="tab" aria-controls={`${id}-${name}`} aria-selected={folder === name}
          tabIndex={folder === name ? 0 : -1} onClick={() => chooseFolder(name)}
          {...(name === 'progress' ? { 'aria-label': progressLabel, title: progressLabel } : {})}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = folders[event.key === 'Home' ? 0 : event.key === 'End' ? folders.length - 1 :
              (index + (event.key === 'ArrowRight' ? 1 : folders.length - 1)) % folders.length]!
            chooseFolder(next)
            document.getElementById(`${id}-${next}-tab`)?.focus()
          }}>
          {name === 'progress' ? 'Progress' : `${name[0]!.toUpperCase()}${name.slice(1)} (${counts[name]})`}
          {(name === 'inbox' && receipts.unread.length || name === 'system' && system.unread.length) ? <span className="composer-mailbox__dot" aria-hidden="true" /> : null}
        </button>)}
      </div>
      {detail ? <div className="composer-mailbox__back"><button ref={back} type="button" className="composer-tool" onClick={leaveRecord}>Back to {folder[0]!.toUpperCase() + folder.slice(1)}</button></div> : null}
      <div ref={body} className="composer-mailbox__content" onFocusCapture={event => { lastReadingFocus.current = event.target }}>
      <div id={`${id}-inbox`} role="tabpanel" aria-labelledby={`${id}-inbox-tab`} hidden={folder !== 'inbox'}>
        {open && folder === 'inbox' ? timeline ? <MessageHistory items={incoming} incoming selectedKey={detail ? wanted : null} onOpen={selectRecord} onCopy={onCopyQueued} /> : <p>Waiting for message history.</p> : null}
      </div>
      <div id={`${id}-outbox`} role="tabpanel" aria-labelledby={`${id}-outbox-tab`} hidden={folder !== 'outbox'}>
        {open && folder === 'outbox' ? <>
          {!selectedMessage && pending.length ? <ComposerOutbox queued={pending} selectedId={selectedQueue?.id ?? null}
            onSelect={(key, event) => selectRecord(`queue:${key}`, event)}
            {...(onRemoveQueued ? { onRemove: onRemoveQueued } : {})} {...(onMoveQueued ? { onMove: onMoveQueued } : {})}
            {...(onSendQueued ? { onSend: onSendQueued } : {})} {...(onCopyQueued ? { onCopy: onCopyQueued } : {})} /> : null}
          {!selectedQueue ? <section className="composer-mailbox__history" aria-label="Input history">
            {!selectedMessage ? <h3>History</h3> : null}
            {historyError && !historyError.message.includes('unavailable in the web preview') ? <div className="composer-mailbox__error" data-kind="error">
              <strong>Failed to read native conversation history</strong><p>{historyError.message}</p>
              <button type="button" className="composer-tool" onClick={() => void refresh()}>Retry</button>
            </div> : null}
            {observationError ? <div className="composer-mailbox__error" data-kind="error">
              <strong>Automatic native updates are unavailable</strong><p>{observationError.message} Existing messages are kept.</p>
              <button type="button" className="composer-tool" onClick={() => void refresh()}>Refresh source</button>
            </div> : null}
            {windowFrozen ? <div className="composer-mailbox__boundary">
              <span>The native source changed. This bounded reading window is kept.</span>
              <button type="button" className="composer-tool" onClick={() => void refresh()}>Read latest records</button>
            </div> : null}
            <MessageHistory items={sent} incoming={false} selectedKey={detail ? wanted : null} onOpen={selectRecord} onCopy={onCopyQueued} />
            {!selectedMessage && hasMore ? <div className="composer-mailbox__boundary"><span>Earlier native messages available.</span>
              <button type="button" className="composer-tool" onClick={() => void loadEarlier()}>Load earlier messages</button></div> : null}
          </section> : null}
        </> : null}
      </div>
      <div id={`${id}-system`} role="tabpanel" aria-labelledby={`${id}-system-tab`} hidden={folder !== 'system'}>
        {open && folder === 'system' ? selectedNotice ? <article className="composer-mailbox__detail composer-notice" data-kind={selectedNotice.notice.kind}>
          <div className="composer-notice__body"><ServiceWindowNotice notice={selectedNotice.notice} />
            <MailboxTime value={selectedNotice.observedAt} complete />
            {selectedNotice.id === 'queue' ? <button type="button" className="composer-tool" onClick={() => chooseFolder('outbox')}>View outbox</button> : null}
            {selectedNotice.action ? <button type="button" className="composer-tool" onClick={selectedNotice.action.run}>{selectedNotice.action.label}</button> : null}
          </div>
        </article> : notices.length ? <ol className="composer-mailbox__messages" aria-label="Current service notices">
          {notices.map(item => <li key={item.id} className="composer-notice" data-kind={item.notice.kind}><MailboxRecordRow
            recordKey={`notice:${item.id}:${serviceNoticeFingerprint(item)}`} label={item.notice.notice.step}
            text={item.notice.notice.mode.slice(0,240)}
            metadata={<><span>{item.notice.kind === 'indeterminate' ? 'Status unknown' : 'Current service notice'}</span><MailboxTime value={item.observedAt} />
              <span className="composer-mailbox__notice-restore">{item.notice.notice.restore.slice(0,240)}</span>
              {item.action ? <span>Action: {item.action.label}</span> : null}</>}
            onOpen={selectRecord} /></li>)}
        </ol> : <p>{system.available ? 'No current notices.' : 'Waiting for Session status.'}</p> : null}
      </div>
      {progressSession ? <div id={`${id}-progress`} role="tabpanel" aria-labelledby={`${id}-progress-tab`} hidden={folder !== 'progress'}>
        <ContinuousProgressControl session={progressSession} onStatusChange={onProgressStatus} />
      </div> : null}
      </div>
    </div>
  </>
}
