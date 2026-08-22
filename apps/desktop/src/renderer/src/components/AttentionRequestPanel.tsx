import { ArrowUpRight, X } from 'lucide-react'
import type { AgentMuxInteractionResponse } from '@agentmux/core'
import { useAppStore } from '../store'
import { AgentInteractionCard } from './AgentInteractionCard'

export function AttentionRequestPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const selectSession = useAppStore((state) => state.selectSession)
  const respondInteraction = useAppStore((state) => state.respondInteraction)
  if (!session || session.kind !== 'agent') return null
  const request = session.pendingInteraction
  return (
    <aside className="attention-request-panel" aria-label={`Request from ${session.label}`}>
      <header className="attention-request-panel__header">
        <div><span>Needs you</span><strong>{session.label}</strong><small>{session.workspacePath}</small></div>
        <div className="attention-request-panel__actions">
          <button type="button" className="small-button" onClick={() => selectSession(session.id)}><ArrowUpRight size={12} /> Open Session</button>
          <button type="button" className="icon-button" aria-label="Close request" title="Close request" onClick={onClose}><X size={14} /></button>
        </div>
      </header>
      {request ? (
        <AgentInteractionCard
          request={request}
          disabled={session.processState !== 'running' || session.status.state === 'disconnected'}
          onRespond={async (response: AgentMuxInteractionResponse) => await respondInteraction(session.id, response)}
        />
      ) : (
        <div className="attention-request-panel__empty" role="status">This Session needs attention, but Core has not exposed a typed request. Open the Session to inspect it.</div>
      )}
    </aside>
  )
}
