import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentInputSubmissionReceipt, AgentMuxAgentSession, AgentTimelineSnapshot } from '@agentmux/core'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { agentPromptCondition, agentPromptNotApplied, validateAgentPromptCondition } from '@agentmux/core/prompt-condition'
import { expandSemanticReferences } from '@agentmux/client-ui'
import { projectInputReceipt } from '@agentmux/client-ui/input-receipt-projection'
import { presentMessageDeliveryFailure } from '@agentmux/client-ui/message-delivery-presentation'
import { ClientDeliveryDiagnostics, startDeliveryAttempt, type DeliveryAttemptSeed } from '@agentmux/client-ui/delivery-diagnostics'
import { deliveryOutcome, errorMessage } from './delivery'
import type { createLocalDrafts, PromptAttempt } from './local-drafts'
import type { MobileConnection } from './use-hosted-conversation'
import type { ConfirmedAttachmentPrompt } from './attachments'

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

type MobilePromptControllerOptions = {
  local: ReturnType<typeof createLocalDrafts>
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  session: AgentMuxAgentSession | null
  timeline: AgentTimelineSnapshot | null
  connection: MobileConnection
  disconnected: boolean
  visible: boolean
  refresh: () => Promise<unknown>
}
export type MobilePromptPreparation = {
  prepare(body: string): Promise<string>
  /** Stop only this undispatched preparation; an original upload already requested is retained. */
  cancel?(): void
  /** Called only after the complete original message has been retained. */
  commit(): Promise<void>
}

/** Coordinates original device intents with Core; local-drafts remains the durable owner. */
export function useMobilePromptController({ local, client, agentSessionId, session, timeline, connection,
  disconnected, visible, refresh }: MobilePromptControllerOptions) {
  const draftKey = JSON.stringify(['draft', agentSessionId])
  const drafts = useRef(local.drafts), attempts = useRef(local.attempts)
  const [diagnostics] = useState(() => new ClientDeliveryDiagnostics())
  const [revision, redraw] = useState(0)
  const preparingKeys = useRef(new Map<string, { cancelled: boolean; cancel?: (() => void) | undefined }>())
  const [preparationIssue, setPreparationIssue] = useState<{ client: AgentMuxHostedClient | null; sessionId: string | null; message: string } | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const draft = drafts.current.get(draftKey) ?? ''
  const attempt = attempts.current.get(draftKey)
  const available = Boolean(client && agentSessionId && session && connection.state === 'connected' && !disconnected)
  const setDraft = (value: string, key = draftKey) => { drafts.current.set(key, value); void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1) }
  const confirmPrompt = (key: string, original: PromptAttempt, message = 'Core 已确认输入。') => {
    if (!mounted.current || attempts.current.get(key) !== original) return
    original.phase = 'confirmed'
    original.message = message
    delete original.logId
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
      if (!client.inspectAgentInput) return
      const currentRuntimeId = client.runtimeOwnerIdentity?.()?.runtimeId
      for (const [key, original] of promptAttemptsForSession(attempts.current, agentSessionId)) {
        if (!original.manualInput || original.manualInput.runtimeId !== null && currentRuntimeId && original.manualInput.runtimeId !== currentRuntimeId) continue
        void Promise.resolve().then(() => client.inspectAgentInput({ key: manualKey(original) })).then(receipt => {
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
      if (originalPromptRefused(session, agentSessionId, pending, client?.runtimeOwnerIdentity?.()?.runtimeId)) {
        pending.phase = 'rejected'
        pending.message = 'Core 已确认原输入未应用；草稿保留，可由你重新发送。'
        local.save()
        redraw(value => value + 1)
        continue
      }
      const receipt = timeline?.items.find(item => item.agentSessionId === agentSessionId
        && item.id === `prompt:${pending.operationId}` && item.kind === 'user_message' && item.status === 'complete')
      if (receipt) confirmPrompt(key, pending)
    }
  }, [timeline, session, agentSessionId, draftKey, revision])

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
    const settled = original.phase === 'confirmed' || original.inputReceipt?.status === 'terminal-confirmed' || original.inputReceipt?.status === 'admitted'
    if (!settled && mounted.current && attempts.current.get(key) === original) {
      original.phase = original.inputRequested === false ? 'rejected'
        : retry && original.phase !== 'rejected' ? 'unknown' : deliveryOutcome(error, 'prompt')
      original.message = errorMessage(error)
      local.save()
      redraw(value => value + 1)
    }
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
  async function submit(explicit = true, originalBody?: PromptAttempt, selectedKey = draftKey, preparation?: MobilePromptPreparation | null, bodyOnly = false): Promise<void> {
    const existing = attempts.current.get(selectedKey)
    const initialBody = originalBody?.draft ?? drafts.current.get(selectedKey) ?? ''
    let body = initialBody
    if (preparingKeys.current.has(selectedKey) && !bodyOnly || existing?.phase === 'sending' || !body.trim() && !preparation || originalBody && originalBody !== existing) return
    if (bodyOnly) {
      const previous = preparingKeys.current.get(selectedKey)
      if (previous) { previous.cancelled = true; previous.cancel?.() }
      preparingKeys.current.delete(selectedKey)
    }
    const preparing = { cancelled: false, cancel: preparation?.cancel }
    setPreparationIssue(null)
    const preparedTarget = preparation && client && session ? {
      client, sessionId: session.agentSessionId, hostId: session.hostId, runId: session.run.runId,
      runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId ?? null
    } : null
    const assertPreparedTarget = () => {
      if (!preparation) return
      if (preparing.cancelled) throw new Error('本次已明确选择仅发送正文；原上传和附件仍保留。')
      const selected = preparedTarget?.client.agentSession(preparedTarget.sessionId)
      if (!preparedTarget || current.current.client !== preparedTarget.client || current.current.agentSessionId !== preparedTarget.sessionId ||
          selected?.hostId !== preparedTarget.hostId || selected.run.runId !== preparedTarget.runId ||
          preparedTarget.client.runtimeOwnerIdentity?.()?.runtimeId !== preparedTarget.runtimeId) {
        throw new Error('原附件消息的客户端、Mac、Session 或 Run 已改变；正文和附件保留，本次没有请求输入。')
      }
    }
    if (preparation) {
      preparingKeys.current.set(selectedKey, preparing); redraw(value => value + 1)
      try { body = await preparation.prepare(initialBody); assertPreparedTarget() }
      catch (error) {
        if (mounted.current && !preparing.cancelled) setPreparationIssue({ client, sessionId: agentSessionId, message: errorMessage(error) })
        return
      } finally { if (preparingKeys.current.get(selectedKey) === preparing) preparingKeys.current.delete(selectedKey); if (mounted.current) redraw(value => value + 1) }
      if (!body.trim()) return
    }
    const refused = existing?.manualInput ? existing.inputReceipt?.status === 'not-applied'
      : originalPromptRefused(session, agentSessionId, existing, client?.runtimeOwnerIdentity?.()?.runtimeId)
    if (originalBody && !refused) return
    // An identical unresolved input keeps its original identity, even after another
    // draft became active. A distinct explicit body is a new intent for Core to qualify.
    const unresolved = !originalBody && promptAttemptsForSession(attempts.current, agentSessionId).find(([, value]) =>
      value.phase === 'unknown' && expandSemanticReferences(value.draft) === expandSemanticReferences(body))
    if (unresolved) {
      if (bodyOnly) { setPreparationIssue({ client, sessionId: agentSessionId, message: '同一正文已有未确认输入；原记录保留，请从原消息核对回执。本次仅正文不会重放它。' }); return }
      await retryOriginalPrompt(unresolved[0]); return
    }
    if (!refused && existing?.phase === 'rejected' && existing.draft === body) { await retryOriginalPrompt(selectedKey); return }
    const originalClient = client, originalId = agentSessionId
    const original: PromptAttempt = { operationId: randomClientRequestId(), runId: session?.run.runId ?? null,
      draft: body, phase: 'sending', message: '正在发送输入…', inputRequested: false,
      originalRuntimeId: originalClient?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
      originalHostId: session?.hostId ?? null, explicit }
    let seed = startDeliveryAttempt({ agentSessionId: originalId, operationId: original.operationId,
      hostId: session?.hostId ?? null, prompt: expandSemanticReferences(body) })
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
    let rpcRequested = false
    try {
      if (!available || !originalClient || !originalId) throw Object.assign(new Error(
        `原会话当前不能投递：${connection.issue ?? connection.message}${disconnected ? '；会话连接已断开' : ''}。草稿已保留，可继续点击发送重试。`), { code: 'CONTROL_UNAVAILABLE' })
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
      if (preparation && drafts.current.get(originalKey) === initialBody) drafts.current.set(originalKey, body)
      if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入，原正文保留。')
      redraw(value => value + 1)
      if (attempts.current.get(originalKey) !== original) throw new Error('另一页面已保全原消息；本次未请求输入，请核对原请求和两份正文。')
      if (preparation) { assertPreparedTarget(); await preparation.commit(); assertPreparedTarget() }
      stage = 'core-submit'
      original.inputRequested = true; if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入。')
      if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入，请核对原记录。')
      assertPreparedTarget()
      rpcRequested = true
      const receipt = await originalClient.submitAgentPrompt({ agentSessionId: originalId, operationId: original.operationId,
        prompt: expandSemanticReferences(original.draft), authorHuman: true,
        ...(original.manualInput ? { expectedRun: original.manualInput.expectedRun, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
          : { ...original.request!.condition, execution: original.request!.execution }) })
      if (original.manualInput) {
        if (receipt && !observeInputReceipt(originalKey, original, receipt)) throw Object.assign(
          new Error('Core 返回了另一条输入的回执；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
        if (!receipt) throw Object.assign(new Error('原消息的 Core 保存或输入回执尚未确认；原正文和身份保留，可核对原请求。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      } else confirmPrompt(originalKey, original)
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void refresh()
    } catch (error) {
      if (!rpcRequested) original.inputRequested = false
      await retainFailure(original, seed, error, stage, originalClient, originalKey, false)
    }
  }

  async function retryOriginalPrompt(selectedKey = draftKey): Promise<void> {
    const original = attempts.current.get(selectedKey)
    if (!original || original.phase === 'sending' || original.phase === 'confirmed') return
    if (original.manualInput) { await retryManualInput(selectedKey, original); return }
    if (originalPromptRefused(session, agentSessionId, original, client?.runtimeOwnerIdentity?.()?.runtimeId)) {
      await submit(original.request!.explicit, original, selectedKey)
      return
    }
    const originalClient = client, originalId = agentSessionId, originalKey = selectedKey
    let seed = startDeliveryAttempt({ agentSessionId: originalId, operationId: original.operationId,
      hostId: session?.hostId ?? null, condition: original.request?.condition,
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
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void refresh()
    } catch (error) {
      original.phase = previousPhase
      await retainFailure(original, seed, error, stage, originalClient, originalKey, true)
    }
  }

  const allAttempts = promptAttemptsForSession(attempts.current, agentSessionId)
  // Recent device intents remain editable memory; they are never promoted to native history or a delivery receipt.
  const historyLocalEntries = allAttempts
    .filter(([, original]) => original.draft && session?.hostId && original.originalHostId === session.hostId)
    .map(([key, original]) => ({ id: key + ':' + original.operationId, text: original.draft,
      ...(original.manualInput && original.originalHostId ? { inputOrigin: { hostId: original.originalHostId, key: manualKey(original) } } : {}) }))
  const retainedAttempts = allAttempts.filter(([key, original]) => key !== draftKey && original.phase !== 'confirmed')
  let confirmedAttachmentPrompt: ConfirmedAttachmentPrompt | null = null
  if (attempt?.phase === 'confirmed') {
    const runtimeId = attempt.manualInput?.runtimeId ?? attempt.request?.runtimeId ?? attempt.originalRuntimeId
    const hostId = attempt.originalHostId, runId = attempt.manualInput?.expectedRun.runId ?? attempt.request?.condition.expectedRun.runId ?? attempt.runId
    // The draft Map key is the original saved Session route, never today's Session metadata.
    const savedKey: unknown = JSON.parse(draftKey)
    const sessionId = attempt.manualInput?.agentSessionId ?? (Array.isArray(savedKey) && savedKey[0] === 'draft' && typeof savedKey[1] === 'string' ? savedKey[1] : null)
    if (runtimeId && hostId && runId && sessionId) confirmedAttachmentPrompt = { operationId: attempt.operationId, body: attempt.draft, source: { runtimeId, hostId, sessionId, runId } }
  }
  return { draftKey, draft, attempt, available, diagnostics, setDraft, submit, retryOriginalPrompt, stopManualInput,
    confirmedAttachmentPrompt,
    sendBodyOnly: () => submit(true, undefined, draftKey, undefined, true),
    preparing: preparingKeys.current.has(draftKey), hasAnyPreparation: () => preparingKeys.current.size > 0, preparationIssue: preparationIssue && preparationIssue.client === client && preparationIssue.sessionId === agentSessionId ? preparationIssue.message : null,
    historyLocalEntries, retainedAttempts, sessionAttempts: allAttempts,
    promptWasRefused: (original: PromptAttempt) => originalPromptRefused(session, agentSessionId, original, client?.runtimeOwnerIdentity?.()?.runtimeId) }
}
