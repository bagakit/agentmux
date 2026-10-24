import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
export type GoalChanges = { goalIds: string[] }
export type GoalChangePort = { subscribe(onChange: (change: GoalChanges) => void | Promise<void>, onEnd: (error?: Error) => void | Promise<void>, signal: AbortSignal): Promise<{ initial: GoalChanges; dispose(): void | Promise<void> }> }
export function parseGoalChanges(value: unknown): GoalChanges {
  const p = rpcRecord(value, ['goalIds'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.goalIds) || !p.goalIds.every(id => typeof id === 'string' && !!id.trim() && !/[\0\r\n]/u.test(id))) throw new AgentMuxError('Original Goal changes have an unconfirmed target.', 'CONTROL_PROTOCOL_ERROR')
  return { goalIds: p.goalIds }
}
