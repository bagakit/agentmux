import type { AgentExecutorConfig, AgentProviderId } from './types.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Executable observation only, not Provider or split-execution qualification.
 * Unknown/failed checks never mean missing; missing does not mean every path is absent. */
const AGENTMUX_EXECUTOR_AVAILABILITIES = ['unknown', 'check-failed', 'missing', 'available'] as const
export type AgentMuxExecutorAvailability = typeof AGENTMUX_EXECUTOR_AVAILABILITIES[number]
export function isAgentMuxExecutorAvailability(value: unknown): value is AgentMuxExecutorAvailability {
  return (AGENTMUX_EXECUTOR_AVAILABILITIES as readonly unknown[]).includes(value)
}

/** Safe launch metadata. Executor environment and arguments stay with the executing Host. */
export type AgentMuxHostExecutorDescriptor = {
  executorId: string
  label: string
  providerId: AgentProviderId
  command: string
  source: 'provider-default' | 'registered'
  configRevision: string
  availability: AgentMuxExecutorAvailability
  /** Absolute executable selected on this Host, present only after a successful check. */
  executable?: string
  cause?: { code: string; message: string }
}

export type AgentMuxHostExecutorInventory = {
  runtimeId: string
  executors: AgentMuxHostExecutorDescriptor[]
}

function invalidInventory(): never { throw new AgentMuxError('Executor metadata does not match its original owner.', 'CONTROL_PROTOCOL_ERROR') }
/** The same safe descriptor codec serves Settings and route readers. */
export function parseHostExecutorDescriptor(value: unknown): AgentMuxHostExecutorDescriptor {
  const d = rpcRecord(value, ['executorId', 'label', 'providerId', 'command', 'source', 'configRevision', 'availability', 'executable', 'cause'], 'CONTROL_PROTOCOL_ERROR')
  for (const key of ['executorId', 'label', 'providerId', 'command', 'configRevision']) if (typeof d[key] !== 'string' || !d[key] || /[\0\r\n]/u.test(d[key])) invalidInventory()
  if (!['registered', 'provider-default'].includes(d.source as string) || !isAgentMuxExecutorAvailability(d.availability)) invalidInventory()
  if (d.executable !== undefined && (typeof d.executable !== 'string' || !d.executable.startsWith('/') || /[\0\r\n]/u.test(d.executable))) invalidInventory()
  if (d.availability === 'available' && (!d.executable || d.cause !== undefined) || d.availability === 'check-failed' && d.cause === undefined) invalidInventory()
  if (d.cause !== undefined) {
    const cause = rpcRecord(d.cause, ['code', 'message'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof cause.code !== 'string' || !cause.code || typeof cause.message !== 'string') invalidInventory()
  }
  return d as AgentMuxHostExecutorDescriptor
}
export function parseHostExecutorInventory(value: unknown): AgentMuxHostExecutorInventory {
  const p = rpcRecord(value, ['runtimeId', 'executors'], 'CONTROL_PROTOCOL_ERROR')
  if (typeof p.runtimeId !== 'string' || !p.runtimeId || /[\0\r\n]/u.test(p.runtimeId) || !Array.isArray(p.executors)) invalidInventory()
  const executors = p.executors.map(parseHostExecutorDescriptor)
  if (new Set(executors.map(item => item.executorId)).size !== executors.length) invalidInventory()
  return { runtimeId: p.runtimeId, executors }
}

export type AgentMuxHostExecutorConfigureInput = {
  executorId: string
  config: AgentExecutorConfig
  expectedRevision?: string
}

export type AgentMuxHostExecutorConfiguration = {
  runtimeId: string
  executor: AgentMuxHostExecutorDescriptor
}

/** Host-internal resolved invocation. Never project this configuration to a client. */
export type AgentMuxResolvedHostExecutor = {
  config: AgentExecutorConfig
  descriptor: AgentMuxHostExecutorDescriptor
}
