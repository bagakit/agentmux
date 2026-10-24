/** Device-local copies of requests whose original Goal receipt may be unknown. */
export type MobileGoalOperationRecord = {
  runtimeId: string | null
  ownerInstanceId: string | null
  deviceHostId: string | null
  origin: string
  method: 'goal.assign' | 'goal.start' | 'goal.handoff' | 'goal.delete' | 'goal.link-session' | 'goal.link-project'
  request: Record<string, unknown> & { goalId: string; operationId: string }
}

export function parseMobileGoalOperationRecord(value: unknown): MobileGoalOperationRecord {
  const invalid = () => { throw new Error('设备目标操作记录无法完整核实；原记录保留。') }
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(key => Object.hasOwn(v, key))) return invalid()
    return v as Record<string, unknown>
  }
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256
  const v = object(value, ['runtimeId', 'ownerInstanceId', 'deviceHostId', 'origin', 'method', 'request'])
  if (!(v.runtimeId === null && v.ownerInstanceId === null || id(v.runtimeId) && id(v.ownerInstanceId)) || !(v.deviceHostId === null || id(v.deviceHostId)) || typeof v.origin !== 'string' || !v.origin || v.origin.length > 2048) return invalid()
  const method = v.method
  if (!['goal.assign', 'goal.start', 'goal.handoff', 'goal.delete', 'goal.link-session', 'goal.link-project'].includes(String(method))) return invalid()
  const raw = v.request as Record<string, unknown>
  const optionalSession = raw && Object.hasOwn(raw, 'sessionId') && (method === 'goal.start' || method === 'goal.handoff') ? ['sessionId'] : []
  const extra = method === 'goal.assign' ? ['assigneeSessionIds', 'supervisorSessionId', 'expectedUpdatedAt', 'start']
    : method === 'goal.handoff' ? ['assigneeSessionIds', 'supervisorSessionId', 'expectedUpdatedAt', ...optionalSession]
      : method === 'goal.start' ? optionalSession : method === 'goal.delete' ? ['confirmation']
        : method === 'goal.link-session' ? ['sessionId'] : ['projectId']
  const request = object(raw, ['goalId', 'operationId', ...extra])
  if (!id(request.goalId) || !id(request.operationId)) return invalid()
  if (method === 'goal.assign' || method === 'goal.handoff') {
    if (!Array.isArray(request.assigneeSessionIds) || request.assigneeSessionIds.length > 256 || !request.assigneeSessionIds.every(id)
      || !(request.supervisorSessionId === null || id(request.supervisorSessionId)) || !Number.isSafeInteger(request.expectedUpdatedAt) || Number(request.expectedUpdatedAt) < 0) return invalid()
  }
  if (method === 'goal.assign' && request.start !== false || method === 'goal.delete' && request.confirmation !== 'delete'
    || Object.hasOwn(request, 'sessionId') && !id(request.sessionId) || method === 'goal.link-project' && !id(request.projectId)) return invalid()
  return structuredClone(value) as MobileGoalOperationRecord
}
