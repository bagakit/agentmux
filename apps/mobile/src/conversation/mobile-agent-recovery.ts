import { mobileCapability, type MobileConversationClient } from './mobile-conversation-client'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentResumeIntent } from '../recovery/agent-resume-intents'

// In-flight coordination only. Durable Session, operation and phase facts stay with DeviceWorkface/Core.
const flights = new WeakMap<MobileConversationClient, Set<string>>()
const subscribers = new WeakMap<MobileConversationClient, Map<string, Set<() => void>>>()
export function subscribeMobileAgentRecovery(client: MobileConversationClient | null, agentSessionId: string, notify: () => void): () => void {
  if (!client) return () => {}
  let bySession = subscribers.get(client)
  if (!bySession) { bySession = new Map(); subscribers.set(client, bySession) }
  let listeners = bySession.get(agentSessionId)
  if (!listeners) { listeners = new Set(); bySession.set(agentSessionId, listeners) }
  listeners.add(notify)
  return () => { listeners.delete(notify); if (!listeners.size) bySession.delete(agentSessionId); if (!bySession.size) subscribers.delete(client) }
}
function notifyFlight(client: MobileConversationClient, agentSessionId: string) {
  for (const notify of subscribers.get(client)?.get(agentSessionId) ?? []) notify()
}
export function mobileAgentRecoveryBusy(client: MobileConversationClient | null, agentSessionId: string): boolean {
  return Boolean(client && flights.get(client)?.has(agentSessionId))
}
export function pendingMobileAgentRecovery(client: MobileConversationClient | null, agentSessionId: string): MobileAgentResumeIntent | undefined {
  const record = getDeviceWorkface().snapshot().record
  return record.agentResumes?.find(item => item.input.agentSessionId === agentSessionId && item.phase !== 'confirmed' && item.phase !== 'superseded' &&
    item.runtimeId === client?.runtimeOwnerIdentity?.()?.runtimeId && item.deviceHostId === (record.host?.hostId ?? null))
}
export type MobileAgentRecoveryRequest = {
  client: MobileConversationClient; agentSessionId: string; expectedHostId?: string
  /** Opening an existing main Agent inspects any pending operation; only Continue may redispatch that same request. */
  mode?: 'open' | 'new' | 'inspect' | 'continue'
  isCurrent(): boolean; onNotice(message: string, technical?: string): void
  /** A confirmed reattach or resume is a normal state. Callers that open a conversation stay quiet;
   *  explicit recovery actions keep the confirmation visible. Failures and unknowns always notify. */
  quietWhenConfirmed?: boolean
}
/** Called only by an explicit person action. Reading, mounting and reconnecting never enter here. */
export async function recoverMobileAgent({ client, agentSessionId, expectedHostId, mode = 'open', isCurrent, onNotice, quietWhenConfirmed = false }: MobileAgentRecoveryRequest): Promise<void> {
  if (!isCurrent()) return
  if (!client.forwardRpc) { onNotice('还不能读取 Mac 上的对话，重新连接后可以再核对。'); return }
  let flight = flights.get(client)
  if (!flight) { flight = new Set(); flights.set(client, flight) }
  if (flight.has(agentSessionId)) return
  flight.add(agentSessionId); notifyFlight(client, agentSessionId)
  const owner = getDeviceWorkface(), recordId = owner.recordIdentity()
  const scope = { runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId, deviceHostId: owner.snapshot().record.host?.hostId ?? null }
  const unchanged = () => isCurrent() && owner.recordIdentity() === recordId && client.runtimeOwnerIdentity?.()?.runtimeId === scope.runtimeId &&
    (owner.snapshot().record.host?.hostId ?? null) === scope.deviceHostId
  const notice = (message: string, technical?: string) => { if (unchanged()) technical ? onNotice(message, technical) : onNotice(message) }
  const confirmedNotice = (message: string) => { if (!quietWhenConfirmed) notice(message) }
  const pending = pendingMobileAgentRecovery(client, agentSessionId)
  const action = mode === 'open' ? pending ? 'inspect' : 'new' : mode
  let intent: MobileAgentResumeIntent | undefined = pending
  try {
    if (!scope.runtimeId) throw new Error('还没确认 Mac 的身份。')
    const result = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId } })
    if (!unchanged()) return
    if (result.session.agentSessionId !== agentSessionId) throw new Error('返回了另一个 Agent，没有恢复。')
    if (expectedHostId !== undefined && (result.routeHostId !== expectedHostId ||
      result.session.hostId !== 'local' && result.session.hostId !== expectedHostId)) throw new Error('这个 Agent 在另一台 Mac 上，没有恢复。')
    if (action === 'inspect') {
      if (!intent || intent.hostId !== result.session.hostId) throw new Error('还没确认恢复的目标。')
      const operation = result.session.continuityOperations?.[intent.input.operationId]
      if (!operation) { notice('Mac 还没确认这次恢复，可以稍后再核对。'); return }
      if (operation.operationId !== intent.input.operationId || operation.launchInput || operation.agentSessionId !== agentSessionId || operation.previousRun.runId !== intent.input.expectedRun.runId || operation.action === 'restart') throw new Error('恢复结果属于另一个目标，没有采用。')
      if (operation.kind === 'conflict' && result.session.run.runId !== intent.input.expectedRun.runId) {
        await owner.retainAgentResume({ ...intent, phase: 'superseded' }, recordId)
        if (unchanged()) { notice('这个 Agent 已被其他操作重新启动，不会自动重试。可以再恢复一次。') }
      } else if (operation.kind === 'resumed' || operation.kind === 'reattachable') {
        await owner.retainAgentResume({ ...intent, phase: 'confirmed' }, recordId)
        if (!unchanged()) return
        confirmedNotice(operation.kind === 'resumed' ? '恢复已开始，Agent 可以继续工作时会显示。' : '可以重新连回这个 Agent。')
      } else notice('恢复还没完成，可以核对结果或继续这次恢复。', `${operation.kind}\n${operation.error ?? operation.reason}`)
      return
    }
    if (intent && action === 'new') throw new Error('上一次恢复还没确认结果，不会再发起一次。')
    if (intent && intent.hostId !== result.session.hostId) throw new Error('恢复记录属于另一台 Mac，没有重新执行。')
    intent ??= { ...scope, runtimeId: scope.runtimeId, hostId: result.session.hostId, input: { agentSessionId, expectedRun: { ...result.session.run }, operationId: randomClientRequestId(), trigger: 'manual' }, phase: 'sending' }
    await owner.retainAgentResume(intent, recordId)
    if (!unchanged()) return
    const restored = await mobileCapability(client, 'ensureAgentContinuity')(intent.input)
    if (('session' in restored ? restored.session.agentSessionId !== agentSessionId || restored.session.hostId !== intent.hostId : restored.agentSessionId !== agentSessionId) || restored.previousRun.runId !== intent.input.expectedRun.runId) throw new Error('恢复结果属于另一个目标，可以核对后再试。')
    const confirmed = restored.kind === 'resumed' || restored.kind === 'reattachable'
    const superseded = restored.kind === 'conflict' && restored.reason === 'session-run-changed'
    await owner.retainAgentResume({ ...intent, phase: confirmed ? 'confirmed' : superseded ? 'superseded' : 'unknown' }, recordId)
    if (!unchanged()) return
    if (confirmed) confirmedNotice(restored.kind === 'resumed' ? '恢复已开始，Agent 可以继续工作时会显示。' : '可以重新连回这个 Agent。')
    else if (superseded) notice('这个 Agent 已被其他操作重新启动，不会自动重试。可以再恢复一次。')
    else notice('恢复还没完成，可以核对结果或继续这次恢复。', [restored.kind, 'error' in restored ? restored.error : null, 'reason' in restored ? restored.reason : null].filter(Boolean).join('\n'))
  } catch (error) {
    if (intent && action !== 'inspect') { try { await owner.retainAgentResume({ ...intent, phase: 'unknown' }, recordId) } catch { /* Replacement records never accept old receipts. */ } }
    if (unchanged()) notice('恢复未确认，可以稍后核对；仍可阅读对话。', error instanceof Error ? error.message : String(error))
  } finally { flight.delete(agentSessionId); if (!flight.size) flights.delete(client); notifyFlight(client, agentSessionId) }
}
