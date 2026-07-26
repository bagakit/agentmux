import { AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, ServerOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { AgentSessionComposer } from './AgentSessionComposer'
import { AgentInteractionCard } from './AgentInteractionCard'
import { ActivityView } from './ActivityView'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { TerminalView } from './TerminalView'
import { agentSessionServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'

const NO_TIMELINE_ITEMS: never[] = []

const INTERRUPTION_REASON_COPY: Record<string, string> = {
  daemon_restart: 'The terminal backend restarted, so this session’s process was lost. Open a new session to continue here.',
  tmux_server_unavailable: 'The terminal backend became unavailable and this session’s process was lost. Open a new session to continue here.',
  tmux_target_changed: 'The underlying terminal target changed, so this session could no longer be tracked. Open a new session to continue here.',
  tmux_protocol_error: 'The terminal backend hit a protocol error and this session’s process was lost. Open a new session to continue here.'
}

function humanizeDetail(
  interruptionReason: string | undefined,
  detail: string | undefined,
  exited: boolean
): string {
  if (interruptionReason && INTERRUPTION_REASON_COPY[interruptionReason]) {
    return INTERRUPTION_REASON_COPY[interruptionReason]
  }
  if (!detail) return exited ? 'The process is no longer running.' : 'Check the host and try again.'
  return detail
}

export function SessionPane({
  sessionId,
  surfaceKind,
  interactiveResize,
  visible,
  linkOrigin
}: {
  sessionId: string
  surfaceKind: 'agent' | 'terminal'
  interactiveResize: boolean
  // 这一格看不看得见。隐藏的 Tab 留在 DOM 里保住终端实例，但里面的终端一律停工。
  visible: boolean
  linkOrigin: OpenHttpLinkOrigin
}) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const timeline = useAppStore((state) => state.timelines[sessionId]?.items ?? NO_TIMELINE_ITEMS)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const viewMode = useAppStore((state) => state.viewModes[sessionId] ?? 'terminal')
  const refreshSession = useAppStore((state) => state.refreshSession)
  const recoverSession = useAppStore((state) => state.recoverSession)
  const respondInteraction = useAppStore((state) => state.respondInteraction)
  const [refreshing, setRefreshing] = useState(false)
  const [recovering, setRecovering] = useState(false)
  // daemon_restart auto-recovery fires at most once per dead session id, so a flapping
  // daemon can't spin us into a relaunch loop. Keyed by the session id we last recovered from.
  const autoRecoveredRef = useRef<string | null>(null)

  const disconnected = session?.status.state === 'disconnected'
  const missing = session?.processState === 'interrupted' && session?.status.state === 'error'
  const exited = session?.processState === 'exited'
  const interruptionReason = session?.interruptionReason
  const continuity = session?.status.continuity

  async function recover(): Promise<void> {
    if (recovering) return
    setRecovering(true)
    await recoverSession(sessionId)
    setRecovering(false)
  }

  // Terminals whose backend restarted (daemon_restart) can never come back by refreshing —
  // the PTY is gone. Auto-relaunch a fresh terminal in the same cwd and rebind the tab,
  // replacing the useless "Check again" with a seamless recovery. One-shot per session id.
  useEffect(() => {
    if (!session || session.kind !== 'terminal') return
    if (!missing || interruptionReason !== 'daemon_restart') return
    if (autoRecoveredRef.current === session.id) return
    autoRecoveredRef.current = session.id
    void recover()
    // recover()/recovering are stable enough; we intentionally key only on the dead-session signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.kind, missing, interruptionReason])

  // A launching Region exists before Core returns its Session snapshot. Keep that handoff
  // neutral; interrupted and exited Sessions use the explicit recovery banners below.
  if (!session || !terminalThemeId) {
    return (
      <section className="agent-surface">
        <div className="pane-state" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={18} />
          <strong>Connecting to this session…</strong>
          <span>Waiting for the Core client to publish this Runtime View.</span>
        </div>
        {surfaceKind === 'agent' ? <AgentSessionComposer sessionId={sessionId} disabled /> : null}
      </section>
    )
  }

  const noun = session.kind === 'agent' ? 'Agent' : 'Terminal'
  const recoveryTitle = continuity === 'conflict'
      ? 'Agent continuity conflict'
      : continuity === 'unavailable'
        ? 'Agent resume unavailable'
        : disconnected
          ? 'Remote terminal disconnected'
          : exited
            ? `${noun} process exited`
            : `${noun} session unavailable`

  async function refresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    await refreshSession(sessionId)
    setRefreshing(false)
  }

  return (
    <section className="agent-surface">
      <div className="agent-body">
        {session.kind === 'terminal' || viewMode === 'terminal' ? (
          <div className="agent-terminal-stage">
            <TerminalView
              session={session}
              themeId={terminalThemeId}
              interactiveResize={interactiveResize}
              visible={visible}
              linkOrigin={linkOrigin}
            />
            {disconnected || missing || exited ? (
              <div className={`terminal-recovery terminal-recovery--${disconnected ? 'disconnected' : exited ? 'exited' : 'error'}`} role="status" aria-live="polite">
                <span className="terminal-recovery__icon">
                  {refreshing || recovering ? <LoaderCircle className="spin" size={16} /> : disconnected ? <ServerOff size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div>
                  <strong>{recoveryTitle}</strong>
                  <span>{humanizeDetail(session.interruptionReason, session.status.detail, exited)}</span>
                </div>
                <div className="terminal-recovery__actions">
                  {session.kind === 'terminal' ? (
                    disconnected ? (
                      <button type="button" className="small-button" disabled={refreshing} onClick={() => void refresh()}>
                        <RefreshCw size={12} /> {refreshing ? 'Checking…' : 'Check again'}
                      </button>
                    ) : (
                      // The PTY is gone for good — relaunch a fresh terminal in the same cwd.
                      <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
                        <RotateCcw size={12} /> {recovering ? 'Restarting…' : 'Restart terminal'}
                      </button>
                    )
                  ) : continuity ? (
                    <button
                      type="button"
                      className="small-button"
                      disabled
                      title={session.status.detail}
                    >
                      <RotateCcw size={12} /> {
                        continuity === 'conflict'
                            ? 'Resolve conflict first'
                            : 'Resume unavailable'
                      }
                    </button>
                  ) : (
                    <button type="button" className="small-button" disabled={recovering} onClick={() => void recover()}>
                      <RotateCcw size={12} /> {recovering ? 'Resuming…' : 'Resume'}
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <ActivityView
            items={timeline}
            capability={session.kind === 'agent' ? session.capabilities.timeline : 'unavailable'}
          />
        )}
      </div>
      {surfaceKind === 'agent' && session.kind === 'agent' ? (
        <div className="agent-input-stack">
          {/* 服务窗（原则 11）：一处我们的流程失败，在阻断用户之前先分清是哪一类。这里的 disconnected
              是样板——终端投影有恢复横幅承载，但 Activity 投影下它此前只剩一个禁用占位，等于静默降级。
              放行 + 明确告知由这条告示补上；判定全在 lib，组件只渲染结果。 */}
          <ServiceWindowNotice
            notice={serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(session)))}
          />
          {session.pendingInteraction ? (
            <AgentInteractionCard
              request={session.pendingInteraction}
              // A pending request outlives the process that asked it, so the card must go inert on the
              // same terms as the composer below it — otherwise a dead Run still shows live buttons and
              // answering it fails on a Run that can no longer accept input.
              disabled={session.processState !== 'running' || session.status.state === 'disconnected'}
              onRespond={async (response) => await respondInteraction(session.id, response)}
            />
          ) : null}
          <AgentSessionComposer sessionId={session.id} />
        </div>
      ) : null}
    </section>
  )
}
