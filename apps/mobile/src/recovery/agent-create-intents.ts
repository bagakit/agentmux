/** The authored mobile form is a bounded subset of public agent.open, not a second creation owner. */
export type MobileAgentCreateDestination = { spaceId: string; zoneId: string } & (
  | { newTab: true; tabId?: never; regionId?: never }
  | { tabId: string; regionId: string; newTab?: never }
)
export type MobileAgentCreateIntent = {
  runtimeId: string; deviceHostId: string | null
  input: { operationId: string; content: { kind: 'new-agent'; executorId: string; prompt?: string }; destination: MobileAgentCreateDestination; focus: false }
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
  const content = object(input.content, ['kind', 'executorId', 'prompt'])
  const rawDestination = input.destination as Record<string, unknown> | null
  const newTab = rawDestination?.newTab === true
  const destination = object(input.destination, newTab ? ['spaceId', 'zoneId', 'newTab'] : ['spaceId', 'zoneId', 'tabId', 'regionId'])
  if (!id(item.runtimeId) || !(item.deviceHostId === null || id(item.deviceHostId)) || !id(input.operationId) || content.kind !== 'new-agent' || !id(content.executorId) ||
    !(content.prompt === undefined || typeof content.prompt === 'string') || !id(destination.spaceId) || !id(destination.zoneId) ||
    !(newTab || id(destination.tabId) && id(destination.regionId)) || input.focus !== false ||
    !['sending', 'unknown', 'confirmed'].some(phase => phase === item.phase) || !(item.agentSessionId === undefined || id(item.agentSessionId))) invalid()
  return structuredClone(value) as MobileAgentCreateIntent
}
