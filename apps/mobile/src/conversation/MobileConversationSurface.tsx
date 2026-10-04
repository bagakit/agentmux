import { ClientDeliveryDiagnostics, startDeliveryAttempt, type DeliveryAttemptSeed } from '@agentmux/client-ui/delivery-diagnostics'
import { DeliveryLogDetails } from '@agentmux/client-ui/components/DeliveryLogDetails'
import { initFollowState, onContentChange, onScroll, shouldShowJumpToLatest } from '@agentmux/client-ui/activity-autoscroll'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxInteractionResponse } from '@agentmux/core'
import { agentPromptCondition, validateAgentPromptCondition } from '@agentmux/core/prompt-condition'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import {
  AgentComposer, AgentInteractionCard, ClientUiProvider, NativeProcessObservation, ConversationMessage, ConversationView,
  createSpeakerResolver, expandSemanticReferences, speakerOfUserMessage,
  type ClientUiPlatform, type ConversationMessageProps
} from '@agentmux/client-ui'
import { deliveryOutcome, errorMessage } from './delivery'
import { createLocalDrafts, type PromptAttempt, type ResponseAttempt } from './local-drafts'
import { useHostedConversation, type MobileConnection } from './use-hosted-conversation'
import { MobileMessageTools } from './MobileMessageTools'
import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { MobileMailbox } from './MobileMailbox'
import { MobileAttachments, type MobileAttachmentControls } from './MobileAttachments'
import { fileUploadScopeMatches } from './attachments'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { appendNamedFileReference } from '@agentmux/client-ui/composer-file-reference'
import './conversation.css'

export type { MobileConnection } from './use-hosted-conversation'
function promptExecutionFor(client: AgentMuxHostedClient, session: AgentMuxAgentSession) {
  try {
    const provider = client.catalog().find(entry => entry.id === session.providerId)
    if (!provider) return { execution: 'default' as const, supported: undefined, issue: '公共能力目录未包含原 Session 的 Provider。' }
    const supported = provider.capabilities.promptExecution?.immediate === 'interrupt-before-input' || provider.capabilities.promptExecution?.immediate === 'native-steer'
    return { execution: supported ? 'immediate' as const : 'default' as const, supported }
  } catch (error) {
    return { execution: 'default' as const, supported: undefined, issue: `公共能力目录读取失败：${errorMessage(error)}` }
  }
}
function originalPromptRequest(session: AgentMuxAgentSession | null | undefined, agentSessionId: string | null,
  attempt: PromptAttempt | undefined) {
  if (attempt?.request && attempt.phase !== 'sending' && attempt.phase !== 'confirmed' && attempt.operationId && attempt.draft.trim()) {
    const saved = attempt.request
    if (!session || session.agentSessionId !== agentSessionId || session.run.runId !== attempt.runId) return undefined
    const condition = validateAgentPromptCondition(saved.condition)
    return { agentSessionId: session.agentSessionId, operationId: attempt.operationId, ...condition,
      prompt: expandSemanticReferences(attempt.draft), authorHuman: true as const, execution: saved.execution,
      ...(saved.explicit ? { allowUncertainTurn: true as const } : {}) }
  }
  const admission = session?.promptCompletionAdmission, intent = admission?.intent, message = intent?.message
  if (!session || session.agentSessionId !== agentSessionId || !attempt || attempt.phase !== 'unknown'
    || !attempt.operationId || !attempt.runId || session.run.runId !== attempt.runId
    || admission?.submissionId !== attempt.operationId || admission.notApplied === true
    || intent?.run.runId !== attempt.runId || !attempt.draft.trim()
    || intent.prompt !== expandSemanticReferences(attempt.draft) || message?.userContent !== intent.prompt
    || message.authorHuman !== true || message.authorAgentSessionId !== undefined || message.systemContext !== undefined
    || (intent.execution !== 'default' && intent.execution !== 'immediate')) return undefined
  // The Host supplies this call's authenticated device; Core checks it against the original message.
  return { agentSessionId: session.agentSessionId, operationId: attempt.operationId, expectedRun: { ...intent.run },
    afterSubmissionId: attempt.operationId, prompt: intent.prompt, authorHuman: true as const, execution: intent.execution,
    ...(intent.execution === 'immediate' ? { allowUncertainTurn: true } : {}) }
}
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
  const reading = useHostedConversation(client, agentSessionId, visible && connection.state === 'connected')
  const feed = useRef<HTMLDivElement>(null), follow = useRef(initFollowState())
  const [jump, setJump] = useState(false)
  useEffect(() => { follow.current = initFollowState(); setJump(false) }, [agentSessionId])
  useLayoutEffect(() => {
    const node = feed.current
    if (!visible || !node) return
    const tail = reading.page?.items.at(-1) ?? reading.timeline?.items.at(-1)
    const geometry = { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
    const change = onContentChange(follow.current, { itemCount: reading.page?.items.length ?? reading.timeline?.items.length ?? 0, lastItemId: tail?.id ?? null, lastItemLength: tail ? JSON.stringify(tail).length : 0 }, geometry)
    follow.current = change.state
    if (change.scrollToBottom && !reading.olderWindow) node.scrollTop = node.scrollHeight
    const resize = new ResizeObserver(() => { if (follow.current.following && !reading.olderWindow) node.scrollTop = node.scrollHeight })
    for (const child of node.children) resize.observe(child)
    return () => resize.disconnect()
  }, [reading.page, reading.timeline, reading.olderWindow, visible])
  const draftKey = JSON.stringify(['draft', agentSessionId])
  const [local] = useState(createLocalDrafts)
  const [diagnostics] = useState(() => new ClientDeliveryDiagnostics())
  const drafts = useRef(local.drafts)
  const attempts = useRef(local.attempts)
  const responses = useRef(local.responses)
  const [revision, redraw] = useState(0)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [inputCapabilities, setInputCapabilities] = useState<Record<string, { sessionId: string; runId: string; execution: 'default' | 'immediate'; supported?: boolean | undefined; issue?: string | undefined }>>({})
  const inputCapability = agentSessionId ? inputCapabilities[agentSessionId] : undefined
  const setInputCapability = (value: NonNullable<typeof inputCapability>) =>
    setInputCapabilities(current => ({ ...current, [value.sessionId]: value }))
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const draft = drafts.current.get(draftKey) ?? ''
  const attempt = attempts.current.get(draftKey)
  const attachmentControls = useRef<MobileAttachmentControls>(null)
  const insertion = useRef<ComposerInsertionHandle>(null)
  const available = Boolean(client && agentSessionId && reading.session && connection.state === 'connected' && !reading.disconnected)
  const setDraft = (value: string, key = draftKey) => { drafts.current.set(key, value); local.save(); redraw(value => value + 1) }
  const confirmPrompt = (key: string, original: PromptAttempt, message = 'Core 已确认输入。') => {
    if (attempts.current.get(key) !== original) return
    original.phase = 'confirmed'
    original.message = message
    // A receipt belongs to its captured operation, including after navigating elsewhere.
    if (drafts.current.get(key) === original.draft) drafts.current.set(key, '')
    local.save()
    if (mounted.current) redraw(value => value + 1)
  }
  useEffect(() => {
    const pending = attempts.current.get(draftKey)
    if (!pending || pending.phase !== 'unknown') return
    const admission = reading.session?.promptCompletionAdmission
    if (admission?.submissionId === pending.operationId && admission.notApplied === true
      && admission.intent?.run.runId === pending.runId && reading.session?.run.runId === pending.runId) {
      pending.phase = 'rejected'
      pending.message = 'Core 已确认原输入未应用；草稿保留，可由你重新发送。'
      local.save()
      redraw(value => value + 1)
      return
    }
    const receipt = reading.timeline?.items.find(item => item.agentSessionId === agentSessionId
      && item.id === `prompt:${pending.operationId}` && item.kind === 'user_message' && item.status === 'complete')
    if (receipt) confirmPrompt(draftKey, pending)
  }, [reading.timeline, reading.session, agentSessionId, draftKey, revision])

  const diagnosticOwner = (originalClient: AgentMuxHostedClient | null): string | null => {
    const identity = originalClient?.runtimeOwnerIdentity?.()
    return identity ? `runtime:${identity.runtimeId}` : null
  }
  const reportDiagnostics = (originalClient: AgentMuxHostedClient | null) => {
    const owner = diagnosticOwner(originalClient)
    if (owner && originalClient?.forwardRpc) void diagnostics.sync(owner, record => originalClient.forwardRpc!(
      'message.delivery.report', { hostId: 'local', record }))
  }
  useEffect(() => diagnostics.subscribe(() => redraw(value => value + 1)), [diagnostics])
  useEffect(() => { if (connection.state === 'connected') reportDiagnostics(client) }, [client, connection.state])
  async function retainFailure(original: PromptAttempt, seed: DeliveryAttemptSeed, error: unknown, stage: string,
    originalClient: AgentMuxHostedClient | null, key: string, retry: boolean) {
    const owner = original.request?.runtimeId ? `runtime:${original.request.runtimeId}` : diagnosticOwner(originalClient)
    const log = await diagnostics.failed(seed, error, stage, owner)
    reportDiagnostics(originalClient)
    // A refusal of this click cannot settle an older unknown logical message.
    original.phase = original.inputRequested === false ? 'rejected'
      : retry && original.phase !== 'rejected' ? 'unknown' : deliveryOutcome(error, 'prompt')
    original.logId = log.record.logId
    original.message = errorMessage(error)
    if (attempts.current.get(key) === original) local.save()
    if (mounted.current) redraw(value => value + 1)
  }
  async function submit(explicit = true): Promise<void> {
    const existing = attempts.current.get(draftKey)
    if (existing?.phase === 'sending' || !draft.trim()) return
    if (existing?.phase === 'unknown' && existing.draft !== draft) {
      const seed = startDeliveryAttempt({ agentSessionId, operationId: null,
        hostId: reading.session?.hostId ?? null, prompt: expandSemanticReferences(draft) })
      await retainFailure(existing, seed, Object.assign(new Error(
        '上一条消息的发送结果尚未核实，当前正文已不同。本次未发送；两份正文均保留，可用“重试原请求”续做原消息。'),
        { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' }), 'editor-validation', client, draftKey, true)
      return
    }
    if (existing?.phase === 'unknown' || existing?.phase === 'rejected' && existing.draft === draft) { await retryOriginalPrompt(); return }
    const originalClient = client, originalId = agentSessionId, originalKey = draftKey
    const original: PromptAttempt = { operationId: randomClientRequestId(), runId: reading.session?.run.runId ?? null,
      draft, phase: 'sending', message: '正在发送输入…', inputRequested: false,
      originalRuntimeId: originalClient?.runtimeOwnerIdentity?.()?.runtimeId ?? null, explicit }
    let seed = startDeliveryAttempt({ agentSessionId: originalId, operationId: original.operationId,
      hostId: reading.session?.hostId ?? null, prompt: expandSemanticReferences(draft) })
    attempts.current.set(originalKey, original)
    let stage = 'client-validation'
    try {
      if (!available || !originalClient || !originalId) throw Object.assign(new Error(
        `原会话当前不能投递：${connection.issue ?? connection.message}${reading.disconnected ? '；会话连接已断开' : ''}。草稿已保留，可继续点击发送重试。`), { code: 'CONTROL_UNAVAILABLE' })
      const originalSession = originalClient.agentSession(originalId), condition = agentPromptCondition(originalSession)
      const capability = explicit ? promptExecutionFor(originalClient, originalSession) : { execution: 'default' as const }
      setInputCapability({ sessionId: originalId, runId: condition.expectedRun.runId, ...capability })
      original.runId = condition.expectedRun.runId
      original.request = { condition: structuredClone(condition), execution: capability.execution, explicit,
        runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
      seed = Object.freeze({ ...seed, expectedRunId: original.runId, afterSubmissionId: condition.afterSubmissionId,
        conditionAvailable: true, execution: capability.execution })
      local.save(); redraw(value => value + 1)
      stage = 'core-submit'
      original.inputRequested = true; local.save()
      await originalClient.submitAgentPrompt({ agentSessionId: originalId, operationId: original.operationId,
        prompt: expandSemanticReferences(original.draft), authorHuman: true, ...condition,
        ...(explicit ? { allowUncertainTurn: true, ...(capability.execution === 'immediate' ? { execution: 'immediate' as const } : {}) } : {}) })
      confirmPrompt(originalKey, original, capability.execution === 'immediate' ? 'Core 已确认立即执行输入。' : 'Core 已确认普通输入。')
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void reading.refresh()
    } catch (error) { await retainFailure(original, seed, error, stage, originalClient, originalKey, false) }
  }

  async function retryOriginalPrompt(): Promise<void> {
    const original = attempts.current.get(draftKey)
    if (!original || original.phase === 'sending' || original.phase === 'confirmed') return
    const originalClient = client, originalId = agentSessionId, originalKey = draftKey
    let seed = startDeliveryAttempt({ agentSessionId: originalId, operationId: original.operationId,
      hostId: reading.session?.hostId ?? null, condition: original.request?.condition,
      ...(original.request ? { execution: original.request.execution } : {}), prompt: expandSemanticReferences(original.draft) })
    const previousPhase = original.phase
    let stage = 'retry-validation'
    try {
      if (!available || !originalClient || !originalId) throw Object.assign(new Error(
        `原会话当前不能投递：${connection.issue ?? connection.message}。原输入与当前草稿保留，可再次重试。`), { code: 'CONTROL_UNAVAILABLE' })
      const originalRuntimeId = original.request?.runtimeId ?? original.originalRuntimeId
      if (originalRuntimeId && originalClient.runtimeOwnerIdentity?.()?.runtimeId !== originalRuntimeId) {
        throw Object.assign(new Error('当前连接不属于原消息的 Runtime；不会把原消息发往另一个 Host。'), { code: 'STALE_AGENT_SESSION' })
      }
      const originalSession = originalClient.agentSession(originalId)
      // Only a locally known never-requested intent may obtain its first condition
      // after reconnect. Legacy missing facts and unknown dispatched input cannot.
      if (!original.request && original.inputRequested === false) {
        if (originalSession.agentSessionId !== originalId || original.runId !== null && originalSession.run.runId !== original.runId) {
          throw Object.assign(new Error('原消息的 Session 或 Run 已变化；本次未请求输入。'), { code: 'STALE_AGENT_SESSION' })
        }
        if (original.explicit === undefined) throw Object.assign(new Error(
          '原消息最初的执行选择无法核实；本次未请求输入，原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
        const condition = agentPromptCondition(originalSession), capability = original.explicit
          ? promptExecutionFor(originalClient, originalSession) : { execution: 'default' as const }
        original.runId = condition.expectedRun.runId
        original.request = { condition: structuredClone(condition), execution: capability.execution, explicit: original.explicit,
          runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
        local.save()
      }
      const input = originalPromptRequest(originalSession, originalId, original)
      if (!input) throw Object.assign(new Error('原 Session、Run 或投递条件无法完整核实；本次未请求输入，原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      seed = Object.freeze({ ...seed, expectedRunId: input.expectedRun.runId,
        afterSubmissionId: input.afterSubmissionId, conditionAvailable: true, execution: input.execution })
      original.phase = 'sending'; original.message = '正在核对并续做原请求…'
      local.save(); redraw(value => value + 1)
      stage = 'core-submit'
      original.inputRequested = true; local.save()
      await originalClient.submitAgentPrompt(input)
      confirmPrompt(originalKey, original)
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void reading.refresh()
    } catch (error) {
      original.phase = previousPhase
      await retainFailure(original, seed, error, stage, originalClient, originalKey, true)
    }
  }

  const session = reading.session
  const pending = session?.pendingInteraction
  const request = pending?.request
  const requestRun = request?.evidence?.run ?? session?.run
  const requestKey = session && request && requestRun
    ? JSON.stringify([session.agentSessionId, requestRun.runId, request.id]) : null
  const responseAttempt = requestKey ? responses.current.get(requestKey) : undefined
  const responseDisabled = !available || request?.agentSessionId !== session?.agentSessionId
    || requestRun?.runId !== session?.run.runId || Boolean(pending?.response || pending?.nativeInput || pending?.nativeCompleted)
    || responseAttempt?.phase === 'unknown' || responseAttempt?.phase === 'sending' || responseAttempt?.phase === 'confirmed'
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (!client || !session || !request || !requestRun || !requestKey || responseDisabled) return
    const previous = responses.current.get(requestKey)
    if (previous?.phase === 'sending' || previous?.phase === 'unknown' || previous?.phase === 'confirmed') return
    const originalKey = requestKey
    const original: ResponseAttempt = { phase: 'sending', message: '正在发送原请求的答复…' }
    responses.current.set(originalKey, original)
    local.save()
    redraw(value => value + 1)
    try {
      await client.respondAgentInteraction({ agentSessionId: session.agentSessionId, expectedRun: requestRun, response })
      if (!mounted.current) return
      original.phase = 'confirmed'; original.message = 'Core 已确认答复，等待原请求更新。'
    } catch (error) {
      if (!mounted.current) throw error
      original.phase = deliveryOutcome(error, 'interaction')
      original.message = original.phase === 'unknown'
        ? `答复回执未知；不会重复回答这个请求。请在原会话核对。${errorMessage(error)}`
        : `Core 已拒绝答复。${errorMessage(error)}`
      throw error
    } finally { if (mounted.current) { local.save(); redraw(value => value + 1) } }
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
  const captured = useMemo(() => agentSessionId && reading.timeline
    ? projectSessionUserMessages({ agentSessionId, timeline: reading.timeline }) : [], [agentSessionId, reading.timeline])
  const capturedById = useMemo(() => new Map(captured.map(message => [message.id, message])), [captured])
  const appendQuote = (quote: string) => setDraft(`${drafts.current.get(draftKey) ?? ''}${drafts.current.get(draftKey) ? '\n\n' : ''}${quote}`)
  const readingProps = {
    ...(session ? { workspaceRoot: session.workspacePath } : {}),
    ...(openWorkspaceFile ? { openWorkspaceFile } : {}), ...(readPastedImage ? { readPastedImage } : {}),
    ...(openHttpLink ? { openHttpLink } : {}),
    onSelectAnnotation: ({ messageId, quote }: Parameters<NonNullable<ConversationMessageProps['onSelectAnnotation']>>[0]) =>
      appendQuote(`引用会话 ${JSON.stringify(agentSessionId)}，消息 ${JSON.stringify(messageId)}：\n${quote.split('\n').map(line => `> ${line}`).join('\n')}`)
  }
  return <ClientUiProvider platform={platform}>
    <section className="mobile-conversation" aria-label="会话" data-agent-surface-mode="activity" data-agent-session-id={agentSessionId ?? ''}>
      {!available || connection.issue ? <p className="mobile-conversation__connection" role="status">{connection.issue ?? connection.message}{!available ? ' 当前不能发送；草稿与阅读保留。' : ''}</p> : null}
      {reading.notice ? <details className="mobile-conversation__notice"><summary>对话读取暂未确认 · 原 Agent 与输入保留</summary><p>{reading.notice}</p><button onClick={() => { void reading.refresh() }}>刷新原记录</button></details> : null}
      {local.notice ? <aside className="mobile-conversation__notice" role="status">{local.notice}
        {local.canSave ? <button type="button" onClick={() => { local.save(); redraw(value => value + 1) }}>重试保存</button> : null}
        <button type="button" disabled={!draft} onClick={() => {
          void platform.copyText(draft, error => setCopyNotice(`草稿未复制：${errorMessage(error)}`))
            .then(copied => { if (copied) setCopyNotice('已复制当前草稿。') })
        }}>复制当前草稿</button>
        {copyNotice ? <span>{copyNotice}</span> : null}
      </aside> : null}
      <div ref={feed} className="mobile-conversation__reading" onScroll={event => {
        const node = event.currentTarget
        follow.current = onScroll(follow.current, { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
        setJump(shouldShowJumpToLatest(follow.current))
      }}>
        {reading.page?.nextCursor && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { follow.current.following = false; void reading.older() }}>更早消息</button>}
        {(jump || reading.newerAvailable || reading.olderWindow) && <button className="mobile-reading-action mobile-reading-latest" onClick={() => {
          follow.current = initFollowState(); setJump(false)
          if (reading.olderWindow || reading.newerAvailable) void reading.refresh()
          else if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
        }}>{reading.newerAvailable ? '有新回复 · 回到最新' : '回到最新'}</button>}
        {session?.semanticStatus?.state === 'working' ? <p className="mobile-active-state" role="status"><span />正在执行</p> : null}
        {reading.page && agentSessionId ? <>
          <ConversationView page={reading.page} showInputSource={false} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
            renderProcess={props => <NativeProcessObservation {...props} compact />}
            {...(available && client?.forwardRpc ? { onReplyQuestion: async input => {
              const condition = agentPromptCondition(client.agentSession(agentSessionId))
              if (condition.expectedRun.runId !== session?.run.runId) throw new Error('原问题的 Run 已改变；对话与终端仍保留。')
              return client.forwardRpc!('agent.question.reply', { ...input, ...condition, agentSessionId, sourceChannel: 'api' })
            } } : {})}
            {...readingProps} />
        </> : !reading.reading ? <p className="mobile-conversation__empty">暂无已确认的对话内容，可发送消息或查看 Terminal。</p> : null}
        {captured.length > 0 || reading.timeline?.items.some(item => item.kind === 'assistant_message') ? <details className="mobile-conversation__captured" open={!reading.page?.items.length}><summary>发送与实时观察{attempt && attempt.phase !== 'confirmed' ? ' · 交付待确认' : ''}</summary><section aria-label="已发送消息">
          {reading.page && <p className="mobile-captured-source">独立记录来源，保留发送设备与交付事实</p>}
          {reading.timeline?.items.filter(item => item.agentSessionId === agentSessionId && (item.kind === 'user_message' || item.kind === 'assistant_message')).map(item => {
            if (item.kind === 'assistant_message') return <CapturedConversationMessage key={item.id} item={item}
              conversationSessionId={agentSessionId!} speaker={{ role: 'agent', id: agentSessionId! }} describeSpeaker={describeSpeaker} {...readingProps} />
            const message = capturedById.get(`captured:${item.id}`)
            return message ? <ConversationMessage key={message.id} messageId={message.id}
              conversationSessionId={agentSessionId!} content={message.contentParts} inputSource={message.source}
              speaker={speakerOfUserMessage(message)} describeSpeaker={describeSpeaker}
              {...(message.deliveryStatus ? { status: message.deliveryStatus } : {})}
              {...(message.recordedAt !== undefined ? { createdAt: message.recordedAt } : {})} {...readingProps} /> : null
          })}
        </section></details> : null}
      </div>
      {reading.timeline?.items.filter(item => item.sourceDevice && item.kind === 'system_message').map(item => <details key={item.id} className="mobile-conversation__notice"><summary>设备操作记录</summary><ConversationMessage
        messageId={item.id} conversationSessionId={agentSessionId!} content={item.content ?? item.title}
        inputSource={{ kind: 'captured', submissionId: item.id, device: item.sourceDevice! }}
        speaker={{ role: 'system', id: 'agentmux' }} createdAt={item.createdAt} {...readingProps} /></details>)}
      {request && requestKey ? <div className="mobile-conversation__interaction">
        <AgentInteractionCard key={requestKey} request={request} disabled={responseDisabled}
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : {})}
          onRespond={respond} />
        {responseAttempt ? <p role="status">{responseAttempt.message}</p> : null}
      </div> : null}
      <div className="mobile-conversation__composer">
        {inputCapability?.sessionId === agentSessionId && inputCapability.runId === session?.run.runId ?
          <aside className="mobile-conversation__notice" role="status">
            {inputCapability.execution === 'immediate' ? '立即执行输入' : inputCapability.issue ? '普通输入 · 立即执行能力未确认' : inputCapability.supported === false ? '普通输入 · 不支持立即执行' : '普通输入'}
            {attempt?.phase === 'confirmed' ? <span> · {attempt.message}</span> : null}
            {inputCapability.issue ? <><p>{inputCapability.issue} 原会话与当前草稿保留；本次选择普通输入，未尝试立即执行。</p>
              <button type="button" onClick={() => {
                if (!client || !agentSessionId) return
                try {
                  const original = client.agentSession(agentSessionId)
                  if (original.agentSessionId !== inputCapability.sessionId || original.run.runId !== inputCapability.runId) return
                  const observed = promptExecutionFor(client, original)
                  // Read-only recovery updates the service window, never the captured input mode.
                  setInputCapability({ ...inputCapability, supported: observed.supported, issue: observed.issue })
                } catch (error) {
                  setInputCapability({ ...inputCapability, issue: `原 Session 能力读取失败：${errorMessage(error)}` })
                }
              }}>重新读取能力目录</button></> : null}
          </aside> : null}
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
          tools={<MobileMessageTools refresh={() => { void reading.refresh() }} terminal={onShowTerminal} />} mailbox={<MobileMailbox session={session} connected={connection.state === 'connected'} messages={captured} platform={platform} describeSpeaker={describeSpeaker}
          refresh={() => { void reading.refresh() }} {...(onShowTerminal ? { terminal: onShowTerminal } : {})} />} value={draft} disabled={false} placeholder={available ? '发消息' : '离线草稿'}
          onChange={setDraft} {...(attempt?.phase !== 'sending' ? { onSubmit: () => void submit(), onQueue: () => void submit(false) } : {})}
          onAttach={onAttach ?? (() => { void attachmentControls.current?.choose() })} {...(readPastedImage ? { readPastedImage } : {})}
          />
        {attempt && attempt.phase !== 'confirmed' ? <aside className="mobile-send-status" data-phase={attempt.phase} aria-live="polite">
          <div className="mobile-send-status__summary">
            <span>{attempt.phase === 'sending' ? '正在发送…' : attempt.phase === 'unknown' ? '发送结果未确认 · 草稿已保留' : '尚未发送 · 草稿已保留'}</span>
            {attempt.phase !== 'sending' ? <button type="button" onClick={() => { void retryOriginalPrompt() }}>重试原请求</button> : null}
            {attempt.phase !== 'sending' ? <button type="button" onClick={() => { void reading.refresh() }}>刷新</button> : null}
            {attempt.phase !== 'sending' && onShowTerminal ? <button type="button" onClick={onShowTerminal}>终端</button> : null}
            {attempt.phase !== 'sending' ? <><p role="alert">{attempt.message}</p>{attempt.logId ? <DeliveryLogDetails log={diagnostics.get(attempt.logId)} logId={attempt.logId} copyText={text => platform.copyText(text, error => setCopyNotice(errorMessage(error)))} /> : null}</> : null}
          </div>
        </aside> : null}
      </div>
    </section>
  </ClientUiProvider>
}
