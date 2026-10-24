import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useMemo } from 'react'
import type { AgentMuxMessageMetadata, AgentMuxMessageNotification, AgentPromptInputKey } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { retainMailboxNotificationIntent, useAppStore } from '../store'
import { mailboxNotificationIntentKey, mailboxNotificationScope, mailboxNotificationSubject, type MailboxNotificationIntent, type MailboxNotificationFeedback, type MailboxNotificationHistory } from './mailbox-notification-intent'
import { api } from './api'

const SendIcon = semanticIconComponent('action.send')
const RefreshIcon = semanticIconComponent('action.refresh')
type Message = Pick<AgentMuxMessageMetadata, 'envelope' | 'deliveryMode' | 'notification'>
type Attempt = MailboxNotificationIntent & Omit<MailboxNotificationFeedback, 'state'> & { state: MailboxNotificationFeedback['state'] | 'unchecked'; pending: boolean }
const EMPTY_INTENTS: Readonly<Record<string, MailboxNotificationIntent>> = Object.freeze({})
const EMPTY_FEEDBACK: Readonly<Record<string, MailboxNotificationFeedback>> = Object.freeze({})
const EMPTY_HISTORY: Readonly<Record<string, MailboxNotificationHistory>> = Object.freeze({})
const sameKey = (a: AgentPromptInputKey, b: AgentPromptInputKey) => a.kind === 'prompt' && b.kind === 'prompt' &&
  a.agentSessionId === b.agentSessionId && a.expectedRun.runId === b.expectedRun.runId && a.submissionId === b.submissionId
const settled = (state: Attempt['state']) => state === 'submitted' || state === 'not-applied'
const status = (attempt: Attempt) => attempt.checking ? 'checking…' : attempt.sending ? 'sending…'
  : attempt.state === 'unchecked' ? 'receipt not checked' : attempt.state === 'not-applied' ? 'not applied' : attempt.state

function feedback(intent: MailboxNotificationIntent) { return useAppStore.getState().mailboxNotificationFeedback[mailboxNotificationSubject(intent)]?.[mailboxNotificationIntentKey(intent)] }
function patchFeedback(intent: MailboxNotificationIntent, patch: Partial<MailboxNotificationFeedback>) {
  const subject = mailboxNotificationSubject(intent), key = mailboxNotificationIntentKey(intent)
  useAppStore.setState(state => ({ mailboxNotificationFeedback: { ...state.mailboxNotificationFeedback, [subject]: {
    ...state.mailboxNotificationFeedback[subject],
    [key]: { state: 'pending', ...state.mailboxNotificationFeedback[subject]?.[key], ...patch } } } }))
}
/** The original Core notice owns the input Run; the message envelope holds historical facts. */
function originalNotice(intent: MailboxNotificationIntent, result: { hostId: string; notification: AgentMuxMessageNotification | null }) {
  const notice = result.notification, previousKey = feedback(intent)?.key
  if (result.hostId !== intent.hostId || !notice || notice.notificationId !== intent.operationId || notice.key.kind !== 'prompt' ||
      notice.key.submissionId !== intent.operationId || notice.mode !== 'steer' || notice.messageIds.length !== 1 ||
      notice.messageIds[0] !== intent.messageId || notice.key.agentSessionId !== intent.recipientSessionId ||
      notice.key.expectedRun.runId !== notice.condition.expectedRun.runId || previousKey && !sameKey(notice.key, previousKey)) throw new Error(
    'The returned receipt does not match this original notification. Check its original operation.')
  return notice
}
/** A late transport error cannot undo an already observed result of the same original operation. */
function observe(intent: MailboxNotificationIntent, result: MailboxNotificationFeedback) {
  const previous = feedback(intent)
  const retained = previous && (previous.state === 'submitted' || previous.state === 'not-applied' && result.state !== 'submitted')
  patchFeedback(intent, retained ? { ...result, state: previous.state, reason: previous.reason, sending: false, checking: undefined }
    : { ...result, ...(settled(result.state) ? { sending: false, checking: undefined } : {}) })
}

/** Durable client correlation is separate from transient observations of the original Core receipt. */
export function useMailboxNotifications(reference: SessionHistoryReference, messages: readonly AgentMuxMessageMetadata[]) {
  const subject = mailboxNotificationSubject({ hostId: reference.hostId, participantSessionId: reference.agentSessionId })
  const intents = useAppStore(state => state.mailboxNotificationIntents[subject] ?? EMPTY_INTENTS)
  const observations = useAppStore(state => state.mailboxNotificationFeedback[subject] ?? EMPTY_FEEDBACK)
  const histories = useAppStore(state => state.mailboxNotificationHistory[subject] ?? EMPTY_HISTORY)
  const scope = (messageId: string) => mailboxNotificationScope({ hostId: reference.hostId, participantSessionId: reference.agentSessionId, messageId })
  const byMessage = useMemo(() => {
    const index = new Map<string, MailboxNotificationIntent[]>()
    for (const intent of Object.values(intents).reverse()) {
      const group = index.get(intent.messageId) ?? []
      group.push(intent); index.set(intent.messageId, group)
    }
    for (const group of index.values()) group.sort((a, b) => b.createdAt - a.createdAt)
    return index
  }, [intents, reference.hostId, reference.agentSessionId])
  const matchingIntents = (messageId: string) => byMessage.get(messageId) ?? []
  function attemptFor(intent: MailboxNotificationIntent, message: Message): Attempt {
    const observation = observations[mailboxNotificationIntentKey(intent)]
    const metadata = message.notification?.notificationId === intent.operationId ? message.notification : undefined
    const confirmed = metadata?.state === 'submitted'
    // A missing association cannot establish this retained manual operation's outcome.
    const metadataState = metadata?.state === 'unassociated' ? 'unconfirmed' : metadata?.state
    return { ...intent, ...observation, state: confirmed ? 'submitted' : observation?.state ?? metadataState ?? 'unchecked',
      reason: observation ? observation.reason : metadata?.reason,
      ...(confirmed ? { sending: false, checking: undefined, reason: undefined } : {}),
      pending: !confirmed && Boolean(observation?.sending || observation?.checking) }
  }
  useEffect(() => {
    for (const message of messages) {
      if (message.notification?.state !== 'submitted') continue
      const intent = matchingIntents(message.envelope.messageId).find(item => item.operationId === message.notification!.notificationId)
      if (!intent) continue
      const previous = feedback(intent)
      if (previous?.state === 'submitted' && !previous.sending && !previous.checking) continue
      observe(intent, { state: 'submitted', reason: undefined })
    }
  }, [messages, intents, reference.hostId, reference.agentSessionId])
  const currentAttempt = (message: Message) => {
    const intent = matchingIntents(message.envelope.messageId)[0]
    return intent ? attemptFor(intent, message) : undefined
  }
  async function notify(message: Message, refresh: () => void | Promise<void>) {
    const messageId = message.envelope.messageId
    // This fence concerns only the exact in-flight human action, across all mounted consumers.
    const state = useAppStore.getState()
    if (Object.values(state.mailboxNotificationIntents[subject] ?? EMPTY_INTENTS).some(intent => mailboxNotificationScope(intent) === scope(messageId) &&
      state.mailboxNotificationFeedback[subject]?.[mailboxNotificationIntentKey(intent)]?.sending)) return
    const intent: MailboxNotificationIntent = { hostId: reference.hostId, participantSessionId: reference.agentSessionId, messageId,
      recipientSessionId: message.envelope.recipientSessionId!, operationId: mintObjectId(), createdAt: Date.now(),
      ...(message.envelope.recipientRunId ? { recipientRunId: message.envelope.recipientRunId } : {}) }
    patchFeedback(intent, { state: 'pending', sending: true })
    try {
      const preserved = await retainMailboxNotificationIntent(intent)
      if (preserved.reason) patchFeedback(intent, { preservationIssue: `Saving this request locally is unconfirmed: ${preserved.reason}` })
      const result = await api.sessions.notifyMessage(reference, messageId, intent.operationId)
      const notice = originalNotice(intent, result)
      observe(intent, { state: notice.state, key: notice.key, wire: notice.wire, sending: false, reason: notice.reason })
    } catch (error) {
      observe(intent, { state: 'unconfirmed', sending: false, reason: error instanceof Error ? error.message : String(error) })
    }
    void refresh()
  }
  async function readEvents(target: Pick<MailboxNotificationIntent, 'hostId' | 'participantSessionId' | 'messageId' | 'recipientSessionId'>,
    continuation?: MailboxNotificationFeedback['older']) {
    const owner = mailboxNotificationSubject(target), id = mailboxNotificationScope(target)
    const prior = useAppStore.getState().mailboxNotificationHistory[owner]?.[id], request = mintObjectId()
    useAppStore.setState(state => ({ mailboxNotificationHistory: { ...state.mailboxNotificationHistory,
      [owner]: { ...state.mailboxNotificationHistory[owner],
        [id]: { events: [], ...state.mailboxNotificationHistory[owner]?.[id], loading: request, error: undefined } } } }))
    try {
      const page = await api.sessions.messageEvents({ hostId: target.hostId, agentSessionId: target.participantSessionId }, {
        messageId: target.messageId, limit: 50, ...(continuation ? continuation : { latest: true }) })
      if (page.hostId !== target.hostId || page.participantSessionId !== target.participantSessionId || page.messageId !== target.messageId ||
          prior?.incarnation && page.incarnation !== prior.incarnation ||
          continuation && (page.incarnation !== continuation.incarnation || page.throughSequence !== continuation.throughSequence || page.beforeSequence !== continuation.beforeSequence) ||
          page.events.some(event => event.messages.some(ref => ref.messageId !== target.messageId || ref.recipientSessionId !== target.recipientSessionId ||
            ref.senderSessionId !== target.participantSessionId && ref.recipientSessionId !== target.participantSessionId)))
        throw new Error('The returned event page does not belong to this original message and participant.')
      useAppStore.setState(state => {
        const current = state.mailboxNotificationHistory[owner]?.[id]
        if (current?.loading !== request) return state
        const events = new Map((current.incarnation === page.incarnation ? current.events : []).map(event => [event.sequence, event]))
        for (const event of page.events) events.set(event.sequence, event)
        return { mailboxNotificationHistory: { ...state.mailboxNotificationHistory, [owner]: {
          ...state.mailboxNotificationHistory[owner], [id]: {
          events: [...events.values()].sort((a, b) => a.sequence - b.sequence), incarnation: page.incarnation,
          older: page.nextBeforeSequence === null ? undefined : { beforeSequence: page.nextBeforeSequence,
            throughSequence: page.throughSequence, incarnation: page.incarnation }
        } } } }
      })
      const originalIntents = new Map(Object.values(useAppStore.getState().mailboxNotificationIntents[owner] ?? EMPTY_INTENTS)
        .filter(intent => mailboxNotificationScope(intent) === id).map(intent => [intent.operationId, intent]))
      for (const event of page.events) {
        if (event.kind !== 'a2a-notification-result' || !event.notificationId || event.state !== 'submitted' && event.state !== 'not-applied' && event.state !== 'unconfirmed') continue
        const intent = originalIntents.get(event.notificationId)
        if (intent) observe(intent, { state: event.state, reason: event.reason, sending: false })
      }
      return page
    } catch (error) {
      useAppStore.setState(state => state.mailboxNotificationHistory[owner]?.[id]?.loading !== request ? state : {
        mailboxNotificationHistory: { ...state.mailboxNotificationHistory, [owner]: { ...state.mailboxNotificationHistory[owner],
          [id]: { ...state.mailboxNotificationHistory[owner]![id]!, loading: undefined,
            error: error instanceof Error ? error.message : String(error) } } } })
      throw error
    }
  }
  async function inspect(intent: MailboxNotificationIntent, refresh: () => void | Promise<void>, continuation?: MailboxNotificationFeedback['older']) {
    const previous = feedback(intent)
    if (previous?.checking) return
    const request = mintObjectId(), original = { hostId: intent.hostId, agentSessionId: intent.participantSessionId }
    patchFeedback(intent, { checking: request })
    let eventIssue: string | undefined
    try {
      // One explicit read, one bounded page for this MID. Continuations retain the original journal boundary.
      try {
        const page = await readEvents(intent, continuation)
        patchFeedback(intent, { older: page.nextBeforeSequence === null ? undefined : {
          beforeSequence: page.nextBeforeSequence, throughSequence: page.throughSequence, incarnation: page.incarnation } })
        const results = page.events.filter(event => event.kind === 'a2a-notification-result' && event.notificationId === intent.operationId)
        const result = results.find(event => event.state === 'submitted') ?? results.at(-1)
        if (result?.state === 'unconfirmed') eventIssue = result.reason ?? 'The original notification result is unconfirmed.'
      } catch (error) { eventIssue = error instanceof Error ? error.message : String(error) }
      const result = await api.sessions.inspectMessageNotification(original, intent.messageId, intent.operationId)
      if (!result.notification) throw new Error('No original notification record was found in this read. Nothing was replayed; the original outcome remains unconfirmed.')
      const notice = originalNotice(intent, result)
      observe(intent, { key: notice.key, wire: notice.wire, state: notice.state, sending: false,
        reason: notice.reason ?? (settled(notice.state) ? undefined : eventIssue ?? 'The original input has no confirmed submission receipt. Check this same operation.') })
    } catch (error) {
      observe(intent, { state: 'unconfirmed', sending: false, reason: error instanceof Error ? error.message : eventIssue ?? String(error) })
    } finally {
      if (feedback(intent)?.checking === request) patchFeedback(intent, { checking: undefined })
      void refresh()
    }
  }
  const render = (message: Message, refresh: () => void | Promise<void>, recipientName = message.envelope.recipientSessionId!) => {
    if (message.deliveryMode !== 'reference' || !message.envelope.recipientSessionId) return null
    const attempts = matchingIntents(message.envelope.messageId).map(intent => attemptFor(intent, message)), attempt = attempts[0]
    const target = `${recipientName} (${message.envelope.recipientSessionId}) on ${reference.hostId}`
    const inspectButton = (item: Attempt, earlier = false) => <button key={`${item.operationId}:${earlier ? 'earlier' : 'inspect'}`} type="button" className="composer-tool" data-mailbox-notification-action={earlier ? 'earlier' : 'inspect'}
      aria-label={earlier ? 'Read earlier receipts' : item.state === 'unchecked' ? 'Check receipt' : 'Refresh receipt'}
      title={`${earlier ? 'Read earlier results for' : 'Check'} original operation ${item.operationId} · ${target}`} aria-disabled={Boolean(item.checking)}
      onClick={() => void inspect(item, refresh, earlier ? item.older : undefined)}><RefreshIcon size={14} aria-hidden="true" /><span>{earlier ? 'Read earlier receipts' : item.state === 'unchecked' ? 'Check receipt' : 'Refresh receipt'}</span></button>
    const attemptDetails = (item: Attempt) => <><p>Operation <code>{item.operationId}</code></p>
      <p>To {target}</p>
      {item.recipientRunId ? <p>Original message Run <code>{item.recipientRunId}</code></p> : null}
      {item.key ? <p>Notification input Run <code>{item.key.expectedRun.runId}</code></p> : null}
      <p>{item.reason ?? (item.state === 'unchecked' ? 'The original request is retained. Check its result; no notification will be sent.'
        : 'This is the notification input receipt. Reading and task acceptance are separate.')}</p>
      {item.preservationIssue ? <p>{item.preservationIssue}</p> : null}{item.older ? inspectButton(item, true) : null}</>
    const historyTarget = { hostId: reference.hostId, participantSessionId: reference.agentSessionId,
      messageId: message.envelope.messageId, recipientSessionId: message.envelope.recipientSessionId }
    const history = histories[mailboxNotificationScope(historyTarget)]
    const recorded = new Map<string, NonNullable<typeof history>['events'][number]>()
    for (const event of history?.events ?? []) {
      if (!event.notificationId || event.kind !== 'a2a-notification' && event.kind !== 'a2a-notification-result') continue
      const previous = recorded.get(event.notificationId)
      if (previous?.state !== 'submitted') recorded.set(event.notificationId, event)
    }
    const readHistory = (continuation?: MailboxNotificationFeedback['older']) => { void readEvents(historyTarget, continuation).catch(() => {}) }
    const journalDetails = <details className="composer-mailbox__notification-journal" onToggle={event => {
        if (event.currentTarget.open && !useAppStore.getState().mailboxNotificationHistory[subject]?.[mailboxNotificationScope(historyTarget)]) readHistory()
      }}><summary>Notification history</summary>
        <p>Original notification records for this message. They do not confirm reading or task acceptance.</p>
        {[...recorded.values()].reverse().map(event => <section key={event.notificationId} data-notification-history-operation={event.notificationId}>
          <p>Notification: {event.state === 'not-applied' ? 'not applied' : event.state}</p><p>Operation <code>{event.notificationId}</code></p>
          {event.reason ? <p>{event.reason}</p> : null}
        </section>)}
        {history?.error ? <p role="status">{history.error}</p> : history && !history.loading && !recorded.size ? <p>No notification record in this page. The original operation is not replayed.</p> : null}
        <button type="button" className="composer-tool" data-mailbox-notification-action="history" disabled={Boolean(history?.loading)}
          onClick={() => readHistory()}>{history?.loading ? 'Reading notification history…' : 'Refresh notification history'}</button>
        {history?.older ? <button type="button" className="composer-tool" data-mailbox-notification-action="history-earlier" disabled={Boolean(history.loading)}
          onClick={() => readHistory(history.older)}>Read earlier notification history</button> : null}
      </details>
    return <div className="composer-mailbox__notification-controls" data-notification-operation={attempt?.operationId}>
      <div className="composer-mailbox__notification-actions">
        {attempt && !settled(attempt.state) ? inspectButton(attempt) : null}
        <button key="notify" type="button" className="composer-tool composer-mailbox__notify" data-mailbox-notification-action="notify"
          aria-label={`${attempt ? 'Notify again' : 'Notify now'}: ${recipientName}`} title={`${attempt ? 'Send a separate notification to' : 'Notify'} ${target} using this saved message reference`}
          aria-disabled={attempts.some(item => item.sending)} onClick={() => void notify(message, refresh)}>
          <SendIcon size={14} aria-hidden="true" /><span>{attempt ? 'Notify again' : 'Notify now'}</span></button>
        <span className="composer-mailbox__notification-target" title={target}>To {recipientName}</span>
      </div>
      {attempt ? <div className="composer-mailbox__action-feedback composer-mailbox__notification-feedback" role="status">
        {attempt.reason ? <p className="composer-mailbox__notification-reason" title={attempt.reason}>{attempt.reason}</p> : null}
        <details><summary>This notification: {status(attempt)}</summary>{attemptDetails(attempt)}{settled(attempt.state) ? inspectButton(attempt) : null}
          {attempts.length > 1 ? <details className="composer-mailbox__notification-history"><summary>Other notification attempts ({attempts.length - 1})</summary>
            {attempts.slice(1).map(item => <section key={item.operationId} data-notification-operation={item.operationId}><p>Notification: {status(item)}</p>
              {attemptDetails(item)}{inspectButton(item)}</section>)}
          </details> : null}
          {journalDetails}
        </details>
      </div> : null}
      {!attempt ? journalDetails : null}
    </div>
  }
  return { render, attempt: currentAttempt }
}
