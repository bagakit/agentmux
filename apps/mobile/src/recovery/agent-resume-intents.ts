import type { AgentMuxAgentContinuityInput } from '@agentmux/core'

/** A saved explicit request is a read reference, never permission to replay it. */
export type MobileAgentResumeIntent = {
  runtimeId: string
  deviceHostId: string | null
  hostId: string
  input: Pick<AgentMuxAgentContinuityInput, 'agentSessionId' | 'expectedRun' | 'operationId'> & { trigger: 'manual' }
  phase: 'sending' | 'unknown' | 'confirmed' | 'superseded'
}
export function parseMobileAgentResumeIntent(value: unknown): MobileAgentResumeIntent {
  const invalid = (): never => { throw new Error('原 Agent 恢复意图无效；保留原记录，不重放。') }
  const object = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
    return value as Record<string, unknown>
  }
  const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)
  const item = object(value, ['runtimeId', 'deviceHostId', 'hostId', 'input', 'phase'])
  const input = object(item.input, ['agentSessionId', 'expectedRun', 'operationId', 'trigger'])
  const run = object(input.expectedRun, ['runId'])
  if (!id(item.runtimeId) || !(item.deviceHostId === null || id(item.deviceHostId)) || !id(item.hostId) || !id(input.agentSessionId) ||
    !id(input.operationId) || !id(run.runId) || input.trigger !== 'manual' || !['sending', 'unknown', 'confirmed', 'superseded'].some(phase => phase === item.phase)) invalid()
  return structuredClone(value) as MobileAgentResumeIntent
}
