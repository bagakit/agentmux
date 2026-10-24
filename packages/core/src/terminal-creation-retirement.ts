import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRun } from './types.js'

/** Native's persistent lineage and the serving authority observed for an explicit action. */
export type AgentMuxCreationRuntime = { runtimeId: string; instanceId: string; buildIdentity: string; protocolVersion: number }
export type AgentMuxTerminalCreationRetirement = { runtime: AgentMuxCreationRuntime } & (
  { outcome: 'retired' } | { outcome: 'retained'; run: AgentMuxRun })
export type AgentMuxTerminalCreationRetirementObservation = {
  runtime: AgentMuxCreationRuntime; outcome: 'retired' | 'not_retired'
}
export function parseCreationRuntime(value: unknown): AgentMuxCreationRuntime {
  const r = rpcRecord(value, ['runtimeId', 'instanceId', 'buildIdentity', 'protocolVersion'])
  if ([r.runtimeId, r.instanceId, r.buildIdentity].some(v => typeof v !== 'string' || !v || /[\0\r\n]/u.test(v)) ||
    !Number.isSafeInteger(r.protocolVersion) || Number(r.protocolVersion) < 1)
    throw new AgentMuxError('The exact Native creation Runtime identity is required.', 'INVALID_CONTROL_REQUEST')
  return structuredClone(r) as AgentMuxCreationRuntime
}
