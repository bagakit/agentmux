import { getAmuxProtocolTemplate, renderAmuxProtocol } from './amux-protocol.js'
import { formatAmuxSourceReference } from './amux-protocol-definition.js'
import type { AgentNativeResumeSource } from './types.js'

/** Original source facts only. Location and permission remain with the business owners. */
export type AgentTakeoverContextSource = {
  hostId: string | undefined
  agentSessionId?: string | undefined
  executorId: string | undefined
  nativeSource?: AgentNativeResumeSource | undefined
  diagnostic?: string | undefined
}

export function agentSourceContextNote(source: AgentTakeoverContextSource, contextHostId: string | null, page?: unknown): string {
  if (contextHostId === null) {
    const note = renderAmuxProtocol('agent-source', 'unrouted', {
      host: source.hostId ?? 'Unconfirmed',
      source: source.agentSessionId ?? source.nativeSource?.nativeHandle.sessionId ?? 'Unconfirmed',
      diagnostic: source.diagnostic ?? ''
    }).trimEnd()
    return page === undefined ? note : note + '\n\n' + renderAmuxProtocol('agent-source', 'history', { page: JSON.stringify(page) })
  }
  const native = source.nativeSource
  const nativeReference = native && renderAmuxProtocol('agent-source', 'native', {
    host: contextHostId, executor: source.executorId ?? 'Unconfirmed',
    provider: native.nativeHandle.providerId, session: native.nativeHandle.sessionId, directory: native.workspacePath,
    locator: renderAmuxProtocol('agent-source', 'native-locator', {
      revision: native.revision, transcript: native.nativeHandle.transcriptPath ?? 'Unavailable'
    })
  })
  if (!source.agentSessionId && nativeReference) return formatAmuxSourceReference('native-context', nativeReference)
  const session = renderAmuxProtocol('agent-source', 'session', { host: contextHostId, session: source.agentSessionId ?? 'Unconfirmed' })
  return formatAmuxSourceReference('agent-context', nativeReference ? session + '\n\n' + renderAmuxProtocol('agent-source', 'separate-native', {
    entry: 'agent native history --help', source: nativeReference
  }) : session)
}

export function agentTakeoverInput(source: AgentTakeoverContextSource, contextHostId: string | null = 'local', page?: unknown) {
  return {
    prompt: getAmuxProtocolTemplate('agent-source', 'takeover'),
    agentMuxNote: agentSourceContextNote(source, contextHostId, page)
  }
}
