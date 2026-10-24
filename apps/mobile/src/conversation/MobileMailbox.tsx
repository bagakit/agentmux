import { inputMailboxItemKey, inputMailboxKey, useAgentInputMailbox } from '@agentmux/client-ui/use-agent-input-mailbox'
import { InputMailboxRecords, inputMailboxPresentation } from '@agentmux/client-ui/components/InputMailboxRecords'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import type { ClientDeliveryDiagnostics } from '@agentmux/client-ui/delivery-diagnostics'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { conversationRecordId, projectSessionInputs, type ConversationInputEntity } from '@agentmux/core/conversation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxAgentSession, AgentSessionUserMessage } from '@agentmux/core'
import { ConversationMessage, speakerOfUserMessage, type ClientUiPlatform, type DescribeSpeaker } from '@agentmux/client-ui'
import type { ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import { InputHistoryList, InputHistoryOriginalRecords, type InputHistoryLocalEntry } from '@agentmux/client-ui/components/InputHistoryList'
import { useAgentInputHistory, type InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import type { PromptAttempt } from './local-drafts'

const ThemeObjectMailboxIcon = semanticIconComponent('object.mailbox')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')

function sameOriginalReading(a: AgentSessionUserMessage, b: AgentSessionUserMessage) {
  return a === b || Boolean(a.sourceRecord && b.sourceRecord && a.sourceRecord.revision === b.sourceRecord.revision &&
    conversationRecordId(a.sourceRecord.record) === conversationRecordId(b.sourceRecord.record))
}

/** A client presentation of original Core messages and state, never a second mailbox owner. */
export function MobileMailbox({ client, session, connected, messages, inputs, sourceHostId, platform, describeSpeaker, refresh, terminal,
  historyScope, readHistory, onHistoryFill, onHistoryCopy, localEntries = [], onHistoryFillLocal, promptAttempts = [], diagnostics, reading, visible = true }: {
  client?: AgentMuxHostedClient | null; session: AgentMuxAgentSession | null; connected: boolean; messages: readonly AgentSessionUserMessage[]; platform: ClientUiPlatform;
  inputs?: readonly ConversationInputEntity[]; sourceHostId?: string
  describeSpeaker: DescribeSpeaker; refresh(): void; terminal?: () => void
  historyScope: string; readHistory: InputHistoryRead; reading?: ConversationReadingProps; visible?: boolean
  onHistoryFill(message: AgentSessionUserMessage, signal: AbortSignal): Promise<string | void>
  onHistoryCopy(message: AgentSessionUserMessage, signal: AbortSignal): Promise<boolean>
  localEntries?: readonly InputHistoryLocalEntry[]
  onHistoryFillLocal?(entry: InputHistoryLocalEntry): void
  promptAttempts?: readonly [string, PromptAttempt][]
  diagnostics?: ClientDeliveryDiagnostics
}) {
  // Hosted reads use the connection's local route; Session.hostId identifies the execution owner.
  const hostId = 'local'
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<{ scope: string; message: AgentSessionUserMessage } | null>(null)
  const action = useRef<AbortController | null>(null)
  const readInputMailbox = useCallback(async (input: import('@agentmux/core/agent-input-mailbox').AgentInputMailboxRead) => {
    if (!client) throw new Error('原发送信箱尚未连接；原消息保留。')
    return await client.readAgentInputMailbox(input)
  }, [client])
  const mailbox = useAgentInputMailbox({ hostId, agentSessionId: session?.agentSessionId ?? '',
    enabled: open && visible && connected && Boolean(session && client), read: readInputMailbox })
  useEffect(() => {
    if (!client || !open || !visible || !session) return
    return client.onEvent(event => {
      if (event.type === 'agent-input-recorded' && event.agentSessionId === session.agentSessionId ||
          event.type === 'agent-input' && event.receipt.key.agentSessionId === session.agentSessionId ||
          event.type === 'connection-state' && event.state === 'restored') void mailbox.refresh()
    })
  }, [client, open, visible, session?.agentSessionId, mailbox.refresh])
  const history = useAgentInputHistory({ scope: historyScope, enabled: open && visible, read: readHistory, initialMessages: messages })
  const originalHostId = sourceHostId && history.sourceHostId && sourceHostId !== history.sourceHostId
    ? undefined : history.sourceHostId ?? sourceHostId
  const groups = useMemo(() => projectSessionInputs({ hostId, agentSessionId: session?.agentSessionId ?? '',
    ...(originalHostId ? { sourceHostId: originalHostId } : {}), messages: history.messages,
    ...(inputs ? { inputs } : {}), mailbox: mailbox.items }), [session?.agentSessionId, originalHostId, history.messages, inputs, mailbox.items])
  const selectedOriginal = selection?.scope === historyScope ? selection.message : null
  const selectedGroup = selectedOriginal ? groups.find(group => group.messages.some(message => sameOriginalReading(message, selectedOriginal))) : undefined
  const groupedMessages = [
    ...(selectedOriginal && !selectedGroup ? [selectedOriginal] : []),
    ...groups.flatMap(group => group === selectedGroup && selectedOriginal ? [selectedOriginal]
      // An open original version stays readable until released; its newer version cannot reuse that row.
      : !group.mailbox.length && group.primary && group.primary.id !== selectedOriginal?.id ? [group.primary] : [])]
  const groupedHistory = { ...history, messages: groupedMessages }
  const relatedMessages = new Map(groups.flatMap(group => {
    const primary = group === selectedGroup ? selectedOriginal : !group.mailbox.length ? group.primary : null
    return primary ? [[primary.id, group.messages.filter(message => !sameOriginalReading(message, primary))] as const] : []
  }))
  const selectedJournalKeys = new Set(selectedGroup?.mailbox.map(item => inputMailboxItemKey(hostId, item)) ?? [])
  const mailboxGroups = new Map(groups.flatMap(group => group.mailbox.map(item => [inputMailboxItemKey(hostId, item), group] as const)))
  // A history query may match an original contribution absent from the journal body.
  const matchedMailbox = { ...mailbox, items: mailbox.items.filter(item => !history.query ||
    mailboxGroups.get(inputMailboxItemKey(hostId, item))?.messages.length || inputMailboxPresentation(item).text?.includes(history.query)) }
  useEffect(() => {
    action.current?.abort()
    return () => { action.current?.abort() }
  }, [historyScope])
  function changeOpen(next: boolean) {
    if (!next) action.current?.abort()
    setOpen(next)
  }
  useEffect(() => { if (!visible) changeOpen(false) }, [visible])
  function originalAction<T>(message: AgentSessionUserMessage, run: (message: AgentSessionUserMessage, signal: AbortSignal) => Promise<T>) {
    action.current?.abort()
    const controller = new AbortController(); action.current = controller
    return run(message, controller.signal)
  }
  const readMessage = (message: AgentSessionUserMessage) => <ConversationMessage {...reading} copyInParent
    messageId={message.id} conversationSessionId={message.agentSessionId}
    content={message.contentParts.length ? message.contentParts : message.content} inputSource={message.source}
    {...(message.questionAnswers ? { questionAnswers: message.questionAnswers } : {})}
    {...(message.questionDiagnostic ? { questionDiagnostic: message.questionDiagnostic } : {})}
    speaker={speakerOfUserMessage(message)} describeSpeaker={describeSpeaker}
    {...(message.source.kind === 'native' ? { nativeResourceRecord: { source: { providerId: message.source.providerId, nativeSessionId: message.source.nativeSessionId }, recordId: message.source.recordId,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }) } } : {})}
    {...(message.deliveryStatus ? { status: message.deliveryStatus } : {})}
    {...(message.recordedAt === undefined ? {} : { createdAt: message.recordedAt })} />
  const historyActions = { onRead: readMessage, onFill: (message: AgentSessionUserMessage) => originalAction(message, onHistoryFill),
    onCopy: (message: AgentSessionUserMessage) => originalAction(message, onHistoryCopy) }
  const recordedKeys = new Set(mailbox.items.map(item => inputMailboxItemKey(session?.hostId ?? '',item)))
  const localIntents = localEntries.filter(entry => !entry.inputOrigin || !recordedKeys.has(inputMailboxKey(entry.inputOrigin.hostId,entry.inputOrigin.key)))
  const unrecordedAttempts = promptAttempts.filter(([, attempt]) =>
    !(attempt.inputReceipt && attempt.originalHostId && recordedKeys.has(inputMailboxKey(attempt.originalHostId, attempt.inputReceipt.key))) &&
    (attempt.inputReceipt || attempt.logId || attempt.phase !== 'confirmed'))
  const state = session?.semanticStatus?.state
  const stateLabels: Readonly<Record<string, string>> = { working: '执行中', running: '状态未确认', starting: '启动中', waiting: '等待输入', blocked: '需要处理', done: '已完成', error: '出错', exited: '已结束', disconnected: '状态未知' }
  const label = !connected ? '连接中断 · 最近状态保留' : session?.pendingInteraction ? '需要回应' : stateLabels[state ?? ''] ?? '状态未知'
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger className="mobile-message-tools__trigger" aria-label={`输入历史与通信记录 · ${label}`} title="输入历史与通信记录"><ThemeObjectMailboxIcon size={16} /><span>历史</span><i data-state={state ?? 'unknown'} /></Dialog.Trigger>
    <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-message-tools" aria-describedby="mobile-message-tools-description">
      <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>输入历史与通信记录</Dialog.Title><Dialog.Close className="mobile-icon-button" aria-label="关闭通信记录"><SemanticIcon name="action.close" size={19} /></Dialog.Close></div>
      <Dialog.Description id="mobile-message-tools-description">{session?.providerId ?? 'Agent'} · {label}</Dialog.Description>
      <div className="mobile-message-tools__actions"><button className="mobile-text-button" onClick={() => { refresh(); history.search(); void mailbox.refresh() }}><ThemeActionRefreshIcon size={16} />刷新消息</button>{terminal && <button className="mobile-text-button" onClick={() => { changeOpen(false); terminal() }}><ThemeObjectTerminalIcon size={16} />查看 Terminal</button>}</div>
      <section className="mobile-message-tools__records" aria-label="通信记录">
        {unrecordedAttempts.length > 0 ? <div className="mobile-message-tools__attempts" aria-label="本机投递回执">
          {unrecordedAttempts.map(([key, attempt]) => {
            const waiting = attempt.inputReceipt?.control.waiting
            const failure = waiting?.phase === 'native-environment' ? waiting.observation?.failure : waiting?.failure
            return <div key={key} className="mobile-message-tools__attempt" data-operation-id={attempt.operationId} data-phase={attempt.phase}>
              <MessageDeliveryFailure compact error={failure ?? diagnostics?.get(attempt.logId ?? '')?.record.error ?? attempt.message}
                inputUnconfirmed={!attempt.inputReceipt && attempt.phase === 'unknown'}
                logId={attempt.logId} log={attempt.logId ? diagnostics?.get(attempt.logId) : undefined}
                inputReceipt={attempt.inputReceipt} inputStopReceipt={attempt.manualInput?.stopReceipt}
                copyText={text => platform.copyText(text, () => {})} />
              <small className="mobile-message-tools__attempt-meta">原操作 {attempt.operationId}{attempt.runId ? ` · 原 Run ${attempt.runId}` : ''}</small>
            </div>
          })}
        </div> : null}
        <InputMailboxRecords refreshInParent mailbox={matchedMailbox} hostId={hostId} reading={reading}
          inputGroup={item => mailboxGroups.get(inputMailboxItemKey(hostId, item))}
          onCopy={text => platform.copyText(text, () => {})} renderRelated={item => {
            const key = inputMailboxItemKey(hostId, item)
            const messages = mailboxGroups.get(key)?.messages.filter(message => !selectedOriginal || !selectedJournalKeys.has(key) || !sameOriginalReading(message, selectedOriginal))
            return <InputHistoryOriginalRecords messages={messages ?? []} {...historyActions} />
          }} renderRecords={records => <InputHistoryList history={groupedHistory} relatedMessages={relatedMessages}
            relatedContent={new Map(selectedOriginal && selectedJournalKeys.size ? [[selectedOriginal.id,
              <ol className="input-history__records" aria-label="本次输入的原登记与回执">{records.filter(record => selectedJournalKeys.has(record.key)).map(record => record.node)}</ol>]] : [])}
            onReadingChange={message => setSelection(message ? { scope: historyScope, message } : null)}
            additionalRecords={records.filter(record => !selectedJournalKeys.has(record.key))} localEntries={localIntents}
            {...(onHistoryFillLocal ? { onFillLocal: onHistoryFillLocal } : {})} {...historyActions} />} />
      </section>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
