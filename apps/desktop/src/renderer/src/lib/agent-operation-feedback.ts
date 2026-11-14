import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { api } from './api'
import { mintObjectId } from '@agentmux/core/object-id'
import type { TakeoverSource } from './session-takeover'
import type { AgentMuxAgentStopReceipt } from '@agentmux/core'

import { agentOperationKey, type AgentOperationFeedback } from './agent-operation'
export { agentOperationKey, restoredAgentOperations } from './agent-operation'
export type { AgentOperationFeedback, AgentOperationKind, AgentOperationPhase, AgentOperationReferences, AgentOperationSubject } from './agent-operation'

/** Retained client intent and last observation, never a second lifecycle authority. */
export function beginAgentOperation(operation: AgentOperationFeedback): AgentOperationFeedback {
  const key = agentOperationKey(operation), held = useAppStore.getState().agentOperations[key]
  if (held) return held
  useAppStore.setState(state => ({ agentOperations: { ...state.agentOperations, [key]: operation } }))
  return operation
}

/** A Club preparation becomes its one frozen Core request in this same original client reference. */
export function retainTakeoverRequest(operation: Extract<AgentOperationFeedback, { kind: 'takeover' }>, source: TakeoverSource) {
  const key = agentOperationKey(operation)
  let retained = operation
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    if (!held || held.kind !== 'takeover') throw new Error('The original Takeover reference is unavailable. Its request was not replaced.')
    if (held.takeoverSource.coreRequest && JSON.stringify(held.takeoverSource.coreRequest) !== JSON.stringify(source.coreRequest))
      throw new Error('The original Takeover request is already frozen. Keep its exact source, destination and Agent.')
    retained = { ...held, takeoverSource: source }
    return { agentOperations: { ...state.agentOperations, [key]: retained } }
  })
  return retained
}

export function updateAgentOperation(operation: AgentOperationFeedback, patch: Partial<Pick<AgentOperationFeedback, 'phase' | 'message' | 'canContinue' | 'report'>>) {
  const key = agentOperationKey(operation)
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    const regresses = held && patch.phase && patch.phase !== held.phase &&
      (held.phase === 'cancelled' || held.phase === 'retired' || held.phase === 'succeeded' && !(held.kind !== 'stop' && patch.phase === 'retired'))
    return held && !regresses
      ? { agentOperations: { ...state.agentOperations, [key]: { ...held, ...patch,
        ...(held.kind === 'takeover' && held.cancellation && held.message ? { message: held.message } : {}) } } } : state
  })
}

export function dismissAgentOperation(operation: AgentOperationFeedback) {
  const key = agentOperationKey(operation)
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    if (held?.phase !== 'succeeded' || held.kind === 'takeover' && held.cancellation) return state
    const { [key]: _finished, ...agentOperations } = state.agentOperations
    return { agentOperations }
  })
}

export function settleAgentCreation(operation: AgentOperationFeedback, report: AgentMuxSpaceMutationReport) {
  if (report.requestId !== operation.operationId) {
    updateAgentOperation(operation, { phase: 'unconfirmed', message: '返回结果不属于原创建请求，请核对原操作。' })
    return
  }
  updateAgentOperation(operation, { report, phase: report.outcome === 'opened' ? 'succeeded'
    : report.outcome === 'partial' ? 'partial' : report.outcome === 'retired' ? 'retired' : 'unconfirmed',
    message: report.issues.map(issue => issue.message).join('\n') ||
      (report.outcome === 'retired' ? '这次创建的 Agent 后已关闭，原工作仍保留。' : undefined) })
}

/** Core can join a pre-existing Stop; keep its canonical identity and each original caller. */
export function acceptAgentStopReceipt(operation: Extract<AgentOperationFeedback, { kind: 'stop' }>, receipt: AgentMuxAgentStopReceipt | import('@agentmux/core').TerminalControlReceipt | undefined): receipt is AgentMuxAgentStopReceipt {
  const control = operation.control
  if (!receipt || !('agentSessionId' in receipt) || receipt.agentSessionId !== control.agentSessionId || receipt.expectedRun.runId !== control.run.runId ||
    receipt.operationId !== operation.operationId && receipt.admission !== 'retained' && receipt.admission !== 'joined') {
    updateAgentOperation(operation, { phase: 'unconfirmed', message: '停止回执尚未确认；原 Session、历史与草稿保留。' })
    return false
  }
  const key = agentOperationKey(operation)
  useAppStore.setState(state => {
    const held = state.agentOperations[key]
    if (!held) return state
    const canonical = { ...held, operationId: receipt.operationId, phase: 'succeeded' as const, message: undefined }
    const canonicalKey = agentOperationKey(canonical), previous = state.agentOperations[canonicalKey]
    const callerOperationIds = [...new Set([...(previous?.callerOperationIds ?? []), ...(held.callerOperationIds ?? []), operation.operationId])]
      .filter(id => id !== receipt.operationId)
    const { [key]: _caller, ...references } = state.agentOperations
    return { agentOperations: { ...references, [canonicalKey]: { ...canonical, callerOperationIds } } }
  })
  return true
}

/** Check reads the exact original owner; it never sends Stop or creates an Agent. */
export async function inspectAgentOperation(operation: AgentOperationFeedback) {
  const key = agentOperationKey(operation), started = useAppStore.getState().agentOperations[key]
  if (!started) return
  const stillCurrent = () => useAppStore.getState().agentOperations[key] === started
  try {
    if (operation.kind === 'stop') {
      const inspected = await api.sessions.inspectStop(operation.control, operation.operationId)
      if (!stillCurrent()) return
      if (inspected.operationIdMatched !== true || inspected.agentSessionId !== operation.control.agentSessionId || inspected.expectedRun.runId !== operation.control.run.runId) {
        updateAgentOperation(operation, { phase: 'unconfirmed', canContinue: false, message: '原操作结果尚未确认，保留原 Session 与工作面。' })
        return
      }
      updateAgentOperation(operation, { phase: inspected.phase === 'retired' ? 'succeeded'
        : inspected.phase === 'stopping' && !inspected.failure ? 'pending' : 'unconfirmed',
        canContinue: inspected.canRetry, message: inspected.failure?.message })
      return
    }
    if (operation.kind === 'takeover') {
      if (started.kind === 'takeover' && started.cancellation) {
        const { inspectTakeoverCancellation } = await import('./session-takeover-cancellation')
        await inspectTakeoverCancellation(started)
        return
      }
      if (operation.takeoverSource.clubPreparation && !operation.takeoverSource.coreRequest) {
        const { inspectTakeoverClub } = await import('./session-takeover')
        const topic = await inspectTakeoverClub(operation.takeoverSource)
        if (stillCurrent()) updateAgentOperation(operation, { phase: topic ? 'partial' : 'unconfirmed',
          message: topic ? 'Club 已建立，尚未选择接手 Agent。回到 Promotion 继续同次准备。' : '原 Club 准备尚未确认；保留这次身份，继续原准备。' })
        return
      }
      const { inspectTakeoverOperation } = await import('./session-takeover')
      const report = await inspectTakeoverOperation(operation.takeoverSource, operation.operationId)
      if (stillCurrent()) settleAgentCreation(operation, report)
      return
    }
    const result = await useAppStore.getState().executeControl({ schemaVersion: 5,
      requestId: `operation-inspect:${mintObjectId()}`, operation: 'space.inspect', target: { requestId: operation.operationId } })
    if (!stillCurrent()) return
    if (result.operation === 'space.inspect' && result.request?.report) settleAgentCreation(operation, result.request.report)
    else updateAgentOperation(operation, { phase: 'unconfirmed', message: '原创建结果尚未确认；检查不会重新创建 Agent。' })
  } catch (error) {
    if (stillCurrent()) updateAgentOperation(operation, {
      ...(started.phase === 'succeeded' || started.phase === 'retired' ? {} : { phase: 'unconfirmed' as const }), message: presentError(error)
    })
  }
}
