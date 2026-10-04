import type { AgentExecutorConfig, AgentProviderId } from './types.js'
import type { AgentMuxExecutorAvailability } from './control.js'

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
