import { useMobileCommands } from './use-mobile-commands'
import { consumeProgrammaticReadingScroll, markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import type { ConversationPresentationController } from '@agentmux/client-ui/use-conversation-record-layout'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import { presentMessageDeliveryFailure } from '@agentmux/client-ui/message-delivery-presentation'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { mobileQuestionReplyState, reconcileMobileQuestionReplies, submitMobileQuestionReply } from './question-replies'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { DeliveryLogDetails } from '@agentmux/client-ui/components/DeliveryLogDetails'
import { initFollowState, onContentChange, onScroll, shouldShowJumpToLatest } from '@agentmux/client-ui/activity-autoscroll'
import { currentAgentSemanticStatus, nativeTargetSourceUnconfirmed } from '@agentmux/core/agent-status'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import {
  AgentComposer, AgentInteractionCard, ClientUiProvider, NativeProcessObservation, ConversationView,
  createSpeakerResolver,
  type ClientUiPlatform, type ConversationMessageProps
} from '@agentmux/client-ui'
import { errorMessage } from './delivery'
import { createLocalDrafts, type PromptAttempt, type ResponseAttempt } from './local-drafts'
import { useHostedConversation, type MobileConnection } from './use-hosted-conversation'
import { MobileMessageTools, MobilePosturePicker } from './MobileMessageTools'
import { MobileSkillsPicker } from './MobileSkillsPicker'
import { MobileMailbox } from './MobileMailbox'
import { MobileAttachments, type MobileAttachmentControls } from './MobileAttachments'
import { fileUploadScopeMatches } from './attachments'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { encodeSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { appendNamedFileReference } from '@agentmux/client-ui/composer-file-reference'
import { formatSessionAddress } from '@agentmux/core/sharing'
import { useMobilePromptController } from './use-mobile-prompt-controller'
import { useMobileInteractionController } from './use-mobile-interaction-controller'
import './conversation.css'
import { DELIVERY_DISMISSAL_STORAGE, MobileNotice, MobileNoticeScope, useMobileNotices } from '../notices/MobileNotice'

export type { MobileConnection } from './use-hosted-conversation'
export type MobileConversationSurfaceProps = Pick<ConversationMessageProps,
  'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink'> & {
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  connection: MobileConnection
  platform: ClientUiPlatform
  onAttach?: () => void
  onShowTerminal?: () => void
  onShowGoals?: (trigger: HTMLButtonElement) => void
  visible?: boolean
  displayName?: string
}
/** A first-party SDK reader and input client. Core owns ordering, authorship and admission. */
export function MobileConversationSurface({ client, agentSessionId, connection, platform, onAttach, onShowTerminal, onShowGoals, visible = true, displayName,
  openWorkspaceFile, readPastedImage, openHttpLink }: MobileConversationSurfaceProps) {
  const conversationPlatform = useMemo(() => ({ ...platform,
    readA2AMessage: async (reference: { hostId: string; agentSessionId: string }, messageId: string, notificationId?: string) => {
      // The selected hosted client owns the local namespace; it cannot route another Host or participant.
      if (!client) throw new Error('The selected Host is unavailable. The original message reference is retained.')
      if (reference.hostId !== 'local' || reference.agentSessionId !== agentSessionId) throw new Error('The original message belongs to another Host or Session. Its reference is retained.')
      return client.readMessage({ messageId, ...(notificationId === undefined ? {} : { notificationId }) })
    }
  }), [platform, client, agentSessionId])
  const feed = useRef<HTMLDivElement>(null), follow = useRef(initFollowState())
  const presentation = useRef<ConversationPresentationController | null>(null)
  const presentationIntent = useRef(0)
  const reading = useHostedConversation(client, agentSessionId, visible && connection.state === 'connected',
    frame => presentation.current?.canPresent(frame, { preserveAnchor: !follow.current.following }) !== false)
  const [jump, setJump] = useState(false)
  useEffect(() => { follow.current = initFollowState(); setJump(false) }, [agentSessionId])
  useLayoutEffect(() => {
    const node = feed.current
    if (!visible || !node) return
    const tail = reading.page?.items.at(-1) ?? reading.timeline?.items.at(-1)
    const change = onContentChange(follow.current, { itemCount: reading.page?.items.length ?? reading.timeline?.items.length ?? 0, lastItemId: tail?.id ?? null, lastItemLength: tail ? JSON.stringify(tail).length : 0 })
    follow.current = change.state
    if (change.scrollToBottom && !reading.olderWindow) node.scrollTop = node.scrollHeight
  }, [reading.page, reading.timeline, reading.olderWindow, visible])
  const [local] = useState(createLocalDrafts)
  const drafts = useRef(local.drafts)
  const [, redraw] = useState(0)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const notices = useMobileNotices()
  const [localDismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(DELIVERY_DISMISSAL_STORAGE)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string').slice(-64)) : new Set()
    } catch { return new Set() }
  })
  const dismissed = notices?.deliveryDismissed ?? localDismissed
  const updateDismissed = (mutate: (next: Set<string>) => void) => notices ? notices.updateDelivery(mutate) : setDismissed(previous => {
    const next = new Set(previous)
    mutate(next)
    try { localStorage.setItem(DELIVERY_DISMISSAL_STORAGE, JSON.stringify([...next].slice(-64))) } catch { /* Presentation preference only. */ }
    return next
  })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const { draftKey, draft, attempt, available, diagnostics, setDraft, submit, sendBodyOnly, confirmedAttachmentPrompt, retryOriginalPrompt, stopManualInput, preparing, preparationIssue,
    historyLocalEntries, retainedAttempts, sessionAttempts, promptWasRefused } = useMobilePromptController({ local, client, agentSessionId,
      session: reading.session, timeline: reading.timeline, connection, disconnected: reading.disconnected, visible, refresh: reading.refresh })
  const attachmentControls = useRef<MobileAttachmentControls>(null)
  const [hasPendingAttachments, setHasPendingAttachments] = useState(false)
  const insertion = useRef<ComposerInsertionHandle>(null)
  const currentActivity = connection.state === 'connected' && reading.activity?.semantic === 'active'
  const retainedActivity = currentAgentSemanticStatus(reading.session?.semanticStatus)
  const workingObservedAt = currentActivity ? reading.activity?.observedAt
    : reading.activity?.lastKnownActivity?.state === 'working' ? reading.activity.lastKnownActivity.observedAt
      : retainedActivity?.state === 'working' ? retainedActivity.observedAt : undefined
  useEffect(() => {
    if (agentSessionId) void reconcileMobileQuestionReplies(local, agentSessionId, reading.session, client?.runtimeOwnerIdentity?.()?.runtimeId).then(changed => { if (changed && mounted.current) redraw(value => value + 1) })
  }, [reading.session, agentSessionId, client, local])

  const session = reading.session
  const isWorking = Boolean(session && (currentActivity || retainedActivity?.state === 'working'))
  const providerCapabilities = (() => {
    try {
      const provider = session?.providerId ? client?.catalog?.().find(entry => entry.id === session.providerId) : undefined
      return { route: provider?.capabilities.asyncQuestionReply, postureControl: provider?.postureControl, commands: provider?.composer?.commands }
    } catch (error) { return { route: undefined, postureControl: undefined, commands: undefined, issue: errorMessage(error) } }
  })()
  const questionCapability = { route: providerCapabilities.route, issue: providerCapabilities.issue }
  const postureControl = providerCapabilities.postureControl
  const [commandMenuOpen, setCommandMenuOpen] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const mobileCommands = useMobileCommands({ client, agentSessionId, providerId: session?.providerId,
    commands: providerCapabilities.commands, visible, connected: connection.state === 'connected' && !reading.disconnected,
    demand: commandMenuOpen || composerFocused })
  const commandSuggestions = mobileCommands.commands
  const agentReferences = useMemo<ComposerSuggestion[]>(() => {
    try {
      return (client?.agentSessions() ?? []).map(peer => {
        const peerId = peer.agentSessionId
        const label = peerId === agentSessionId && displayName ? displayName : `${peer.providerId} (${peerId.slice(0, 6)})`
        const link = formatSessionAddress(peerId)
        return {
          id: `agent:${peerId}`,
          text: `@${label}`,
          label,
          description: `${peer.hostId} · ${peerId}`,
          group: 'Agents',
          searchText: `${label} ${peerId} ${peer.providerId}`,
          insertText: encodeSemanticReference({ kind: 'agent', token: `@${label}`, label, reference: link })
        }
      })
    } catch { return [] }
  }, [client, session, agentSessionId, displayName])
  async function insertSuggestion(item: ComposerSuggestion) {
    if (!insertion.current) {
      setCopyNotice('原编辑器未准备好；草稿保留。')
      return
    }
    try {
      const original = { client, agentSessionId, editor: insertion.current }
      await original.editor.insert(() => mounted.current && current.current.client === original.client &&
        current.current.agentSessionId === original.agentSessionId && insertion.current === original.editor
        ? item.insertText ?? item.text : null, { separate: true })
    } catch (error) {
      setCopyNotice(errorMessage(error))
    }
  }
  async function interruptCurrentTurn() {
    if (!client?.signalAgent || !session || !agentSessionId) return
    try {
      const originalSession = client.agentSession(agentSessionId)
      if (originalSession.agentSessionId !== session.agentSessionId || originalSession.run.runId !== session.run.runId) {
        setCopyNotice('原 Session 或 Run 已改变，未发送中断信号；原草稿保留。')
        return
      }
      await client.signalAgent(originalSession.agentSessionId, { ...originalSession.run }, 'SIGINT')
      setCopyNotice(null)
    } catch (error) {
      setCopyNotice(`中断当前回复未确认：${errorMessage(error)}`)
    }
  }
  async function changePosture(modeId: string) {
    if (!client?.setAgentPosture || !session || !agentSessionId) return
    try {
      const originalSession = client.agentSession(agentSessionId)
      if (originalSession.agentSessionId !== session.agentSessionId || originalSession.run.runId !== session.run.runId) {
        setCopyNotice('原 Session 或 Run 已改变，未切换模式；原草稿保留。')
        return
      }
      await client.setAgentPosture({ agentSessionId: originalSession.agentSessionId, expectedRun: { ...originalSession.run }, modeId })
      setCopyNotice(null)
    } catch (error) {
      setCopyNotice(`模式切换未完成：${errorMessage(error)}`)
    }
  }
  // A reader is scoped to its exact Host connection and persistent Agent, not to a replaceable Run.
  const historyConnection = useRef({ client, generation: 0 })
  if (historyConnection.current.client !== client) historyConnection.current = { client, generation: historyConnection.current.generation + 1 }
  const historyScope = JSON.stringify([historyConnection.current.generation, session?.hostId ?? null, agentSessionId])
  const currentHistory = useRef({ scope: historyScope, client, agentSessionId, visible })
  currentHistory.current = { scope: historyScope, client, agentSessionId, visible }
  const readInputHistory = useCallback<InputHistoryRead>(async (input, signal) => {
    if (!client || !agentSessionId) throw new Error('原 Host 尚未连接，已读取记录和草稿保留。')
    const page = await client.readAgentSessionHistory({ ...input, hostId: 'local', agentSessionId }, { signal })
    if (page.agentSessionId !== agentSessionId || page.hostId !== 'local') throw new Error('历史返回了另一处 Agent 的记录；原列表和草稿保留。')
    return page
  }, [client, agentSessionId])
  async function readHistoryMessage(message: AgentSessionUserMessage, signal: AbortSignal) {
    const original = { scope: historyScope, client, agentSessionId, visible }
    const unchanged = () => mounted.current && currentHistory.current.scope === original.scope &&
      currentHistory.current.client === original.client && currentHistory.current.agentSessionId === original.agentSessionId &&
      currentHistory.current.visible === original.visible
    signal.throwIfAborted()
    if (!unchanged() || message.agentSessionId !== original.agentSessionId) throw new Error('已切换 Agent，原记录保留，当前草稿未改变。')
    const content = await inputHistoryText(message, original.client && original.agentSessionId ? input =>
      original.client!.sessionHistoryResource(original.agentSessionId!, { ...input, signal }) : undefined, signal)
    signal.throwIfAborted()
    if (!unchanged()) throw new Error('已切换 Agent，原记录保留，当前草稿未改变。')
    return content
  }
  function currentHistoryTarget(scope: string) {
    return mounted.current && currentHistory.current.scope === scope && currentHistory.current.client === client &&
      currentHistory.current.agentSessionId === agentSessionId && currentHistory.current.visible
  }
  async function fillHistoryMessage(message: AgentSessionUserMessage, signal: AbortSignal) {
    const originalScope = historyScope, originalEditor = insertion.current
    const before = drafts.current.get(draftKey) ?? ''
    const content = await readHistoryMessage(message, signal)
    signal.throwIfAborted()
    if (!currentHistoryTarget(originalScope) || insertion.current !== originalEditor) throw new Error('原编辑器或 Agent 已切换，原记录保留，当前草稿未改变。')
    if ((drafts.current.get(draftKey) ?? '') !== before) throw new Error('读取期间草稿已更新，保留新稿；可重新选择这条记录。')
    if (!originalEditor) throw new Error('原编辑器已关闭，记录和草稿保留。')
    originalEditor.replace(content.text)
    return content.attachments ? '已填入正文，尚未发送；附件仍在原记录' : undefined
  }
  async function copyHistoryMessage(message: AgentSessionUserMessage, signal: AbortSignal) {
    const originalScope = historyScope
    const content = await readHistoryMessage(message, signal)
    signal.throwIfAborted()
    if (!currentHistoryTarget(originalScope)) throw new Error('已切换 Agent，原记录保留，本次没有复制。')
    let cause: unknown
    const copied = await platform.copyText(content.originalText, error => { cause = error })
    signal.throwIfAborted()
    if (!copied && cause) throw cause
    return copied
  }
  const { request, requestKey, responseUnavailableReason, responseEntry, responseAttempt, responseDisabled,
    respond, inspectResponse, retainedResponses, unidentifiedResponses } = useMobileInteractionController({ local, client,
      agentSessionId, session, available })
  function responseStatus(key: string, attempt: ResponseAttempt) {
    return <aside key={key} className="mobile-send-status" data-phase={attempt.phase} data-original-response={attempt.original!.input.operationId}>
      <MobileNotice identity={[attempt.original?.input.operationId,attempt.phase,attempt.message]} role="status">{attempt.message}</MobileNotice>
      <button type="button" onClick={() => { void inspectResponse(key, attempt).catch(() => {}) }}>查询原答复回执</button>
    </aside>
  }
  const describeSpeaker = useMemo(() => createSpeakerResolver({
    lookupAgent: id => {
      try {
        const author = session?.agentSessionId === id ? session : client?.agentSession(id)
        return author?.agentSessionId === id ? { label: author.agentSessionId === agentSessionId && displayName ? displayName : `${author.providerId} Agent`, providerId: author.providerId } : undefined
      } catch { return undefined }
    },
    ...(session ? { currentSession: { id: session.agentSessionId, label: displayName ?? `${session.providerId} Agent`, providerId: session.providerId } } : {})
  }), [client, session, agentSessionId, displayName])
  // Source-history search is keyed by original records, independently of message entities.
  const mailboxMessages = useMemo(() => reading.projection?.originalRecords.flatMap(record => record.input ? [record.input] : []) ?? [], [reading.projection])
  const appendQuote = (quote: string) => setDraft(`${drafts.current.get(draftKey) ?? ''}${drafts.current.get(draftKey) ? '\n\n' : ''}${quote}`)
  const readHistoryResource = useCallback<NonNullable<ConversationMessageProps['readHistoryResource']>>(input => {
    if (!client || !agentSessionId) throw new Error('原 Host 尚未连接，原资源引用和草稿保留。')
    return client.sessionHistoryResource(agentSessionId, input)
  }, [client, agentSessionId])
  const pageClient = reading.pageOwner?.client, pageSessionId = reading.pageOwner?.agentSessionId
  const readNativeResource = useCallback<NonNullable<ConversationMessageProps['readHistoryResource']>>(input => {
    if (!pageClient || !pageSessionId) throw new Error('原阅读来源尚未确认，原资源引用和草稿保留。')
    return pageClient.sessionHistoryResource(pageSessionId, input)
  }, [pageClient, pageSessionId])
  const readingProps = {
    active: visible,
    ...(session ? { workspaceRoot: session.workspacePath, executionHostId: session.hostId } : {}),
    ...(client && agentSessionId ? { readHistoryResource } : {}),
    ...(openWorkspaceFile ? { openWorkspaceFile } : {}), ...(readPastedImage ? { readPastedImage } : {}),
    ...(openHttpLink ? { openHttpLink } : {}),
    onSelectAnnotation: ({ messageId, quote }: Parameters<NonNullable<ConversationMessageProps['onSelectAnnotation']>>[0]) =>
      appendQuote(`引用会话 ${JSON.stringify(agentSessionId)}，消息 ${JSON.stringify(messageId)}：\n${quote.split('\n').map(line => `> ${line}`).join('\n')}`)
  }
  const { executionHostId: _currentHost, workspaceRoot: _currentWorkspace, ...sharedReadingProps } = readingProps
  const nativeReadingProps = { ...sharedReadingProps,
    ...(reading.pageOwner?.hostId ? { executionHostId: reading.pageOwner.hostId } : {}),
    workspaceRoot: reading.pageOwner?.workspacePath ?? '', readHistoryResource: readNativeResource }
  const renderPromptAttempt = ([key, original]: [string, PromptAttempt]) => {
    const waiting = original.inputReceipt?.control.waiting
    const failure = waiting?.phase === 'native-environment' ? waiting.observation?.failure : waiting?.failure
    const signature = JSON.stringify([key, original.operationId, original.phase, original.phase === 'confirmed' ? original.logId ?? null : null,
      original.inputReceipt?.status ?? null, original.inputReceipt?.ref.waitGeneration ?? null, original.manualInput?.stopReceipt?.cancelOperationId ?? null])
    const clearDismissedForOperation = () => updateDismissed(set => {
      for (const item of [...set]) if (item.includes(JSON.stringify(original.operationId))) set.delete(item)
    })
    const controlledManual = Boolean(original.manualInput && (original.inputReceipt || original.phase === 'sending'))
    if (original.phase !== 'sending' && dismissed.has(signature)) {
      const summary = controlledManual
        ? presentMessageDeliveryFailure({ error: failure ?? diagnostics.get(original.logId ?? '')?.record.error ?? original.message,
            logId: original.logId, log: original.logId ? diagnostics.get(original.logId) : undefined,
            inputReceipt: original.inputReceipt, inputStopReceipt: original.manualInput?.stopReceipt }).title
        : original.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'
      return <aside className="mobile-send-status mobile-send-status--collapsed" key={key} data-phase={original.phase}
        data-collapsed="true" data-manual={Boolean(original.manualInput) || undefined} data-retained={key !== draftKey || undefined}
        data-original-operation={original.operationId} aria-live="polite">
        <span className="mobile-send-status__collapsed-title">{summary}</span>
        <div className="mobile-send-status__actions">
          <button type="button" aria-label="查看投递回执" onClick={() => updateDismissed(set => set.delete(signature))}>查看回执</button>
        </div>
      </aside>
    }
    return <aside
          className="mobile-send-status" key={key} data-phase={original.phase} data-manual={Boolean(original.manualInput) || undefined} data-retained={key !== draftKey || undefined}
          data-original-operation={original.operationId} aria-live="polite">
          {controlledManual ? <>
            {original.phase === 'sending' && !original.inputReceipt ? <p role="status">正在保存这条原消息…</p>
              : original.phase === 'confirmed' && !original.inputReceipt ? <p role="status">先前输入已确认；当前 Core 回执观察待恢复。这不代表任务完成。</p>
              : <MessageDeliveryFailure compact error={failure ?? diagnostics.get(original.logId ?? '')?.record.error ?? original.message}
              logId={original.logId} log={original.logId ? diagnostics.get(original.logId) : undefined}
              inputReceipt={original.inputReceipt} inputStopReceipt={original.manualInput!.stopReceipt}
              onRetry={original.phase === 'confirmed' ? undefined : () => { clearDismissedForOperation(); void retryOriginalPrompt(key) }}
              onDismiss={() => updateDismissed(set => set.add(signature))}
              copyText={text => platform.copyText(text, error => setCopyNotice(errorMessage(error)))} />}
            {(original.inputReceipt?.status === 'waiting' || original.inputReceipt?.status === 'not-applied' || key !== draftKey || onShowTerminal) ? <div className="mobile-send-status__actions">
              {original.inputReceipt?.status === 'waiting' ? <button type="button" onClick={() => { void stopManualInput(key, original) }}>
                {original.manualInput!.stopIntent && !original.manualInput!.stopReceipt ? '重试停止等待' : '停止等待'}</button> : null}
              {original.inputReceipt?.status === 'not-applied' ? <button type="button" onClick={() => { clearDismissedForOperation(); void submit(true, original, key) }}>重新发送原正文</button> : null}
              {key !== draftKey ? <button type="button" onClick={() => { void platform.copyText(original.draft, error => setCopyNotice(errorMessage(error))) }}>复制原正文</button> : null}
              {onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
            </div> : null}
          </> : <>
          <div className="mobile-send-status__summary">
            <span>{original.phase === 'sending' ? '正在发送…' : key !== draftKey
              ? original.phase === 'unknown' ? '先前消息结果未确认 · 原记录保留' : '先前消息未发送 · 原记录保留'
              : original.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'}</span>
            {original.phase !== 'sending' ? <div className="mobile-send-status__actions">
              <button type="button" onClick={() => { clearDismissedForOperation(); void retryOriginalPrompt(key) }}>{promptWasRefused(original) ? '重新发送原正文' : key === draftKey ? '重试原请求' : '重试这条原请求'}</button>
              <button type="button" onClick={() => { void reading.refresh() }}>刷新</button>
              <button type="button" className="mobile-send-status__dismiss" aria-label="关闭操作说明" title="关闭操作说明" onClick={() => updateDismissed(set => set.add(signature))}>收起</button>
            </div> : null}
          </div>
          {original.phase !== 'sending' ? <details className="mobile-send-status__diagnosis"><summary>发送详情</summary>
            <pre>{original.draft}</pre>
            <button type="button" onClick={() => { void platform.copyText(original.draft, error => setCopyNotice(`原正文未复制：${errorMessage(error)}`))
              .then(copied => { if (copied) setCopyNotice('已复制原正文。') }) }}>复制原正文</button>
            <dl><dt>原操作</dt><dd>{original.operationId}</dd><dt>原 Run</dt><dd>{original.runId ?? '尚未确认'}</dd></dl>
            <p role="alert">{original.message}</p>
            {original.logId ? <DeliveryLogDetails log={diagnostics.get(original.logId)} logId={original.logId} copyText={text => platform.copyText(text, error => setCopyNotice(errorMessage(error)))} /> : null}
            {onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
          </details> : null}</>}
        </aside>
  }
  return <ClientUiProvider platform={conversationPlatform}><MobileNoticeScope owner={client} identity={[ agentSessionId, session?.run.runId]}>
    <section className="mobile-conversation" aria-label="会话" data-agent-surface-mode="activity" data-agent-session-id={agentSessionId ?? ''}>
      {!available || connection.issue ? <MobileNotice identity={[connection.state,connection.issue,available]} className="mobile-conversation__connection" role="status">{connection.issue ?? connection.message}{!available ? ' 当前发送暂不可用。' : ''}</MobileNotice> : null}
      {reading.notice ? <details className="mobile-conversation__notice"><summary>对话读取暂未确认 · 原 Agent 与输入保留</summary><p>{reading.notice}</p><button onClick={() => { void reading.refresh() }}>刷新原记录</button></details> : null}
      {questionCapability.issue ? <MobileNotice identity={[questionCapability.issue]} className="mobile-conversation__notice" role="status">
        异步问题能力观察未确认；原会话与草稿保留，普通输入仍按原 Core 条件处理。{questionCapability.issue}
        <button type="button" onClick={() => redraw(value => value + 1)}>重新核对问题能力</button>
      </MobileNotice> : null}
      {local.notice ? <MobileNotice identity={[local.notice]} className="mobile-conversation__notice" role="status">{local.notice}
        {local.canSave ? <button type="button" onClick={() => { void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) }}>重试保存</button> : null}
        <button type="button" disabled={!draft} onClick={() => {
          void platform.copyText(draft, error => setCopyNotice(`草稿未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制当前草稿。') })
        }}>复制当前草稿</button>
        {local.recordChanged ? <button type="button" onClick={() => {
          void platform.copyText(local.exportBackup(), error => setCopyNotice(`本页备份未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制本页保全备份，包含原正文和操作身份。') })
        }}>复制本页保全备份</button> : null}
      </MobileNotice> : null}
      {local.conflicts.filter(item => item.key === draftKey).length > 0 && <details className="mobile-conversation__notice"><summary>保全的冲突内容</summary>
        {local.conflicts.filter(item => item.key === draftKey).map((item, index) => {
          const body = typeof item.value === 'string' ? item.value : Array.isArray(item.value) ? item.value.map(answer => answer.answer).join('\n') : 'draft' in item.value ? item.value.draft : 'input' in item.value ? item.value.input.answers.map(answer => answer.answer).join('\n') : '原请求的答复回执尚未确认。'
          return <div key={index}>{typeof item.value !== 'string' && <p>原请求记录保留，请核对回执。</p>}<pre>{body}</pre><button type="button" onClick={() => { void platform.copyText(body, error => setCopyNotice(errorMessage(error))) }}>复制这份保全内容</button></div>
        })}
      </details>}
      <div className="mobile-conversation__reader">
      <div ref={feed} className="mobile-conversation__reading" onScroll={event => {
        const node = event.currentTarget
        const programmatic = consumeProgrammaticReadingScroll(node)
        follow.current = programmatic === 'restore' ? { ...follow.current, lastScrollTop: node.scrollTop } : onScroll(follow.current, { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
        setJump(shouldShowJumpToLatest(follow.current))
      }}>
        {(reading.page?.nextCursor || reading.capturedHasMore) && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { follow.current.following = false; void reading.older() }}>更早消息</button>}
        {reading.hasNewer && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { void reading.newer() }}>较新消息</button>}
        {workingObservedAt !== undefined ? <p className="mobile-active-state" role="status" data-activity-current={currentActivity}
          title={`最后观察：${new Date(workingObservedAt).toLocaleString()}`}><SemanticIcon name="status.presence-working" size={5} />{currentActivity ? '正在执行' : '最近观察：执行中'}</p> : null}
        {agentSessionId ? <>
          <ConversationView readProcessDetail={reading.readProcessDetail} sourceLabelsInDetails coverageSummary="阅读范围与来源" readingGeometry={{ viewport: () => feed.current,
            following: () => follow.current.following && !reading.olderWindow,
            pinToBottom: () => { if (feed.current) { feed.current.scrollTop = feed.current.scrollHeight; markProgrammaticReadingScroll(feed.current) } } }} presentation={{ controller: presentation, pending: reading.held, onRelease: reading.acceptHeld, intent: presentationIntent.current }} page={reading.page} readActivity={reading.readActivity} expandSubmissions={Boolean(reading.readError)} timeline={reading.timeline ?? undefined} questionAnswerContext={reading.answerContext} records={reading.projection?.records ?? []} originalRecords={reading.projection?.originalRecords ?? []} coverage={reading.projection?.timeline.coverage ?? []} showInputSource={false} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
            renderProcess={props => <NativeProcessObservation {...props} compact />}
            questionReplyState={target => {
              const state = mobileQuestionReplyState(local, agentSessionId, target), original = state?.original
              return original && (original.hostId !== reading.pageOwner?.hostId || original.runtimeId &&
                original.runtimeId !== pageClient?.runtimeOwnerIdentity()?.runtimeId) ? undefined : state
            }}
            questionReplyDraft={target => local.questionDrafts.get(questionReplyKey(agentSessionId, target))}
            onQuestionDraftChange={(target, answers) => {
              local.questionDrafts.set(questionReplyKey(agentSessionId, target), structuredClone(answers))
              void local.save().then(() => { if (mounted.current) redraw(value => value + 1) })
            }}
            onQuestionReply={input => submitMobileQuestionReply(local, agentSessionId, pageClient ?? null, input,
              () => { if (mounted.current) redraw(value => value + 1) })}
            questionDraftNotice={local.notice ?? undefined}
            questionReplyRoute={questionCapability.route}
            questionReplyTarget={pageClient === client && session && !nativeTargetSourceUnconfirmed(session) && session.nativeHandle?.kind === 'provider' ? {
              source: { providerId: session.nativeHandle.providerId, nativeSessionId: session.nativeHandle.sessionId }, run: session.run
            } : undefined}
            questionReplyContext={JSON.stringify([session?.hostId, agentSessionId, session?.run.runId, client?.runtimeOwnerIdentity?.()?.runtimeId])}
            {...(onShowTerminal && pageClient === client ? { onOpenQuestionTerminal: onShowTerminal } : {})}
            {...(reading.page ? nativeReadingProps : readingProps)} />
        </> : !reading.reading ? <p className="mobile-conversation__empty">暂无已确认的对话内容，可发送消息或查看 Terminal。</p> : null}
      </div>
        <div className="mobile-conversation__floating-tools" role="group" aria-label="对话工具">
          {onShowGoals && <button type="button" className="mobile-conversation__goal" aria-label="目标与结果" title="目标与结果" onClick={event => onShowGoals(event.currentTarget)}><SemanticIcon name="object.goal" size={18} /></button>}
          <MobileMailbox key={historyConnection.current.generation} client={client} session={session} connected={connection.state === 'connected'} messages={mailboxMessages} platform={platform} describeSpeaker={describeSpeaker}
          {...(reading.projection ? { inputs: reading.projection.inputs } : {})}
          {...(reading.projection?.timeline.reference?.hostId ? { sourceHostId: reading.projection.timeline.reference.hostId } : {})}
          refresh={() => { void reading.refresh() }} historyScope={historyScope} readHistory={readInputHistory} visible={visible}
          onHistoryFill={fillHistoryMessage} onHistoryCopy={copyHistoryMessage} localEntries={historyLocalEntries}
          promptAttempts={sessionAttempts} diagnostics={diagnostics}
          onHistoryFillLocal={entry => {
            if (currentHistory.current.scope !== historyScope || current.current.client !== client || current.current.agentSessionId !== agentSessionId)
              throw new Error('已切换 Agent，原正文和当前草稿保留。')
            if (!insertion.current) throw new Error('原编辑器已关闭，正文和草稿保留。')
            insertion.current.replace(entry.text)
          }}
          reading={readingProps}
          {...(onShowTerminal ? { terminal: onShowTerminal } : {})} />
        </div>
      </div>
      {(jump || reading.newerAvailable || reading.olderWindow) && <button className="mobile-reading-action mobile-reading-latest" onClick={() => {
        follow.current = initFollowState(); presentationIntent.current++; setJump(false)
        if (reading.olderWindow || reading.newerAvailable) void reading.refresh()
        else if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
      }}>{reading.newerAvailable ? '有新回复 · 回到最新' : '回到最新'}</button>}
      {request && requestKey ? <div className="mobile-conversation__interaction">
        <AgentInteractionCard key={requestKey} request={request} disabled={responseDisabled}
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : responseUnavailableReason ? { responseUnavailableReason } : {})}
          responseStatus={responseAttempt?.original ? responseStatus(responseEntry![0], responseAttempt) : undefined}
          {...(onShowTerminal ? { onOpenTerminal: onShowTerminal } : {})}
          onRespond={respond} />
      </div> : null}
      {retainedResponses.map(([key, attempt]) => responseStatus(key, attempt))}
      {unidentifiedResponses.map(([key, attempt]) => <MobileNotice identity={[key,attempt.original?.input.operationId,attempt.phase,attempt.message]} key={key} role="status">{attempt.message}</MobileNotice>)}
      <div onFocusCapture={event => { if ((event.target as HTMLElement).isContentEditable) setComposerFocused(true) }} onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerFocused(false)
        }} className="mobile-conversation__composer">
        <AgentComposer insertionRef={insertion} aboveInput={<MobileAttachments client={client} session={session ?? null}
          connected={connection.state === 'connected' && !reading.disconnected} controls={attachmentControls}
          onPendingContentChange={setHasPendingAttachments}
          promptOperationId={attempt?.operationId ?? null} confirmedPrompt={confirmedAttachmentPrompt}
          onSendBodyOnly={sendBodyOnly}
          bodyOnlyDisabled={!draft.trim() || attempt?.phase === 'sending'}
          insert={async (resolve, original) => {
            const originalClient = current.current.client, selectedId = current.current.agentSessionId
            const selected = selectedId ? originalClient?.agentSession(selectedId) : null
            if (!fileUploadScopeMatches(original, { runtimeId: originalClient?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
              hostId: selected?.hostId ?? null, sessionId: selectedId, runId: selected?.run.runId ?? null }) || !insertion.current) {
              throw new Error('原附件回执已保留；当前编辑器不属于原 Mac、Session 或 Run，草稿未改变。')
            }
            await insertion.current.insert(async () => {
              const path = await resolve()
              if (path === null) return null
              const selectedId = current.current.agentSessionId, client = current.current.client
              const selected = selectedId ? client?.agentSession(selectedId) : null
              if (!fileUploadScopeMatches(original, { runtimeId: client?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
                hostId: selected?.hostId ?? null, sessionId: selectedId, runId: selected?.run.runId ?? null })) {
                throw new Error('原附件已保存；当前编辑器已切换，原回执保留，草稿未改变。')
              }
              return appendNamedFileReference('', path, original.identity.name)
            }, { separate: true })
          }} />}
          commands={commandSuggestions} promptKeywords={mobileCommands.promptKeywords} references={agentReferences}
          tools={<MobileMessageTools refresh={() => { void reading.refresh() }}
            key={JSON.stringify([historyScope, session?.providerId])}
            commands={commandSuggestions} onCommand={item => { void insertSuggestion(item) }}
            onCommandsOpenChange={setCommandMenuOpen} commandsLoading={mobileCommands.loading}
            commandsIssue={mobileCommands.issue} retryCommands={mobileCommands.retry}
            skills={<MobileSkillsPicker client={client} session={session} scope={JSON.stringify([historyScope, session?.providerId, session?.workspacePath, session?.run.runId])}
              connected={connection.state === 'connected' && !reading.disconnected} visible={visible} onSelect={item => { void insertSuggestion(item) }} />}
            {...(isWorking && available && Boolean(draft.trim()) ? { onInterrupt: () => { void interruptCurrentTurn() } } : {})} />}
          {...(postureControl && available && reading.activity?.process !== 'exited' && reading.activity?.process !== 'interrupted' ? { postureTool:
            <MobilePosturePicker control={postureControl} disabled={!available} onSet={modeId => { void changePosture(modeId) }} />
          } : {})}
          {...(postureControl && available && !reading.activity ? { feedback: <MobileNotice identity={[session?.run.runId]} className="composer-feedback" role="status">Run 状态未确认；模式切换由原服务核验。</MobileNotice> } : {})}
          primaryAction={isWorking && !draft.trim() && !hasPendingAttachments ? 'stop' : 'send'}
          {...(isWorking && available ? { onInterrupt: () => { void interruptCurrentTurn() } } : {})}
          value={draft} disabled={false} placeholder={available ? '发消息' : '离线草稿'}
          hasPendingContent={hasPendingAttachments}
          onChange={setDraft} {...(attempt?.phase !== 'sending' && !preparing ? {
            onSubmit: () => void submit(true, undefined, draftKey, attachmentControls.current?.captureForSend()),
            onQueue: () => void submit(false, undefined, draftKey, attachmentControls.current?.captureForSend())
          } : {})}
          onAttach={onAttach ?? (() => { void attachmentControls.current?.choose() })}
          onPasteImage={file => { void attachmentControls.current?.stageFile(file) }}
          onDropFiles={files => { void attachmentControls.current?.stageFiles(files) }}
          {...(readPastedImage ? { readPastedImage } : {})}
          />
        {preparationIssue ? <MobileNotice identity={[agentSessionId,preparationIssue]} role="status">{preparationIssue}</MobileNotice> : null}
        {attempt && (attempt.phase !== 'confirmed' || Boolean(attempt.logId)) ? renderPromptAttempt([draftKey, attempt]) : null}
        {retainedAttempts.length ? <details className="mobile-retained-prompts"><summary>保留的原消息 ({retainedAttempts.length})</summary>
          {retainedAttempts.map(renderPromptAttempt)}
        </details> : null}
        {copyNotice ? <MobileNotice kind="feedback" identity={[copyNotice]} role="status">{copyNotice}</MobileNotice> : null}
      </div>
    </section>
  </MobileNoticeScope></ClientUiProvider>
}
