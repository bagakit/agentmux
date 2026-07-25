import { ArrowUpRight, Check, ChevronRight, Globe2, LoaderCircle, Play, RadioTower, RefreshCw, Sparkles, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DESKTOP_ACTIONS } from '../../../shared/desktop-actions'
import { executorDetectionKey, useAppStore, warmTerminalKey } from '../store'
import { configuredExecutors } from '../lib/executors'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { TerminalView } from './TerminalView'

export function NewTabSurface({
  tabGroupId,
  tabId,
  regionId
}: {
  tabGroupId: string
  tabId?: string
  regionId?: string
}) {
  const [executorId, setExecutorId] = useState('codex')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<'agent' | 'terminal' | 'browser' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUnavailable, setShowUnavailable] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const tabWorkspaceId = useAppStore((state) => tabId ? state.tabs[tabId]?.workspaceId : undefined)
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const promoteWarmTerminal = useAppStore((state) => state.promoteWarmTerminal)
  const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)
  const warmTerminal = useAppStore((state) => state.warmTerminal)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const workspace = config?.workspaces.find((item) => item.id === (tabWorkspaceId ?? activeWorkspaceId))
  const hostLabel = workspace ? (config?.hosts.find((host) => host.id === workspace.hostId)?.label ?? workspace.hostId) : 'No host'
  const hostCheck = useAppStore((state) => workspace ? state.hostChecks[workspace.hostId] : undefined)
  // Only show a warm shell created for this exact host and working directory.
  // It remains outside the ordinary Session list until the user claims it.
  const warmKey = workspace ? warmTerminalKey(workspace.hostId, workspace.path) : null
  const warmSession = warmTerminal && warmTerminal.key === warmKey ? warmTerminal.session : null
  const warmPending = Boolean(warmTerminal && warmTerminal.key === warmKey && !warmTerminal.session)
  const executors = useMemo(
    () => configuredExecutors(config).map((executor) => ({
      ...executor,
      detection: workspace ? detections[executorDetectionKey(workspace.hostId, executor.id)] : undefined
    })),
    [config?.executors, detections, workspace]
  )
  const installedExecutors = executors.filter((executor) => executor.detection?.state === 'ready')
  const unavailableExecutors = executors.filter((executor) => executor.detection?.state !== 'ready')
  const detecting = executors.some((executor) => executor.detection?.state === 'checking')

  useEffect(() => {
    promptRef.current?.focus()
  }, [])

  useEffect(() => {
    // The create page owns the prewarm trigger. Promoting the shell does not create
    // another hidden terminal; a future create page will warm its own shell on mount.
    if (workspace) prewarmTerminal(workspace.id)
  }, [prewarmTerminal, workspace?.id])

  useEffect(() => {
    if (!workspace || executors.every((executor) => executor.detection)) return
    void detectExecutors(workspace.hostId)
  }, [executors, detectExecutors, workspace])

  useEffect(() => {
    if (installedExecutors.some((executor) => executor.id === executorId)) return
    const first = installedExecutors[0]
    if (first) setExecutorId(first.id)
  }, [executorId, installedExecutors])

  async function run<T>(kind: 'agent' | 'terminal' | 'browser', action: () => Promise<T>): Promise<void> {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="launch-surface">
      <div className="launch-surface__heading">
        <span className="launch-surface__icon" aria-hidden="true"><Sparkles size={20} /></span>
        <div className="launch-surface__heading-content">
          <div className="eyebrow">New session</div>
          <h2>Start in {workspace?.name ?? 'this workspace'}</h2>
          <p>Pick an Agent and describe the outcome — or open a terminal or browser instead.</p>
        </div>
        <button
          type="button"
          className="icon-button launch-surface__refresh"
          title="Refresh agents on this host"
          disabled={!workspace || detecting}
          onClick={() => workspace && void detectExecutors(workspace.hostId)}
        >
          {detecting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="agent-catalog" aria-label="Agent executors">
        <div className="agent-catalog__group">
          <div className="agent-catalog__label">
            <span><i className="agent-catalog__ready-dot" />Available Agents</span>
            <div className="agent-catalog__label-actions">
              <em>{installedExecutors.length}</em>
              {unavailableExecutors.length > 0 ? (
                <button
                  type="button"
                  className={`agent-catalog__more-btn ${showUnavailable ? 'agent-catalog__more-btn--active' : ''}`}
                  title={showUnavailable ? 'Hide unavailable agents' : `View ${unavailableExecutors.length} more uninstalled agents`}
                  onClick={() => setShowUnavailable((prev) => !prev)}
                >
                  <ChevronRight size={12} className={showUnavailable ? 'icon-rotate-90' : ''} />
                  <span>{showUnavailable ? 'Less' : `+${unavailableExecutors.length} more`}</span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="agent-picks">
            {installedExecutors.map((executor) => (
              <button
                type="button"
                key={executor.id}
                aria-pressed={executor.id === executorId}
                className={`agent-pick ${executor.id === executorId ? 'agent-pick--selected' : ''}`}
                onClick={() => setExecutorId(executor.id)}
              >
                <span className="agent-pick__icon"><AgentProviderIcon providerId={executor.providerId} size={16} /></span>
                <span className="agent-pick__copy"><strong>{executor.label}</strong><small>{agentProviderLabel(executor.providerId)} · Ready</small></span>
                {executor.id === executorId ? <span className="agent-pick__check"><Check size={10} strokeWidth={3} /></span> : null}
              </button>
            ))}
            {installedExecutors.length === 0 ? (
              detecting ? (
                <div className="agent-catalog__empty">Checking providers…</div>
              ) : (
                <div className="agent-catalog__empty agent-catalog__empty--action">
                  <strong>No agent providers found on {hostLabel}</strong>
                  <small>Install a supported CLI (codex, claude, …) on this host, then re-check.</small>
                  <button
                    type="button"
                    className="small-button"
                    disabled={!workspace || detecting}
                    onClick={() => workspace && void detectExecutors(workspace.hostId)}
                  >
                    <RefreshCw size={12} /> Re-check host
                  </button>
                </div>
              )
            ) : null}
          </div>
        </div>

        {showUnavailable && unavailableExecutors.length > 0 ? (
          <div className="agent-catalog__group agent-catalog__group--unavailable animate-fade-in">
            <div className="agent-catalog__label">
              <span>Not installed on {workspace?.hostId ?? 'this host'}</span>
              <em>{unavailableExecutors.length}</em>
            </div>
            <div className="agent-picks">
              {unavailableExecutors.map((executor) => (
                <button type="button" key={executor.id} className="agent-pick agent-pick--unavailable" disabled>
                  <span className="agent-pick__icon"><AgentProviderIcon providerId={executor.providerId} size={16} /></span>
                  <span className="agent-pick__copy"><strong>{executor.label}</strong><small>{agentProviderLabel(executor.providerId)} · Unavailable</small></span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <textarea
        ref={promptRef}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the outcome. You can steer the agent after launch."
        rows={4}
      />

      <div className="launch-surface__footer">
        <span>
          {workspace?.hostId !== 'local' ? <RadioTower size={13} /> : null}
          {hostLabel}
          {hostCheck ? <em className={`launch-host-health launch-host-health--${hostCheck.state}`}>{hostCheck.state === 'ready' ? 'Ready' : hostCheck.state === 'checking' ? 'Checking' : 'Needs attention'}</em> : null}
        </span>
        <button
          className="primary-button"
          disabled={!workspace || busy !== null || installedExecutors.length === 0}
          onClick={() => void run('agent', () => launchAgent(
            executorId,
            prompt,
            tabGroupId,
            tabId && regionId ? { tabId, regionId } : undefined
          ))}
        >
          {busy === 'agent' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} {busy === 'agent' ? 'Launching…' : 'Launch agent'}
        </button>
      </div>
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}

      <div className="launch-surface__alt">
        <div className="agent-catalog__label">
          <span>Quick Surfaces</span>
        </div>

        {workspace && warmSession && terminalThemeId ? (
          <div className="launch-surfaces-stack">
            <div className="launch-terminal">
              <div className="launch-terminal__head">
                <span className="launch-terminal__hint">
                  <SquareTerminal size={13} className="launch-terminal__icon" />
                  Terminal · Ready for quick commands
                </span>
                <button
                  type="button"
                  className="small-button launch-terminal__claim"
                  aria-label="Open reusable Terminal in tab"
                  data-agentmux-action={DESKTOP_ACTIONS.claimReusableTerminal}
                  data-agentmux-session-id={warmSession.id}
                  disabled={busy !== null}
                  onClick={() => void run('terminal', () => promoteWarmTerminal(
                    tabGroupId,
                    tabId && regionId ? { tabId, regionId } : undefined
                  ))}
                >
                  {busy === 'terminal' ? <LoaderCircle className="spin" size={12} /> : <ArrowUpRight size={12} />}
                  {busy === 'terminal' ? 'Opening…' : 'Open in tab'}
                </button>
              </div>
              <div className="launch-terminal__body">
                <TerminalView
                  session={warmSession}
                  themeId={terminalThemeId}
                  interactiveResize={false}
                  autoFocus={false}
                  linkOrigin={{ workspaceId: workspace.id, tabGroupId }}
                />
              </div>
            </div>

            <div className="launch-surface-quick-grid">
              <button
                type="button"
                className="agent-pick agent-pick--action launch-quick-card"
                aria-label="Open Browser"
                data-agentmux-action={DESKTOP_ACTIONS.openBrowser}
                disabled={!workspace || busy !== null}
                onClick={() => void run('browser', () => createBrowser(
                  tabGroupId,
                  tabId && regionId ? { tabId, regionId } : undefined
                ))}
              >
                <span className="agent-pick__icon"><Globe2 size={16} /></span>
                <span className="agent-pick__copy"><strong>Browser</strong><small>Main-owned embedded WebContents</small></span>
                <span className="agent-pick__go">{busy === 'browser' ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="launch-surface-quick-grid">
            <button
              type="button"
              className="agent-pick agent-pick--action launch-quick-card launch-terminal__fallback"
              aria-label="Open Terminal"
              data-agentmux-action={DESKTOP_ACTIONS.claimReusableTerminal}
              disabled={!workspace || busy !== null}
              onClick={() => void run('terminal', () => promoteWarmTerminal(
                tabGroupId,
                tabId && regionId ? { tabId, regionId } : undefined
              ))}
            >
              <span className="agent-pick__icon">{warmPending ? <LoaderCircle className="spin" size={16} /> : <SquareTerminal size={16} />}</span>
              <span className="agent-pick__copy"><strong>Terminal</strong><small>{warmPending ? 'Warming a reusable host shell…' : 'Host shell in a recoverable core session'}</small></span>
              <span className="agent-pick__go">{busy === 'terminal' ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}</span>
            </button>

            <button
              type="button"
              className="agent-pick agent-pick--action launch-quick-card"
              aria-label="Open Browser"
              data-agentmux-action={DESKTOP_ACTIONS.openBrowser}
              disabled={!workspace || busy !== null}
              onClick={() => void run('browser', () => createBrowser(
                tabGroupId,
                tabId && regionId ? { tabId, regionId } : undefined
              ))}
            >
              <span className="agent-pick__icon"><Globe2 size={16} /></span>
              <span className="agent-pick__copy"><strong>Browser</strong><small>Main-owned embedded WebContents</small></span>
              <span className="agent-pick__go">{busy === 'browser' ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}</span>
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
