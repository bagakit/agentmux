import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseScheduleTarget, parseScheduleRecord, parseProgressTaskSource } from './public-rpc-schedules.js'
import { isAgentSchedule, type ContinuousProgressLoop, type ContinuousProgressTarget, type ContinuousProgressTaskSource } from './continuous-progress-scheduler.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
export type AgentProgressParams = {
  'agent.progress.list': { target: ContinuousProgressTarget }
  'agent.progress.create': { target: ContinuousProgressTarget; intervalMs: number; prompt: string; taskSource?: Exclude<ContinuousProgressTaskSource, { kind: 'goal' }>; operationId: string }
  'agent.progress.action': { target: ContinuousProgressTarget; loopId: string; action: 'pause' | 'resume' | 'stop' | 'check'; expectedLoop: ContinuousProgressLoop; operationId: string }
}
export type AgentProgressMethod = keyof AgentProgressParams
export type AgentProgressResults = { 'agent.progress.list': { loops: ContinuousProgressLoop[] }; 'agent.progress.create': { loop: ContinuousProgressLoop; diskDurability: 'confirmed' }; 'agent.progress.action': { loop: ContinuousProgressLoop; diskDurability: 'confirmed' } }
export type AgentProgressOwner = { call<M extends AgentProgressMethod>(method: M, input: AgentProgressParams[M], context: AgentMuxRpcCallContext): Promise<AgentProgressResults[M]> }
export const AGENT_PROGRESS_METHODS = { 'agent.progress.list': 'short', 'agent.progress.create': 'long', 'agent.progress.action': 'long' } as const
export const isAgentProgressMethod = (value: string): value is AgentProgressMethod => Object.hasOwn(AGENT_PROGRESS_METHODS, value)
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\0\r\n]/u.test(v)
export function parseAgentProgressParams<M extends AgentProgressMethod>(method: M, input: unknown): AgentProgressParams[M] {
  const p = rpcRecord(input, method === 'agent.progress.list' ? ['target'] : method === 'agent.progress.create' ? ['target','intervalMs','prompt','taskSource','operationId'] : ['target','loopId','action','expectedLoop','operationId'])
  parseScheduleTarget(p.target)
  if (method !== 'agent.progress.list' && !id(p.operationId)) throw new AgentMuxError('Continuous progress requires its original operation identity.', 'INVALID_CONTROL_REQUEST')
  if (method === 'agent.progress.create') {
    if (!Number.isSafeInteger(p.intervalMs) || (p.intervalMs as number) < 60_000 || typeof p.prompt !== 'string' || !p.prompt.trim()) throw new AgentMuxError('Continuous progress requires an explicit interval and original prompt.', 'INVALID_CONTROL_REQUEST')
    if (p.taskSource !== undefined) parseProgressTaskSource(p.taskSource)
  }
  if (method === 'agent.progress.action' && (!id(p.loopId) || !['pause','resume','stop','check'].includes(String(p.action)))) throw new AgentMuxError('Continuous progress action requires its original loop, saved execution intent and action.', 'INVALID_CONTROL_REQUEST')
  if (method === 'agent.progress.action') parseScheduleRecord(p.expectedLoop)
  return p as AgentProgressParams[M]
}
export function parseAgentProgressResult<M extends AgentProgressMethod>(method: M, result: unknown, input: AgentProgressParams[M]): AgentProgressResults[M] {
  const p = rpcRecord(result, method === 'agent.progress.list' ? ['loops'] : ['loop','diskDurability'], 'CONTROL_PROTOCOL_ERROR')
  if (method === 'agent.progress.list' && !Array.isArray(p.loops) || method !== 'agent.progress.list' && p.diskDurability !== 'confirmed') throw new AgentMuxError('Continuous progress observation is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  const loops = method === 'agent.progress.list' ? p.loops as unknown[] : [p.loop]
  for (const value of loops) {
    const loop = parseScheduleRecord(value)
    if (isAgentSchedule(loop) || loop.taskSource?.kind === 'goal' || ['hostId','agentSessionId','providerId','workspacePath'].some(key => loop[key as keyof ContinuousProgressTarget] !== input.target[key as keyof ContinuousProgressTarget])) throw new AgentMuxError('Continuous progress returned another exact target.', 'CONTROL_PROTOCOL_ERROR')
    if (method === 'agent.progress.create' && (loop.creationOperationId !== (input as AgentProgressParams['agent.progress.create']).operationId || loop.prompt !== (input as AgentProgressParams['agent.progress.create']).prompt || loop.intervalMs !== (input as AgentProgressParams['agent.progress.create']).intervalMs)) throw new AgentMuxError('Continuous progress returned another original creation.', 'CONTROL_PROTOCOL_ERROR')
    if (method === 'agent.progress.action' && loop.loopId !== (input as AgentProgressParams['agent.progress.action']).loopId) throw new AgentMuxError('Continuous progress returned another original loop.', 'CONTROL_PROTOCOL_ERROR')
  }
  return p as AgentProgressResults[M]
}
