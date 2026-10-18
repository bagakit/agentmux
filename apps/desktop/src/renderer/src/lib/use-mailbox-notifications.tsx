import { useEffect, useRef, useState } from 'react'
import type { AgentMuxMessageMetadata, AgentPromptInputKey } from '@agentmux/core'
import { agentPromptNotApplied } from '@agentmux/core/prompt-condition'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from './api'

const SendIcon = semanticIconComponent('action.send')
const RefreshIcon = semanticIconComponent('action.refresh')
type Message = Pick<AgentMuxMessageMetadata, 'envelope' | 'deliveryMode' | 'notification'>
type Attempt = { operationId: string; key?: AgentPromptInputKey; wire?: string; pending: boolean; state: 'pending' | 'submitted' | 'unconfirmed' | 'not-applied'; reason?: string }
const sameKey = (a: AgentPromptInputKey, b: AgentPromptInputKey) => a.kind === 'prompt' && b.kind === 'prompt' &&
  a.agentSessionId === b.agentSessionId && a.expectedRun.runId === b.expectedRun.runId && a.submissionId === b.submissionId
const label = (attempt: Attempt) => 'This notification: ' + (attempt.pending ? 'checking…' : attempt.state === 'submitted' ? 'submitted'
  : attempt.state === 'not-applied' ? 'not applied' : attempt.state === 'pending' ? 'pending' : 'unconfirmed')

/** Local action feedback survives reading/folder changes; original business facts remain in Core. */
export function useMailboxNotifications(reference: SessionHistoryReference, messages: readonly AgentMuxMessageMetadata[]) {
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({})
  const busy = useRef(new Set<string>())
  const identity = (messageId: string) => JSON.stringify([reference.hostId, reference.agentSessionId, messageId])
  const save = (id: string, attempt: Attempt) => setAttempts(previous => {
    const confirmed = previous[id]
    return { ...previous, [id]: confirmed?.operationId === attempt.operationId && confirmed.state === 'submitted' && attempt.state !== 'submitted'
      ? { ...confirmed, pending: attempt.pending } : attempt }
  })
  useEffect(() => {
    setAttempts(previous => {
      let next = previous
      for (const message of messages) {
        const id = identity(message.envelope.messageId), saved = previous[id]
        if (!saved || saved.state === 'submitted' || message.notification?.notificationId !== saved.operationId || message.notification.state !== 'submitted') continue
        const { reason: _previousReason, ...confirmed } = saved
        next = { ...next, [id]: { ...confirmed, state: 'submitted' } }
      }
      return next
    })
  }, [messages, reference.hostId, reference.agentSessionId])
  const currentAttempt = (message: Message) => {
    const saved = attempts[identity(message.envelope.messageId)]
    if (saved && message.notification?.notificationId === saved.operationId && message.notification.state === 'submitted') {
      const { reason: _previousReason, ...confirmed } = saved
      return { ...confirmed, state: 'submitted' as const }
    }
    return saved
  }
  async function notify(message: Message, refresh: () => void | Promise<void>) {
    const messageId = message.envelope.messageId, id = identity(messageId)
    if (busy.current.has(id)) return
    busy.current.add(id)
    const operationId = crypto.randomUUID()
    const key = message.envelope.recipientSessionId && message.envelope.recipientRunId ? {
      kind: 'prompt' as const, agentSessionId: message.envelope.recipientSessionId,
      expectedRun: { runId: message.envelope.recipientRunId }, submissionId: operationId
    } : undefined
    let attempt: Attempt = { operationId, ...(key ? { key } : {}), pending: true, state: 'pending' }
    save(id, attempt)
    try {
      const result = await api.sessions.notifyMessage(reference, messageId, operationId)
      const notice = result.notification
      if (result.hostId !== reference.hostId || notice.notificationId !== operationId || notice.key.submissionId !== operationId || notice.mode !== 'steer' || notice.messageIds.length !== 1 ||
          notice.messageIds[0] !== messageId || notice.key.agentSessionId !== message.envelope.recipientSessionId ||
          (key && !sameKey(notice.key, key))) throw new Error('The returned receipt does not match this original notification. Refresh its original operation.')
      attempt = { operationId, key: notice.key, wire: notice.wire, pending: false, state: notice.state, ...(notice.reason ? { reason: notice.reason } : {}) }
    } catch (error) {
      attempt = { ...attempt, pending: false, state: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) }
    } finally { busy.current.delete(id) }
    save(id, attempt)
    void refresh()
  }
  async function inspect(messageId: string, attempt: Attempt, refresh: () => void | Promise<void>) {
    const id = identity(messageId)
    if (busy.current.has(id)) return
    busy.current.add(id); save(id, { ...attempt, pending: true })
    try {
      let key = attempt.key
      if (!key) {
        const original = await api.sessions.readMessage(reference, messageId)
        const notification = original.message?.notification
        if (original.hostId !== reference.hostId || original.message?.envelope.messageId !== messageId ||
            notification?.notificationId !== attempt.operationId || !notification.key) throw new Error('The original notification key is not yet confirmed. Keep this operation ID and refresh its receipt.')
        key = notification.key
      }
      const { record } = await api.sessions.inspectMessageNotification(reference, messageId, key)
      const claim = record?.admission, intent = claim?.intent, content = intent?.message
      if (!record || record.agentSessionId !== key.agentSessionId || record.run.runId !== key.expectedRun.runId ||
          !claim?.inputKey || !sameKey(claim.inputKey, key) || claim.submissionId !== attempt.operationId ||
          intent?.run.runId !== key.expectedRun.runId || intent.execution !== 'immediate' || intent.admissionIntent?.kind !== 'manual-actor' ||
          intent.admissionIntent.expectedRun.runId !== key.expectedRun.runId || content?.a2aNotificationId !== attempt.operationId ||
          typeof content.systemContext !== 'string' || !content.systemContext || intent.prompt !== content.systemContext ||
          Object.keys(content).some(name => name !== 'a2aNotificationId' && name !== 'systemContext') ||
          (attempt.wire !== undefined && content.systemContext !== attempt.wire)) throw new Error('The original notification input receipt is still unconfirmed. No notification was replayed.')
      const submitted = claim.acknowledged === true || record.terminalPromptSubmission?.submit.acknowledged === true
      const notApplied = agentPromptNotApplied({ run: record.run, promptCompletionAdmission: claim,
        ...(record.terminalPromptSubmission ? { terminalPromptSubmission: record.terminalPromptSubmission } : {}) }) !== undefined
      const { reason: _previousReason, ...retained } = attempt
      save(id, { ...retained, key, pending: false, state: submitted ? 'submitted' : notApplied ? 'not-applied' : 'unconfirmed',
        ...(submitted || notApplied ? {} : { reason: 'The original input has no confirmed submission receipt. Refresh this same operation.' }) })
    } catch (error) {
      save(id, { ...attempt, pending: false, reason: error instanceof Error ? error.message : String(error) })
    } finally { busy.current.delete(id) }
    void refresh()
  }
  const render = (message: Message, refresh: () => void | Promise<void>) => {
    if (message.deliveryMode !== 'reference' || !message.envelope.recipientSessionId) return null
    const attempt = currentAttempt(message)
    return <><button type="button" className="composer-tool composer-mailbox__notify" aria-label="Notify now"
      title="Notify the original recipient now using this saved message reference" disabled={attempt?.pending}
      onClick={() => void notify(message, refresh)}><SendIcon size={14} aria-hidden="true" /><span>Notify now</span></button>
      {attempt ? <div className="composer-mailbox__action-feedback composer-mailbox__notification-feedback" role="status" data-notification-operation={attempt.operationId}>
        <details><summary>{label(attempt)}</summary><p>Operation <code>{attempt.operationId}</code></p>
          <p>{attempt.reason ?? 'This is the notification input receipt. Reading and task acceptance are separate.'}</p></details>
        <button type="button" className="composer-tool" aria-label="Refresh receipt" title="Refresh this original notification receipt" disabled={attempt.pending}
          onClick={() => void inspect(message.envelope.messageId, attempt, refresh)}><RefreshIcon size={14} aria-hidden="true" /></button>
      </div> : null}</>
  }
  return { render, attempt: currentAttempt }
}
