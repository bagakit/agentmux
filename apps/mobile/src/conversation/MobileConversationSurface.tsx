import { canReplaceCapturedWindow } from '@agentmux/client-ui/captured-conversation-page'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { mobileQuestionReplyState, reconcileMobileQuestionReplies, submitMobileQuestionReply } from './question-replies'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { DeliveryLogDetails } from '@agentmux/client-ui/components/DeliveryLogDetails'
import { initFollowState, onContentChange, onScroll, shouldShowJumpToLatest } from '@agentmux/client-ui/activity-autoscroll'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason, agentInteractionOperationReceiptMatches, agentInteractionRequestsMatch } from '@agentmux/core/agent-interaction-state'
import { currentAgentSemanticStatus } from '@agentmux/core/agent-status'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxInteractionOperationReceipt, AgentMuxInteractionResponse, AgentSessionUserMessage } from '@agentmux/core'
import type { InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import { protectsConversationWindow } from '@agentmux/client-ui/conversation-reading-anchor'
import {
  AgentComposer, AgentInteractionCard, ClientUiProvider, NativeProcessObservation, ConversationView,
  createSpeakerResolver,
  type ClientUiPlatform, type ConversationMessageProps
} from '@agentmux/client-ui'
import { deliveryOutcome, errorMessage } from './delivery'
import { createLocalDrafts, type PromptAttempt, type ResponseAttempt } from './local-drafts'
import { useHostedConversation, type MobileConnection } from './use-hosted-conversation'
import { MobileMessageTools } from './MobileMessageTools'
import { MobileMailbox } from './MobileMailbox'
import { MobileAttachments, type MobileAttachmentControls } from './MobileAttachments'
import { fileUploadScopeMatches } from './attachments'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { appendNamedFileReference } from '@agentmux/client-ui/composer-file-reference'
import { useMobilePromptController } from './use-mobile-prompt-controller'
import './conversation.css'

export type { MobileConnection } from './use-hosted-conversation'
export type MobileConversationSurfaceProps = Pick<ConversationMessageProps,
  'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink'> & {
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  connection: MobileConnection
  platform: ClientUiPlatform
  onAttach?: () => void
  onShowTerminal?: () => void
  visible?: boolean
  displayName?: string
}
/** A first-party SDK reader and input client. Core owns ordering, authorship and admission. */
export function MobileConversationSurface({ client, agentSessionId, connection, platform, onAttach, onShowTerminal, visible = true, displayName,
  openWorkspaceFile, readPastedImage, openHttpLink }: MobileConversationSurfaceProps) {
  const feed = useRef<HTMLDivElement>(null), follow = useRef(initFollowState())
  const reading = useHostedConversation(client, agentSessionId, visible && connection.state === 'connected', (snapshot, displayed) => canReplaceCapturedWindow(feed.current, snapshot, !follow.current.following, displayed),
    (page, previous) => !protectsConversationWindow(feed.current, page, !follow.current.following, previous ?? undefined, { current: previous }))
  const [jump, setJump] = useState(false)
  useEffect(() => { follow.current = initFollowState(); setJump(false) }, [agentSessionId])
  useLayoutEffect(() => {
    const node = feed.current
    if (!visible || !node) return
    const tail = reading.page?.items.at(-1) ?? reading.timeline?.items.at(-1)
    const change = onContentChange(follow.current, { itemCount: reading.page?.items.length ?? reading.timeline?.items.length ?? 0, lastItemId: tail?.id ?? null, lastItemLength: tail ? JSON.stringify(tail).length : 0 })
    follow.current = change.state
    if (change.scrollToBottom && !reading.olderWindow) node.scrollTop = node.scrollHeight
    const resize = new ResizeObserver(() => { if (follow.current.following && !reading.olderWindow) node.scrollTop = node.scrollHeight })
    for (const child of node.children) resize.observe(child)
    return () => resize.disconnect()
  }, [reading.page, reading.timeline, reading.olderWindow, visible])
  const [local] = useState(createLocalDrafts)
  const drafts = useRef(local.drafts)
  const responses = useRef(local.responses)
  const [, redraw] = useState(0)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const { draftKey, draft, attempt, available, diagnostics, setDraft, submit, retryOriginalPrompt, stopManualInput,
    historyLocalEntries, retainedAttempts, promptWasRefused } = useMobilePromptController({ local, client, agentSessionId,
      session: reading.session, timeline: reading.timeline, connection, disconnected: reading.disconnected, visible, refresh: reading.refresh })
  const attachmentControls = useRef<MobileAttachmentControls>(null)
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
    const copied = await platform.copyText(content.text, error => { cause = error })
    signal.throwIfAborted()
    if (!copied && cause) throw cause
    return copied
  }
  const pending = session?.pendingInteraction
  const request = agentInteractionActiveRequest(pending)
  const responseUnavailableReason = pending && agentInteractionResponseUnavailableReason(pending)
  const requestRun = request?.evidence?.run ?? session?.run
  const runtimeId = client?.runtimeOwnerIdentity()?.runtimeId
  const requestKey = session && request && requestRun
    ? JSON.stringify([session.agentSessionId, session.hostId, runtimeId, requestRun.runId, request.id]) : null
  const responseOwnerMatches = (attempt: ResponseAttempt) => Boolean(attempt.original && session && runtimeId &&
    attempt.original.input.agentSessionId === session.agentSessionId && attempt.original.hostId === session.hostId &&
    attempt.original.runtimeId === runtimeId)
  const responseEntry = [...responses.current.forSession(agentSessionId ?? '')].reverse().find(([, attempt]) =>
    responseOwnerMatches(attempt) && request && attempt.original!.input.expectedRun.runId === requestRun?.runId &&
    agentInteractionRequestsMatch(attempt.original!.input.expectedRequest, request))
  const responseAttempt = responseEntry?.[1]
  const responseDisabled = !available || request?.agentSessionId !== session?.agentSessionId
    || requestRun?.runId !== session?.run.runId || Boolean(responseUnavailableReason)
    || responseAttempt?.phase === 'unknown' || responseAttempt?.phase === 'sending' || responseAttempt?.phase === 'confirmed'
  async function respond(response: AgentMuxInteractionResponse, intent: import('@agentmux/core').AgentMuxInteractionOperationIntent): Promise<void | import('@agentmux/core').AgentMuxInteractionOperationReceipt> {
    if (!client || !session || !request || !requestRun || !requestKey || responseDisabled) return
    const previous = responseAttempt
    if (previous?.phase === 'sending' || previous?.phase === 'unknown' || previous?.phase === 'confirmed') return
    const originalKey = JSON.stringify([session.agentSessionId, requestRun.runId, request.id, intent.operationId])
    const original: ResponseAttempt = { phase: 'sending', message: '正在发送原请求的答复…', original: {
      input: structuredClone({ agentSessionId: session.agentSessionId, expectedRun: requestRun, response, ...intent }),
      hostId: session.hostId, runtimeId: client.runtimeOwnerIdentity()?.runtimeId ?? null } }
    responses.current.set(originalKey, original)
    const retained = await local.save()
    redraw(value => value + 1)
    try {
      if (!retained || responses.current.get(originalKey) !== original) throw new Error('另一页面已保全这个请求的答复；本次未重复回答。')
      const target = client.agentSession(original.original!.input.agentSessionId)
      if (target.hostId !== original.original!.hostId || client.runtimeOwnerIdentity()?.runtimeId !== original.original!.runtimeId) throw new Error('原请求的 Host 或 Runtime 已改变；原答复保留，本次未发送。')
      const receipt = await client.respondAgentInteraction(original.original!.input)
      if (!mounted.current || responses.current.get(originalKey) !== original) return
      adoptResponseReceipt(original, receipt)
      return receipt
    } catch (error) {
      if (!mounted.current) throw error
      original.phase = deliveryOutcome(error, 'interaction')
      original.message = original.phase === 'unknown'
        ? `答复回执未知；不会重复回答这个请求。请在原会话核对。${errorMessage(error)}`
        : `Core 已拒绝答复。${errorMessage(error)}`
      throw error
    } finally { if (mounted.current) { void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) } }
  }
  function adoptResponseReceipt(attempt: ResponseAttempt, receipt: AgentMuxInteractionOperationReceipt) {
    const input = attempt.original!.input
    if (!agentInteractionOperationReceiptMatches(input, receipt)) throw new Error('原答复回执身份未匹配；原请求与操作保留。')
    attempt.phase = receipt.delivery === 'unknown' || receipt.delivery === 'saved' ? 'unknown' : 'confirmed'
    attempt.message = receipt.nativeCompleted ? '原请求已确认完成；答复回执仍可查询。'
      : receipt.delivery === 'saved' ? '答复已保存；是否送达尚未确认。'
      : receipt.delivery === 'unknown' ? '答复回执未知；请查询原操作。' : '答复已送入原会话；是否采用及任务进展仍需核对。'
  }
  async function inspectResponse(key: string, attempt: ResponseAttempt): Promise<AgentMuxInteractionOperationReceipt | null> {
    if (!client || !attempt.original) return null
    const original = attempt.original
    try {
      if (client.agentSession(original.input.agentSessionId).hostId !== original.hostId ||
          !original.runtimeId || client.runtimeOwnerIdentity()?.runtimeId !== original.runtimeId) throw new Error('当前连接不属于原答复的 Host 或 Runtime；原操作保留。')
      const receipt = await client.inspectAgentInteractionOperation({ agentSessionId: original.input.agentSessionId, operationId: original.input.operationId })
      if (!mounted.current || responses.current.get(key) !== attempt) return receipt
      if (receipt) adoptResponseReceipt(attempt, receipt)
      else attempt.message = '尚未取得原操作的回执；是否送达仍未知，原答复保留。'
      await local.save()
      return receipt
    } catch (error) {
      if (mounted.current && responses.current.get(key) === attempt) attempt.message = `原答复查询未确认；原操作保留。${errorMessage(error)}`
      throw error
    } finally { if (mounted.current) redraw(value => value + 1) }
  }
  function responseStatus(key: string, attempt: ResponseAttempt) {
    return <aside key={key} className="mobile-send-status" data-phase={attempt.phase} data-original-response={attempt.original!.input.operationId}>
      <p role="status">{attempt.message}</p>
      <button type="button" onClick={() => { void inspectResponse(key, attempt).catch(() => {}) }}>查询原答复回执</button>
    </aside>
  }
  const describeSpeaker = useMemo(() => createSpeakerResolver({
    lookupAgent: id => {
      try {
        const author = client?.agentSessions().find(value => value.agentSessionId === id)
        return author ? { label: author.agentSessionId === agentSessionId && displayName ? displayName : `${author.providerId} Agent`, providerId: author.providerId } : undefined
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
    return <aside
          className="mobile-send-status" key={key} data-phase={original.phase} data-manual={Boolean(original.manualInput) || undefined} data-retained={key !== draftKey || undefined}
          data-original-operation={original.operationId} aria-live="polite">
          {original.manualInput ? <>
            {original.phase === 'sending' && !original.inputReceipt ? <p role="status">正在保存这条原消息…</p>
              : original.phase === 'confirmed' && !original.inputReceipt ? <p role="status">先前输入已确认；当前 Core 回执观察待恢复。这不代表任务完成。</p>
              : <MessageDeliveryFailure compact error={failure ?? diagnostics.get(original.logId ?? '')?.record.error ?? original.message}
              logId={original.logId} log={original.logId ? diagnostics.get(original.logId) : undefined}
              inputReceipt={original.inputReceipt} inputStopReceipt={original.manualInput.stopReceipt}
              onRetry={original.phase === 'confirmed' ? undefined : () => { void retryOriginalPrompt(key) }}
              copyText={text => platform.copyText(text, error => setCopyNotice(errorMessage(error)))} />}
            {original.inputReceipt?.status === 'waiting' ? <button type="button" onClick={() => { void stopManualInput(key, original) }}>
              {original.manualInput.stopIntent && !original.manualInput.stopReceipt ? '重试停止等待' : '停止等待'}</button> : null}
            {original.inputReceipt?.status === 'not-applied' ? <button type="button" onClick={() => { void submit(true, original, key) }}>重新发送原正文</button> : null}
            <details className="mobile-send-status__diagnosis"><summary>原消息与身份</summary><pre>{original.draft}</pre>
              <button type="button" onClick={() => { void platform.copyText(original.draft, error => setCopyNotice(errorMessage(error))) }}>复制原正文</button>
              <dl><dt>原操作</dt><dd>{original.operationId}</dd><dt>原 Run</dt><dd>{original.runId}</dd></dl>
              {onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
            </details>
          </> : <>
          <div className="mobile-send-status__summary">
            <span>{original.phase === 'sending' ? '正在发送…' : key !== draftKey
              ? original.phase === 'unknown' ? '先前消息结果未确认 · 原记录保留' : '先前消息未发送 · 原记录保留'
              : original.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'}</span>
            {original.phase !== 'sending' ? <div className="mobile-send-status__actions">
              <button type="button" onClick={() => { void retryOriginalPrompt(key) }}>{promptWasRefused(original) ? '重新发送原正文' : key === draftKey ? '重试原请求' : '重试这条原请求'}</button>
              <button type="button" onClick={() => { void reading.refresh() }}>刷新</button>
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
  return <ClientUiProvider platform={platform}>
    <section className="mobile-conversation" aria-label="会话" data-agent-surface-mode="activity" data-agent-session-id={agentSessionId ?? ''}>
      {!available || connection.issue ? <p className="mobile-conversation__connection" role="status">{connection.issue ?? connection.message}{!available ? ' 当前发送暂不可用。' : ''}</p> : null}
      {reading.notice ? <details className="mobile-conversation__notice"><summary>对话读取暂未确认 · 原 Agent 与输入保留</summary><p>{reading.notice}</p><button onClick={() => { void reading.refresh() }}>刷新原记录</button></details> : null}
      {local.notice ? <aside className="mobile-conversation__notice" role="status">{local.notice}
        {local.canSave ? <button type="button" onClick={() => { void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) }}>重试保存</button> : null}
        <button type="button" disabled={!draft} onClick={() => {
          void platform.copyText(draft, error => setCopyNotice(`草稿未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制当前草稿。') })
        }}>复制当前草稿</button>
        {local.recordChanged ? <button type="button" onClick={() => {
          void platform.copyText(local.exportBackup(), error => setCopyNotice(`本页备份未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制本页保全备份，包含原正文和操作身份。') })
        }}>复制本页保全备份</button> : null}
      </aside> : null}
      {local.conflicts.filter(item => item.key === draftKey).length > 0 && <details className="mobile-conversation__notice"><summary>保全的冲突内容</summary>
        {local.conflicts.filter(item => item.key === draftKey).map((item, index) => {
          const body = typeof item.value === 'string' ? item.value : Array.isArray(item.value) ? item.value.map(answer => answer.answer).join('\n') : 'draft' in item.value ? item.value.draft : 'input' in item.value ? item.value.input.answers.map(answer => answer.answer).join('\n') : '原请求的答复回执尚未确认。'
          return <div key={index}>{typeof item.value !== 'string' && <p>原请求记录保留，请核对回执。</p>}<pre>{body}</pre><button type="button" onClick={() => { void platform.copyText(body, error => setCopyNotice(errorMessage(error))) }}>复制这份保全内容</button></div>
        })}
      </details>}
      <div ref={feed} className="mobile-conversation__reading" onScroll={event => {
        const node = event.currentTarget
        follow.current = onScroll(follow.current, { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
        setJump(shouldShowJumpToLatest(follow.current))
      }}>
        {(reading.page?.nextCursor || reading.capturedHasMore) && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { follow.current.following = false; void reading.older() }}>更早消息</button>}
        {reading.hasNewer && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { void reading.newer() }}>较新消息</button>}
        {(jump || reading.newerAvailable || reading.olderWindow) && <button className="mobile-reading-action mobile-reading-latest" onClick={() => {
          follow.current = initFollowState(); setJump(false)
          if (reading.olderWindow || reading.newerAvailable) void reading.refresh()
          else if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
        }}>{reading.newerAvailable ? '有新回复 · 回到最新' : '回到最新'}</button>}
        {workingObservedAt !== undefined ? <p className="mobile-active-state" role="status" data-activity-current={currentActivity}
          title={`最后观察：${new Date(workingObservedAt).toLocaleString()}`}><SemanticIcon name="status.presence-working" size={5} />{currentActivity ? '正在执行' : '最近观察：执行中'}</p> : null}
        {agentSessionId ? <>
          <ConversationView page={reading.page} readActivity={reading.readActivity} expandSubmissions={Boolean(reading.readError)} timeline={reading.timeline ?? undefined} questionAnswerContext={reading.answerContext} records={reading.projection?.records ?? []} originalRecords={reading.projection?.originalRecords ?? []} coverage={reading.projection?.timeline.coverage ?? []} showInputSource={false} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
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
            questionReplyRoute={session?.providerId ? client?.catalog?.().find(provider => provider.id === session.providerId)?.capabilities.asyncQuestionReply : undefined}
            questionReplyTarget={pageClient === client && !session?.nativeSourceObservation && session?.nativeHandle?.kind === 'provider' ? {
              source: { providerId: session.nativeHandle.providerId, nativeSessionId: session.nativeHandle.sessionId }, run: session.run
            } : undefined}
            questionReplyContext={JSON.stringify([session?.hostId, agentSessionId, session?.run.runId, client?.runtimeOwnerIdentity?.()?.runtimeId])}
            {...(onShowTerminal && pageClient === client ? { onOpenQuestionTerminal: onShowTerminal } : {})}
            {...(reading.page ? nativeReadingProps : readingProps)} />
        </> : !reading.reading ? <p className="mobile-conversation__empty">暂无已确认的对话内容，可发送消息或查看 Terminal。</p> : null}
      </div>
      {request && requestKey ? <div className="mobile-conversation__interaction">
        <AgentInteractionCard key={requestKey} request={request} disabled={responseDisabled}
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : responseUnavailableReason ? { responseUnavailableReason } : {})}
          responseStatus={responseAttempt?.original ? responseStatus(responseEntry![0], responseAttempt) : undefined}
          {...(onShowTerminal ? { onOpenTerminal: onShowTerminal } : {})}
          onRespond={respond} />
      </div> : null}
      {[...responses.current.forSession(agentSessionId ?? '')].filter(([key, attempt]) =>
        responseOwnerMatches(attempt) && key !== responseEntry?.[0]).map(([key, attempt]) => responseStatus(key, attempt))}
      {[...responses.current.forSession(agentSessionId ?? '')].filter(([, attempt]) => !attempt.original)
        .map(([key, attempt]) => <p key={key} role="status">{attempt.message}</p>)}
      <div className="mobile-conversation__composer">
        <AgentComposer insertionRef={insertion} aboveInput={<MobileAttachments client={client} session={session ?? null}
          connected={connection.state === 'connected' && !reading.disconnected} controls={attachmentControls}
          promptOperationId={attempt?.operationId ?? null} promptConfirmed={attempt?.phase === 'confirmed'}
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
          tools={<MobileMessageTools refresh={() => { void reading.refresh() }} terminal={onShowTerminal} />} mailbox={<MobileMailbox key={historyConnection.current.generation} client={client} session={session} connected={connection.state === 'connected'} messages={mailboxMessages} platform={platform} describeSpeaker={describeSpeaker}
          {...(reading.projection ? { inputs: reading.projection.inputs } : {})}
          {...(reading.projection?.timeline.reference?.hostId ? { sourceHostId: reading.projection.timeline.reference.hostId } : {})}
          refresh={() => { void reading.refresh() }} historyScope={historyScope} readHistory={readInputHistory} visible={visible}
          onHistoryFill={fillHistoryMessage} onHistoryCopy={copyHistoryMessage} localEntries={historyLocalEntries}
          onHistoryFillLocal={entry => {
            if (currentHistory.current.scope !== historyScope || current.current.client !== client || current.current.agentSessionId !== agentSessionId)
              throw new Error('已切换 Agent，原正文和当前草稿保留。')
            if (!insertion.current) throw new Error('原编辑器已关闭，正文和草稿保留。')
            insertion.current.replace(entry.text)
          }}
          reading={readingProps}
          {...(onShowTerminal ? { terminal: onShowTerminal } : {})} />} value={draft} disabled={false} placeholder={available ? '发消息' : '离线草稿'}
          onChange={setDraft} {...(attempt?.phase !== 'sending' ? { onSubmit: () => void submit(), onQueue: () => void submit(false) } : {})}
          onAttach={onAttach ?? (() => { void attachmentControls.current?.choose() })} {...(readPastedImage ? { readPastedImage } : {})}
          />
        {attempt && (attempt.phase !== 'confirmed' || attempt.manualInput) ? renderPromptAttempt([draftKey, attempt]) : null}
        {retainedAttempts.length ? <details className="mobile-retained-prompts"><summary>保留的原消息 ({retainedAttempts.length})</summary>
          {retainedAttempts.map(renderPromptAttempt)}
        </details> : null}
        {copyNotice ? <p role="status">{copyNotice}</p> : null}
      </div>
    </section>
  </ClientUiProvider>
}
