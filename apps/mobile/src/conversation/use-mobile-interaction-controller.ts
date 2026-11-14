import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxInteractionOperationIntent, AgentMuxInteractionOperationReceipt, AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason, agentInteractionOperationReceiptMatches, agentInteractionRequestsMatch } from '@agentmux/core/agent-interaction-state'
import { deliveryOutcome, errorMessage } from './delivery'
import type { createLocalDrafts, ResponseAttempt } from './local-drafts'

type MobileInteractionControllerOptions = {
  local: ReturnType<typeof createLocalDrafts>
  client: AgentMuxHostedClient | null
  agentSessionId: string | null
  session: AgentMuxAgentSession | null
  available: boolean
}

/** Synchronous request operations keep their original Core identity independently of prompt and async-question input. */
export function useMobileInteractionController({ local, client, agentSessionId, session, available }: MobileInteractionControllerOptions) {
  const responses = useMemo(() => ({ current: local.responses }), [local])
  const [, redraw] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pending = session?.pendingInteraction
  const request: AgentMuxInteractionRequest | undefined = agentInteractionActiveRequest(pending)
  const responseUnavailableReason = pending && agentInteractionResponseUnavailableReason(pending)
  const requestRun = request?.evidence?.run ?? session?.run
  const runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId
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
  async function respond(response: AgentMuxInteractionResponse, intent: AgentMuxInteractionOperationIntent): Promise<void | AgentMuxInteractionOperationReceipt> {
    if (!client || !session || !request || !requestRun || !requestKey || responseDisabled) return
    const previous = responseAttempt
    if (previous?.phase === 'sending' || previous?.phase === 'unknown' || previous?.phase === 'confirmed') return
    // A remounted Card has no operation ref. An unchanged refused answer still
    // belongs to the device's original operation, including an unknown source.
    const priorInput = previous?.original?.input
    const input = priorInput && JSON.stringify(priorInput.response) === JSON.stringify(response)
      ? structuredClone(priorInput)
      : structuredClone({ agentSessionId: session.agentSessionId, expectedRun: requestRun, response, ...intent })
    const originalKey = JSON.stringify([session.agentSessionId, requestRun.runId, request.id, input.operationId])
    const original: ResponseAttempt = { phase: 'sending', message: '正在发送答复…', original: {
      input,
      hostId: session.hostId, runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId ?? null } }
    responses.current.set(originalKey, original)
    const retained = await local.save()
    if (mounted.current) redraw(value => value + 1)
    try {
      if (!retained || responses.current.get(originalKey) !== original) throw new Error('另一页面已保全这个请求的答复；本次未重复回答。')
      const target = client.agentSession(original.original!.input.agentSessionId)
      if (target.hostId !== original.original!.hostId || client.runtimeOwnerIdentity?.()?.runtimeId !== original.original!.runtimeId) throw new Error('Mac 连接已变化，这次没有发送。答复已留在这台手机上。')
      const receipt = await client.respondAgentInteraction(original.original!.input)
      if (responses.current.get(originalKey) !== original) return
      adoptResponseReceipt(original, receipt)
      return receipt
    } catch (error) {
      if (responses.current.get(originalKey) !== original) throw error
      original.phase = deliveryOutcome(error, 'interaction')
      original.message = original.phase === 'unknown'
        ? `还没确认答复是否送达，不会重复发送。可以打开对话查看。${errorMessage(error)}`
        : `Core 已拒绝答复。${errorMessage(error)}`
      throw error
    } finally {
      // The page owns this attempt beyond the ticket's lifetime. Only painting depends on its view.
      void local.save().then(() => { if (mounted.current) redraw(value => value + 1) })
      if (mounted.current) redraw(value => value + 1)
    }
  }
  function adoptResponseReceipt(attempt: ResponseAttempt, receipt: AgentMuxInteractionOperationReceipt) {
    const input = attempt.original!.input
    if (!agentInteractionOperationReceiptMatches(input, receipt)) throw new Error('确认结果不属于这条答复，没有采用。')
    attempt.phase = receipt.delivery === 'unknown' || receipt.delivery === 'saved' ? 'unknown' : 'confirmed'
    attempt.message = receipt.nativeCompleted ? '这个请求已完成。'
      : receipt.delivery === 'saved' ? '答复已保存；是否送达尚未确认。'
      : receipt.delivery === 'unknown' ? '还没确认答复是否送达，可以查询结果。' : '答复已送达，Agent 是否采用待查看。'
  }
  async function inspectResponse(key: string, attempt: ResponseAttempt): Promise<AgentMuxInteractionOperationReceipt | null> {
    if (!client || !attempt.original) return null
    const original = attempt.original
    try {
      if (client.agentSession(original.input.agentSessionId).hostId !== original.hostId ||
          !original.runtimeId || client.runtimeOwnerIdentity?.()?.runtimeId !== original.runtimeId) throw new Error('当前连接的不是这条答复所在的 Mac。')
      const receipt = await client.inspectAgentInteractionOperation({ agentSessionId: original.input.agentSessionId, operationId: original.input.operationId })
      if (responses.current.get(key) !== attempt) return receipt
      if (receipt) adoptResponseReceipt(attempt, receipt)
      else attempt.message = '还没查到确认结果，答复是否送达仍未知。'
      await local.save()
      return receipt
    } catch (error) {
      if (responses.current.get(key) === attempt) attempt.message = `没有查到答复结果。${errorMessage(error)}`
      throw error
    } finally { if (mounted.current) redraw(value => value + 1) }
  }
  const retainedResponses = [...responses.current.forSession(agentSessionId ?? '')].filter(([key, attempt]) =>
    responseOwnerMatches(attempt) && key !== responseEntry?.[0])
  const unidentifiedResponses = [...responses.current.forSession(agentSessionId ?? '')].filter(([, attempt]) => !attempt.original)
  return { request, requestKey, responseUnavailableReason, responseEntry, responseAttempt, responseDisabled,
    respond, inspectResponse, retainedResponses, unidentifiedResponses }
}
