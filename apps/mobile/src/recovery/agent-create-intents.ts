/** The authored mobile form is a bounded subset of public agent.open, not a second creation owner. */
export type MobileAgentCreateIntent = {
  runtimeId: string; deviceHostId: string | null
  input: { operationId: string; content: { kind: 'new-agent'; executorId: string; prompt?: string }; destination: { spaceId: string; zoneId: string; newTab: true }; focus: false }
  phase: 'sending' | 'unknown' | 'confirmed'
  agentSessionId?: string
}
export function parseMobileAgentCreateIntent(value: unknown): MobileAgentCreateIntent {
  const invalid = (): never => { throw new Error('原 Agent 创建意图无效；保留原记录，不重放。') }
  const object = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
    return value as Record<string, unknown>
  }
  const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 65536 && !/[\0\r\n]/u.test(value)
  const item = object(value, ['runtimeId', 'deviceHostId', 'input', 'phase', 'agentSessionId'])
  const input = object(item.input, ['operationId', 'content', 'destination', 'focus'])
  const content = object(input.content, ['kind', 'executorId', 'prompt']), destination = object(input.destination, ['spaceId', 'zoneId', 'newTab'])
  if (!id(item.runtimeId) || !(item.deviceHostId === null || id(item.deviceHostId)) || !id(input.operationId) || content.kind !== 'new-agent' || !id(content.executorId) ||
    !(content.prompt === undefined || typeof content.prompt === 'string') || !id(destination.spaceId) || !id(destination.zoneId) || destination.newTab !== true || input.focus !== false ||
    !['sending', 'unknown', 'confirmed'].some(phase => phase === item.phase) || !(item.agentSessionId === undefined || id(item.agentSessionId))) invalid()
  return structuredClone(value) as MobileAgentCreateIntent
}
