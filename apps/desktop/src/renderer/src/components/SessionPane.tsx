import { AlertTriangle, LoaderCircle, RadioTower, RefreshCw, ServerOff, Square } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store'
import {
  abbreviatedSessionId,
  latestSessionActivityAt,
  recentSessionMessage
} from '../lib/session-metadata'
import { ConversationView } from './ConversationView'
import { ConfirmationDialog } from './ConfirmationDialog'
import { RichComposer } from './RichComposer'
import { TerminalView } from './TerminalView'

const NO_ACTIVITIES: never[] = []

function formatSessionTime(timestamp: number): string {
  const value = new Date(timestamp)
  const today = new Date()
  const sameDay = value.getFullYear() === today.getFullYear()
    && value.getMonth() === today.getMonth()
    && value.getDate() === today.getDate()
  return sameDay
    ? value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : value.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SessionPane({ sessionId }: { sessionId: string }) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const activities = useAppStore((state) => state.activities[sessionId] ?? NO_ACTIVITIES)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const viewMode = useAppStore((state) => state.viewModes[sessionId] ?? 'terminal')
  const refreshSession = useAppStore((state) => state.refreshSession)
  const stopSession = useAppStore((state) => state.stopSession)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [stopping, setStopping] = useState(false)

  if (!session || !terminalThemeId) {
    return (
      <div className="pane-state pane-state--error">
        <AlertTriangle size={20} />
        <strong>Session is no longer available</strong>
        <span>Waiting for the Core client to publish this Runtime View.</span>
      </div>
    )
  }

  const disconnected = session.status.state === 'disconnected'
  const missing = session.processState === 'interrupted' && session.status.state === 'error'
  const exited = session.processState === 'exited'
  const lastActivityAt = latestSessionActivityAt(session, activities)
  const recentMessage = session.kind === 'agent'
    ? recentSessionMessage(activities) ?? 'No messages yet'
    : `${session.latestOutputBytes.toLocaleString()} output bytes`

  async function refresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    await refreshSession(sessionId)
    setRefreshing(false)
  }

  async function stop(): Promise<void> {
    if (stopping) return
    setStopping(true)
    try {
      await stopSession(sessionId)
    } finally {
      setStopping(false)
      setConfirmingStop(false)
    }
  }

  return (
    <section className="agent-surface">
      <header className="session-info-bar">
        <div className="session-info-bar__identity">
          <strong title={session.label}>{session.label}</strong>
          <code title={`Session ID · ${session.id}`}>ID {abbreviatedSessionId(session.id)}</code>
        </div>
        <span className="session-info-bar__time session-info-bar__time--started">
          <i>Started</i>
          <time dateTime={new Date(session.createdAt).toISOString()} title={new Date(session.createdAt).toLocaleString()}>{formatSessionTime(session.createdAt)}</time>
        </span>
        <span className="session-info-bar__time">
          <i>Active</i>
          <time dateTime={new Date(lastActivityAt).toISOString()} title={new Date(lastActivityAt).toLocaleString()}>{formatSessionTime(lastActivityAt)}</time>
        </span>
        <span className="session-info-bar__recent" title={recentMessage}>
          <i>{session.kind === 'agent' ? 'Recent' : 'Output'}</i>
          <span>{recentMessage}</span>
        </span>
        <div className="session-info-bar__actions">
          {session.hostId !== 'local' ? <span title={`Host · ${session.hostId}`}><RadioTower size={11} />{session.hostId}</span> : null}
          {session.processState !== 'exited' ? (
            <button type="button" className="small-button session-info-bar__stop" onClick={() => setConfirmingStop(true)}>
              <Square size={11} /> Stop Run
            </button>
          ) : null}
        </div>
      </header>
      <div className="agent-body">
        {session.kind === 'terminal' || viewMode === 'terminal' ? (
          <div className="agent-terminal-stage">
            <TerminalView session={session} themeId={terminalThemeId} />
            {disconnected || missing || exited ? (
              <div className={`terminal-recovery terminal-recovery--${disconnected ? 'disconnected' : exited ? 'exited' : 'error'}`} role="status" aria-live="polite">
                <span className="terminal-recovery__icon">
                  {refreshing ? <LoaderCircle className="spin" size={16} /> : disconnected ? <ServerOff size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div>
                  <strong>{disconnected ? 'Remote terminal disconnected' : exited ? `${session.kind === 'agent' ? 'Agent' : 'Terminal'} process exited` : 'Terminal session unavailable'}</strong>
                  <span>{session.status.detail ?? (exited ? 'The Run process is no longer running.' : 'Check the host and try again.')}</span>
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
      {session.kind === 'agent' && viewMode === 'conversation' ? <RichComposer sessionId={session.id} /> : null}
      <ConfirmationDialog
        open={confirmingStop}
        title={`Stop this ${session.kind === 'agent' ? 'agent' : 'terminal'} Run?`}
        description="This stops the underlying Run for every open View. Closing a Tab only closes that View."
        subject={session.label}
        confirmLabel="Stop Run"
        busy={stopping}
        onCancel={() => !stopping && setConfirmingStop(false)}
        onConfirm={() => void stop()}
      />
    </section>
  )
}
