import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseAgentScheduleCalendar, parseAgentScheduleCheckIn, type AgentScheduleCalendar, type AgentScheduleCheckInPolicy } from './agent-schedule.js'
import { validateAgentPromptCondition } from './agent-prompt-condition.js'
import type { ContinuousProgressLoop, ContinuousProgressTarget } from './continuous-progress-scheduler.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

export type ScheduleMutation = { scheduleId: string; expectedRevision: number; operationId: string }
export type ScheduleParamsMap = {
  'schedule.list': { target?: ContinuousProgressTarget }
  'schedule.inspect': { scheduleId?: string; operationId?: string }
  'schedule.create': { target: ContinuousProgressTarget; calendar: AgentScheduleCalendar; prompt: string; operationId: string; checkIn?: AgentScheduleCheckInPolicy }
  'schedule.pause': ScheduleMutation
  'schedule.resume': ScheduleMutation
  'schedule.cancel': ScheduleMutation
}
export type ScheduleReceipt = { schedule: ContinuousProgressLoop; diskDurability: 'confirmed'; executionScope: 'connected-host' }
export type ScheduleResultMap = {
  'schedule.list': { schedules: ContinuousProgressLoop[]; executionScope: 'connected-host' }
  'schedule.inspect': { schedule: ContinuousProgressLoop | null; executionScope: 'connected-host' }
  'schedule.create': ScheduleReceipt
  'schedule.pause': ScheduleReceipt
  'schedule.resume': ScheduleReceipt
  'schedule.cancel': ScheduleReceipt
}
export type ScheduleMethod = keyof ScheduleParamsMap
export interface AgentMuxRpcSchedulesOwner {
  call<M extends ScheduleMethod>(method: M, params: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext): Promise<ScheduleResultMap[M]>
}
export const AGENTMUX_RPC_SCHEDULE_METHODS = {
  'schedule.list': 'short', 'schedule.inspect': 'short', 'schedule.create': 'long',
  'schedule.pause': 'long', 'schedule.resume': 'long', 'schedule.cancel': 'long'
} as const satisfies Record<ScheduleMethod, 'short' | 'long'>
export function isScheduleMethod(value: unknown): value is ScheduleMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_SCHEDULE_METHODS, value)
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function string(value: unknown, code: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid('An exact schedule identity or nonempty message is required.', code)
}
function integer(value: unknown, code: string, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid('Schedule revision or occurrence is invalid.', code)
}
export function parseScheduleTarget(value: unknown, code = 'INVALID_CONTROL_REQUEST'): ContinuousProgressTarget {
  const p = rpcRecord(value, ['hostId','agentSessionId','providerId','workspacePath'], code)
  for (const key of ['hostId','agentSessionId','providerId','workspacePath']) string(p[key], code)
  return p as ContinuousProgressTarget
}
export function parseScheduleRpcParams<M extends ScheduleMethod>(method: M, value: unknown): ScheduleParamsMap[M] {
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, method === 'schedule.list' ? ['target'] : method === 'schedule.inspect' ? ['scheduleId','operationId'] :
    method === 'schedule.create' ? ['target','calendar','prompt','operationId','checkIn'] : ['scheduleId','expectedRevision','operationId'], code)
  if (method === 'schedule.list') { if (p.target !== undefined) parseScheduleTarget(p.target) }
  else if (method === 'schedule.inspect') {
    if ((p.scheduleId !== undefined) === (p.operationId !== undefined)) invalid('Inspect requires exactly one schedule ID or original operation ID.', code)
    string(p.scheduleId ?? p.operationId, code)
  } else if (method === 'schedule.create') {
    parseScheduleTarget(p.target); parseAgentScheduleCalendar(p.calendar); string(p.prompt, code, 64 * 1024); string(p.operationId, code)
    if (p.checkIn !== undefined) parseAgentScheduleCheckIn(p.checkIn)
  } else { string(p.scheduleId, code); string(p.operationId, code); integer(p.expectedRevision, code, 1) }
  return p as ScheduleParamsMap[M]
}
export function parseScheduleRecord(value: unknown): ContinuousProgressLoop {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['loopId','hostId','agentSessionId','providerId','workspacePath','calendar','checkIn','checkInState','revision','creationOperationId','lastMutation','futureIntentId','lastOccurrenceAt','intervalMs','prompt','nextCheckAt','status','pendingCompletion','lastCompletionId','lastTickId','lastOutcome','lastTickAt','lastDecision','taskSource'], code)
  parseScheduleTarget({ hostId: p.hostId, agentSessionId: p.agentSessionId, providerId: p.providerId, workspacePath: p.workspacePath }, code)
  string(p.loopId, code); string(p.prompt, code, 64 * 1024); integer(p.intervalMs, code, 1); integer(p.nextCheckAt, code)
  if (!['active','paused','stopped'].includes(p.status as string)) invalid('Schedule state is invalid.', code)
  if (p.calendar !== undefined) parseAgentScheduleCalendar(p.calendar, code)
  if (p.checkIn !== undefined) parseAgentScheduleCheckIn(p.checkIn, code)
  if (p.checkInState !== undefined) {
    if (p.checkIn === undefined) invalid('Quiet follow-up state requires its saved policy.', code)
    const state = rpcRecord(p.checkInState, ['lastClaimAt','budgetDate','budgetUsed','unanswered'], code)
    for (const key of ['lastClaimAt','budgetUsed']) if (state[key] !== undefined) integer(state[key], code)
    if (state.budgetDate !== undefined && (typeof state.budgetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(state.budgetDate))) invalid('Quiet follow-up budget day is invalid.', code)
    if ((state.budgetDate === undefined) !== (state.budgetUsed === undefined)) invalid('Quiet follow-up budget is incomplete.', code)
    if (state.unanswered !== undefined) {
      const unanswered = rpcRecord(state.unanswered, ['humanId','humanCreatedAt','claimAt'], code)
      string(unanswered.humanId, code); integer(unanswered.humanCreatedAt, code); integer(unanswered.claimAt, code)
    }
  }
  if (p.revision !== undefined) integer(p.revision, code, 1)
  for (const key of ['creationOperationId','futureIntentId','lastCompletionId','lastTickId','lastDecision']) if (p[key] !== undefined) string(p[key], code, 64 * 1024)
  for (const key of ['lastOccurrenceAt','lastTickAt']) if (p[key] !== undefined) integer(p[key], code)
  if (p.lastOutcome !== undefined && !['sent','skipped','unknown'].includes(p.lastOutcome as string)) invalid('Schedule outcome is invalid.', code)
  if (p.lastMutation !== undefined) {
    const m = rpcRecord(p.lastMutation, ['operationId','action','expectedRevision'], code)
    string(m.operationId, code); integer(m.expectedRevision, code, 1)
    if (!['pause','resume','cancel'].includes(m.action as string)) invalid('Schedule action is invalid.', code)
  }
  if (p.pendingCompletion !== undefined) {
    const claim = rpcRecord(p.pendingCompletion, ['id','operationId','condition','inputByte','prompt','agentMuxNote','futureIntent'], code)
    string(claim.id, code); string(claim.operationId, code)
    if (claim.condition !== undefined) validateAgentPromptCondition(claim.condition)
    if (claim.inputByte !== undefined) integer(claim.inputByte, code)
    for (const key of ['prompt','agentMuxNote']) if (claim[key] !== undefined) string(claim[key], code, 64 * 1024)
    if (claim.futureIntent !== undefined) {
      const occurrence = rpcRecord(claim.futureIntent, ['intentId','occurrenceAt'], code)
      string(occurrence.intentId, code); integer(occurrence.occurrenceAt, code)
    }
  }
  if (p.taskSource !== undefined) {
    const source = rpcRecord(p.taskSource, ['root','ownerId','readerPath'], code)
    for (const key of ['root','ownerId','readerPath']) string(source[key], code)
  }
  return structuredClone(p) as ContinuousProgressLoop
}
export function validateScheduleRpcResult<M extends ScheduleMethod>(method: M, value: unknown, params?: ScheduleParamsMap[M]): ScheduleResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, method === 'schedule.list' ? ['schedules','executionScope'] : method === 'schedule.inspect' ? ['schedule','executionScope'] : ['schedule','executionScope','diskDurability'], code)
  if (p.executionScope !== 'connected-host') invalid('The schedule execution scope is unconfirmed.', code)
  if (method === 'schedule.list') {
    if (!Array.isArray(p.schedules) || p.schedules.length > 4096) invalid('Schedule results must be bounded.', code);
    (p.schedules as unknown[]).forEach(parseScheduleRecord)
  } else if (p.schedule !== null || method !== 'schedule.inspect') parseScheduleRecord(p.schedule)
  if (method !== 'schedule.list' && method !== 'schedule.inspect' && p.diskDurability !== 'confirmed') invalid('Schedule persistence is unconfirmed.', code)
  const records = method === 'schedule.list' ? p.schedules as ContinuousProgressLoop[] : p.schedule === null ? [] : [p.schedule as ContinuousProgressLoop]
  for (const schedule of records) {
    if (!schedule.calendar || !schedule.revision || !schedule.futureIntentId || !schedule.creationOperationId) invalid('Calendar arrangement identity or admission is unconfirmed.', code)
    if (params) {
      if (method === 'schedule.list') {
        const target = (params as ScheduleParamsMap['schedule.list']).target
        if (target && ['hostId','agentSessionId','providerId','workspacePath'].some(key => schedule[key as keyof ContinuousProgressTarget] !== target[key as keyof ContinuousProgressTarget])) invalid('Schedule list returned another target.', code)
      } else if (method === 'schedule.create') {
        const request = params as ScheduleParamsMap['schedule.create']
        if (schedule.creationOperationId !== request.operationId || schedule.prompt !== request.prompt || JSON.stringify(schedule.calendar) !== JSON.stringify(request.calendar) || JSON.stringify(schedule.checkIn) !== JSON.stringify(request.checkIn) ||
            ['hostId','agentSessionId','providerId','workspacePath'].some(key => schedule[key as keyof ContinuousProgressTarget] !== request.target[key as keyof ContinuousProgressTarget])) invalid('Schedule receipt belongs to different intent or target.', code)
      } else if (method === 'schedule.inspect') {
        const request = params as ScheduleParamsMap['schedule.inspect']
        if (request.scheduleId ? schedule.loopId !== request.scheduleId : ![schedule.creationOperationId, schedule.lastMutation?.operationId, schedule.pendingCompletion?.operationId, schedule.lastTickId].includes(request.operationId)) invalid('Schedule inspection returned another identity.', code)
      } else {
        const request = params as ScheduleMutation
        if (schedule.loopId !== request.scheduleId || schedule.revision !== request.expectedRevision + 1 || schedule.lastMutation?.operationId !== request.operationId || schedule.lastMutation.action !== method.slice('schedule.'.length)) invalid('Schedule mutation receipt does not match its original request.', code)
        const expectedStatus = method === 'schedule.resume' ? 'active' : method === 'schedule.pause' ? 'paused' : 'stopped'
        if (schedule.status !== expectedStatus) invalid('Schedule mutation did not establish its requested state.', code)
      }
    }
  }
  return p as ScheduleResultMap[M]
}
export function isScheduleRpcResult(method: ScheduleMethod, value: unknown): boolean {
  try { validateScheduleRpcResult(method, value); return true } catch { return false }
}
