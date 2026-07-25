import { AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, ServerOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { OpenHttpLinkOrigin } from '../lib/open-destination'
import { AgentSessionComposer } from './AgentSessionComposer'
import { ActivityView } from './ActivityView'
import { TerminalView } from './TerminalView'

const NO_TIMELINE_ITEMS: never[] = []

// 内核的中断原因是机读 token（ctxmux-run-adapter 的已知集合）。刷新路径会把它原样
// 塞进 status.detail，导致 banner 直接显示字面 "daemon_restart"。这里在渲染层兜底翻译成
// 人类可读句子；未知值原样透传（不误改用户主动中断等其它文案）。真正的原因分支未来应下沉到
// session-state.ts（当前为他人未提交热区，暂不改）。
const INTERRUPTION_REASON_COPY: Record<string, string> = {
  daemon_restart: 'The terminal backend restarted, so this session’s process was lost. Open a new session to continue here.',
  tmux_server_unavailable: 'The terminal backend became unavailable and this session’s process was lost. Open a new session to continue here.',
  tmux_target_changed: 'The underlying terminal target changed, so this session could no longer be tracked. Open a new session to continue here.',
  tmux_protocol_error: 'The terminal backend hit a protocol error and this session’s process was lost. Open a new session to continue here.'
}

function humanizeDetail(detail: string | undefined, exited: boolean): string {
  if (!detail) return exited ? 'The process is no longer running.' : 'Check the host and try again.'
  return INTERRUPTION_REASON_COPY[detail] ?? detail
}

export function SessionPane({
  sessionId,
  surfaceKind,
  interactiveResize,
  linkOrigin
}: {
  sessionId: string
  surfaceKind: 'agent' | 'terminal'
  interactiveResize: boolean
  linkOrigin: OpenHttpLinkOrigin
}) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId))
  const timeline = useAppStore((state) => state.timelines[sessionId]?.items ?? NO_TIMELINE_ITEMS)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const viewMode = useAppStore((state) => state.viewModes[sessionId] ?? 'terminal')
  const refreshSession = useAppStore((state) => state.refreshSession)
  const recoverSession = useAppStore((state) => state.recoverSession)
  const [refreshing, setRefreshing] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // daemon_restart auto-recovery fires at most once per dead session id, so a flapping
  // daemon can't spin us into a relaunch loop. Keyed by the session id we last recovered from.
  const autoRecoveredRef = useRef<string | null>(null)

  const disconnected = session?.status.state === 'disconnected'
  const missing = session?.processState === 'interrupted' && session?.status.state === 'error'
  const exited = session?.processState === 'exited'
  const reason = session?.status.detail
  const continuity = session?.status.continuity

  // 当会话状态恢复为正常运行或切换 session 时重置 dismissed 状态
  useEffect(() => {
    setDismissed(false)
  }, [sessionId, session?.processState, session?.status.state])

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
    if (!missing || reason !== 'daemon_restart') return
    if (autoRecoveredRef.current === session.id) return
    autoRecoveredRef.current = session.id
    void recover()
    // recover()/recovering are stable enough; we intentionally key only on the dead-session signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.kind, missing, reason])

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
              linkOrigin={linkOrigin}
            />
            {(disconnected || missing || exited) && !dismissed ? (
              <div className={`terminal-recovery terminal-recovery--${disconnected ? 'disconnected' : exited ? 'exited' : 'error'}`} role="status" aria-live="polite">
                <span className="terminal-recovery__icon">
                  {refreshing || recovering ? <LoaderCircle className="spin" size={16} /> : disconnected ? <ServerOff size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div>
                  <strong>{recoveryTitle}</strong>
                  <span>{humanizeDetail(session.status.detail, exited)}</span>
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
                  <button
                    type="button"
                    className="terminal-recovery__dismiss"
                    onClick={() => setDismissed(true)}
                    title="Dismiss overlay to inspect terminal output"
                    aria-label="Dismiss recovery banner"
                  >
                    <X size={14} />
                  </button>
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
        <AgentSessionComposer sessionId={session.id} />
      ) : null}
    </section>
  )
}
