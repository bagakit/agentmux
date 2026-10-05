import type { AgentMuxRpcGoal, AgentMuxRpcResult, ContinuousProgressLoop } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { type DeviceWorkfaceStore, type GoalWorkSelection, type MobileGoalOperation } from '../recovery/device-workface'

export type MobileGoalDetail = AgentMuxRpcResult<'goal.inspect'>
const unavailable = (message: string) => new Error(`${message} 原目标、会话与未确认操作保留；请核对原 Host。`)

/** Durable semantic identity, rather than this connection/process or the execution Host ID. */
export function goalWorkTarget(client: AgentMuxHostedClient, owner: DeviceWorkfaceStore, sessionId: string, goalId: string): GoalWorkSelection {
  const runtime = client.runtimeOwnerIdentity()
  if (!runtime || runtime.availability !== 'connected') throw unavailable('原 Host 运行身份尚未确认。')
  const session = client.agentSession(sessionId)
  if (session.agentSessionId !== sessionId) throw unavailable('原执行会话尚未确认。')
  return { runtimeId: runtime.runtimeId, deviceHostId: owner.snapshot().record.host?.hostId ?? null, sessionId, goalId }
}
/** An absent old Relay ID does not invent one, or deny a confirmed original semantic Runtime. */
export function admitsGoalWorkTarget(expected: GoalWorkSelection, observed: GoalWorkSelection): boolean {
  return expected.runtimeId === observed.runtimeId && expected.sessionId === observed.sessionId && expected.goalId === observed.goalId
    && (expected.deviceHostId === null || expected.deviceHostId === observed.deviceHostId)
}
export function assertGoalAssociation(goal: AgentMuxRpcGoal | null, goalId: string, sessionId: string): asserts goal is AgentMuxRpcGoal {
  if (!goal || goal.id !== goalId || !Array.isArray(goal.sessionIds) || !goal.sessionIds.includes(sessionId)) throw unavailable('目标与所选 Agent 的关联尚未确认。')
}
export function goalSessionLoops(client: AgentMuxHostedClient, detail: MobileGoalDetail, sessionId: string): ContinuousProgressLoop[] {
  assertGoalAssociation(detail.goal, detail.goal?.id ?? '', sessionId)
  const session = client.agentSession(sessionId)
  if (!Array.isArray(detail.goalContinuations)) throw unavailable('原续跑目录尚未确认。')
  const loops = detail.goalContinuations.filter(loop => loop.agentSessionId === sessionId)
  const ids = new Set<string>()
  for (const loop of loops) {
    if (!loop.loopId || ids.has(loop.loopId) || loop.taskSource?.kind !== 'goal' || loop.taskSource.goalId !== detail.goal.id
      || loop.hostId !== session.hostId || loop.providerId !== session.providerId || loop.workspacePath !== session.workspacePath) {
      throw unavailable('续跑目标与原执行会话不一致。')
    }
    ids.add(loop.loopId)
  }
  return loops
}
export async function inspectGoal(client: AgentMuxHostedClient, goalId: string, sessionId: string): Promise<MobileGoalDetail> {
  if (!client.forwardRpc) throw unavailable('Host 尚未提供目标端口。')
  const result = await client.forwardRpc('goal.inspect', { goalId })
  assertGoalAssociation(result.goal, goalId, sessionId)
  goalSessionLoops(client, result, sessionId)
  return result
}

/** A fresh read and original business OP precede each explicit write. Reconnection never calls this. */
export async function sendGoalOperation(client: AgentMuxHostedClient, owner: DeviceWorkfaceStore,
  operation: MobileGoalOperation, stillCurrent: () => boolean): Promise<MobileGoalDetail> {
  const recordId = owner.recordIdentity()
  if (!client.forwardRpc || !stillCurrent()) throw unavailable('当前选择已经改变或连接不可用。')
  if (!admitsGoalWorkTarget(operation, goalWorkTarget(client, owner, operation.sessionId, operation.goalId))) throw unavailable('待确认操作属于另一个原 Host。')
  const detail = await inspectGoal(client, operation.goalId, operation.sessionId)
  if (owner.recordIdentity() !== recordId || !stillCurrent() || !admitsGoalWorkTarget(operation, goalWorkTarget(client, owner, operation.sessionId, operation.goalId))) throw unavailable('读取期间目标或 Host 已改变。')
  const loops = goalSessionLoops(client, detail, operation.sessionId)
  if (operation.kind === 'start') {
    const sameOperation = loops.filter(loop => loop.creationOperationId === operation.operationId)
    if (sameOperation.length > 1) throw unavailable('原开始操作出现了多个续跑记录。')
    const prior = sameOperation[0]
    if (prior && (prior.status === 'stopped' || prior.intervalMs !== operation.intervalMs
      || prior.taskSource?.kind !== 'goal' || prior.taskSource.alignmentRevision !== operation.alignmentRevision)) throw unavailable('原开始操作已经停止或内容不同。')
    if (!prior && loops.some(loop => loop.status !== 'stopped')) throw unavailable('此 Agent 已有目标续跑；请先核对原操作。')
    if (detail.goal?.alignment?.confirmedAt == null || detail.goal.alignment.revision !== operation.alignmentRevision
      || detail.goal.status === 'done' || detail.goal.status === 'cancelled') throw unavailable('目标范围版本尚未确认或已经结束。')
    const result = await client.forwardRpc('goal.start', { goalId: operation.goalId, sessionId: operation.sessionId,
      continuation: { intervalMs: operation.intervalMs, alignmentRevision: operation.alignmentRevision }, operationId: operation.operationId })
    if (!admitsGoalWorkTarget(operation, goalWorkTarget(client, owner, operation.sessionId, operation.goalId))) throw unavailable('回执到达时原 Host 身份已经改变。')
    assertGoalAssociation(result.goal, operation.goalId, operation.sessionId)
    const loop = result.continuation
    if (result.receipt.goalId !== operation.goalId || result.receipt.sessionId !== operation.sessionId || !loop
      || loop.creationOperationId !== operation.operationId || loop.intervalMs !== operation.intervalMs
      || loop.initialDelivery?.operationId !== operation.operationId || loop.taskSource?.kind !== 'goal'
      || loop.taskSource.alignmentRevision !== operation.alignmentRevision) throw unavailable('开始操作的回执尚未确认。')
    const returned = { goal: result.goal, goalContinuations: [loop] }
    if (goalSessionLoops(client, returned, operation.sessionId).length !== 1) throw unavailable('开始回执属于其他执行会话。')
    if (loop.initialDelivery.state === 'confirmed') await owner.confirmGoalOperation(operation, recordId)
  } else {
    const loop = loops.find(item => item.loopId === operation.loopId)
    if (!loop) throw unavailable('原续跑引用尚未确认。')
    const acknowledged = loop.lastMutation?.operationId === operation.operationId && loop.lastMutation.action === operation.action
      && loop.lastMutation.expectedRevision === operation.expectedRevision
    if (loop.revision !== operation.expectedRevision && !acknowledged) throw unavailable('续跑版本已变化；保留原操作供核对。')
    if (operation.action === 'resume' && (loop.initialDelivery?.state !== 'confirmed' || detail.goal?.alignment?.confirmedAt == null
      || loop.taskSource?.kind !== 'goal' || detail.goal.alignment.revision !== loop.taskSource.alignmentRevision)) throw unavailable('原输入或目标范围尚未确认，不能恢复自动续跑。')
    const result = await client.forwardRpc('goal.continuation-action', { goalId: operation.goalId, loopId: operation.loopId,
      action: operation.action, expectedRevision: operation.expectedRevision, operationId: operation.operationId })
    if (!admitsGoalWorkTarget(operation, goalWorkTarget(client, owner, operation.sessionId, operation.goalId))) throw unavailable('回执到达时原 Host 身份已经改变。')
    const receipt = result.continuation
    if (result.goalId !== operation.goalId || result.diskDurability !== 'confirmed' || receipt.loopId !== operation.loopId
      || receipt.lastMutation?.operationId !== operation.operationId || receipt.lastMutation.action !== operation.action
      || receipt.lastMutation.expectedRevision !== operation.expectedRevision) throw unavailable('原续跑操作的回执尚未确认。')
    if (goalSessionLoops(client, { goal: detail.goal, goalContinuations: [receipt] }, operation.sessionId).length !== 1) throw unavailable('续跑回执属于其他执行会话。')
    await owner.confirmGoalOperation(operation, recordId)
  }
  return stillCurrent() ? inspectGoal(client, operation.goalId, operation.sessionId) : detail
}
