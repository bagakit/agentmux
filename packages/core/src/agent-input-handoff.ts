import { dequal as isDeepStrictEqual } from 'dequal'
import { AgentMuxError } from './errors.js'
import { normalizePromptInputPlan } from './prompt-submission-record.js'
import type { AgentPromptInputPlan, AgentNativePromptInputPlan } from './types.js'

export type AgentInputCarrier =
  | { kind: 'pty'; plan: AgentPromptInputPlan;
      qualification?: { nativeSourceId: string; processId: number | null; inputByte: number } }
  | { kind: 'native'; plan: AgentNativePromptInputPlan }
  | { kind: 'launch'; lifecycleOperationId: string; reservationId: string }
export type AgentInputHandoff = { version: 1; storeScope: string; carrier: AgentInputCarrier }

export function parseAgentInputHandoff(value: unknown): AgentInputHandoff {
  const fail = (): never => { throw new AgentMuxError('The original input carrier preparation is invalid.', 'INVALID_AGENT_INPUT_CONTROL') }
  const object = (value: unknown, fields: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return fail()
    return value as Record<string, unknown>
  }
  const id = (value: unknown): string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value) ? value : fail()
  const p = object(value, ['version', 'storeScope', 'carrier']), c = object(p.carrier, ['kind', 'plan', 'qualification', 'lifecycleOperationId', 'reservationId'])
  if (p.version !== 1) return fail()
  let carrier: AgentInputCarrier
  if (c.kind === 'launch') {
    if (c.plan !== undefined || c.qualification !== undefined) return fail()
    carrier = { kind: 'launch', lifecycleOperationId: id(c.lifecycleOperationId), reservationId: id(c.reservationId) }
  } else {
    if (c.lifecycleOperationId !== undefined || c.reservationId !== undefined) return fail()
    const plan = normalizePromptInputPlan(c.plan)
    if (!isDeepStrictEqual(plan, c.plan)) return fail()
    if (c.kind === 'native' && plan.kind === 'native-rpc' && c.qualification === undefined) carrier = { kind: 'native', plan }
    else if (c.kind === 'pty' && (plan.kind === 'single-phase' || plan.kind === 'render-then-submit')) {
      let qualification: Extract<AgentInputCarrier, { kind: 'pty' }>['qualification']
      if (c.qualification !== undefined) {
        const q = object(c.qualification, ['nativeSourceId', 'processId', 'inputByte'])
        if (q.processId !== null && (!Number.isSafeInteger(q.processId) || Number(q.processId) < 1) ||
            !Number.isSafeInteger(q.inputByte) || Number(q.inputByte) < 0) return fail()
        qualification = { nativeSourceId: id(q.nativeSourceId), processId: q.processId as number | null, inputByte: q.inputByte as number }
      }
      carrier = { kind: 'pty', plan, ...(qualification ? { qualification } : {}) }
    } else return fail()
  }
  return { version: 1, storeScope: id(p.storeScope), carrier }
}
