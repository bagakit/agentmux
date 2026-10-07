import { isDeepStrictEqual } from 'node:util'
import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { normalizeSessionHistoryPage, sessionHistoryWithoutMetrics } from './session-history.js'
import { parseSessionHistoryResourceOptions, parseProviderSessionHistoryResourceReadResult } from './session-history-resource.js'
import type { AgentNativeResumeSource, AgentProviderSessionHistoryPage, AgentSessionHistoryResourceRequest,
  AgentProviderSessionHistoryResourceReadResult } from './types.js'

export type AgentMuxRpcNativeHistoryParams = {
  hostId: string
  executorId: string
  source: AgentNativeResumeSource
  cursor?: string
  limit?: number
}
export type AgentMuxRpcNativeHistoryResult = AgentProviderSessionHistoryPage & {
  hostId: string
  executorId: string
  nativeSource: AgentNativeResumeSource
}
export type AgentMuxRpcNativeHistoryResourceParams = AgentSessionHistoryResourceRequest & {
  hostId: string
  executorId: string
  nativeSource: AgentNativeResumeSource
}
export type AgentMuxRpcNativeHistoryResourceResult = AgentProviderSessionHistoryResourceReadResult & {
  hostId: string
  executorId: string
  nativeSource: AgentNativeResumeSource
}

/** A saved Provider conversation is a read target, without a Core Session or Run. */
export function parseNativeHistoryParams(value: unknown): AgentMuxRpcNativeHistoryParams {
  const p = rpcRecord(value, ['hostId', 'executorId', 'source', 'cursor', 'limit'])
  for (const field of ['hostId', 'executorId']) {
    if (typeof p[field] !== 'string' || !p[field] || /[\0\r\n]/u.test(p[field] as string) ||
        Buffer.byteLength(p[field] as string) > 4096) {
      throw new AgentMuxError('Native history requires the exact Host and Executor.', 'INVALID_CONTROL_REQUEST')
    }
  }
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 100) ||
      p.cursor !== undefined && (typeof p.cursor !== 'string' || !p.cursor || p.cursor.length > 16_384)) {
    throw new AgentMuxError('Native history requires a limit from 1 to 100 and an opaque cursor.', 'INVALID_AGENT_SESSION_HISTORY_OPTIONS')
  }
  return { hostId: p.hostId as string, executorId: p.executorId as string, source: parseAgentNativeResumeSource(p.source),
    ...(p.cursor === undefined ? {} : { cursor: p.cursor as string }),
    ...(p.limit === undefined ? {} : { limit: p.limit as number }) }
}

/** Preserve the exact resource identity and the existing Provider history page contract. */
export function parseNativeHistoryResult(value: unknown, input: AgentMuxRpcNativeHistoryParams): AgentMuxRpcNativeHistoryResult {
  try {
    const p = rpcRecord(value, ['hostId', 'executorId', 'nativeSource', 'source', 'items', 'nextCursor', 'sourceSizeBytes'], 'CONTROL_PROTOCOL_ERROR')
    if (p.hostId !== input.hostId || p.executorId !== input.executorId ||
        !isDeepStrictEqual(parseAgentNativeResumeSource(p.nativeSource), input.source)) throw new Error('Native history target changed.')
    const { hostId: _host, executorId: _executor, nativeSource: _native, ...body } = p
    const normalized = normalizeSessionHistoryPage({ providerId: input.source.nativeHandle.providerId,
      nativeSessionId: input.source.nativeHandle.sessionId }, body, input.limit ?? 30)
    if (!isDeepStrictEqual(sessionHistoryWithoutMetrics(normalized), sessionHistoryWithoutMetrics({ ...body, items: body.items as unknown[] }))) {
      throw new Error('Native history page changed during validation.')
    }
    return { ...p, ...normalized } as AgentMuxRpcNativeHistoryResult
  } catch {
    throw new AgentMuxError('Native history result is malformed or belongs to another source.', 'CONTROL_PROTOCOL_ERROR')
  }
}

export function parseNativeHistoryResourceParams(value: unknown): AgentMuxRpcNativeHistoryResourceParams {
  const p = rpcRecord(value, ['hostId', 'executorId', 'nativeSource', 'source', 'turnId', 'recordId', 'partIndex', 'expectedReference', 'maxBytes', 'offsetBytes'])
  const { hostId, executorId, nativeSource, ...resource } = p
  const route = parseNativeHistoryParams({ hostId, executorId, source: nativeSource })
  const request = parseSessionHistoryResourceOptions(resource)
  if (request.source.providerId !== route.source.nativeHandle.providerId ||
      request.source.nativeSessionId !== route.source.nativeHandle.sessionId) {
    throw new AgentMuxError('The resource belongs to another native conversation.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }
  return { hostId: route.hostId, executorId: route.executorId, nativeSource: route.source, ...request }
}

export function parseNativeHistoryResourceResult(value: unknown,
  input: AgentMuxRpcNativeHistoryResourceParams): AgentMuxRpcNativeHistoryResourceResult {
  try {
    const p = rpcRecord(value, ['hostId', 'executorId', 'nativeSource', 'source', 'turnId', 'recordId', 'partIndex', 'reference', 'label', 'result'], 'CONTROL_PROTOCOL_ERROR')
    if (p.hostId !== input.hostId || p.executorId !== input.executorId ||
        !isDeepStrictEqual(parseAgentNativeResumeSource(p.nativeSource), input.nativeSource)) throw new Error('Native resource target changed.')
    const { hostId: _host, executorId: _executor, nativeSource: _native, ...resource } = p
    parseProviderSessionHistoryResourceReadResult(resource, input)
    return p as AgentMuxRpcNativeHistoryResourceResult
  } catch {
    throw new AgentMuxError('Native resource result is malformed or belongs to another source.', 'CONTROL_PROTOCOL_ERROR')
  }
}
