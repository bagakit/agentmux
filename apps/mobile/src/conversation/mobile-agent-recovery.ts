import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { getDeviceWorkface } from '../recovery/device-workface'
import type { MobileAgentResumeIntent } from '../recovery/agent-resume-intents'

// In-flight coordination only. Durable Session, operation and phase facts stay with DeviceWorkface/Core.
const flights = new WeakMap<AgentMuxHostedClient, Set<string>>()
const subscribers = new WeakMap<AgentMuxHostedClient, Map<string, Set<() => void>>>()
export function subscribeMobileAgentRecovery(client: AgentMuxHostedClient | null, agentSessionId: string, notify: () => void): () => void {
  if (!client) return () => {}
  let bySession = subscribers.get(client)
  if (!bySession) { bySession = new Map(); subscribers.set(client, bySession) }
  let listeners = bySession.get(agentSessionId)
  if (!listeners) { listeners = new Set(); bySession.set(agentSessionId, listeners) }
  listeners.add(notify)
  return () => { listeners.delete(notify); if (!listeners.size) bySession.delete(agentSessionId); if (!bySession.size) subscribers.delete(client) }
}
function notifyFlight(client: AgentMuxHostedClient, agentSessionId: string) {
  for (const notify of subscribers.get(client)?.get(agentSessionId) ?? []) notify()
}
export function mobileAgentRecoveryBusy(client: AgentMuxHostedClient | null, agentSessionId: string): boolean {
  return Boolean(client && flights.get(client)?.has(agentSessionId))
}
export function pendingMobileAgentRecovery(client: AgentMuxHostedClient | null, agentSessionId: string): MobileAgentResumeIntent | undefined {
  const record = getDeviceWorkface().snapshot().record
  return record.agentResumes?.find(item => item.input.agentSessionId === agentSessionId && item.phase !== 'confirmed' && item.phase !== 'superseded' &&
    item.runtimeId === client?.runtimeOwnerIdentity?.()?.runtimeId && item.deviceHostId === (record.host?.hostId ?? null))
}
export type MobileAgentRecoveryRequest = {
  client: AgentMuxHostedClient; agentSessionId: string; expectedHostId?: string
  /** Opening an existing main Agent inspects any pending operation; only Continue may redispatch that same request. */
  mode?: 'open' | 'new' | 'inspect' | 'continue'
  isCurrent(): boolean; onNotice(message: string): void
}
/** Called only by an explicit person action. Reading, mounting and reconnecting never enter here. */
export async function recoverMobileAgent({ client, agentSessionId, expectedHostId, mode = 'open', isCurrent, onNotice }: MobileAgentRecoveryRequest): Promise<void> {
  if (!isCurrent()) return
  if (!client.forwardRpc) { onNotice('原 Host 会话读取尚未准备好；原身份、历史和草稿保留，可重连后再核对。'); return }
  let flight = flights.get(client)
  if (!flight) { flight = new Set(); flights.set(client, flight) }
  if (flight.has(agentSessionId)) return
  flight.add(agentSessionId); notifyFlight(client, agentSessionId)
  const owner = getDeviceWorkface(), recordId = owner.recordIdentity()
  const scope = { runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId, deviceHostId: owner.snapshot().record.host?.hostId ?? null }
  const unchanged = () => isCurrent() && owner.recordIdentity() === recordId && client.runtimeOwnerIdentity?.()?.runtimeId === scope.runtimeId &&
    (owner.snapshot().record.host?.hostId ?? null) === scope.deviceHostId
  const notice = (message: string) => { if (unchanged()) onNotice(message) }
  const pending = pendingMobileAgentRecovery(client, agentSessionId)
  const action = mode === 'open' ? pending ? 'inspect' : 'new' : mode
  let intent: MobileAgentResumeIntent | undefined = pending
  try {
    if (!scope.runtimeId) throw new Error('原 Host 运行身份尚未确认；原对话与草稿保留。')
    const result = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId } })
    if (!unchanged()) return
    if (result.session.agentSessionId !== agentSessionId) throw new Error('读取返回了另一 Agent；原记录保留，未执行恢复。')
    if (expectedHostId !== undefined && (result.routeHostId !== expectedHostId ||
      result.session.hostId !== 'local' && result.session.hostId !== expectedHostId)) throw new Error('主 Agent 的原 Host 与当前读取不同；原身份、历史和请求保留，未改投恢复。')
    if (action === 'inspect') {
      if (!intent || intent.hostId !== result.session.hostId) throw new Error('原恢复目标未确认；保留原操作。')
      const operation = result.session.continuityOperations?.[intent.input.operationId]
      if (!operation) { notice('Host 尚未确认此原恢复操作；原请求保留，可稍后再核对。'); return }
      if (operation.operationId !== intent.input.operationId || operation.launchInput || operation.agentSessionId !== agentSessionId || operation.previousRun.runId !== intent.input.expectedRun.runId || operation.action === 'restart') throw new Error('原恢复回执目标不同；未采用该回执。')
      if (operation.kind === 'conflict' && result.session.run.runId !== intent.input.expectedRun.runId) {
        await owner.retainAgentResume({ ...intent, phase: 'superseded' }, recordId)
        if (unchanged()) { notice('原 Run 已被其他操作更替，原冲突记录保留。可重新显式恢复当前 Run，不会自动重放。') }
      } else if (operation.kind === 'resumed' || operation.kind === 'reattachable') {
        await owner.retainAgentResume({ ...intent, phase: 'confirmed' }, recordId)
        if (!unchanged()) return
        notice(operation.kind === 'resumed' ? '原恢复启动已确认；上下文与输入就绪仍以 Core 当前状态为准。' : '原 Run 可重新接回；当前对话与草稿保留。')
      } else notice(`原恢复操作：${operation.kind}。${operation.error ?? operation.reason} 原操作与草稿保留。`)
      return
    }
    if (intent && action === 'new') throw new Error('已有原恢复操作待核对；不会创建另一恢复请求。')
    if (intent && intent.hostId !== result.session.hostId) throw new Error('原恢复 Host 不同；未重新执行。')
    intent ??= { ...scope, runtimeId: scope.runtimeId, hostId: result.session.hostId, input: { agentSessionId, expectedRun: { ...result.session.run }, operationId: randomClientRequestId(), trigger: 'manual' }, phase: 'sending' }
    await owner.retainAgentResume(intent, recordId)
    if (!unchanged()) return
    const restored = await client.ensureAgentContinuity(intent.input)
    if (('session' in restored ? restored.session.agentSessionId !== agentSessionId || restored.session.hostId !== intent.hostId : restored.agentSessionId !== agentSessionId) || restored.previousRun.runId !== intent.input.expectedRun.runId) throw new Error('恢复返回了另一目标；保留原请求供核对。')
    const confirmed = restored.kind === 'resumed' || restored.kind === 'reattachable'
    const superseded = restored.kind === 'conflict' && restored.reason === 'session-run-changed'
    await owner.retainAgentResume({ ...intent, phase: confirmed ? 'confirmed' : superseded ? 'superseded' : 'unknown' }, recordId)
    if (unchanged()) notice(superseded ? '原 Run 已被其他操作更替，原冲突记录保留。可重新显式恢复当前 Run，不会自动重放。' : confirmed ? restored.kind === 'resumed' ? '原恢复启动已确认；上下文与输入就绪仍以 Core 当前状态为准。' : '原 Run 可重新接回；当前对话与草稿保留。' : `恢复尚未完成：${restored.kind}。原身份、请求和草稿保留，可核对原操作。`)
  } catch (error) {
    if (intent && action !== 'inspect') { try { await owner.retainAgentResume({ ...intent, phase: 'unknown' }, recordId) } catch { /* Replacement records never accept old receipts. */ } }
    if (unchanged()) notice(`恢复未确认：${error instanceof Error ? error.message : String(error)}`)
  } finally { flight.delete(agentSessionId); if (!flight.size) flights.delete(client); notifyFlight(client, agentSessionId) }
}
