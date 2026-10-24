import { useEffect, useState } from 'react'
import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { formatSessionAddress } from '@agentmux/core/sharing'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { encodeSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { errorMessage } from './delivery'

const empty: ComposerSuggestion[] = []

/** Only an active completion query needs the peer directory, not ordinary reading. */
export function useMobileAgentReferences(client: AgentMuxHostedClient | null, sessionId: string | null,
  displayName: string | undefined, requested: boolean) {
  const [snapshot, setSnapshot] = useState<{ client: AgentMuxHostedClient; sessionId: string;
    displayName: string | undefined; values: ComposerSuggestion[]; issue: string | null } | null>(null)
  useEffect(() => {
    if (!requested || !client || !sessionId) { setSnapshot(null); return }
    let current = true
    const peers = new Map<string, { runId: string; suggestion: ComposerSuggestion }>()
    let issue: string | null = null
    const reference = (peer: AgentMuxAgentSession) => {
      const id = peer.agentSessionId
      const label = id === sessionId && displayName ? displayName : `${peer.providerId} (${id.slice(0, 6)})`
      return { id: `agent:${id}`, text: `@${label}`, label,
        description: `${peer.hostId} · ${id}`, group: 'Agents', searchText: `${label} ${id} ${peer.providerId}`,
        insertText: encodeSemanticReference({ kind: 'agent', token: `@${label}`, label, reference: formatSessionAddress(id) }) }
    }
    let publicationQueued = false
    const publish = () => {
      if (publicationQueued) return
      publicationQueued = true
      // One bootstrap publishes many peer facts in the same turn. Materialize
      // its complete candidate array once while retaining each identity change.
      queueMicrotask(() => {
        publicationQueued = false
        if (current) setSnapshot({ client, sessionId, displayName, values: [...peers.values()].map(value => value.suggestion), issue })
      })
    }
    const refresh = () => {
      try {
        const next = client.agentSessions().map(peer => [peer.agentSessionId,
          { runId: peer.run.runId, suggestion: reference(peer) }] as const)
        peers.clear()
        for (const [id, peer] of next) peers.set(id, peer)
        issue = null
      } catch (error) { issue = `引用目录暂未完整读取；收起后可重新打开。${errorMessage(error)}` }
    }
    refresh()
    publish()
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = client.onEvent(event => {
        if (!current) return
        if (event.type === 'agent-session') {
          const peer = event.session, previous = peers.get(peer.agentSessionId), next = reference(peer)
          peers.set(peer.agentSessionId, { runId: peer.run.runId, suggestion: next })
          // Status and history changes do not change a reference's original identity.
          if (!previous || previous.suggestion.insertText !== next.insertText || previous.suggestion.description !== next.description ||
            previous.suggestion.searchText !== next.searchText) publish()
        } else if (event.type === 'run-removed' && event.agentSessionId && peers.get(event.agentSessionId)?.runId === event.run.runId) {
          peers.delete(event.agentSessionId); publish()
        } else if (event.type === 'connection-state' && event.state === 'restored') {
          // The SDK has accepted the new bootstrap before publishing restoration.
          // A lost observation alone cannot retire retained references.
          refresh(); publish()
        }
      })
    } catch (error) {
      issue = `引用目录变化暂未接回；收起后可重新打开。${errorMessage(error)}`; publish()
    }
    return () => { current = false; unsubscribe?.() }
  }, [client, sessionId, displayName, requested])
  const matches = requested && snapshot?.client === client && snapshot.sessionId === sessionId && snapshot.displayName === displayName
  return { references: matches ? snapshot.values : empty, issue: matches ? snapshot.issue : null }
}
