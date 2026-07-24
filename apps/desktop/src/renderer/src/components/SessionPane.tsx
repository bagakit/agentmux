import { AlertTriangle, LoaderCircle, RadioTower, RefreshCw, ServerOff, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store'
import { ConversationView } from './ConversationView'
import { RichComposer } from './RichComposer'
import { StatusDot } from './StatusDot'
import { TerminalView } from './TerminalView'

const NO_ACTIVITIES: never[] = []

export function SessionPane({ sessionId }: { sessionId: string }) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const activities = useAppStore((state) => state.activities[sessionId] ?? NO_ACTIVITIES)
  const viewMode = useAppStore((state) => state.viewModes[sessionId] ?? 'terminal')
  const refreshSession = useAppStore((state) => state.refreshSession)
  const [refreshing, setRefreshing] = useState(false)

  if (!session) {
    return (
      <div className="pane-state pane-state--error">
        <AlertTriangle size={20} />
        <strong>Session is no longer available</strong>
        <span>Waiting for the Core client to publish this daemon session.</span>
      </div>
    )
  }

  const disconnected = session.status.state === 'disconnected'
  const missing = session.processState === 'lost' && session.status.state === 'error'
  const exited = session.processState === 'exited'

  async function refresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    await refreshSession(sessionId)
    setRefreshing(false)
  }

  return (
    <section className="agent-surface">
      <header className="agent-context-bar">
        <div className="agent-context-bar__identity">
          <StatusDot status={session.status} withLabel />
          <span className="agent-provider-mark">
            {session.kind === 'agent' ? session.agentId.slice(0, 1).toUpperCase() : <SquareTerminal size={11} />}
          </span>
          <strong>{session.kind === 'agent' ? session.agentId : 'Terminal'}</strong>
          <span>{session.processState}</span>
        </div>
        <div className="agent-context-bar__host">
          {session.hostId !== 'local' ? <RadioTower size={11} /> : null}
          <span>{session.hostId}</span>
          {session.status.detail ? <span>· {session.status.detail}</span> : null}
        </div>
      </header>
      <div className="agent-body">
        {session.kind === 'terminal' || viewMode === 'terminal' ? (
          <div className="agent-terminal-stage">
            <TerminalView session={session} />
            {disconnected || missing || exited ? (
              <div className={`terminal-recovery terminal-recovery--${disconnected ? 'disconnected' : exited ? 'exited' : 'error'}`} role="status" aria-live="polite">
                <span className="terminal-recovery__icon">
                  {refreshing ? <LoaderCircle className="spin" size={16} /> : disconnected ? <ServerOff size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div>
                  <strong>{disconnected ? 'Remote terminal disconnected' : exited ? `${session.kind === 'agent' ? 'Agent' : 'Terminal'} process exited` : 'Terminal session unavailable'}</strong>
                  <span>{session.status.detail ?? (exited ? 'The daemon process is no longer running.' : 'Check the host and try again.')}</span>
                </div>
                {!exited ? (
                  <button type="button" className="small-button" disabled={refreshing} onClick={() => void refresh()}>
                    <RefreshCw size={12} /> {refreshing ? 'Checking…' : 'Retry'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <ConversationView activities={activities} />
        )}
      </div>
      {session.kind === 'agent' ? <RichComposer sessionId={session.id} /> : null}
    </section>
  )
}
