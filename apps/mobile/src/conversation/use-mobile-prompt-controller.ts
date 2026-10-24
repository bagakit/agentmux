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
import { useMobileWebDispatchedOperations, useMobileWebUpdatePendingAction } from '../mobile-web/update-safety'
import { getDeviceWorkface } from '../recovery/device-workface'

function dispatchedPromptIdentity(original: PromptAttempt): string {
  const input = original.manualInput
  return JSON.stringify([original.operationId, original.runId, original.draft, original.originalRuntimeId,
    original.originalHostId, original.explicit, original.request,
    input && [input.agentSessionId, input.expectedRun, input.runtimeId]])
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

type PendingInputAction = { cancelled: boolean; dispatched: boolean; saving: boolean; allowUpdate: () => void }

/** Coordinates original device intents with Core; local-drafts remains the durable owner. */
export function useMobilePromptController({ local, client, agentSessionId, session, timeline, connection,
  disconnected, visible, refresh }: MobilePromptControllerOptions) {
  const draftKey = JSON.stringify(['draft', agentSessionId])
  const drafts = useRef(local.drafts), attempts = useRef(local.attempts)
  const [diagnostics] = useState(() => new ClientDeliveryDiagnostics())
  const [revision, redraw] = useState(0)
  const protectUpdate = useMobileWebUpdatePendingAction()
  const dispatched = useMobileWebDispatchedOperations()
  const preparingKeys = useRef(new Map<string, { cancelled: boolean; retaining: boolean; cancel?: (() => void) | undefined }>())
  const pendingActions = useRef(new Map<string, PendingInputAction>())
  const [preparationIssue, setPreparationIssue] = useState<{ client: AgentMuxHostedClient | null; sessionId: string | null; message: string } | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, agentSessionId })
  current.current = { client, agentSessionId }
  const draft = drafts.current.get(draftKey) ?? ''
  const attempt = attempts.current.get(draftKey)
  const available = Boolean(client && agentSessionId && session && connection.state === 'connected' && !disconnected)
  const automaticPause = useRef<{ target: import('@agentmux/core/agent-automation').AgentAutomationTarget; client: AgentMuxHostedClient } | null>(null)
  const pauseForExplicitInput = () => {
    if (!client || !session || session.agentSessionId !== agentSessionId) return
    const owner = client.runtimeOwnerIdentity()
    if (!owner || owner.availability !== 'connected') {
      setPreparationIssue({ client, sessionId: agentSessionId, message: '原 Host 身份尚未确认，自动活动暂停未提交；手工输入与草稿仍可使用。' }); return
    }
    const prior = automaticPause.current
    if (prior?.client === client && prior.target.agentSessionId === session.agentSessionId && prior.target.expectedRun.runId === session.run.runId && prior.target.ownerInstanceId === owner.ownerInstanceId) return
    const target = { agentSessionId: session.agentSessionId, expectedRun: { runId: session.run.runId }, ownerInstanceId: owner.ownerInstanceId, operationId: randomClientRequestId() }
    automaticPause.current = { target, client }
    void Promise.resolve().then(() => {
      if (!client.forwardRpc) throw new Error('原 Host 公共暂停能力暂不可用。')
      return client.forwardRpc('agent.automation.pause', target)
    }).then(result => {
      if (result.receipt?.status !== 'confirmed') throw new Error('原自动活动暂停回执未知。')
    }).catch(error => { if (mounted.current) setPreparationIssue({ client, sessionId: target.agentSessionId,
      message: `自动活动暂停尚未确认：${errorMessage(error)}。保留原操作 ${target.operationId}、Host ${target.ownerInstanceId}；可用 agent automation inspect 核对，不会自动重投。手工输入仍可使用。` }) })
  }
  const setDraft = (value: string, key = draftKey) => {
    const occupied = Boolean(drafts.current.get(key)?.trim())
    drafts.current.set(key, value)
    if (key === draftKey && value.trim() && !occupied) pauseForExplicitInput()
    if (key === draftKey && !value.trim()) automaticPause.current = null
    void local.save().then(() => { if (mounted.current) redraw(value => value + 1) }); redraw(value => value + 1)
  }
  const cancelPreparation = (key = draftKey) => {
    const original = preparingKeys.current.get(key)
    if (!original) return
    original.cancelled = true; original.cancel?.()
    if (!original.retaining && preparingKeys.current.get(key) === original) preparingKeys.current.delete(key)
    setPreparationIssue({ client, sessionId: agentSessionId, message: original.retaining
      ? '本次发送准备已取消；正文和原附件保留，设备保存尚未确认。'
      : '本次发送准备已取消；正文、所选附件与已发起的原上传仍保留。' })
    redraw(value => value + 1)
  }
  const actionKey = (key: string, kind: 'retry' | 'stop') => JSON.stringify([kind, key])
  const cancelPendingAction = (key: string, kind: 'retry' | 'stop') => {
    const id = actionKey(key, kind), original = pendingActions.current.get(id)
    if (!original || original.dispatched) return
    original.cancelled = true; original.allowUpdate()
    if (!original.saving) pendingActions.current.delete(id)
    setPreparationIssue({ client, sessionId: agentSessionId, message: `已取消未发起的${kind === 'retry' ? '重试' : '停止'}；原消息和原操作保留。` })
    redraw(value => value + 1)
  }
  const protectPendingAction = (key: string, kind: 'retry' | 'stop', run: (action: PendingInputAction) => Promise<void>) => {
    const id = actionKey(key, kind)
    if (pendingActions.current.has(id)) {
      setPreparationIssue({ client, sessionId: agentSessionId, message: '上一次原操作的保存仍未确认；原消息保留，请等待该保存结束后再试。' })
      return Promise.resolve()
    }
    return protectUpdate(`原消息的${kind === 'retry' ? '重试' : '停止'}操作仍在执行；请等待原回执后再更新网页。`, async allowUpdate => {
      const action: PendingInputAction = { cancelled: false, dispatched: false, saving: false, allowUpdate }
      pendingActions.current.set(id, action); if (mounted.current) redraw(value => value + 1)
      try { await run(action) } finally {
        if (pendingActions.current.get(id) === action) pendingActions.current.delete(id)
        if (mounted.current) redraw(value => value + 1)
      }
    })
  }
  const savePendingAction = async (action: PendingInputAction) => {
    action.saving = true
    try { return await local.save() } finally { action.saving = false }
  }
  const trackDispatchedPrompt = (originalClient: AgentMuxHostedClient, originalKey: string, original: PromptAttempt) => {
    const identity = dispatchedPromptIdentity(original), recordId = getDeviceWorkface().recordIdentity()
    return dispatched.track(originalKey, candidate => {
      if (!candidate || typeof candidate !== 'object' || !('original' in candidate)) return false
      const value = candidate as { client: AgentMuxHostedClient | null; key: string; original: PromptAttempt; recordId: string | null }
      return value.client === originalClient && value.recordId === recordId && value.key === originalKey && dispatchedPromptIdentity(value.original) === identity
    })
  }
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
    if (receipt === original.inputReceipt && original.inputRequested === true) return true
    original.inputRequested = true
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
  async function retryManualInput(key: string, original: PromptAttempt, action: PendingInputAction) {
    try {
      const source = originalManualClient(original), input = original.manualInput!
      const observed = await source.inspectAgentInput({ key: manualKey(original) })
      if (action.cancelled) return
      if (observed && !observeInputReceipt(key, original, observed)) throw Object.assign(
        new Error('Core 返回了另一条输入的观察；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      if (attempts.current.get(key) !== original) return
      if (observed && (observed.status !== 'stopped' && (observed.status !== 'waiting' ||
          observed.observation !== 'rejoin-needed' && observed.control.waiting?.wake !== 'explicit-rejoin'))) return
      if (!await savePendingAction(action) || attempts.current.get(key) !== original) return
      if (action.cancelled) return
      const previousRequested = original.inputRequested
      original.inputRequested = true
      const retained = await savePendingAction(action)
      if (action.cancelled) {
        if (attempts.current.get(key) === original && !original.inputReceipt) {
          if (previousRequested === undefined) delete original.inputRequested; else original.inputRequested = previousRequested
          await local.save()
        }
        return
      }
      if (!retained || attempts.current.get(key) !== original) return
      const pending = observed ? source.rejoinAgentInputWaiting({ ref: observed.ref })
        : source.submitAgentPrompt({ agentSessionId: input.agentSessionId, operationId: original.operationId,
          expectedRun: input.expectedRun, admissionIntent: { kind: 'manual-actor' }, prompt: expandSemanticReferences(original.draft),
          execution: 'immediate', authorHuman: true })
      action.dispatched = true; action.allowUpdate(); if (mounted.current) redraw(value => value + 1)
      const receipt = await pending
      if (receipt && !observeInputReceipt(key, original, receipt)) throw Object.assign(
        new Error('Core 返回了另一条输入的回执；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      if (!receipt) throw Object.assign(new Error('原操作尚未返回 Core 输入回执；原正文和身份保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    } catch (error) { if (!action.cancelled) await retainFailure(original, manualSeed(original), error, 'input-observation', client, key, true) }
  }
  function stopManualInput(key: string, original: PromptAttempt) {
    return protectPendingAction(key, 'stop', action => stopManualInputOriginal(key, original, action))
  }
  async function stopManualInputOriginal(key: string, original: PromptAttempt, action: PendingInputAction) {
    try {
      const source = originalManualClient(original), input = original.manualInput!
      const receipt = original.inputReceipt ?? await source.inspectAgentInput({ key: manualKey(original) })
      if (action.cancelled) return
      if (!receipt) throw Object.assign(new Error('原等待代次尚未确认，未发起停止；原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      if (!observeInputReceipt(key, original, receipt)) throw Object.assign(
        new Error('Core 返回了另一条等待的观察；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
      const ref = receipt.ref
      const previousStop = input.stopIntent
      const stop = previousStop?.ref.waitGeneration === ref.waitGeneration ? previousStop
        : { ref: structuredClone(ref), cancelOperationId: randomClientRequestId() }
      input.stopIntent = stop
      const retained = await savePendingAction(action)
      if (action.cancelled) {
        if (attempts.current.get(key) === original && input.stopIntent === stop) {
          if (previousStop === undefined) delete input.stopIntent; else input.stopIntent = previousStop
          await local.save()
        }
        return
      }
      if (!retained || attempts.current.get(key) !== original) return
      const pending = source.stopAgentInputWaiting(stop)
      action.dispatched = true; action.allowUpdate(); if (mounted.current) redraw(value => value + 1)
      const stopped = await pending
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
    } catch (error) { if (!action.cancelled) await retainFailure(original, manualSeed(original), error, 'input-stop', client, key, true) }
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
    const priorPreparation = preparingKeys.current.get(selectedKey)
    if (priorPreparation?.cancelled && priorPreparation.retaining) {
      setPreparationIssue({ client, sessionId: agentSessionId, message: '已取消的原发送仍在核对设备保存；正文保留，请等保存结束后再发送。' })
      return
    }
    if (preparingKeys.current.has(selectedKey) && !bodyOnly || existing?.phase === 'sending' || !body.trim() && !preparation || originalBody && originalBody !== existing) return
    if (bodyOnly) {
      const previous = preparingKeys.current.get(selectedKey)
      if (previous) { previous.cancelled = true; previous.cancel?.() }
      preparingKeys.current.delete(selectedKey)
    }
    if (!originalBody && selectedKey === draftKey) pauseForExplicitInput()
    const preparing = { cancelled: false, retaining: false, cancel: preparation?.cancel }
    const endPreparation = () => {
      if (preparingKeys.current.get(selectedKey) !== preparing) return
      preparingKeys.current.delete(selectedKey)
      if (mounted.current) redraw(value => value + 1)
    }
    setPreparationIssue(null)
    const preparedTarget = preparation && client && session ? {
      client, sessionId: session.agentSessionId, hostId: session.hostId, runId: session.run.runId,
      runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId ?? null
    } : null
    const assertPreparedTarget = () => {
      if (preparing.cancelled) throw new Error('本次发送准备已取消；原上传和附件仍保留。')
      if (!preparation) return
      const selected = preparedTarget?.client.agentSession(preparedTarget.sessionId)
      if (!preparedTarget || current.current.client !== preparedTarget.client || current.current.agentSessionId !== preparedTarget.sessionId ||
          selected?.hostId !== preparedTarget.hostId || selected.run.runId !== preparedTarget.runId ||
          preparedTarget.client.runtimeOwnerIdentity?.()?.runtimeId !== preparedTarget.runtimeId) {
        throw new Error('原附件消息的客户端、Mac、Session 或 Run 已改变；正文和附件保留，本次没有请求输入。')
      }
    }
    preparingKeys.current.set(selectedKey, preparing); redraw(value => value + 1)
    if (preparation) {
      try { body = await preparation.prepare(initialBody); assertPreparedTarget() }
      catch (error) {
        if (mounted.current && !preparing.cancelled) setPreparationIssue({ client, sessionId: agentSessionId, message: errorMessage(error) })
        endPreparation()
        return
      }
      if (!body.trim()) { endPreparation(); return }
    }
    preparing.retaining = true
    try { await protectUpdate(() => preparing.cancelled
      ? '发送准备已取消；设备保存仍未确认，请保留当前页面，恢复设备存储后再更新。'
      : '原消息操作仍在执行；请等待原回执后再更新网页。', async allowUpdate => {
      const refused = existing?.manualInput ? existing.inputReceipt?.status === 'not-applied'
        : originalPromptRefused(session, agentSessionId, existing, client?.runtimeOwnerIdentity?.()?.runtimeId)
      if (originalBody && !refused) return
      // An identical unresolved input keeps its original identity, even after another
      // draft became active. A distinct explicit body is a new intent for Core to qualify.
      const unresolved = !originalBody && promptAttemptsForSession(attempts.current, agentSessionId).find(([, value]) =>
        value.phase === 'unknown' && expandSemanticReferences(value.draft) === expandSemanticReferences(body))
      if (unresolved) {
        if (bodyOnly) { setPreparationIssue({ client, sessionId: agentSessionId, message: '同一正文已有未确认输入；原记录保留，请从原消息核对回执。本次仅正文不会重放它。' }); return }
        endPreparation()
        const retry = retryOriginalPrompt(unresolved[0]); allowUpdate()
        await retry; return
      }
      if (!refused && existing?.phase === 'rejected' && existing.draft === body) {
        endPreparation(); const retry = retryOriginalPrompt(selectedKey); allowUpdate()
        await retry; return
      }
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
      let removeDispatch: (() => void) | undefined
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
        assertPreparedTarget()
        if (preparation) { await preparation.commit(); assertPreparedTarget() }
        stage = 'core-submit'
        original.inputRequested = true; if (!await local.save()) throw new Error('设备工作面已被替换；本次未请求输入。')
        if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入，请核对原记录。')
        assertPreparedTarget()
        rpcRequested = true
        const pendingReceipt = originalClient.submitAgentPrompt({ agentSessionId: originalId, operationId: original.operationId,
          prompt: expandSemanticReferences(original.draft), authorHuman: true,
          ...(original.manualInput ? { expectedRun: original.manualInput.expectedRun, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
            : { ...original.request!.condition, execution: original.request!.execution }) })
        removeDispatch = trackDispatchedPrompt(originalClient, originalKey, original)
        endPreparation()
        allowUpdate()
        const receipt = await pendingReceipt
        if (original.manualInput) {
          if (receipt && !observeInputReceipt(originalKey, original, receipt)) throw Object.assign(
            new Error('Core 返回了另一条输入的回执；原记录保留。'), { code: 'CONTROL_PROTOCOL_ERROR' })
          if (!receipt) throw Object.assign(new Error('原消息的 Core 保存或输入回执尚未确认；原正文和身份保留，可核对原请求。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
        } else confirmPrompt(originalKey, original)
        if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void refresh()
      } catch (error) {
        if (!rpcRequested) original.inputRequested = false
        if (preparing.cancelled && !rpcRequested) {
          original.phase = 'rejected'; original.message = '本次发送准备已取消；正文和原附件保留，本次没有请求输入。'
          await local.save(); if (mounted.current) redraw(value => value + 1)
          return
        }
        await retainFailure(original, seed, error, stage, originalClient, originalKey, false)
      } finally { removeDispatch?.() }
    }) } finally { endPreparation() }
  }

  function retryOriginalPrompt(selectedKey = draftKey): Promise<void> {
    return protectPendingAction(selectedKey, 'retry', action => retryOriginalPromptOriginal(selectedKey, action))
  }
  async function retryOriginalPromptOriginal(selectedKey: string, action: PendingInputAction): Promise<void> {
    const original = attempts.current.get(selectedKey)
    if (!original || original.phase === 'sending' || original.phase === 'confirmed') return
    if (original.manualInput) { await retryManualInput(selectedKey, original, action); return }
    if (originalPromptRefused(session, agentSessionId, original, client?.runtimeOwnerIdentity?.()?.runtimeId)) {
      pendingActions.current.delete(actionKey(selectedKey, 'retry'))
      if (mounted.current) redraw(value => value + 1)
      const send = submit(original.request!.explicit, original, selectedKey); action.allowUpdate()
      await send
      return
    }
    const originalClient = client, originalId = agentSessionId, originalKey = selectedKey
    let seed = startDeliveryAttempt({ agentSessionId: originalId, operationId: original.operationId,
      hostId: session?.hostId ?? null, condition: original.request?.condition,
      ...(original.request ? { execution: original.request.execution } : {}), prompt: expandSemanticReferences(original.draft) })
    const previousPhase = original.phase
    const previousRequested = original.inputRequested
    const previousRunId = original.runId, previousHostId = original.originalHostId, previousRequest = original.request
    let stage = 'retry-validation'
    let removeDispatch: (() => void) | undefined
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
          if (!await savePendingAction(action) || attempts.current.get(originalKey) !== original) return
          if (action.cancelled) return
          await retryManualInput(originalKey, original, action)
          return
        }
        const condition = agentPromptCondition(originalSession)
        original.runId = condition.expectedRun.runId
        original.request = { condition: structuredClone(condition), execution: 'default', explicit: false,
          runtimeId: originalClient.runtimeOwnerIdentity?.()?.runtimeId ?? null }
        if (!await savePendingAction(action)) throw new Error('设备工作面已被替换；本次未请求输入。')
        if (action.cancelled) return
        if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入。')
      }
      const input = originalPromptRequest(originalSession, originalId, original)
      if (!input) throw Object.assign(new Error('原 Session、Run 或投递条件无法完整核实；本次未请求输入，原消息保留。'), { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
      seed = Object.freeze({ ...seed, expectedRunId: input.expectedRun.runId,
        afterSubmissionId: input.afterSubmissionId, conditionAvailable: true, execution: input.execution })
      original.phase = 'sending'; original.message = '正在核对并续做原请求…'
      if (!await savePendingAction(action)) throw new Error('设备工作面已被替换；本次未请求输入，原正文保留。')
      if (action.cancelled) return
      redraw(value => value + 1)
      if (attempts.current.get(originalKey) !== original) throw new Error('另一页面已保全原消息；本次未请求输入，请核对原请求和两份正文。')
      stage = 'core-submit'
      original.inputRequested = true; if (!await savePendingAction(action)) throw new Error('设备工作面已被替换；本次未请求输入。')
      if (action.cancelled) return
      if (attempts.current.get(originalKey) !== original) throw new Error('原消息记录已改变；本次未请求输入，请核对原记录。')
      const pending = originalClient.submitAgentPrompt(input)
      removeDispatch = trackDispatchedPrompt(originalClient, originalKey, original)
      action.dispatched = true; action.allowUpdate(); if (mounted.current) redraw(value => value + 1)
      await pending
      confirmPrompt(originalKey, original)
      if (mounted.current && current.current.client === originalClient && current.current.agentSessionId === originalId) void refresh()
    } catch (error) {
      original.phase = previousPhase
      if (!action.cancelled) await retainFailure(original, seed, error, stage, originalClient, originalKey, true)
    } finally {
      removeDispatch?.()
      if (action.cancelled && !action.dispatched && attempts.current.get(originalKey) === original) {
        if (!original.inputReceipt) {
          original.phase = previousPhase
          if (previousRequested === undefined) delete original.inputRequested; else original.inputRequested = previousRequested
          original.runId = previousRunId
          if (previousHostId === undefined) delete original.originalHostId; else original.originalHostId = previousHostId
          if (previousRequest === undefined) delete original.request; else original.request = previousRequest
          delete original.manualInput
          original.message = '本次未发起重试；原消息和原操作保留。'
        }
        await local.save(); if (mounted.current) redraw(value => value + 1)
      }
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
    preparing: Boolean(preparingKeys.current.get(draftKey) && !preparingKeys.current.get(draftKey)!.cancelled),
    hasAnyPreparation: () => [...preparingKeys.current.values()].some(item => !item.cancelled),
    isDispatchedPrompt: (key: string, original: PromptAttempt) => dispatched.includes(key, { client, key, original, recordId: getDeviceWorkface().recordIdentity() }),
    hasPendingAction: (key: string, kind: 'retry' | 'stop') => { const value = pendingActions.current.get(actionKey(key, kind)); return Boolean(value && !value.cancelled && !value.dispatched) },
    cancelPendingAction, cancelPreparation, preparationIssue: preparationIssue && preparationIssue.client === client && preparationIssue.sessionId === agentSessionId ? preparationIssue.message : null,
    historyLocalEntries, retainedAttempts, sessionAttempts: allAttempts,
    promptWasRefused: (original: PromptAttempt) => originalPromptRefused(session, agentSessionId, original, client?.runtimeOwnerIdentity?.()?.runtimeId) }
}
