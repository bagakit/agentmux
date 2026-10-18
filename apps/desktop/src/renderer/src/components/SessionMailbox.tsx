import { api } from '../lib/api'
import { inputMailboxKey, inputMailboxItemKey, useAgentInputMailbox } from '@agentmux/client-ui/use-agent-input-mailbox'
import { InputMailboxRecords, inputMailboxPresentation, type InputMailboxDisplayRow } from '@agentmux/client-ui/components/InputMailboxRecords'
import { getModalOverlayContainer, ModalAttachmentDismissal } from '@agentmux/client-ui/components/Modal'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { MailboxLocationContext } from './MailboxLocationContext'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import { InputHistoryList } from '@agentmux/client-ui/components/InputHistoryList'
import { describeConversationInputSource } from '@agentmux/client-ui/conversation-input-source'
import type { useComposerInputHistory } from '../lib/use-composer-input-history'
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
import { useSessionMessages } from '../lib/use-session-messages'
import { MailboxA2A } from './MailboxA2A'
import { useMailboxNotifications } from '../lib/use-mailbox-notifications'
import { MailboxWorkspaceNavigation, isAgentMessageFolder, type MailboxFolder as Folder, type AgentMessageFolder } from './MailboxWorkspaceNavigation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import type { AgentSessionControl } from '../../../shared/contracts'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { MailboxCopyAction, MailboxDraftAction, MailboxEmpty, MailboxRecordRow, MailboxTime, MailboxSourceNotice as SourceNotice } from './MailboxReading'
import { MailboxCollaboration } from './MailboxCollaboration'
import { ConversationMessage, type ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import type { ConversationHistoryResourceReader } from '@agentmux/client-ui/components/ConversationResourceImage'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { speakerOf } from '../lib/conversation-speaker'
import type { ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'
import type { RevealMailboxMessage } from '../lib/mailbox-message-navigation'
import { mailboxMessages, mailboxMessageKey as messageKey, isMailboxUserMessage as isUserMessage, type MailboxDisplayItem } from '../lib/session-mailbox-messages'

const ThemeObjectNotificationsIcon = semanticIconComponent('object.notifications')
const ThemeActionRepeatIcon = semanticIconComponent('action.repeat')
const ThemeObjectAutomationIcon = semanticIconComponent('object.automation')
const ThemeActionPauseIcon = semanticIconComponent('action.pause')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')
const ThemeObjectMailIcon = semanticIconComponent('object.mail')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const RevealIcon = semanticIconComponent('action.open-external')


type MailboxSelection = { scope: string; folder: Folder; key: string }

function latestFirst(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return b - a
}


function MessageHistory({ mailboxOrigin, items, selectedKey, onOpen, onCopy, reading, sessionId, renderNavigation, historyResourceReader, queuedRecords = [], renderQueueRecord, additionalRecords = [] }: {
  mailboxOrigin?: OpenHttpLinkOrigin | undefined
  items: readonly MailboxDisplayItem[]; selectedKey: string | null
  onOpen: (key: string, event: MouseEvent<HTMLButtonElement>) => void
  onCopy?: ((text: string) => Promise<boolean>) | undefined
  reading?: ConversationReadingProps | undefined; sessionId?: string | undefined
  historyResourceReader?: ConversationHistoryResourceReader | undefined
  renderNavigation: (item: MailboxDisplayItem, detail?: boolean) => ReactNode
  additionalRecords?: readonly InputMailboxDisplayRow[]
  queuedRecords?: readonly ComposerQueuedMessage[]
  renderQueueRecord?: (entry: ComposerQueuedMessage) => ReactNode
}) {
  // Only the current reading page mounts. Rows read bounded prefixes, never full Markdown.
  const recent = useMemo(() => [...items].sort((a, b) => latestFirst(
    a.message.recordedAt, b.message.recordedAt)), [items])
  const identities = useMemo(() => {
    const result = new Map<string, { speaker: ConversationSpeaker; name: string; avatar: ReactNode }>()
    for (const { message } of recent) {
      const speaker = speakerOf(message) as ConversationSpeaker
      const key = `${speaker.role}:${speaker.id}`
      if (result.has(key)) continue
      const described = speaker.role === 'agent' ? reading?.describeSpeaker?.(speaker, 18) : undefined
      const name = described?.name || (message.author.kind === 'agent' ? `Agent ${message.author.agentSessionId.slice(0, 8)}`
        : message.author.kind === 'external' ? `${message.author.actor.userId} · ${message.author.actor.application.domain}`
        : message.author.kind === 'human' ? 'Human' : 'Author unknown')
      result.set(key, { speaker, name, avatar: described?.avatar ?? <ConversationMessageAvatar speaker={speaker} name={name}
        size={18} providerId={described?.providerId} project={described?.project} /> })
    }
    return result
  }, [recent, reading?.describeSpeaker])
  const identity = (item: MailboxDisplayItem) => {
    const speaker = speakerOf(item.message) as ConversationSpeaker
    return identities.get(`${speaker.role}:${speaker.id}`)!
  }
  const authorLabel = (item: MailboxDisplayItem) => identity(item).name
  const time = (item: MailboxDisplayItem) => item.message.recordedAt
  const state = (item: MailboxDisplayItem) => item.message.deliveryStatus
  const selected = selectedKey ? recent.find(item => messageKey(item) === selectedKey) : undefined
  if (selected) return <MailboxLocationContext origin={mailboxOrigin} sessionId={sessionId}>{(locationSummary, locationDetails) => <article className="composer-mailbox__detail" data-record-key={messageKey(selected)}>
    <ConversationMessage {...reading} compact recordedIdentity detailsOnlyMetadata messageActions={renderNavigation(selected, true)} {...(sessionId ? { conversationSessionId: sessionId } : {})}
      messageId={messageKey(selected)} {...(selected.reference ? { itemRef: selected.reference } : {})} speaker={speakerOf(selected.message) as ConversationSpeaker} name={authorLabel(selected)}
      content={selected.message.contentParts.length > 0 ? selected.message.contentParts : selected.message.content}
      {...(selected.message.questionAnswers ? { questionAnswers: selected.message.questionAnswers } : {})}
      {...(selected.message.questionDiagnostic ? { questionDiagnostic: selected.message.questionDiagnostic } : {})}
      {...(selected.message.source.kind === 'native' && selected.message.contentParts.length > 0
        ? {} : { copyText: selected.message.content })}
      {...(time(selected) === undefined ? {} : { createdAt: time(selected)! })}
      {...(isUserMessage(selected.original) ? { inputSource: selected.message.source } : {})}
      {...(selected.message.source.kind === 'native' ? { nativeResourceRecord: { source: { providerId: selected.message.source.providerId, nativeSessionId: selected.message.source.nativeSessionId }, recordId: selected.message.source.recordId, ...(selected.message.turnId ? { turnId: selected.message.turnId } : {}) }, ...(historyResourceReader ? { readHistoryResource: historyResourceReader } : {}) } : {})}
      {...(onCopy ? { onCopy } : {})}
      messageDetails={<>{locationSummary}<dl className="composer-mailbox__record-facts">
        {!isUserMessage(selected.original) ? <><dt>Source</dt><dd>Captured input</dd><dt>Recorded author</dt><dd>{authorLabel(selected)}</dd></> : null}
        <dt>Time</dt><dd><MailboxTime value={time(selected)} complete /></dd>
        <dt>Delivery</dt><dd>{selected.message.source.kind === 'native' ? 'Recorded · not a delivery receipt' : state(selected) === 'complete' ? 'Submission confirmed · CLI acceptance and reply are separate' : 'Delivery not confirmed'}</dd>
      </dl>{locationDetails}</>} />
    {!selected.message.content && !(isUserMessage(selected.original) && selected.message.contentParts.length) ? <MailboxEmpty title="No text recorded" /> : null}
    {state(selected) !== 'complete' && !(selected.message.source.kind === 'native')
      ? <p className="composer-mailbox__risk">Delivery not confirmed. Check the Agent’s response before sending again.</p> : null}
  </article>}</MailboxLocationContext>
  const records = [
    ...recent.map(item => ({ kind: 'message' as const, time: item.message.recordedAt, key: messageKey(item), item })),
    ...queuedRecords.map(entry => ({ kind: 'queue' as const, time: entry.enqueuedAt, key: `queue:${entry.id}`, entry })),
    ...additionalRecords.map(row => ({ kind: 'journal' as const, time: row.time, key: `journal:${row.key}`, row }))
  ].sort((a, b) => latestFirst(a.time, b.time))
  return records.length ? <ol className="composer-mailbox__messages" aria-label="Recorded input history">
    {records.map(record => {
      if (record.kind === 'journal') return <Fragment key={record.key}>{record.row.node}</Fragment>
      if (record.kind === 'queue') return <Fragment key={record.key}>{renderQueueRecord?.(record.entry)}</Fragment>
      const item = record.item
      return <li key={messageKey(item)}><MailboxRecordRow recordKey={messageKey(item)} label={authorLabel(item)} text={item.message.content}
      avatar={identity(item).avatar} source={<span title={describeConversationInputSource(item.message.source).title}>{describeConversationInputSource(item.message.source).caption}</span>}
      metadata={time(item) === undefined ? null : <MailboxTime value={time(item)} />}
      status={state(item) !== 'complete' && !(item.message.source.kind === 'native') ? <span className="composer-mailbox__risk">Delivery not confirmed</span> : null}
      actions={renderNavigation(item)} onOpen={onOpen} /></li>})}
  </ol> : <MailboxEmpty title="No recorded messages" />
}

/** Folders project durable delivery facts; read receipts never advance delivery state. */
export function SessionMailbox({ system, queued, timeline, progressSession, visible = true, control: propControl, userMessages: propUserMessages, onArchiveQueued, onMoveQueuedToDraft, onMoveQueued, onSendQueued, onCancelQueuedPreparation, onCopyQueued, onEditQueued, sendImmediately = false, reading, onRevealMessage, mailboxOrigin, children, pendingInteraction = false, noticePresentation, inputHistory, historyResourceReader, onHistoryVisible }: {
  children?: (mailbox: ReactNode, pending: ReactNode) => ReactNode
  /** Presentation of an existing notice, shared by this mailbox and its right dock. */
  noticePresentation?: { id: string; content: ReactNode } | undefined
  pendingInteraction?: boolean
  inputHistory?: ReturnType<typeof useComposerInputHistory>
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
  const document = useWorkbenchDocument()
  const window = document.defaultView!
  const id = useId()
  // Reading intent survives a hidden workface; the native popover may leave top layer meanwhile.
  const [open, setOpen] = useState(false)
  const suspension = useRef<{ scope: string; phase: 'hidden' | 'restoring' } | null>(null)
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
    if (!visible || event.pointerType !== 'mouse' || event.buttons !== 0) return
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
    if (!visible || event.pointerType !== 'mouse' || !preview.current) return
    cancelClose()
    closeTimer.current = setTimeout(() => popover.current?.hidePopover(), 180)
  }
  useEffect(() => {
    if (!open || !visible) return
    // The current editor may consume Escape before native light-dismiss. Only a hover preview
    // handles it here; no focus moves and composing Escape remains owned by the editor/IME.
    const dismissPreview = (event: KeyboardEvent) => {
      if (!preview.current || event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return
      event.preventDefault(); event.stopPropagation(); popover.current!.hidePopover()
    }
    document.addEventListener('keydown', dismissPreview, true)
    return () => document.removeEventListener('keydown', dismissPreview, true)
  }, [open, visible, document])
  const [folder, setFolder] = useState<Folder>('inbox')
  const agentFolder = useRef<AgentMessageFolder>('inbox')
  const automationEntry = useRef<HTMLButtonElement>(null)
  const automationReturn = useRef<{ scope: string; folder: Folder; scroll: number; selection: MailboxSelection | null } | null>(null)
  const automationFocus = useRef<'back' | 'entry' | null>(null)
  const progressVisible = open && visible && folder === 'progress'
  const [progressPresented, setProgressPresented] = useState(false)
  useEffect(() => { if (progressVisible) setProgressPresented(true) }, [progressVisible])
  useEffect(() => { onHistoryVisible?.(open && visible && folder === 'user'); return () => onHistoryVisible?.(false) },
    [open, visible, folder, onHistoryVisible])
  const folderLabels = { inbox: 'Received', outbox: 'Sent', user: 'Inputs', system: 'Notices', progress: 'Automation', collaboration: 'Collaboration' }
  const progressTarget = progressSession ? JSON.stringify([progressSession.hostId, progressSession.id, progressSession.providerId, progressSession.workspacePath]) : ''
  const [progress, setProgress] = useState<{ target: string; status: ContinuousProgressStatus }>()
  const onProgressStatus = useCallback((status: ContinuousProgressStatus) => setProgress({ target: progressTarget, status }), [progressTarget])
  const progressStatus = progress?.target === progressTarget ? progress.status : 'unconfirmed'
  const progressLabel = `Continuous progress: ${progressStatus}${progressStatus === 'inactive' ? ' (not enabled)' : ''}`
  const ProgressIcon = progressStatus === 'active' ? ThemeActionRepeatIcon : progressStatus === 'paused' ? ThemeActionPauseIcon : ThemeStatusUnknownIcon

  const storeSession = useAppStore((state) =>
    propControl ? undefined : state.sessions.find((s) => s.id === timeline?.agentSessionId)
  )
  const effectiveControl: AgentSessionControl | undefined =
    propControl ?? (storeSession?.kind === 'agent' ? storeSession.control : undefined)

  const scope = JSON.stringify([effectiveControl?.hostId, effectiveControl?.agentSessionId, effectiveControl?.run.runId, timeline?.agentSessionId])
  const previousScope = useRef(scope)
  const navigationGeneration = useRef(0)
  const [navigationFeedback, setNavigationFeedback] = useState<{ scope: string; key: string; message: string } | null>(null)
  useEffect(() => { ++navigationGeneration.current; setNavigationFeedback(null) }, [scope])
  function renderReveal(item: MailboxDisplayItem, key = messageKey(item)) {
    const feedback = navigationFeedback?.scope === scope && navigationFeedback.key === key ? navigationFeedback.message : null
    return <><button type="button" className="composer-tool composer-mailbox__reveal" aria-label="在对话中查看" title={onRevealMessage ? "在对话中查看原记录" : "当前显示宿主关系未确认，原文仍可阅读、复制与填入草稿"} disabled={!onRevealMessage}
      onClick={async () => {
        if (!onRevealMessage) return
        const action = ++navigationGeneration.current
        setNavigationFeedback(null)
        const result = await onRevealMessage(item.message)
        if (action !== navigationGeneration.current) return
        if (result.kind === 'located') popover.current?.hidePopover()
        else if (result.kind === 'unavailable') setNavigationFeedback({ scope, key, message: result.message })
      }}><RevealIcon size={14} aria-hidden="true" /></button>{feedback ? <span className="composer-mailbox__navigation-feedback" role="status">{feedback}</span> : null}</>
  }
  function renderNavigation(item: MailboxDisplayItem, detail = false) {
    const key = messageKey(item)
    return <>{!detail && (inputHistory || onCopyQueued) ? <MailboxCopyAction key={`copy:${scope}:${key}`} value={item.message.content} onCopy={() => inputHistory ? inputHistory.copy(item.message) : onCopyQueued!(item.message.content)} /> : null}{inputHistory && inputHistory.canFill !== false ? <MailboxDraftAction key={`fill:${scope}:${key}`} value={item.message.content} onFill={() => inputHistory.fill(item.message)} /> : null}{renderReveal(item)}</>
  }
  function renderA2ANavigation(messageId: string) {
    const record = displayedMessages.find(item => !isUserMessage(item.original) && item.original.inputRef?.kind === 'message' &&
      item.original.inputRef.messageId === messageId && item.original.inputRef.agentSessionId === mailboxSessionId && item.original.agentSessionId === mailboxSessionId)
    return record ? renderReveal(record, `a2a:${messageId}`) : null
  }
  const [selection, setSelection] = useState<MailboxSelection | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const explicitUserReveal = useRef<{ scope: string; operationId: string } | null>(null)
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
    if (isAgentMessageFolder(next)) agentFolder.current = next
    focusAfter.current = null; setSelection(null); setFolder(next)
    if (body.current) body.current.scrollTop = 0
  }
  function openAutomation(event: MouseEvent<HTMLButtonElement>) {
    automationReturn.current = { scope, folder, selection, scroll: body.current?.scrollTop ?? 0 }
    automationFocus.current = document.activeElement === event.currentTarget ? 'back' : null
    chooseFolder('progress')
  }
  function returnToMessages() {
    const origin = automationReturn.current?.scope === scope ? automationReturn.current : null
    automationFocus.current = 'entry'
    chooseFolder(origin?.folder ?? 'user')
    setSelection(origin?.selection ?? null)
  }

  const {
    messages: hookUserMessages,
    hasMore,
    loadEarlier,
    refresh,
    error: historyError,
    observationError,
    windowFrozen
  } = useSessionUserMessages(effectiveControl, { enabled: open && visible && folder === 'user' })

  const effectiveUserMessages = propUserMessages ?? hookUserMessages

  const mailboxSessionId = effectiveControl?.agentSessionId ?? timeline?.agentSessionId
  const inputMailboxHost = effectiveControl?.hostId ?? ''
  const readInputMailbox = useCallback((input: import('@agentmux/core/agent-input-mailbox').AgentInputMailboxRead) =>
    api.sessions.inputMailbox({ hostId: inputMailboxHost, agentSessionId: input.agentSessionId }, input), [inputMailboxHost])
  const inputMailbox = useAgentInputMailbox({ hostId: inputMailboxHost, agentSessionId: mailboxSessionId ?? '',
    enabled: open && visible && folder === 'user' && Boolean(inputMailboxHost && mailboxSessionId), read: readInputMailbox })
  useEffect(() => {
    if (!open || !visible || !inputMailboxHost || !mailboxSessionId) return
    return api.sessions.onEvent(event => {
      if (event.type !== 'core' || event.hostId !== inputMailboxHost) return
      const fact = event.event
      if (fact.type === 'agent-input-recorded' && fact.agentSessionId === mailboxSessionId ||
          fact.type === 'agent-input' && fact.receipt.key.agentSessionId === mailboxSessionId ||
          fact.type === 'connection-state' && fact.state === 'restored') void inputMailbox.refresh()
    })
  }, [open, visible, inputMailboxHost, mailboxSessionId, inputMailbox.refresh])
  // The shared inventory retains every input; this face excludes known Agent and platform producers.
  const userInputMailbox = useMemo(() => ({ ...inputMailbox,
    items: inputMailbox.items.filter(item => { const { role } = inputMailboxPresentation(item).speaker; return role !== 'agent' && role !== 'system' }),
    failures: inputMailbox.failures.filter(item => { const { role } = inputMailboxPresentation(item).speaker; return role !== 'agent' && role !== 'system' })
  }), [inputMailbox])
  const displayedMessages = useMemo(() => mailboxMessages(mailboxSessionId,timeline,effectiveUserMessages,effectiveControl?.hostId), [mailboxSessionId,timeline,effectiveUserMessages,effectiveControl?.hostId])
  const sent = useMemo(() => displayedMessages.filter(item => item.message.author.kind !== 'agent'), [displayedMessages])
  const messageReference = useMemo(() => ({ hostId: inputMailboxHost, agentSessionId: mailboxSessionId ?? '' }), [inputMailboxHost, mailboxSessionId])
  const canReadMessages = Boolean(inputMailboxHost && mailboxSessionId)
  const incomingWindow = useSessionMessages({ ...messageReference, direction: 'incoming', enabled: visible && canReadMessages })
  const outgoingWindow = useSessionMessages({ ...messageReference, direction: 'outgoing', enabled: open && visible && folder === 'outbox' && canReadMessages })
  // The public participant query includes self-addressed records; these two faces explicitly mean other Agents.
  const incoming = useMemo(() => incomingWindow.items.filter(item => item.envelope.senderSessionId !== item.envelope.recipientSessionId), [incomingWindow.items])
  const outgoing = useMemo(() => outgoingWindow.items.filter(item => item.envelope.senderSessionId !== item.envelope.recipientSessionId), [outgoingWindow.items])
  const notificationMessages = useMemo(() => [...incoming, ...outgoing], [incoming, outgoing])
  const notifications = useMailboxNotifications(messageReference, notificationMessages)
  const readMessage = useCallback(async (messageId: string) => {
    const result = await api.sessions.readMessage(messageReference, messageId)
    if (result.hostId !== messageReference.hostId) throw new Error('The original message Host changed. Reading is kept; refresh the original Host.')
    return result.message
  }, [messageReference])
  // Original sequence and MID are immutable. Receipt updates never make a human-read message unread.
  const fingerprints = useMemo(() => Object.fromEntries(incoming.map(item => [JSON.stringify([inputMailboxHost, item.envelope.messageId]), String(item.sequence)])), [incoming, inputMailboxHost])
  // A requested page is not a complete journal snapshot and cannot prune prior human reads.
  const receipts = useReadReceipts(`mail:${mailboxSessionId ?? ''}`, fingerprints, canReadMessages, false)
  const unread = receipts.unread.length
  const notices = useMemo(() => [...system.notices].sort((a, b) => latestFirst(a.observedAt, b.observedAt)), [system.notices])

  const deliveredIds = useMemo(() => {
    return new Set(displayedMessages.filter(item => !isUserMessage(item.original) && item.message.deliveryStatus === 'complete').map(item => item.message.rawId))
  }, [displayedMessages])

  const journalLocal = new Map(queued.filter(item => item.inputOrigin).map(item => [inputMailboxKey(item.inputOrigin!.hostId,item.inputOrigin!.key),item]))
  const journalKeys = new Set(inputMailbox.items.map(item => inputMailboxItemKey(inputMailboxHost,item)))
  const localOnly = queued.filter(item => !item.inputOrigin || !journalKeys.has(inputMailboxKey(item.inputOrigin.hostId,item.inputOrigin.key)))
  const pendingIntents = queued.filter((item) => !item.archived && (item.inputControlled || !deliveredIds.has(item.id) && !deliveredIds.has(`prompt:${item.id}`)))
  const pending = pendingIntents.filter(item => !item.inputOrigin || !journalKeys.has(inputMailboxKey(item.inputOrigin.hostId,item.inputOrigin.key)))
  const pendingCount = pendingIntents.length
  const archived = localOnly.filter(item => item.archived).map(item => ({...item,confirmed: item.confirmed || !item.inputControlled && deliveredIds.has(`prompt:${item.id}`)}))
  const hasUserInputs = pending.length + archived.length + userInputMailbox.items.length > 0
  // Re-evaluate priority only on opening. A new arrival never moves the reader's selected folder.
  function openFolder(): Folder {
    return receipts.unread.length ? 'inbox' : system.unread.length ? 'system' : hasUserInputs || sent.length ? 'user' : 'inbox'
  }
  useEffect(() => {
    if (!open || !visible || !viewed) return
    if (folder === 'inbox' && !(selection?.scope === scope && selection.folder === 'inbox') && receipts.unread.length) receipts.acknowledge(receipts.unread)
    if (folder === 'system' && system.unread.length) system.acknowledge(system.unread)
  }, [open, visible, viewed, folder, receipts, system, selection, scope])
  const wanted = selection?.scope === scope && selection.folder === folder ? selection.key : null
  const selectedNotice = wanted && folder === 'system' ? notices.find(item => `notice:${item.id}:${serviceNoticeFingerprint(item)}` === wanted) : undefined
  const selectedQueue = wanted && folder === 'user' ? [...pending,...archived].find(item => `queue:${item.id}` === wanted) : undefined
  const historyMessages = useMemo(() => inputHistory ? mailboxMessages(mailboxSessionId, undefined,
    inputHistory.history.messages.filter(message => message.author.kind !== 'agent'), effectiveControl?.hostId) : sent,
    [inputHistory?.history.messages, sent, mailboxSessionId, effectiveControl?.hostId])
  const selectedMessage = wanted && folder === 'user' ? historyMessages.find(item => messageKey(item) === wanted) : undefined
  const selectedJournal = wanted && folder === 'user' ? userInputMailbox.items.find(item => inputMailboxItemKey(inputMailboxHost, item) === wanted) : undefined
  const detail = Boolean(selectedNotice || selectedMessage || selectedJournal || (folder === 'inbox' || folder === 'outbox') && wanted?.startsWith('a2a:'))
  function queueRecordProps() {
    return { sessionId: mailboxSessionId, selectedId: selectedQueue?.id ?? null, reading, pendingInteraction,
      onSelect: (key: string) => { focusAfter.current = null; setSelection({ scope, folder: 'user', key: `queue:${key}` }) },
      ...(onArchiveQueued ? { onArchive: onArchiveQueued } : {}), ...(onCopyQueued ? { onCopy: onCopyQueued } : {}),
      ...(inputHistory && inputHistory.canFill !== false ? { onFill: inputHistory.fillText } : {}) }
  }
  function renderPending() {
    const query = inputHistory?.history.query ?? ''
    return <ComposerOutbox {...queueRecordProps()} queued={pending} query={query} hideHeading
      onCancelPreparation={onCancelQueuedPreparation} {...(onMoveQueued ? { onMove: onMoveQueued } : {})} onMoveToDraft={onMoveQueuedToDraft}
      {...(onEditQueued ? { onEdit: onEditQueued } : {})} sendImmediately={sendImmediately} {...(onSendQueued ? { onSend: onSendQueued } : {})} />
  }
  function renderRecorded(messages: readonly MailboxDisplayItem[], additionalRecords: readonly InputMailboxDisplayRow[]) {
    const query = inputHistory?.history.query ?? ''
    return <MessageHistory mailboxOrigin={mailboxOrigin} items={messages} selectedKey={null}
      onOpen={selectRecord} onCopy={onCopyQueued} reading={reading} sessionId={mailboxSessionId} renderNavigation={renderNavigation}
      historyResourceReader={historyResourceReader} additionalRecords={additionalRecords} queuedRecords={archived.filter(entry => !query || entry.text.includes(query))}
      renderQueueRecord={entry => <ComposerOutbox {...queueRecordProps()} queued={[entry]} rowsOnly onHistory={operationId => {
        const original = messages.find(item => item.message.agentSessionId === mailboxSessionId && item.message.source.kind === 'captured' && item.message.source.submissionId === `prompt:${operationId}` && item.message.deliveryStatus === 'complete')
        if (original) setSelection({ scope, folder: 'user', key: messageKey(original) })
      }} />} />
  }

  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope
      const ownedFocus = document.activeElement === document.body && lastReadingFocus.current && !lastReadingFocus.current.isConnected
      positions.current = {}; lastReadingFocus.current = null; focusAfter.current = null
      agentFolder.current = 'inbox'; automationReturn.current = null; automationFocus.current = null
      if (body.current) body.current.scrollTop = 0
      if (selection) setSelection(null)
      if (ownedFocus) (document.getElementById(`${id}-${folder}-tab`) ?? popover.current?.querySelector<HTMLButtonElement>('[aria-label="Back to messages"]'))?.focus({ preventScroll: true })
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
    if (folder === 'progress' && automationFocus.current === 'back') {
      automationFocus.current = null
      popover.current?.querySelector<HTMLButtonElement>('[aria-label="Back to messages"]')?.focus({ preventScroll: true })
    }
    if (folder !== 'progress' && automationFocus.current === 'entry') {
      automationFocus.current = null
      if (body.current) body.current.scrollTop = automationReturn.current?.scope === scope ? automationReturn.current.scroll : 0
      automationEntry.current?.focus({ preventScroll: true })
    }
  }, [open, detail, selectedQueue, selection, scope, folder, id])
  useLayoutEffect(() => {
    if (!open || !visible) return
    const panel = popover.current!, editor = trigger.current!.closest<HTMLElement>('.composer')
    if (!editor) return
    const region = editor.closest<HTMLElement>('[data-workbench-region-id]') ?? editor
    const measure = () => {
      const c = editor.getBoundingClientRect(), r = region.getBoundingClientRect()
      if (c.width <= 0) return
      // The native CSS anchor is the whole editor; bound only this open surface to its actual available space.
      panel.style.maxWidth = `${Math.max(1, Math.min(440, r.width - 12))}px`
      panel.style.maxHeight = `${Math.max(1, Math.min(560, c.top - 12))}px`
    }
    measure()
    const observer = new window.ResizeObserver(measure); observer.observe(editor); observer.observe(region)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [open, visible, document])
  useLayoutEffect(() => {
    const panel = popover.current!
    if (suspension.current && suspension.current.scope !== scope) {
      suspension.current = null
      if (!panel.matches(':popover-open')) { setOpen(false); return }
    }
    if (!visible) {
      cancelClose()
      if (panel.matches(':popover-open')) {
        suspension.current = { scope, phase: 'hidden' }
        // Native presentation can open before its asynchronous toggle reaches React.
        if (!open) {
          setFolder(requestedFolder.current ?? openFolder()); requestedFolder.current = null
          if (!preview.current) setViewed(true)
          setOpen(true)
        }
        panel.hidePopover()
      }
    } else if (open && suspension.current?.scope === scope && !panel.matches(':popover-open')) {
      suspension.current = { scope, phase: 'restoring' }
      ;(panel.showPopover as (options: { source: HTMLButtonElement }) => void)
        .call(panel, { source: trigger.current! })
    }
  }, [open, visible, scope])
  const motion = useMailboxMotion(popover, dock, open, visible, scope)
  const readingMounted = open || motion.retaining
  // Retain the original reading DOM through exit paint so its native anchor baseline
  // cannot jump; native closed/inert state and delivery facts already apply immediately.
  useEffect(() => { if (!readingMounted) setSelection(null) }, [readingMounted])
  useLayoutEffect(() => {
    const intent = explicitUserReveal.current
    if (!intent) return
    if (intent.scope !== scope) { explicitUserReveal.current = null; return }
    if (!open || folder !== 'user') return
    explicitUserReveal.current = null
    const row = Array.from(body.current?.querySelectorAll<HTMLElement>('.composer-mailbox__row[data-record-key]') ?? [])
      .find(node => node.dataset.recordKey === `queue:${intent.operationId}`)
    row?.closest<HTMLElement>('li[data-operation-id]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [open, folder, scope, selection])
  const mailboxLabel = `Mailbox: Agent messages ${unread} unread in loaded messages, Inputs ${pendingCount} pending, Notices ${system.unread.length} need attention${progressSession ? `. ${progressLabel}` : ''}`
  function showUserMessages(operationId: string) {
    motion.captureSource(Array.from(dock.current?.querySelectorAll<HTMLElement>('[data-operation-id]') ?? []).find(node => node.dataset.operationId === operationId))
    explicitUserReveal.current = { scope, operationId }
    requestedFolder.current = 'user'
    pin(); chooseFolder('user')
    setSelection({ scope, folder: 'user', key: `queue:${operationId}` })
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
    <div ref={popover} id={id} popover="auto" className="composer-mailbox" aria-label="Mailbox" data-view={folder === 'progress' ? 'automation' : 'messages'}
      data-state={open && visible ? 'open' : 'closed'} inert={!open || !visible}
      onBeforeToggle={event => {
        if (event.target !== event.currentTarget) return
        event.currentTarget.inert = event.newState !== 'open'
        motion.beforeToggle(event.newState)
      }}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') { cancelClose(); setViewed(true) } }}
      onPointerLeave={leave} onPointerDownCapture={pin} onFocusCapture={event => { lastReadingFocus.current = event.target; pin() }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event)) return
        event.preventDefault(); event.stopPropagation()
        popover.current!.hidePopover(); trigger.current!.focus({ preventScroll: true })
      }}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return
        const opening = event.newState === 'open'
        if (opening) {
          const restoring = suspension.current?.scope === scope
          suspension.current = null
          if (!restoring) { setFolder(requestedFolder.current ?? openFolder()); requestedFolder.current = null; if (!preview.current) setViewed(true) }
        } else {
          if (suspension.current?.scope === scope && suspension.current.phase === 'hidden') return
          // A queued native close may have been superseded by the same surface reopening.
          if (event.currentTarget.matches(':popover-open')) return
          suspension.current = null
          cancelClose(); preview.current = false; setViewed(false); focusAfter.current = null
        }
        setOpen(opening)
        motion.afterToggle(event.newState)
      }}>
      <div className="composer-mailbox__heading">
        {folder === 'progress' ? <button type="button" className="composer-tool" aria-label="Back to messages" title="Back to messages"
          onClick={returnToMessages}><ThemeNavigationBackIcon size={15} /></button> : null}
        <strong>{folder === 'progress' ? 'Automation' : 'Messages'}</strong><span className="composer-mailbox__subject" title={mailboxSessionId}>{mailboxSessionId ? reading?.describeSpeaker?.({ role: 'agent', id: mailboxSessionId }, 18)?.name || mailboxSessionId : 'Agent unknown'}</span>
        <button type="button" className="composer-tool" aria-label="Close mailbox" popoverTarget={id} popoverTargetAction="hide"
          onClick={() => trigger.current!.focus({ preventScroll: true })}><ThemeActionCloseIcon size={14} /></button></div>
      {folder !== 'progress' ? <MailboxWorkspaceNavigation id={id} folder={folder} agentFolder={agentFolder.current}
        onSelect={chooseFolder} unread={unread} pending={pendingCount} notices={system.unread.length} collaboration={Boolean(effectiveControl)} /> : null}
      {detail ? <div className="composer-mailbox__back"><button ref={back} type="button" className="composer-tool" aria-label={`Back to ${folderLabels[folder]}`} title={`Back to ${folderLabels[folder]}`} onClick={leaveRecord}><ThemeNavigationBackIcon size={14} aria-hidden="true" /><span>{folderLabels[folder]}</span></button></div> : null}
      <div ref={body} className="composer-mailbox__content" onFocusCapture={event => { lastReadingFocus.current = event.target }}>
      <div id={`${id}-agents`} role="tabpanel" aria-labelledby={`${id}-agents-tab`} hidden={!isAgentMessageFolder(folder)}>
      {(['inbox', 'outbox'] as const).map(name => {
        const window = name === 'inbox' ? incomingWindow : outgoingWindow
        return <div key={name} id={`${id}-${name}`} role="tabpanel" aria-labelledby={`${id}-${name}-tab`} hidden={folder !== name}>
          {readingMounted && folder === name ? canReadMessages ? <MailboxA2A reference={messageReference}
            direction={name === 'inbox' ? 'incoming' : 'outgoing'} items={name === 'inbox' ? incoming : outgoing}
            selectedKey={wanted} active={open && visible} loading={window.loading} error={window.error} observationError={window.observationError}
            nextCursor={window.nextCursor} refresh={window.refresh} loadEarlier={window.loadEarlier} readMessage={readMessage}
            onOpen={selectRecord} reading={reading} onCopy={onCopyQueued}
            renderNotification={message => notifications.render(message, window.refresh, reading?.describeSpeaker?.({ role: 'agent', id: message.envelope.recipientSessionId! }, 18)?.name || message.envelope.recipientSessionId!)} notificationAttempt={notifications.attempt}
            {...(inputHistory && inputHistory.canFill !== false ? { onFill: inputHistory.fillText } : {})}
            {...(name === 'inbox' ? { renderNavigation: renderA2ANavigation } : {})} />
            : <MailboxEmpty title="The original Agent and Host are not yet known" /> : null}
        </div>
      })}
      {effectiveControl ? <div id={`${id}-collaboration`} role="tabpanel" aria-labelledby={`${id}-collaboration-tab`} hidden={folder !== 'collaboration'}>
        {readingMounted && folder === 'collaboration' ? <MailboxCollaboration key={scope} control={effectiveControl} active={open && visible} reading={reading} onCopy={onCopyQueued} /> : null}
      </div> : null}
      </div>
      <div id={`${id}-user`} role="tabpanel" aria-labelledby={`${id}-user-tab`} aria-busy={Boolean(inputHistory?.history.loading || inputMailbox.loading)} hidden={folder !== 'user'}>
        {readingMounted && folder === 'user' ? <>
          <InputMailboxRecords compact refreshInParent={Boolean(inputHistory)} coverageInParent={Boolean(inputHistory)}
            query={inputHistory?.history.query ?? ''} selection={{ key: selectedJournal ? wanted : null, onOpen: selectRecord }} mailbox={userInputMailbox} hostId={inputMailboxHost} reading={reading} onCopy={onCopyQueued}
            renderLocal={item => {
              const original = journalLocal.get(inputMailboxItemKey(inputMailboxHost,item))
              if (!original) return null
              return <ol className="composer-mailbox__messages"><ComposerOutbox {...queueRecordProps()} queued={[{...original,
                ...(item.kind === 'controlled' && item.receipt ? { inputReceipt: item.receipt } : {})}]} selectedId={original.id} rowsOnly
                // The containing journal detail already owns this selection. Local editing must not replace its key.
                onSelect={() => {}}
                onCancelPreparation={onCancelQueuedPreparation} onMoveToDraft={onMoveQueuedToDraft}
                {...(onEditQueued ? { onEdit: onEditQueued } : {})} {...(onSendQueued ? { onSend: onSendQueued } : {})} /></ol>
            }} renderRecords={(journalRecords, journalDetail) => <>
          {journalDetail ?? (selectedMessage ? <MessageHistory mailboxOrigin={mailboxOrigin} items={historyMessages} selectedKey={wanted}
            onOpen={selectRecord} onCopy={onCopyQueued} reading={reading} sessionId={mailboxSessionId} renderNavigation={renderNavigation}
            historyResourceReader={historyResourceReader} /> : <>
            {observationError ? <SourceNotice title="Automatic native updates are unavailable" message={observationError.message} action="Refresh source" onAction={() => void refresh()} /> : null}
            {windowFrozen ? <SourceNotice title="The native source changed" message="This reading window is kept." action="Read latest records" onAction={() => void refresh()} /> : null}
            {inputHistory ? <InputHistoryList history={{ ...inputHistory.history, messages: inputHistory.history.messages.filter(message => message.author.kind !== 'agent') }}
              localEntries={inputHistory.localEntries} onCopy={inputHistory.copy} {...(inputHistory.canFill !== false ? { onFill: inputHistory.fill, onFillLocal: inputHistory.fillLocal } : {})}
              onRefresh={() => { void inputMailbox.refresh(); inputHistory.history.refresh() }}
              refreshing={inputMailbox.loading || inputHistory.history.loading}
              coverage={<>{inputMailbox.loading || inputHistory.history.loading ? 'Reading inputs…' : 'Loaded inputs'} · Partial history
                <details className="composer-mailbox__coverage-details"><summary>Sources</summary>
                  <span>Journal: {userInputMailbox.items.length} loaded; earlier coverage unconfirmed. {inputHistory.history.complete ? 'Available history checked for this read.' : 'History is a partial reading window.'}{inputHistory.history.examined ? ` Examined ${inputHistory.history.examined} history records.` : ''}</span>
                </details></>}
              beforeRecords={renderPending()}
              renderRecords={() => renderRecorded(historyMessages,journalRecords)} /> : <>
              {historyError && !historyError.message.includes('unavailable in the web preview') ? <SourceNotice title="Failed to read native conversation history" message={historyError.message} action="Retry" onAction={() => void refresh()} /> : null}
              {renderPending()}{renderRecorded(sent,journalRecords)}
              {hasMore ? <div className="composer-mailbox__boundary"><button type="button" className="composer-tool" onClick={() => void loadEarlier()}>Load earlier messages</button></div> : null}
            </>}
          </>)}
          </>} />
        </> : null}
      </div>
      <div id={`${id}-system`} role="tabpanel" aria-labelledby={`${id}-system-tab`} hidden={folder !== 'system'}>
        {readingMounted && folder === 'system' ? selectedNotice ? <article className="composer-mailbox__detail composer-notice" data-kind={selectedNotice.notice.kind}>
          <div className="composer-notice__body">{noticePresentation?.id === selectedNotice.id ? noticePresentation.content : <><ServiceWindowNotice notice={selectedNotice.notice} />
            <MailboxTime value={selectedNotice.observedAt} complete />
            {selectedNotice.id === 'queue' ? <button type="button" className="composer-tool" onClick={() => chooseFolder('user')}>View Inputs</button> : null}
            {selectedNotice.action ? <button type="button" className="composer-tool" onClick={selectedNotice.action.run}>{selectedNotice.action.label}</button> : null}</>}
          </div>
        </article> : notices.length ? <ol className="composer-mailbox__messages" aria-label="Current service notices">
          {notices.map(item => <li key={item.id} className="composer-notice" data-kind={item.notice.kind}><MailboxRecordRow
            recordKey={`notice:${item.id}:${serviceNoticeFingerprint(item)}`} label={(item.summary ?? item.notice.notice).step}
            text={(item.summary ?? item.notice.notice).mode.slice(0,240)}
            metadata={item.observedAt === undefined ? null : <MailboxTime value={item.observedAt} />}
            status={item.notice.kind === 'indeterminate' ? 'Status unknown' : 'Service notice'}
            onOpen={selectRecord} /></li>)}
        </ol> : <MailboxEmpty title={system.available ? 'No current notices' : 'Waiting for Session status'} /> : null}
      </div>
      {progressSession ? <div id={`${id}-progress`} role="region" aria-label="Automation settings" hidden={folder !== 'progress'}>
        <ContinuousProgressControl session={progressSession} onStatusChange={onProgressStatus} presented={progressVisible || progressPresented} visible={progressVisible} />
      </div> : null}
      </div>
      {progressSession && folder !== 'progress' ? <button ref={automationEntry} type="button" className="composer-mailbox__automation" aria-label="Automation"
        aria-describedby={`${id}-automation-status`} onClick={openAutomation}>
        <ThemeObjectAutomationIcon size={14} aria-hidden="true" /><span>Automation</span>
        <span id={`${id}-automation-status`} className="composer-mailbox__automation-status" data-status={progressStatus}>
          {progressStatus === 'active' ? 'Running' : progressStatus === 'paused' ? 'Paused' : progressStatus === 'inactive' ? 'Not enabled' : 'Status unknown'}</span>
        <span aria-hidden="true">›</span>
      </button> : null}
    </div>
    <ModalAttachmentDismissal active={Boolean(open && visible && popover.current && getModalOverlayContainer(popover.current))} targetRef={popover}
      onOwnerRemoved={() => popover.current?.hidePopover()}
      onEscapeKeyDown={event => { if (event.defaultPrevented || isImeOwnedKeyboardEvent(event)) return; event.preventDefault(); popover.current?.hidePopover(); trigger.current?.focus({ preventScroll: true }) }} />
  </>
  return children ? children(mailbox, visible ? <ComposerPendingDelivery surfaceRef={dock} returning={!open && motion.retaining} notice={noticePresentation?.content} suppressed={open} anchorRef={trigger} queued={pendingIntents} pendingInteraction={pendingInteraction} onSend={onSendQueued} onCancelPreparation={onCancelQueuedPreparation} onCopy={onCopyQueued} onEdit={onEditQueued} onArchive={onArchiveQueued} onMoveToDraft={onMoveQueuedToDraft} sendImmediately={sendImmediately} onMore={showUserMessages} /> : null) : mailbox
}
