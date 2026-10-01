import type { AgentCatalogEntry } from '@agentmux/core'
import type { AgentSharingMetadata } from '@agentmux/core/sharing'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { sessionPresentationById } from './session-presentation'

/** Resolve display labels from this exact Session's execution identity, without I/O or focus inference. */
export function resolveAgentSharingMetadata(sessionId: string | null, facts: {
  sessions: readonly SessionSnapshot[]
  providerCatalog: readonly AgentCatalogEntry[]
  config: Pick<AppConfig, 'executors'> | null
}): AgentSharingMetadata {
  const session = sessionPresentationById(facts.sessions).get(sessionId ?? '')
  // Missing observation leaves the SID copyable; metadata does not gate an existing identity action.
  if (session?.kind !== 'agent') return {}
  return {
    provider: facts.providerCatalog.find(entry => entry.id === session.providerId)?.label || session.providerId,
    executor: facts.config?.executors[session.executorId]?.label || session.executorId
  }
}
