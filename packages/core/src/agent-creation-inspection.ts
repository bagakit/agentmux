import { dequal } from 'dequal'
import { parseAgentCreationFact, normalizeSessionHistoryMetadata } from "./agent-session-codec.js";
import { parseRpcAgentSession } from "./agent-session-codec.js";
import { parseCreationResolution, type AgentMuxCreationInspectParams, type AgentMuxCreationResolveParams } from './agent-creation-resolution.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxAgentCreationInspection } from './types.js'

export type AgentMuxCreationInspectionResult = { hostId: string; inspection: AgentMuxAgentCreationInspection }
const invalid = (): never => { throw new AgentMuxError('Creation inspection returned another original target or malformed facts.', 'CONTROL_PROTOCOL_ERROR') }
export function parseCreationInspection(value: unknown, target?: string | { createOperationId: string; agentSessionId?: string; operationId?: string }): AgentMuxAgentCreationInspection {
  const source = rpcRecord(value)
  let result: AgentMuxAgentCreationInspection
  if (source.kind === 'agent') result = parseRpcAgentSession(source)
  else if (source.kind === 'retired-agent') {
    const r = rpcRecord(source, ['kind', 'agentSessionId', 'hostId', 'run', 'source', 'observedAt', 'history', 'recordDeletion', 'continuityControlReceipts', 'activityCommit', 'stop'])
    const run = rpcRecord(r.run, ['runId'])
    if (r.source !== 'user' || typeof run.runId !== 'string' || !run.runId || !Number.isSafeInteger(r.observedAt) || Number(r.observedAt) < 0 ||
        typeof r.agentSessionId !== 'string' || !r.agentSessionId || typeof r.hostId !== 'string' || !r.hostId || !r.history) invalid()
    const history = normalizeSessionHistoryMetadata(r.history)
    if (!dequal(history, r.history)) invalid()
    result = structuredClone(r) as unknown as AgentMuxAgentCreationInspection
  } else {
    const r = rpcRecord(source, ['kind', 'agentSessionId', 'providerId', 'executorId', 'hostId', 'workspacePath', 'creation', 'resolution', 'observation'])
    if (!['prepared-agent-creation', 'closed-agent-creation'].includes(String(r.kind)) ||
        ['agentSessionId', 'providerId', 'executorId', 'hostId', 'workspacePath'].some(key => typeof r[key] !== 'string' || !r[key] || /[\0\r\n]/u.test(String(r[key])))) invalid()
    const creation = parseAgentCreationFact(r.creation)
    if (!dequal(creation, r.creation) || creation.createdRun || creation.initialInputKey || creation.resolution) invalid()
    const receipt = r.resolution === undefined ? undefined : parseCreationResolution(r.resolution)
    if (r.kind === 'closed-agent-creation' ? receipt?.outcome !== 'fenced' : receipt && receipt.outcome !== 'pending') invalid()
    if (receipt && (receipt.agentSessionId !== r.agentSessionId || receipt.createOperationId !== creation.createOperationId)) invalid()
    if (r.observation !== undefined) {
      const observation = rpcRecord(r.observation, ['runtimeId', 'retainedRun']), run = rpcRecord(observation.retainedRun, ['runId'])
      if (r.kind === 'closed-agent-creation' || typeof observation.runtimeId !== 'string' || !observation.runtimeId || typeof run.runId !== 'string' || !run.runId) invalid()
    }
    result = structuredClone(r) as unknown as AgentMuxAgentCreationInspection
  }
  const creation = result.kind === 'retired-agent' ? result.history?.creation : result.creation
  const receipt = result.kind === 'agent' || result.kind === 'retired-agent' ? creation?.resolution : result.resolution
  if (typeof target === 'string' ? result.agentSessionId !== target : target &&
      (creation?.createOperationId !== target.createOperationId || target.agentSessionId !== undefined && result.agentSessionId !== target.agentSessionId ||
        receipt && target.operationId !== undefined && receipt.operationId !== target.operationId)) invalid()
  return result
}
export function parseCreationInspectionResult(value: unknown, input: AgentMuxCreationInspectParams | AgentMuxCreationResolveParams): AgentMuxCreationInspectionResult {
  const r = rpcRecord(value, ['hostId', 'inspection'], 'CONTROL_PROTOCOL_ERROR')
  if (r.hostId !== input.hostId) invalid()
  return { hostId: input.hostId, inspection: parseCreationInspection(r.inspection, input) }
}
