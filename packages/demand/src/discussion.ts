/** A Goal's immutable business request. Core owns actual spatial and input facts. */
export type DemandDiscussionIntent = {
  requestOperationId: string
  mode: 'open' | 'grill' | 'grounding'
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
  if (Object.keys(p).some(key => !['requestOperationId','mode','executorId','spaceId','zoneId','agentMuxNote','prompt','callerAgentSessionId'].includes(key)) ||
      typeof p.mode !== 'string' || !['open','grill','grounding'].includes(p.mode) ||
      !['requestOperationId','executorId','spaceId','zoneId','agentMuxNote'].every(key => typeof p[key] === 'string' && (p[key] as string).trim() && !(p[key] as string).includes('\0')) ||
      p.prompt !== undefined && (typeof p.prompt !== 'string' || p.prompt.includes('\0')) ||
      p.callerAgentSessionId !== undefined && (typeof p.callerAgentSessionId !== 'string' || !p.callerAgentSessionId.trim() || p.callerAgentSessionId.includes('\0'))) throw new Error('The original Goal discussion intent is invalid.')
  return { requestOperationId: p.requestOperationId as string, mode: p.mode as DemandDiscussionIntent['mode'], executorId: p.executorId as string, spaceId: p.spaceId as string, zoneId: p.zoneId as string, agentMuxNote: p.agentMuxNote as string,
    ...(p.prompt === undefined ? {} : { prompt: p.prompt as string }), ...(p.callerAgentSessionId === undefined ? {} : { callerAgentSessionId: p.callerAgentSessionId as string }) }
}
