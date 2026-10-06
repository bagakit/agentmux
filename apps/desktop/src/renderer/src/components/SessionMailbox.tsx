import { MailboxLocationContext } from './MailboxLocationContext'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { SessionSnapshot } from '../../../shared/contracts'
import { ContinuousProgressControl, type ContinuousProgressStatus } from './ContinuousProgressControl'
import { ComposerPendingDelivery } from './ComposerPendingDelivery'
import { useMailboxMotion } from './use-mailbox-motion'
import type { EditQueuedMessage } from './ComposerQueuedMessageEditor'
import { ComposerOutbox, type ComposerQueuedMessage, type ArchiveQueuedMessage, type MoveQueuedMessageToDraft } from './ComposerOutbox'
import { useAppStore } from '../store'
import { serviceNoticeFingerprint, useReadReceipts, type useServiceNotices } from '../lib/use-service-notices'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { AgentSessionControl } from '../../../shared/contracts'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { MailboxEmpty, MailboxRecordRow, MailboxTime } from './MailboxReading'
import { ConversationMessage, type ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import type { ConversationHistoryResourceReader } from '@agentmux/client-ui/components/ConversationResourceImage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { speakerOf } from '../lib/conversation-speaker'
import type { ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { RevealMailboxMessage } from '../lib/mailbox-message-navigation'
import { mailboxMessages, mailboxMessageIsIncoming, mailboxMessageKey as messageKey, isMailboxUserMessage as isUserMessage, type MailboxDisplayItem } from '../lib/session-mailbox-messages'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectInboxIcon = semanticIconComponent('object.inbox')
const ThemeActionSendIcon = semanticIconComponent('action.send')
const ThemeObjectNotificationsIcon = semanticIconComponent('object.notifications')
const ThemeActionRepeatIcon = semanticIconComponent('action.repeat')
const ThemeActionPauseIcon = semanticIconComponent('action.pause')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')
const ThemeObjectMailIcon = semanticIconComponent('object.mail')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')


type Folder = 'inbox' | 'outbox' | 'system' | 'progress'
const FOLDERS: readonly Folder[] = ['inbox', 'outbox', 'system']

function latestFirst(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return b - a
}

function useMessageFingerprints(items: readonly MailboxDisplayItem[]) {
  // Activity-only revisions must not rehash unchanged mail or hide its unread state.
  const signature = useMemo(() => JSON.stringify(items.map((item) => {
    if (isUserMessage(item)) {
      return [item.source.kind === 'captured' ? item.source.submissionId : item.id, item.author.kind === 'agent' ? item.author.agentSessionId : undefined, item.content, item.recordedAt, item.deliveryStatus]
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

function MessageHistory({ mailboxOrigin, items, incoming, selectedKey, onOpen, onCopy, reading, sessionId, renderNavigation, historyResourceReader }: {
  mailboxOrigin?: OpenHttpLinkOrigin | undefined
  items: readonly MailboxDisplayItem[]; incoming: boolean; selectedKey: string | null
  onOpen: (key: string, event: MouseEvent<HTMLButtonElement>) => void
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  reading?: ConversationReadingProps | undefined; sessionId?: string | undefined
  historyResourceReader?: ConversationHistoryResourceReader | undefined
  renderNavigation: (item: MailboxDisplayItem) => ReactNode
}) {
  // Only the current reading page mounts. Rows read bounded prefixes, never full Markdown.
  const sessions = useAppStore(state => state.sessions)
  const names = useAppStore(state => state.agentNames)
  const recent = useMemo(() => [...items].sort((a, b) => latestFirst(
    isUserMessage(a) ? a.recordedAt : a.createdAt, isUserMessage(b) ? b.recordedAt : b.createdAt)), [items])
  const authorLabel = (item: MailboxDisplayItem) => {
    const author = isUserMessage(item) ? item.author.kind === 'agent' ? item.author.agentSessionId : undefined : item.authorAgentSessionId
    return author ? reading?.describeSpeaker?.({ role: 'agent', id: author }).name || names?.[author] || sessions.find(s => s.id === author)?.label || `Agent ${author.slice(0, 8)}`
      : (isUserMessage(item) ? item.author.kind === 'human' : item.authorHuman === true) ? 'Human' : 'Author unknown'
  }
  const time = (item: MailboxDisplayItem) => isUserMessage(item) ? item.recordedAt : item.createdAt
  const state = (item: MailboxDisplayItem) => isUserMessage(item) ? item.deliveryStatus : item.status
  const selected = selectedKey ? recent.find(item => messageKey(item) === selectedKey) : undefined
  if (selected) return <MailboxLocationContext origin={mailboxOrigin} sessionId={sessionId}>{(locationSummary, locationDetails) => <article className="composer-mailbox__detail" data-record-key={messageKey(selected)}>
    {locationSummary}
    <ConversationMessage {...reading} compact recordedIdentity {...(sessionId ? { conversationSessionId: sessionId } : {})}
      messageId={messageKey(selected)} speaker={speakerOf(selected) as ConversationSpeaker} name={authorLabel(selected)}
      content={isUserMessage(selected) && selected.contentParts.length > 0 ? selected.contentParts : selected.content ?? ''}
      {...(isUserMessage(selected) && selected.source.kind === 'native' && selected.contentParts.length > 0
        ? {} : { copyText: selected.content ?? '' })}
      {...(time(selected) === undefined ? {} : { createdAt: time(selected)! })}
      {...(isUserMessage(selected) ? { inputSource: selected.source } : {})}
      {...(isUserMessage(selected) && selected.source.kind === 'native' ? { nativeResourceRecord: { source: { providerId: selected.source.providerId, nativeSessionId: selected.source.nativeSessionId }, recordId: selected.source.recordId, ...(selected.turnId ? { turnId: selected.turnId } : {}) }, ...(historyResourceReader ? { readHistoryResource: historyResourceReader } : {}) } : {})}
      {...(onCopy ? { onCopy } : {})}
      messageActions={renderNavigation(selected)}
      messageDetails={<><dl className="composer-mailbox__record-facts">
        {!isUserMessage(selected) ? <><dt>Source</dt><dd>Captured input</dd><dt>Recorded author</dt><dd>{authorLabel(selected)}</dd></> : null}
        <dt>Time</dt><dd><MailboxTime value={time(selected)} complete /></dd>
        <dt>Delivery</dt><dd>{isUserMessage(selected) && selected.source.kind === 'native' ? 'Recorded · not a delivery receipt' : state(selected) === 'complete' ? 'Submission confirmed · CLI acceptance and reply are separate' : 'Delivery not confirmed'}</dd>
      </dl>{locationDetails}</>} />
    {!selected.content && !(isUserMessage(selected) && selected.contentParts.length) ? <MailboxEmpty title="No text recorded" /> : null}
    {state(selected) !== 'complete' && !(isUserMessage(selected) && selected.source.kind === 'native')
      ? <p className="composer-mailbox__risk">Delivery not confirmed. Check the Agent’s response before sending again.</p> : null}
  </article>}</MailboxLocationContext>
  return recent.length ? <ol className="composer-mailbox__messages" aria-label={incoming ? 'Recent Agent messages' : 'Recent outgoing messages'}>
    {recent.map(item => <li key={messageKey(item)}><MailboxRecordRow recordKey={messageKey(item)} label={authorLabel(item)} text={item.content}
      avatar={<ConversationSpeakerAvatar speaker={speakerOf(item) as ConversationSpeaker} name={authorLabel(item)} size={18}
        {...(reading?.describeSpeaker?.(speakerOf(item) as ConversationSpeaker).providerId ? { providerId: reading.describeSpeaker(speakerOf(item) as ConversationSpeaker).providerId! } : {})} />}
      metadata={<>{time(item) === undefined ? null : <MailboxTime value={time(item)} />}
        {state(item) !== 'complete' && !(isUserMessage(item) && item.source.kind === 'native') ? <span className="composer-mailbox__risk">Delivery not confirmed</span> : null}</>}
      onOpen={onOpen} /><div className="composer-mailbox__record-actions">{renderNavigation(item)}</div></li>)}
  </ol> : <MailboxEmpty title={incoming ? 'No Agent messages' : 'No recorded messages'} />
}

function SourceNotice({ title, message, action, onAction }: { title: string; message: string; action: string; onAction(): void }) {
  return <div className="composer-mailbox__source-notice"><details><summary>{title}</summary><p>{message}</p><p>Existing records are kept. {action} to read this same source again.</p></details>
    <button type="button" className="composer-tool" onClick={onAction} title={action} aria-label={action}><ThemeActionRefreshIcon size={14} aria-hidden="true" /></button></div>
}

/** Folders project durable delivery facts; read receipts never advance delivery state. */
export function SessionMailbox({ system, queued, timeline, progressSession, visible = true, control: propControl, userMessages: propUserMessages, onArchiveQueued, onMoveQueuedToDraft, onMoveQueued, onSendQueued, onCancelQueuedPreparation, onCopyQueued, onEditQueued, sendImmediately = false, reading, onRevealMessage, mailboxOrigin, children, pendingInteraction = false, noticePresentation, inputHistory, historyResourceReader, onHistoryVisible }: {
  children?: (mailbox: ReactNode, pending: ReactNode) => ReactNode
  /** Presentation of an existing notice, shared by this mailbox and its right dock. */
  noticePresentation?: { id: string; content: ReactNode } | undefined
  pendingInteraction?: boolean
  inputHistory?: (readMessage: (message: AgentSessionUserMessage) => ReactNode) => ReactNode
  historyResourceReader?: ConversationHistoryResourceReader
  onHistoryVisible?(visible: boolean): void
  onRevealMessage?: RevealMailboxMessage | undefined
  mailboxOrigin?: OpenHttpLinkOrigin | undefined
  reading?: ConversationReadingProps | undefined
  system: ReturnType<typeof useServiceNotices>
  queued: readonly ComposerQueuedMessage[]
  timeline?: AgentTimelineSnapshot | undefined
  progressSession?: Extract<SessionSnapshot, { kind: 'agent' }> | undefined
  visible?: boolean
  control?: AgentSessionControl | undefined
  userMessages?: readonly AgentSessionUserMessage[] | undefined
  onMoveQueuedToDraft?: MoveQueuedMessageToDraft | undefined
  onArchiveQueued?: ArchiveQueuedMessage | undefined
  onMoveQueued?: (id: string, direction: 'up' | 'down') => void
  onSendQueued?: (id: string) => void
  onCancelQueuedPreparation?: ((id: string) => void) | undefined
  onCopyQueued?: (text: string) => Promise<boolean>
  onEditQueued?: EditQueuedMessage
  sendImmediately?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [viewed, setViewed] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLElement>(null)
  const requestedFolder = useRef<Folder | null>(null)
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
  useEffect(() => { onHistoryVisible?.(open && visible && folder === 'outbox'); return () => onHistoryVisible?.(false) },
    [open, visible, folder, onHistoryVisible])
  const folders: readonly Folder[] = progressSession ? [...FOLDERS, 'progress'] : FOLDERS
  const folderLabels = { inbox: 'Inbox', outbox: 'Outbox', system: 'Notices', progress: 'Progress' }
  const folderIcons = { inbox: ThemeObjectInboxIcon, outbox: ThemeActionSendIcon, system: ThemeObjectNotificationsIcon, progress: ThemeActionRepeatIcon }
  const progressTarget = progressSession ? JSON.stringify([progressSession.hostId, progressSession.id, progressSession.providerId, progressSession.workspacePath]) : ''
  const [progress, setProgress] = useState<{ target: string; status: ContinuousProgressStatus }>()
  const onProgressStatus = useCallback((status: ContinuousProgressStatus) => setProgress({ target: progressTarget, status }), [progressTarget])
  const progressStatus = progress?.target === progressTarget ? progress.status : 'unconfirmed'
  const progressLabel = `Continuous progress: ${progressStatus}${progressStatus === 'inactive' ? ' (not enabled)' : ''}`
  const ProgressIcon = progressStatus === 'active' ? ThemeActionRepeatIcon : progressStatus === 'paused' ? ThemeActionPauseIcon : ThemeStatusUnknownIcon

  const storeSession = useAppStore((state) =>
    state.sessions.find(
      (s) => s.id === (propControl?.agentSessionId ?? timeline?.agentSessionId)
    )
  )
  const effectiveControl: AgentSessionControl | undefined =
    propControl ?? (storeSession?.kind === 'agent' ? storeSession.control : undefined)

  const scope = JSON.stringify([effectiveControl?.hostId, effectiveControl?.agentSessionId, effectiveControl?.run.runId, timeline?.agentSessionId])
  const previousScope = useRef(scope)
  const navigationGeneration = useRef(0)
  const [navigationFeedback, setNavigationFeedback] = useState<{ scope: string; key: string; message: string } | null>(null)
  useEffect(() => { ++navigationGeneration.current; setNavigationFeedback(null) }, [scope])
  function renderNavigation(item: MailboxDisplayItem) {
    const key = messageKey(item)
    const feedback = !onRevealMessage ? '当前显示宿主关系未确认，无法定位。原文仍可阅读和复制。'
      : navigationFeedback?.scope === scope && navigationFeedback.key === key ? navigationFeedback.message : null
    return <><button type="button" className="composer-mailbox__reveal" disabled={!onRevealMessage}
      onClick={async () => {
        if (!onRevealMessage) return
        const action = ++navigationGeneration.current
        const message = isUserMessage(item) ? item : projectSessionUserMessages({ agentSessionId: item.agentSessionId,
          timeline: { agentSessionId: item.agentSessionId, revision: 0, items: [item] } })[0]
        if (!message) { setNavigationFeedback({ scope, key, message: '记录关系未确认，无法定位。原文仍可阅读和复制。' }); return }
        setNavigationFeedback(null)
        const result = await onRevealMessage(message)
        if (action !== navigationGeneration.current) return
        if (result.kind === 'located') popover.current?.hidePopover()
        else if (result.kind === 'unavailable') setNavigationFeedback({ scope, key, message: result.message })
      }}>在对话中查看</button>{feedback ? <span className="composer-mailbox__navigation-feedback" role="status">{feedback}</span> : null}</>
  }
  const [selection, setSelection] = useState<{ scope: string; folder: Folder; key: string } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const explicitOutboxReveal = useRef<{ scope: string; operationId: string } | null>(null)
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

  const effectiveUserMessages = inputHistory && folder === 'inbox' ? hookUserMessages : propUserMessages ?? hookUserMessages

  const mailboxSessionId = effectiveControl?.agentSessionId ?? timeline?.agentSessionId
  const messages = useMemo(() => timeline && timeline.agentSessionId === mailboxSessionId ? timeline.items.filter((item) => item.agentSessionId === mailboxSessionId &&
    item.kind === 'user_message') : [], [timeline,mailboxSessionId])
  const displayedMessages = useMemo(() => mailboxMessages(mailboxSessionId,timeline,effectiveUserMessages), [mailboxSessionId,timeline,effectiveUserMessages])
  const incoming = useMemo(() => displayedMessages.filter(mailboxMessageIsIncoming), [displayedMessages])
  const sent = useMemo(() => displayedMessages.filter(item => !mailboxMessageIsIncoming(item)), [displayedMessages])

  const fingerprints = useMessageFingerprints(incoming)
  const receipts = useReadReceipts(`mail:${mailboxSessionId ?? ''}`, fingerprints ?? {},
    Boolean(mailboxSessionId) && (timeline !== undefined || propUserMessages !== undefined || effectiveUserMessages.length > 0) && fingerprints !== undefined)
  const unread = receipts.unread.length
  const notices = useMemo(() => [...system.notices].sort((a, b) => latestFirst(a.observedAt, b.observedAt)), [system.notices])

  const deliveredIds = useMemo(() => {
    return new Set(messages.filter((item) => item.status === 'complete').map((item) => item.id))
  }, [messages])

  const pending = queued.filter((item) => !item.archived && (item.inputControlled || !deliveredIds.has(item.id) && !deliveredIds.has(`prompt:${item.id}`)))
  const archived = queued.filter(item => item.archived).map(item => ({...item,confirmed: item.confirmed || !item.inputControlled && deliveredIds.has(`prompt:${item.id}`)}))
  const counts = { inbox: incoming.length, outbox: pending.length + archived.length + sent.length, system: system.notices.length }
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
  const selectedQueue = wanted && folder === 'outbox' ? [...pending,...archived].find(item => `queue:${item.id}` === wanted) : undefined
  const selectedMessage = wanted ? (folder === 'inbox' ? incoming : folder === 'outbox' ? sent : []).find(item => messageKey(item) === wanted) : undefined
  const detail = Boolean(selectedNotice || selectedMessage)
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
    if (selection && !detail && !selectedQueue) {
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
  }, [open, detail, selectedQueue, selection, scope, folder, id])
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
  const motion = useMailboxMotion(popover, dock, open, visible, scope)
  const readingMounted = open || motion.retaining
  // Retain the original reading DOM through exit paint so its native anchor baseline
  // cannot jump; native closed/inert state and delivery facts already apply immediately.
  useEffect(() => { if (!readingMounted) setSelection(null) }, [readingMounted])
  useLayoutEffect(() => {
    const intent = explicitOutboxReveal.current
    if (!intent) return
    if (intent.scope !== scope) { explicitOutboxReveal.current = null; return }
    if (!open || folder !== 'outbox') return
    explicitOutboxReveal.current = null
    const row = Array.from(body.current?.querySelectorAll<HTMLElement>('.composer-mailbox__row[data-record-key]') ?? [])
      .find(node => node.dataset.recordKey === `queue:${intent.operationId}`)
    row?.closest<HTMLElement>('li[data-operation-id]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [open, folder, scope, selection])
  const mailboxLabel = `Mailbox: Inbox ${unread} unread, Outbox ${pending.length} pending, Notices ${system.unread.length} need attention${progressSession ? `. ${progressLabel}` : ''}`
  function showOutbox(operationId: string) {
    motion.captureSource(Array.from(dock.current?.querySelectorAll<HTMLElement>('[data-operation-id]') ?? []).find(node => node.dataset.operationId === operationId))
    explicitOutboxReveal.current = { scope, operationId }
    requestedFolder.current = 'outbox'
    pin(); chooseFolder('outbox')
    setSelection({ scope, folder: 'outbox', key: `queue:${operationId}` })
    if (open) { requestedFolder.current = null; return }
    ;(popover.current!.showPopover as (options: { source: HTMLButtonElement }) => void)
      .call(popover.current, { source: trigger.current! })
  }
  const mailbox = <>
    <button ref={trigger} type="button" className="composer__mailbox" data-unread={unread > 0} data-progress-state={progressSession ? progressStatus : undefined}
      aria-label={mailboxLabel}
      title={mailboxLabel} popoverTarget={id} popoverTargetAction="toggle"
      onPointerEnter={enter} onPointerLeave={leave}
      onClick={(event) => { if (preview.current && open) { event.preventDefault(); pin() } }}>
      <ThemeObjectMailIcon size={14} aria-hidden="true" />
      {progressSession && progressStatus !== 'inactive' ? <ProgressIcon size={10} className="composer-mailbox__progress" aria-hidden="true" /> : null}
      {system.unread.length ? <ThemeObjectNotificationsIcon size={10} className="composer-mailbox__attention" aria-hidden="true" /> : null}
      {unread ? <span className="composer-mailbox__inbox-count" aria-hidden="true">
        <span className="composer-mailbox__unread">{unread > 99 ? '99+' : unread}</span>
      </span> : null}
    </button>
    <div ref={popover} id={id} popover="auto" className="composer-mailbox" aria-label="Mailbox"
      data-state={open ? 'open' : 'closed'} inert={!open}
      onBeforeToggle={event => {
        if (event.target !== event.currentTarget) return
        event.currentTarget.inert = event.newState !== 'open'
        motion.beforeToggle(event.newState)
      }}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') { cancelClose(); setViewed(true) } }}
      onPointerLeave={leave} onPointerDownCapture={pin} onFocusCapture={event => { lastReadingFocus.current = event.target; pin() }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return
        event.preventDefault(); event.stopPropagation()
        popover.current!.hidePopover(); trigger.current!.focus({ preventScroll: true })
      }}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return
        const opening = event.newState === 'open'
        if (opening) { setFolder(requestedFolder.current ?? openFolder()); requestedFolder.current = null; if (!preview.current) setViewed(true) }
        else { cancelClose(); preview.current = false; setViewed(false); focusAfter.current = null }
        setOpen(opening)
        motion.afterToggle(event.newState)
      }}>
      <div className="composer-mailbox__heading"><strong>Mailbox</strong>
        <button type="button" className="composer-tool" aria-label="Close mailbox" popoverTarget={id} popoverTargetAction="hide"
          onClick={() => trigger.current!.focus({ preventScroll: true })}><ThemeActionCloseIcon size={14} /></button></div>
      <div className="composer-mailbox__folders" role="tablist" aria-label="Mailbox folders">
        {folders.map((name, index) => { const Icon = folderIcons[name], count = name === 'inbox' ? receipts.unread.length : name === 'system' ? system.unread.length : name === 'outbox' ? pending.length : 0
          const label = name === 'progress' ? progressLabel : `${folderLabels[name]}: ${count} ${name === 'outbox' ? 'pending' : 'unread'}`
          return <button key={name} type="button" className={name === 'progress' ? 'composer-mailbox__progress-tab' : undefined} title={label} aria-label={label}
          id={`${id}-${name}-tab`} role="tab" aria-controls={`${id}-${name}`} aria-selected={folder === name}
          tabIndex={folder === name ? 0 : -1} onClick={() => chooseFolder(name)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = folders[event.key === 'Home' ? 0 : event.key === 'End' ? folders.length - 1 :
              (index + (event.key === 'ArrowRight' ? 1 : folders.length - 1)) % folders.length]!
            chooseFolder(next)
            document.getElementById(`${id}-${next}-tab`)?.focus()
          }}>
          <Icon size={13} aria-hidden="true" />{folderLabels[name]}{count ? <span className="composer-mailbox__count" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
        </button>})}
      </div>
      {detail ? <div className="composer-mailbox__back"><button ref={back} type="button" className="composer-tool" onClick={leaveRecord}><ThemeNavigationBackIcon size={14} aria-hidden="true" />Back to {folderLabels[folder]}</button></div> : null}
      <div ref={body} className="composer-mailbox__content" onFocusCapture={event => { lastReadingFocus.current = event.target }}>
      <div id={`${id}-inbox`} role="tabpanel" aria-labelledby={`${id}-inbox-tab`} hidden={folder !== 'inbox'}>
        {readingMounted && folder === 'inbox' ? mailboxSessionId && (timeline || propUserMessages || incoming.length) ? <MessageHistory mailboxOrigin={mailboxOrigin} items={incoming} incoming selectedKey={detail ? wanted : null} onOpen={selectRecord} onCopy={onCopyQueued} reading={reading} sessionId={effectiveControl?.agentSessionId ?? timeline?.agentSessionId} renderNavigation={renderNavigation} /> : <MailboxEmpty title="Waiting for message history" /> : null}
      </div>
      <div id={`${id}-outbox`} role="tabpanel" aria-labelledby={`${id}-outbox-tab`} hidden={folder !== 'outbox'}>
        {readingMounted && folder === 'outbox' ? <>
          {!selectedMessage && pending.length ? <ComposerOutbox sessionId={effectiveControl?.agentSessionId ?? timeline?.agentSessionId} queued={pending} pendingInteraction={pendingInteraction} onCancelPreparation={onCancelQueuedPreparation} selectedId={selectedQueue?.id ?? null}
            onSelect={(key) => { focusAfter.current=null; setSelection({scope,folder:'outbox',key:`queue:${key}`}) }} reading={reading}
            {...(onArchiveQueued ? { onArchive: onArchiveQueued } : {})} {...(onMoveQueued ? { onMove: onMoveQueued } : {})}
            {...(onMoveQueuedToDraft ? { onMoveToDraft: onMoveQueuedToDraft } : {})} {...(onEditQueued ? { onEdit: onEditQueued } : {})} sendImmediately={sendImmediately} {...(onSendQueued ? { onSend: onSendQueued } : {})} {...(onCopyQueued ? { onCopy: onCopyQueued } : {})} /> : null}
          {!selectedMessage && archived.length ? <ComposerOutbox sessionId={mailboxSessionId} queued={archived} selectedId={selectedQueue?.id ?? null}
            onSelect={(key) => { focusAfter.current=null; setSelection({scope,folder:'outbox',key:`queue:${key}`}) }} reading={reading}
            {...(onArchiveQueued ? {onArchive:onArchiveQueued} : {})} {...(onCopyQueued ? {onCopy:onCopyQueued} : {})}
            onHistory={operationId => {
              const original=sent.find(item => !isUserMessage(item) && item.agentSessionId===mailboxSessionId && item.id===`prompt:${operationId}` && item.status==='complete')
              if (original) setSelection({scope,folder:'outbox',key:messageKey(original)})
            }} /> : null}
          <section className="composer-mailbox__history" aria-label="Input history">
            {!selectedMessage ? <h3>History</h3> : null}
            {inputHistory && !selectedMessage && observationError ? <SourceNotice title="Automatic native updates are unavailable" message={observationError.message} action="Refresh source" onAction={() => void refresh()} /> : null}
            {inputHistory && !selectedMessage && windowFrozen ? <SourceNotice title="The native source changed" message="This reading window is kept." action="Read latest records" onAction={() => void refresh()} /> : null}
            {inputHistory && !selectedMessage ? inputHistory(message => <MessageHistory mailboxOrigin={mailboxOrigin} items={[message]} incoming={false} selectedKey={messageKey(message)} onOpen={selectRecord} onCopy={onCopyQueued} reading={reading} sessionId={mailboxSessionId} renderNavigation={renderNavigation} historyResourceReader={historyResourceReader} />) : <>
            {historyError && !historyError.message.includes('unavailable in the web preview') ? <SourceNotice title="Failed to read native conversation history" message={historyError.message} action="Retry" onAction={() => void refresh()} /> : null}
            {observationError ? <SourceNotice title="Automatic native updates are unavailable" message={observationError.message} action="Refresh source" onAction={() => void refresh()} /> : null}
            {windowFrozen ? <SourceNotice title="The native source changed" message="This bounded reading window is kept." action="Read latest records" onAction={() => void refresh()} /> : null}
            <MessageHistory mailboxOrigin={mailboxOrigin} items={sent} incoming={false} selectedKey={detail ? wanted : null} onOpen={selectRecord} onCopy={onCopyQueued} reading={reading} sessionId={effectiveControl?.agentSessionId ?? timeline?.agentSessionId} renderNavigation={renderNavigation} />
            {!selectedMessage && hasMore ? <div className="composer-mailbox__boundary"><span>Earlier native messages available.</span>
              <button type="button" className="composer-tool" onClick={() => void loadEarlier()}>Load earlier messages</button></div> : null}
            </>}
          </section>
        </> : null}
      </div>
      <div id={`${id}-system`} role="tabpanel" aria-labelledby={`${id}-system-tab`} hidden={folder !== 'system'}>
        {readingMounted && folder === 'system' ? selectedNotice ? <article className="composer-mailbox__detail composer-notice" data-kind={selectedNotice.notice.kind}>
          <div className="composer-notice__body">{noticePresentation?.id === selectedNotice.id ? noticePresentation.content : <><ServiceWindowNotice notice={selectedNotice.notice} />
            <MailboxTime value={selectedNotice.observedAt} complete />
            {selectedNotice.id === 'queue' ? <button type="button" className="composer-tool" onClick={() => chooseFolder('outbox')}>View outbox</button> : null}
            {selectedNotice.action ? <button type="button" className="composer-tool" onClick={selectedNotice.action.run}>{selectedNotice.action.label}</button> : null}</>}
          </div>
        </article> : notices.length ? <ol className="composer-mailbox__messages" aria-label="Current service notices">
          {notices.map(item => <li key={item.id} className="composer-notice" data-kind={item.notice.kind}><MailboxRecordRow
            recordKey={`notice:${item.id}:${serviceNoticeFingerprint(item)}`} label={(item.summary ?? item.notice.notice).step}
            text={(item.summary ?? item.notice.notice).mode.slice(0,240)}
            metadata={<><span>{item.notice.kind === 'indeterminate' ? 'Status unknown' : 'Service notice'}</span>{item.observedAt === undefined ? null : <MailboxTime value={item.observedAt} />}</>}
            onOpen={selectRecord} /></li>)}
        </ol> : <MailboxEmpty title={system.available ? 'No current notices' : 'Waiting for Session status'} /> : null}
      </div>
      {progressSession ? <div id={`${id}-progress`} role="tabpanel" aria-labelledby={`${id}-progress-tab`} hidden={folder !== 'progress'}>
        <ContinuousProgressControl session={progressSession} onStatusChange={onProgressStatus} />
      </div> : null}
      </div>
    </div>
  </>
  return children ? children(mailbox, visible ? <ComposerPendingDelivery surfaceRef={dock} returning={!open && motion.retaining} notice={noticePresentation?.content} suppressed={open} anchorRef={trigger} queued={pending} pendingInteraction={pendingInteraction} onSend={onSendQueued} onCancelPreparation={onCancelQueuedPreparation} onCopy={onCopyQueued} onEdit={onEditQueued} onArchive={onArchiveQueued} onMoveToDraft={onMoveQueuedToDraft} sendImmediately={sendImmediately} onMore={showOutbox} /> : null) : mailbox
}
