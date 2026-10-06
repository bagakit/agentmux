import { parseFileReadParams, type FileReadParams } from './public-rpc-files.js'
import { parseDemandDelegationIntent, parseDemandDelegations } from '@agentmux/demand/delegations'
import { parseGrounding } from '@agentmux/demand/goals'
import type { DemandDelegation, DemandDelegationIntent } from '@agentmux/demand/delegations'
import type { DemandGrounding } from '@agentmux/demand/goals'
import { AgentMuxError } from './errors.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** Goal owns business intent and reports; this port never owns a message queue. */
export const GOAL_DELEGATION_METHODS = { 'goal.delegation.prepare': 'long', 'goal.delegations': 'short' } as const
export type GoalDelegationMethod = keyof typeof GOAL_DELEGATION_METHODS
export type GoalDelegationParamsMap = {
  'goal.delegation.prepare': { goalId: string; intent: DemandDelegationIntent; materials?: FileReadParams[] }
  'goal.delegations': { goalId: string }
}
export type GoalDelegationResult = { goalId: string; delegations: DemandDelegation[]; grounding?: DemandGrounding; diskDurability: 'confirmed' }
export type GoalDelegationResultMap = { [M in GoalDelegationMethod]: GoalDelegationResult }
/** Supplied after transport/Core caller admission, never from an editable business payload. */
export type GoalDelegationAuthority = { actor: { kind: 'agent' | 'user' | 'device'; id: string }; hostId?: string; runId?: string }
export interface GoalDelegationsOwner {
  call<M extends GoalDelegationMethod>(method: M, input: GoalDelegationParamsMap[M], context: AgentMuxRpcCallContext,
    authority: GoalDelegationAuthority): Promise<GoalDelegationResultMap[M]>
}
export function isGoalDelegationMethod(value: string): value is GoalDelegationMethod { return Object.hasOwn(GOAL_DELEGATION_METHODS, value) }
function record(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new AgentMuxError('The original Goal delegation object is invalid.', 'INVALID_CONTROL_REQUEST')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new AgentMuxError('An exact Goal delegation identity is required.', 'INVALID_CONTROL_REQUEST')
  return value
}
export function parseGoalDelegationParams<M extends GoalDelegationMethod>(method: M, value: unknown): GoalDelegationParamsMap[M] {
  const p = record(value, method === 'goal.delegation.prepare' ? ['goalId', 'intent', 'materials'] : ['goalId'])
  return { goalId: id(p.goalId), ...(method === 'goal.delegation.prepare' ? { intent: parseDemandDelegationIntent(p.intent), ...(p.materials === undefined ? {} : { materials: Array.isArray(p.materials) ? p.materials.map(parseFileReadParams) : (() => { throw new AgentMuxError('Original materials must be exact File requests.', 'INVALID_CONTROL_REQUEST') })() }) } : {}) } as GoalDelegationParamsMap[M]
}
export function parseGoalDelegationResult(value: unknown, input: { goalId: string }): GoalDelegationResult {
  const p = record(value, ['goalId', 'delegations', 'grounding', 'diskDurability'])
  if (p.goalId !== input.goalId || p.diskDurability !== 'confirmed') throw new AgentMuxError('The Goal delegation read belongs to another object or is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  return { goalId: input.goalId, delegations: parseDemandDelegations(p.delegations), diskDurability: 'confirmed',
    ...(p.grounding === undefined ? {} : { grounding: parseGrounding(p.grounding) }) }
}
