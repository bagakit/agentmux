import { useSyncExternalStore } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { getDeviceWorkface, sameGoalIntentScope, type GoalIntentScope, type GoalIntent, type DeviceWorkfaceStore } from '../recovery/device-workface'

export function goalIntentScope(client: AgentMuxHostedClient | null, owner: DeviceWorkfaceStore): GoalIntentScope {
  const runtime = client?.runtimeOwnerIdentity()
  if (!runtime) throw new Error('原 Host 的运行身份尚未确认；原 Goal 与讨论仍可阅读。')
  return { runtimeId: runtime.runtimeId, deviceHostId: owner.snapshot().record.host?.hostId ?? null }
}
export function assertGoalIntentScope(client: AgentMuxHostedClient | null, owner: DeviceWorkfaceStore, intent: GoalIntent): void {
  if (!sameGoalIntentScope(goalIntentScope(client, owner), intent)) throw new Error('原意图属于另一个 Host；保留原记录，不在当前 Host 重发。')
}
export function useGoalIntents(client: AgentMuxHostedClient | null) {
  const owner = getDeviceWorkface()
  useSyncExternalStore(owner.subscribeGoalIntents, owner.goalIntentRevision)
  const snapshot = owner.snapshot()
  let scope: GoalIntentScope | null = null, issue = snapshot.issue
  try { scope = goalIntentScope(client, owner) } catch (error) { issue ??= error instanceof Error ? error.message : String(error) }
  return { owner, scope, issue, intents: (snapshot.record.goalIntents ?? []).filter(intent => scope && sameGoalIntentScope(scope, intent)) }
}
