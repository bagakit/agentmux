import { optionalDemandInputEpoch } from './collaboration.js'
/** A Goal's immutable business request. Core owns actual spatial and input facts. */
export type DemandDiscussionIntent = {
  inputEpoch?: string
  inputRuntimeId?: string
  requestOperationId: string
  mode: 'open' | 'grill' | 'grounding' | 'plan'
  executorId: string
  spaceId: string
  zoneId: string
  agentMuxNote: string
  callerAgentSessionId?: string
  prompt?: string
}
export function parseDemandDiscussionIntent(value: unknown): DemandDiscussionIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original Goal discussion intent is invalid.')
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['inputEpoch','inputRuntimeId','requestOperationId','mode','executorId','spaceId','zoneId','agentMuxNote','prompt','callerAgentSessionId'].includes(key)) ||
      typeof p.mode !== 'string' || !['open','grill','grounding','plan'].includes(p.mode) ||
      !['requestOperationId','executorId','spaceId','zoneId','agentMuxNote'].every(key => typeof p[key] === 'string' && (p[key] as string).trim() && !(p[key] as string).includes('\0')) ||
      p.inputRuntimeId !== undefined && (typeof p.inputRuntimeId !== 'string' || !p.inputRuntimeId.trim() || /[\0\r\n]/u.test(p.inputRuntimeId)) ||
      p.prompt !== undefined && (typeof p.prompt !== 'string' || p.prompt.includes('\0')) ||
      p.callerAgentSessionId !== undefined && (typeof p.callerAgentSessionId !== 'string' || !p.callerAgentSessionId.trim() || p.callerAgentSessionId.includes('\0'))) throw new Error('The original Goal discussion intent is invalid.')
  return { ...optionalDemandInputEpoch(p.inputEpoch), ...(p.inputRuntimeId === undefined ? {} : { inputRuntimeId: p.inputRuntimeId as string }), requestOperationId: p.requestOperationId as string, mode: p.mode as DemandDiscussionIntent['mode'], executorId: p.executorId as string, spaceId: p.spaceId as string, zoneId: p.zoneId as string, agentMuxNote: p.agentMuxNote as string,
    ...(p.prompt === undefined ? {} : { prompt: p.prompt as string }), ...(p.callerAgentSessionId === undefined ? {} : { callerAgentSessionId: p.callerAgentSessionId as string }) }
}

/** A later explicit request has its own immutable input, separate from PMO creation. */
export type DemandDiscussionInput = { operationId: string; mode: 'grill' | 'grounding'; hostId: string; agentSessionId: string; runId: string;
  prompt: string; agentMuxNote: string; afterSubmissionId: string | null; inputEpoch?: string; callerAgentSessionId?: string }
export function parseDemandDiscussionInput(value: unknown): DemandDiscussionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original discussion input is invalid.')
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['operationId','mode','hostId','agentSessionId','runId','prompt','agentMuxNote','afterSubmissionId','inputEpoch','callerAgentSessionId'].includes(key)) ||
      !['operationId','hostId','agentSessionId','runId','prompt','agentMuxNote'].every(key => typeof p[key] === 'string' && (p[key] as string).trim() && !/[\0\r]/u.test(p[key] as string)) ||
      p.mode !== 'grill' && p.mode !== 'grounding' || p.afterSubmissionId !== null && (typeof p.afterSubmissionId !== 'string' || !p.afterSubmissionId.trim()) ||
      p.callerAgentSessionId !== undefined && (typeof p.callerAgentSessionId !== 'string' || !p.callerAgentSessionId.trim())) throw new Error('The original discussion input is invalid.')
  return { ...structuredClone(p) as DemandDiscussionInput, ...optionalDemandInputEpoch(p.inputEpoch) }
}
export function parseDemandDiscussionInputs(value: unknown): DemandDiscussionInput[] {
  if (!Array.isArray(value)) throw new Error('Original discussion inputs require an array.')
  const values = value.map(parseDemandDiscussionInput)
  if (new Set(values.map(item => item.operationId)).size !== values.length) throw new Error('Original discussion inputs have duplicate operations.')
  return values
}
