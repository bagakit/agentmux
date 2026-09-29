import '../terminal-service-notice-escape/entry'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FullPageLoadingSurface, type FullPageLoadingPhase } from '../../../src/renderer/src/components/FullPageLoadingSurface'
import { SessionConnectingSurface } from '../../../src/renderer/src/components/SessionConnectingSurface'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'

// Actual production presentation; only the preview API and caller-supplied loading facts are controlled.
const element = document.createElement('div')
element.id = 'loading-root'
element.hidden = true
document.body.append(element)
const root = createRoot(element)
const original = (window as any).resultReady
Object.assign(window, { terminalChrome: {
  show(phase: FullPageLoadingPhase | 'connecting', scope: 'app' | 'region', theme = 'dark') {
    const terminalRecovery = phase === 'recovering' && scope === 'region'
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    document.documentElement.dataset.appearance = theme
    document.getElementById('root')!.style.display = 'none'
    element.hidden = false
    flushSync(() => root.render(phase === 'connecting' ? <SessionConnectingSurface phase="restore" surfaceKind="agent"
      request={{ executorId: 'private-executor', prompt: 'Keep the complete original prompt readable.\nRestore the same saved work surface.' }} /> :
      <FullPageLoadingSurface phase={phase} scope={scope} eyebrow={terminalRecovery ? 'Terminal recovery' : phase === 'parked' ? 'Session retained' : 'AgentMux'}
        title={terminalRecovery ? 'Restoring terminal' : phase === 'parked' ? 'Ready to restore' : phase === 'failed' ? 'Connection needs attention' : phase === 'recovering' ? 'Restoring your workspace' : 'Starting AgentMux'}
        detail={terminalRecovery ? 'Replaying retained output and confirming the viewport before live bytes return.' : phase === 'parked' ? 'Existing history and your draft are kept. Send your next request or use Resume.' : phase === 'failed'
          ? 'The connection could not be confirmed. Your sessions, layout and unsent drafts are retained. Check the service and try reconnecting when it is available.'
          : 'Reconnecting to your saved sessions. Your layout stays in place.'}
        details={terminalRecovery ? { summary: 'Recovery details', content: <dl>
          <dt>Session</dt><dd>{session.label}</dd>
          <dt>Run</dt><dd>{session.control.run.runId}</dd>
          <dt>Process</dt><dd>{session.processState}</dd>
        </dl> } : undefined}
        actions={phase === 'failed' ? <button className="small-button" onClick={() => { (window as any).recoveryClicks = ((window as any).recoveryClicks ?? 0) + 1 }}>Retry connection</button> : null} />))
  },
  identity() {
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    return { label: session.label, runId: session.control.run.runId }
  },
  workbench() { element.hidden = true; document.getElementById('root')!.style.display = 'flex'; document.documentElement.dataset.appearance = 'dark' },
  async alternate() {
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    await api.sessions.write(session.control, '\x1b[?1049h\x1b[HLive full-screen application\r\nagent > ')
  },
  park() {
    flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === original.sessionId ? { ...s, processState: 'exited' as const } : s) })))
  }
} })
