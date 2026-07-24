import { MessagesSquare, SquareTerminal, X } from 'lucide-react'
import { useAppStore } from '../store'
import { ConversationView } from './ConversationView'
import { LaunchAgent } from './LaunchAgent'
import { RichComposer } from './RichComposer'
import { StatusDot } from './StatusDot'
import { TerminalView } from './TerminalView'

const NO_ACTIVITIES: never[] = []

export function AgentSession() {
  const sessions = useAppStore((state) => state.sessions)
  const sessionId = useAppStore((state) => state.activeSessionId)
  const activities = useAppStore((state) => (sessionId ? state.activities[sessionId] ?? NO_ACTIVITIES : NO_ACTIVITIES))
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const stopSession = useAppStore((state) => state.stopSession)
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) return <div className="agent-surface agent-surface--empty"><LaunchAgent /></div>
  return (
    <section className="agent-surface">
      <header className="agent-header">
        <div className="agent-header__title">
          <StatusDot status={session.status} withLabel />
          <div><strong>{session.label}</strong><span>{session.agentId} · {session.hostId} · {session.paneCommand ?? 'tmux'}</span></div>
        </div>
        <div className="agent-header__actions">
          <div className="segmented">
            <button className={viewMode === 'terminal' ? 'selected' : ''} onClick={() => setViewMode('terminal')}>
              <SquareTerminal size={13} /> Terminal
            </button>
            <button className={viewMode === 'conversation' ? 'selected' : ''} onClick={() => setViewMode('conversation')}>
              <MessagesSquare size={13} /> Activity
            </button>
          </div>
          <button className="icon-button icon-button--danger" onClick={() => void stopSession()} title="Close session"><X size={15} /></button>
        </div>
      </header>
      <div className="agent-body">
        {viewMode === 'terminal' ? (
          <TerminalView sessionId={session.id} snapshot={session.terminalSnapshot} />
        ) : (
          <ConversationView activities={activities} />
        )}
      </div>
      <RichComposer />
    </section>
  )
}
