import { projectInputReceipt } from '@agentmux/client-ui/input-receipt-projection'
import { presentMessageDeliveryFailure } from '@agentmux/client-ui/message-delivery-presentation'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { mobileQuestionReplyState, observeMobileQuestionAnswers, replyMobileQuestion } from './question-replies'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { ClientDeliveryDiagnostics, startDeliveryAttempt, type DeliveryAttemptSeed } from '@agentmux/client-ui/delivery-diagnostics'
import { DeliveryLogDetails } from '@agentmux/client-ui/components/DeliveryLogDetails'
import { initFollowState, onContentChange, onScroll, shouldShowJumpToLatest } from '@agentmux/client-ui/activity-autoscroll'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason } from '@agentmux/core/agent-interaction-state'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentInputSubmissionReceipt, AgentInputWaitRef, AgentMuxAgentSession, AgentMuxInteractionResponse, AgentSessionUserMessage } from '@agentmux/core'
import type { InputHistoryRead } from '@agentmux/client-ui/use-agent-input-history'
import { inputHistoryText } from '@agentmux/client-ui/input-history-text'
import { agentPromptCondition, agentPromptNotApplied, validateAgentPromptCondition } from '@agentmux/core/prompt-condition'
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
function originalPromptRefused(session: AgentMuxAgentSession | null | undefined, agentSessionId: string | null,
  attempt: PromptAttempt | undefined, runtimeId: string | null | undefined): boolean {
  if (attempt?.manualInput && attempt.inputReceipt?.status === 'not-applied') return session?.agentSessionId === agentSessionId &&
    session.run.runId === attempt.manualInput.expectedRun.runId && session.hostId === attempt.originalHostId &&
    Boolean(runtimeId && runtimeId === attempt.manualInput.runtimeId)
  const request = attempt?.request, originalRuntime = request?.runtimeId ?? attempt?.originalRuntimeId
  if (!session || !attempt || attempt.inputRequested !== true || !request || !originalRuntime || originalRuntime !== runtimeId
    || session.agentSessionId !== agentSessionId || !attempt.originalHostId || session.hostId !== attempt.originalHostId
    || request.condition.expectedRun.runId !== attempt.runId || session.run.runId !== attempt.runId) return false
  const fact = agentPromptNotApplied(session)
  return fact?.submissionId === attempt.operationId && fact.run.runId === attempt.runId
}
function retainedPromptKey(sessionId: string | null, operationId: string): string {
  return JSON.stringify(['retained-prompt', sessionId, operationId])
}
/** These keys route existing device intents; they grant no Core input authority. */
function promptAttemptsForSession(attempts: ReadonlyMap<string, PromptAttempt>, sessionId: string | null) {
  const active = JSON.stringify(['draft', sessionId])
  return [...attempts].filter(([key]) => {
    if (key === active) return true
    try {
      const value: unknown = JSON.parse(key)
      return Array.isArray(value) && value.length === 3 &&
        (value[0] === 'retained-prompt' || value[0] === 'refused-prompt') && value[1] === sessionId
    } catch { return false }
  })
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
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const draft = drafts.current.get(draftKey) ?? ''
  const attempt = attempts.current.get(draftKey)
  const attachmentControls = useRef<MobileAttachmentControls>(null)
  const insertion = useRef<ComposerInsertionHandle>(null)
  const available = Boolean(client && agentSessionId && reading.session && connection.state === 'connected' && !reading.disconnected)
  const setDraft = (value: string, key = draftKey) => { drafts.current.set(key, value); void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) }
  const confirmPrompt = (key: string, original: PromptAttempt, message = 'Core 已确认输入。') => {
    if (!mounted.current || attempts.current.get(key) !== original) return
    original.phase = 'confirmed'
    original.message = message
    // A receipt belongs to its captured operation, including after navigating elsewhere.
    if (drafts.current.get(key) === original.draft) drafts.current.set(key, '')
    local.save()
    if (mounted.current) redraw(value => value + 1)
  }
  function observeInputReceipt(key: string, original: PromptAttempt, next: AgentInputSubmissionReceipt) {
    const input = original.manualInput, target = next.key
    if (!mounted.current || attempts.current.get(key) !== original || !input || target.kind !== 'prompt' ||
        target.agentSessionId !== input.agentSessionId || target.expectedRun.runId !== input.expectedRun.runId ||
        target.submissionId !== original.operationId) return false
    if (original.phase === 'confirmed' && !original.inputReceipt && next.status !== 'terminal-confirmed' && next.status !== 'admitted') {
      throw Object.assign(new Error('当前观察与这条原输入先前的确认记录冲突；先前记录保留，请核对原 Core 回执。'), { code: 'CONTROL_REQUEST_CONFLICT' })
    }
    const receipt = projectInputReceipt(original.inputReceipt, next)
    if (receipt === original.inputReceipt) return true
    original.inputReceipt = receipt
    const summary = presentMessageDeliveryFailure({ error: null, inputReceipt: receipt, inputStopReceipt: input.stopReceipt })
    if (receipt.status === 'terminal-confirmed' || receipt.status === 'admitted') {
      confirmPrompt(key, original, summary.state)
      return true
    }
    original.phase = receipt.status === 'not-applied' ? 'rejected' : 'unknown'
    original.message = `${summary.state} ${summary.action}`
    void local.save(); redraw(value => value + 1)
    return true
  }
  function manualKey(original: PromptAttempt) {
    const input = original.manualInput!
    return { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: original.operationId }
  }
  function originalManualClient(original: PromptAttempt) {
    const input = original.manualInput, originalClient = client
    if (!input || !originalClient) throw Object.assign(new Error('原消息尚未连接到 Core；正文和身份保留。'), { code: 'CONTROL_UNAVAILABLE' })
    let currentSession: ReturnType<AgentMuxHostedClient['agentSession']> | undefined
    try { currentSession = originalClient.agentSession(input.agentSessionId) } catch { /* Observation absence does not replace or revoke the captured key. */ }
    const currentRuntimeId = originalClient.runtimeOwnerIdentity?.()?.runtimeId
    if (input.runtimeId && currentRuntimeId && currentRuntimeId !== input.runtimeId ||
        original.originalHostId && currentSession?.hostId && currentSession.hostId !== original.originalHostId) throw Object.assign(
      new Error('当前连接与原 Runtime 或 Mac 不一致；原消息保留，不会转向另一处重投。'), { code: 'STALE_AGENT_SESSION' })
    return originalClient
  }
  function manualSeed(original: PromptAttempt) {
    return Object.freeze({ ...startDeliveryAttempt({ agentSessionId: original.manualInput!.agentSessionId, operationId: original.operationId,
      hostId: original.originalHostId ?? null, prompt: expandSemanticReferences(original.draft) }), expectedRunId: original.runId, execution: 'immediate' as const })
  }
  async function retryManualInput(key: string, original: PromptAttempt) {
    try {
      const source = originalManualClient(original), input = original.manualInput!
      const observed = await source.inspectAgentInput({ key: manualKey(original) })
      if (observed && !observeInputReceipt(key, original, observed)) throw Object.assign(
        new Error('Core 返回了另一条输入的观察；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      if (attempts.current.get(key) !== original) return
      if (observed && (observed.status !== 'stopped' && (observed.status !== 'waiting' ||
          observed.observation !== 'rejoin-needed' && observed.control.waiting?.wake !== 'explicit-rejoin'))) return
      if (!await local.save() || attempts.current.get(key) !== original) return
      original.inputRequested = true
      if (!await local.save() || attempts.current.get(key) !== original) return
      const receipt = observed ? await source.rejoinAgentInputWaiting({ ref: observed.ref })
        : await source.submitAgentPrompt({ agentSessionId: input.agentSessionId, operationId: original.operationId,
          expectedRun: input.expectedRun, admissionIntent: { kind: 'manual-actor' }, prompt: expandSemanticReferences(original.draft),
          execution: 'immediate', authorHuman: true })
      if (receipt && !observeInputReceipt(key, original, receipt)) throw Object.assign(
        new Error('Core 返回了另一条输入的回执；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      if (!receipt) throw Object.assign(new Error('原操作尚未返回 Core 输入回执；原正文和身份保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    } catch (error) { await retainFailure(original, manualSeed(original), error, 'input-observation', client, key, true) }
  }
  async function stopManualInput(key: string, original: PromptAttempt) {
    try {
      const source = originalManualClient(original), input = original.manualInput!
      const receipt = original.inputReceipt ?? await source.inspectAgentInput({ key: manualKey(original) })
      if (!receipt) throw Object.assign(new Error('原等待代次尚未确认，未发起停止；原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      if (!observeInputReceipt(key, original, receipt)) throw Object.assign(
        new Error('Core 返回了另一条等待的观察；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      const ref = receipt.ref
      const stop = input.stopIntent?.ref.waitGeneration === ref.waitGeneration ? input.stopIntent
        : { ref: structuredClone(ref), cancelOperationId: randomClientRequestId() }
      input.stopIntent = stop
      if (!await local.save() || attempts.current.get(key) !== original) return
      const stopped = await source.stopAgentInputWaiting(stop)
      if (attempts.current.get(key) !== original || input.stopIntent !== stop) return
      const stoppedKey = stopped.ref.key, originalKey = manualKey(original)
      if (stopped.cancelOperationId !== stop.cancelOperationId || stopped.ref.waitGeneration !== stop.ref.waitGeneration ||
          stoppedKey.kind !== 'prompt' || stoppedKey.agentSessionId !== originalKey.agentSessionId ||
          stoppedKey.expectedRun.runId !== originalKey.expectedRun.runId || stoppedKey.submissionId !== originalKey.submissionId) {
        throw Object.assign(new Error('停止回执不属于这条原输入；未采用该回执，原等待身份保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      }
      input.stopReceipt = stopped
      void local.save(); redraw(value => value + 1)
      // The stop ACK stands independently if this follow-up observation is unavailable.
      const after = await source.inspectAgentInput({ key: manualKey(original) })
      if (after) observeInputReceipt(key, original, after)
    } catch (error) { await retainFailure(original, manualSeed(original), error, 'input-stop', client, key, true) }
  }
  useEffect(() => {
    if (!client || !agentSessionId || !visible || connection.state !== 'connected') return
    let live = true
    const inspect = () => {
      const currentRuntimeId = client.runtimeOwnerIdentity?.()?.runtimeId
      for (const [key, original] of promptAttemptsForSession(attempts.current, agentSessionId)) {
        if (!original.manualInput || original.manualInput.runtimeId !== null && currentRuntimeId && original.manualInput.runtimeId !== currentRuntimeId) continue
        void client.inspectAgentInput({ key: manualKey(original) }).then(receipt => {
          if (live && receipt) observeInputReceipt(key, original, receipt)
        }).catch(error => { if (live) void retainFailure(original, manualSeed(original), error, 'input-observation', client, key, true) })
      }
    }
    const unlisten = client.onEvent(event => {
      if (!live) return
      if (event.type === 'connection-state' && event.state === 'restored') inspect()
      if (event.type !== 'agent-input' || event.receipt.key.agentSessionId !== agentSessionId) return
      const currentRuntimeId = client.runtimeOwnerIdentity?.()?.runtimeId
      for (const [key, original] of promptAttemptsForSession(attempts.current, agentSessionId)) {
        if (!original.manualInput || original.manualInput.runtimeId !== null && currentRuntimeId && original.manualInput.runtimeId !== currentRuntimeId) continue
        try { observeInputReceipt(key, original, event.receipt) }
        catch (error) { void retainFailure(original, manualSeed(original), error, 'input-observation', client, key, true) }
      }
    })
    inspect()
    return () => { live = false; unlisten() }
  }, [client, agentSessionId, visible, connection.state])
  useEffect(() => {
    for (const [key, pending] of promptAttemptsForSession(attempts.current, agentSessionId)) {
      if (pending.phase !== 'unknown' || pending.manualInput) continue
      if (originalPromptRefused(reading.session, agentSessionId, pending, client?.runtimeOwnerIdentity?.()?.runtimeId)) {
        pending.phase = 'rejected'
        pending.message = 'Core 已确认原输入未应用；草稿保留，可由你重新发送。'
        local.save()
        redraw(value => value + 1)
        continue
      }
      const receipt = reading.timeline?.items.find(item => item.agentSessionId === agentSessionId
        && item.id === `prompt:${pending.operationId}` && item.kind === 'user_message' && item.status === 'complete')
      if (receipt) confirmPrompt(key, pending)
    }
  }, [reading.timeline, reading.session, agentSessionId, draftKey, revision])

  useEffect(() => {
    if (reading.page && agentSessionId) void observeMobileQuestionAnswers(local, agentSessionId, reading.page, reading.session, client?.runtimeOwnerIdentity?.()?.runtimeId).then(changed => { if (changed && mounted.current) redraw(value => value + 1) })
  }, [reading.page, reading.session, agentSessionId, client, local])
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
    const ownerId = original.manualInput?.runtimeId ?? original.request?.runtimeId
    const owner = ownerId ? `runtime:${ownerId}` : diagnosticOwner(originalClient)
    const log = await diagnostics.failed(seed, error, stage, owner)
    reportDiagnostics(originalClient)
    if (!mounted.current || attempts.current.get(key) !== original) return
    // A refusal of this click cannot settle an older unknown logical message.
    if (original.phase === 'confirmed' || original.inputReceipt?.status === 'terminal-confirmed' || original.inputReceipt?.status === 'admitted') {
      original.logId = log.record.logId; local.save(); redraw(value => value + 1); return
    }
    original.phase = original.inputRequested === false ? 'rejected'
      : retry && original.phase !== 'rejected' ? 'unknown' : deliveryOutcome(error, 'prompt')
    original.logId = log.record.logId
    original.message = errorMessage(error)
    if (attempts.current.get(key) === original) local.save()
    if (mounted.current) redraw(value => value + 1)
  }
  async function submit(explicit = true, originalBody?: PromptAttempt, selectedKey = draftKey): Promise<void> {
    const existing = attempts.current.get(selectedKey)
    const body = originalBody?.draft ?? draft
    if (existing?.phase === 'sending' || !body.trim() || originalBody && originalBody !== existing) return
    const refused = existing?.manualInput ? existing.inputReceipt?.status === 'not-applied'
      : originalPromptRefused(reading.session, agentSessionId, existing, client?.runtimeOwnerIdentity?.()?.runtimeId)
    if (originalBody && !refused) return
    // An identical unresolved input keeps its original identity, even after another
    // draft became active. A distinct explicit body is a new intent for Core to qualify.
    const unresolved = !originalBody && promptAttemptsForSession(attempts.current, agentSessionId).find(([, value]) =>
      value.phase === 'unknown' && expandSemanticReferences(value.draft) === expandSemanticReferences(body))
    if (unresolved) { await retryOriginalPrompt(unresolved[0]); return }
    if (!refused && existing?.phase === 'rejected' && existing.draft === body) { await retryOriginalPrompt(selectedKey); return }
    const originalClient = client, originalId = agentSessionId
    const original: PromptAttempt = { operationId: randomClientRequestId(), runId: reading.session?.run.runId ?? null,
      draft: body, phase: 'sending', message: '正在发送输入…', inputRequested: false,
      originalRuntimeId: originalClient?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
      originalHostId: reading.session?.hostId ?? null, explicit }
    let seed = startDeliveryAttempt({ agentSessionId: originalId, operationId: original.operationId,
      hostId: reading.session?.hostId ?? null, prompt: expandSemanticReferences(body) })
    const originalKey = originalBody && selectedKey !== draftKey ? retainedPromptKey(originalId, original.operationId) : draftKey
    if (existing && (refused || existing.phase === 'unknown')) {
      if (refused) existing.phase = 'rejected'
      // Preserve the complete old intent in the same CAS-backed owner before replacing
      // the active draft slot. No save, navigation or retry dispatches this retained record.
      if (selectedKey === draftKey) attempts.current.set(refused
        ? JSON.stringify(['refused-prompt', originalId, existing.operationId])
        : retainedPromptKey(originalId, existing.operationId), existing)
    }
    attempts.current.set(originalKey, original)
    let stage = 'client-validation'
    try {
      if (!available || !originalClient || !originalId) throw Object.assign(new Error(
        `原会话当前不能投递：${connection.issue ?? connection.message}${reading.disconnected ? '；会话连接已断开' : ''}。草稿已保留，可继续点击发送重试。`), { code: 'CONTROL_UNAVAILABLE' })
      const originalSession = originalClient.agentSession(originalId)
      original.runId = originalSession.run.runId
      if (explicit) {
        original.manualInput = { agentSessionId: originalId, expectedRun: { ...originalSession.run },
          runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
      } else {
        original.request = { condition: structuredClone(agentPromptCondition(originalSession)), execution: 'default', explicit: false,
          runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
      }
      seed = Object.freeze({ ...seed, expectedRunId: original.runId,
        afterSubmissionId: original.request?.condition.afterSubmissionId ?? null,
        conditionAvailable: Boolean(original.request), execution: explicit ? 'immediate' : 'default' })
      if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入，原正文保留。')
      redraw(value => value + 1)
      if (attempts.current.get(originalKey) !== original) throw new Error('另一页面已保全原消息；本次未请求输入，请核对原请求和两份正文。')
      stage = 'core-submit'
      original.inputRequested = true; if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入。')
      if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入，请核对原记录。')
      const receipt = await originalClient.submitAgentPrompt({ agentSessionId: originalId, operationId: original.operationId,
        prompt: expandSemanticReferences(original.draft), authorHuman: true,
        ...(original.manualInput ? { expectedRun: original.manualInput.expectedRun, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
          : { ...original.request!.condition, execution: original.request!.execution }) })
      if (original.manualInput) {
        if (receipt && !observeInputReceipt(originalKey, original, receipt)) throw Object.assign(
          new Error('Core 返回了另一条输入的回执；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
        if (!receipt) throw Object.assign(new Error('原消息的 Core 保存或输入回执尚未确认；原正文和身份保留，可核对原请求。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      } else confirmPrompt(originalKey, original)
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void reading.refresh()
    } catch (error) { await retainFailure(original, seed, error, stage, originalClient, originalKey, false) }
  }

  async function retryOriginalPrompt(selectedKey = draftKey): Promise<void> {
    const original = attempts.current.get(selectedKey)
    if (!original || original.phase === 'sending' || original.phase === 'confirmed') return
    if (original.manualInput) { await retryManualInput(selectedKey, original); return }
    if (originalPromptRefused(reading.session, agentSessionId, original, client?.runtimeOwnerIdentity?.()?.runtimeId)) {
      await submit(original.request!.explicit, original, selectedKey)
      return
    }
    const originalClient = client, originalId = agentSessionId, originalKey = selectedKey
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
        const changedRun = original.runId !== null && originalSession.run.runId !== original.runId
        if (originalSession.agentSessionId !== originalId || original.originalHostId && originalSession.hostId !== original.originalHostId
          || changedRun && (!originalRuntimeId || !original.originalHostId)) {
          throw Object.assign(new Error('原消息的 Session 或执行 Host 无法核实；本次未请求输入。'), { code: 'STALE_AGENT_SESSION' })
        }
        if (original.explicit === undefined) throw Object.assign(new Error(
          '原消息最初的执行选择无法核实；本次未请求输入，原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
        if (original.explicit) {
          original.runId = originalSession.run.runId
          original.originalHostId = originalSession.hostId ?? null
          original.manualInput = { agentSessionId: originalId, expectedRun: { ...originalSession.run },
            runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
          if (!await local.save() || attempts.current.get(originalKey) !== original) return
          await retryManualInput(originalKey, original)
          return
        }
        const condition = agentPromptCondition(originalSession)
        original.runId = condition.expectedRun.runId
        original.request = { condition: structuredClone(condition), execution: 'default', explicit: false,
          runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
        if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入。')
        if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入。')
      }
      const input = originalPromptRequest(originalSession, originalId, original)
      if (!input) throw Object.assign(new Error('原 Session、Run 或投递条件无法完整核实；本次未请求输入，原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      seed = Object.freeze({ ...seed, expectedRunId: input.expectedRun.runId,
        afterSubmissionId: input.afterSubmissionId, conditionAvailable: true, execution: input.execution })
      original.phase = 'sending'; original.message = '正在核对并续做原请求…'
      if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入，原正文保留。')
      redraw(value => value + 1)
      if (attempts.current.get(originalKey) !== original) throw new Error('另一页面已保全原消息；本次未请求输入，请核对原请求和两份正文。')
      stage = 'core-submit'
      original.inputRequested = true; if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入。')
      if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入，请核对原记录。')
      await originalClient.submitAgentPrompt(input)
      confirmPrompt(originalKey, original)
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void reading.refresh()
    } catch (error) {
      original.phase = previousPhase
      await retainFailure(original, seed, error, stage, originalClient, originalKey, true)
    }
  }

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
  const requestKey = session && request && requestRun
    ? JSON.stringify([session.agentSessionId, requestRun.runId, request.id]) : null
  const responseAttempt = requestKey ? responses.current.get(requestKey) : undefined
  const responseDisabled = !available || request?.agentSessionId !== session?.agentSessionId
    || requestRun?.runId !== session?.run.runId || Boolean(responseUnavailableReason)
    || responseAttempt?.phase === 'unknown' || responseAttempt?.phase === 'sending' || responseAttempt?.phase === 'confirmed'
  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (!client || !session || !request || !requestRun || !requestKey || responseDisabled) return
    const previous = responses.current.get(requestKey)
    if (previous?.phase === 'sending' || previous?.phase === 'unknown' || previous?.phase === 'confirmed') return
    const originalKey = requestKey
    const original: ResponseAttempt = { phase: 'sending', message: '正在发送原请求的答复…' }
    responses.current.set(originalKey, original)
    const retained = await local.save()
    redraw(value => value + 1)
    try {
      if (!retained || responses.current.get(originalKey) !== original) throw new Error('另一页面已保全这个请求的答复；本次未重复回答。')
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
    } finally { if (mounted.current) { void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) } }
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
  const mailboxMessages = useMemo(() => agentSessionId ? projectSessionUserMessages({ agentSessionId,
    ...(reading.page ? { historyPage: reading.page } : {}), ...(reading.timeline ? { timeline: reading.timeline } : {}) }) : [],
  [agentSessionId, reading.page, reading.timeline])
  const capturedById = useMemo(() => new Map(captured.map(message => [message.id, message])), [captured])
  const appendQuote = (quote: string) => setDraft(`${drafts.current.get(draftKey) ?? ''}${drafts.current.get(draftKey) ? '\n\n' : ''}${quote}`)
  const readingProps = {
    ...(session ? { workspaceRoot: session.workspacePath } : {}),
    ...(openWorkspaceFile ? { openWorkspaceFile } : {}), ...(readPastedImage ? { readPastedImage } : {}),
    ...(openHttpLink ? { openHttpLink } : {}),
    onSelectAnnotation: ({ messageId, quote }: Parameters<NonNullable<ConversationMessageProps['onSelectAnnotation']>>[0]) =>
      appendQuote(`引用会话 ${JSON.stringify(agentSessionId)}，消息 ${JSON.stringify(messageId)}：\n${quote.split('\n').map(line => `> ${line}`).join('\n')}`)
  }
  // Recent device intents remain editable memory; they are never promoted to native history or a delivery receipt.
  const historyLocalEntries = promptAttemptsForSession(attempts.current, agentSessionId)
    .filter(([, original]) => original.draft && session?.hostId && original.originalHostId === session.hostId)
    .map(([key, original]) => ({ id: key + ':' + original.operationId, text: original.draft }))
  const retainedAttempts = promptAttemptsForSession(attempts.current, agentSessionId).filter(([key, original]) => key !== draftKey && original.phase !== 'confirmed')
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
              <button type="button" onClick={() => { void retryOriginalPrompt(key) }}>{originalPromptRefused(reading.session, agentSessionId, original, client?.runtimeOwnerIdentity?.()?.runtimeId) ? '重新发送原正文' : key === draftKey ? '重试原请求' : '重试这条原请求'}</button>
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
        {reading.page?.nextCursor && <button className="mobile-reading-action" disabled={reading.reading} onClick={() => { follow.current.following = false; void reading.older() }}>更早消息</button>}
        {(jump || reading.newerAvailable || reading.olderWindow) && <button className="mobile-reading-action mobile-reading-latest" onClick={() => {
          follow.current = initFollowState(); setJump(false)
          if (reading.olderWindow || reading.newerAvailable) void reading.refresh()
          else if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
        }}>{reading.newerAvailable ? '有新回复 · 回到最新' : '回到最新'}</button>}
        {session?.semanticStatus?.state === 'working' ? <p className="mobile-active-state" role="status"><SemanticIcon name="status.presence-working" size={5} />正在执行</p> : null}
        {reading.page && agentSessionId ? <>
          <ConversationView page={reading.page} showInputSource={false} sessionId={agentSessionId} describeSpeaker={describeSpeaker}
            renderProcess={props => <NativeProcessObservation {...props} compact />}
            questionReplyState={target => mobileQuestionReplyState(local, agentSessionId, target)}
            questionReplyDraft={target => local.questionDrafts.get(questionReplyKey(agentSessionId, target))}
            onQuestionDraftChange={(target, answers) => {
              local.questionDrafts.set(questionReplyKey(agentSessionId, target), structuredClone(answers))
              void local.save().then(() => { if (mounted.current) redraw(value => value + 1) })
            }}
            {...(available && client?.forwardRpc ? { onReplyQuestion: input => replyMobileQuestion(client, agentSessionId, session!.run.runId,
              input, local, () => { if (mounted.current) redraw(value => value + 1) }) } : {})}
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
          {...(responseAttempt?.phase === 'unknown' ? { responseUnavailableReason: responseAttempt.message } : responseUnavailableReason ? { responseUnavailableReason } : {})}
          onRespond={respond} />
        {responseAttempt ? <p role="status">{responseAttempt.message}</p> : null}
      </div> : null}
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
          tools={<MobileMessageTools refresh={() => { void reading.refresh() }} terminal={onShowTerminal} />} mailbox={<MobileMailbox session={session} connected={connection.state === 'connected'} messages={mailboxMessages} platform={platform} describeSpeaker={describeSpeaker}
          refresh={() => { void reading.refresh() }} historyScope={historyScope} readHistory={readInputHistory} visible={visible}
          onHistoryFill={fillHistoryMessage} onHistoryCopy={copyHistoryMessage} localEntries={historyLocalEntries}
          onHistoryFillLocal={entry => {
            if (currentHistory.current.scope !== historyScope || current.current.client !== client || current.current.agentSessionId !== agentSessionId)
              throw new Error('已切换 Agent，原正文和当前草稿保留。')
            if (!insertion.current) throw new Error('原编辑器已关闭，正文和草稿保留。')
            insertion.current.replace(entry.text)
          }}
          reading={{ ...readingProps, ...(client && agentSessionId ? { readHistoryResource: (input: Parameters<AgentMuxHostedClient['sessionHistoryResource']>[1]) => client.sessionHistoryResource(agentSessionId, input) } : {}) }}
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
