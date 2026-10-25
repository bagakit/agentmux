import { AgentMuxError } from './errors.js'
import type { AgentLaunchPlan } from './types.js'

/** Durable resource identity. The Agent's process cwd and presentation are separate. */
export interface AgentToolExecutionBinding {
  bindingId: string
  resourceHostId: string
  resourceRuntimeId: string
  workspacePath: string
}
export function parseAgentToolExecutionBinding(value: unknown): AgentToolExecutionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('An exact tool execution binding is required.', 'INVALID_EXECUTION_BINDING')
  const record = value as Record<string, unknown>
  const keys = ['bindingId', 'resourceHostId', 'resourceRuntimeId', 'workspacePath']
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => typeof record[key] !== 'string' || !(record[key] as string).length || /[\0\r\n]/u.test(record[key] as string)))
    throw new AgentMuxError('The tool execution binding has invalid identity fields.', 'INVALID_EXECUTION_BINDING')
  return structuredClone(record) as unknown as AgentToolExecutionBinding
}
export interface AgentToolExecutionLaunchContext {
  binding: AgentToolExecutionBinding
  /** Private exact original local helper capability; never a caller-selected URL. */
  url: string
  launchWorkspacePath: string
}
export type PrepareAgentToolExecutionLaunch = (plan: AgentLaunchPlan, context: AgentToolExecutionLaunchContext) => Promise<AgentLaunchPlan>
