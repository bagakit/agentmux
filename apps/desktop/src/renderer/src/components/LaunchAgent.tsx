import { ArrowLeft, Check, LoaderCircle, Play, RadioTower, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { agentDetectionKey, useAppStore } from '../store'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'

export function LaunchAgent({
  paneId,
  launcherTabId,
  onBack
}: {
  paneId: string
  launcherTabId?: string
  onBack?: () => void
}) {
  const [agentId, setAgentId] = useState('codex')
  const [prompt, setPrompt] = useState('')
  const [launching, setLaunching] = useState(false)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const config = useAppStore((state) => state.config)
  const detections = useAppStore((state) => state.agentDetections)
  const detectAgents = useAppStore((state) => state.detectAgents)
  const workspaceId = useAppStore((state) => {
    const launcher = launcherTabId ? state.tabs[launcherTabId] : undefined
    return launcher?.workspaceId ?? state.activeWorkspaceId
  })
  const workspace = config?.workspaces.find((item) => item.id === workspaceId)
  const hostCheck = useAppStore((state) => workspace ? state.hostChecks[workspace.hostId] : undefined)
  const agents = useMemo(
    () => Object.keys(config?.agents ?? {}).map((id) => ({
      id,
      label: agentProviderLabel(id),
      detection: workspace ? detections[agentDetectionKey(workspace.hostId, id)] : undefined
    })),
    [config?.agents, detections, workspace]
  )
  const installedAgents = agents.filter((agent) => agent.detection?.state === 'ready')
  const unavailableAgents = agents.filter((agent) => agent.detection?.state !== 'ready')
  const detecting = agents.some((agent) => agent.detection?.state === 'checking')

  useEffect(() => {
    if (!workspace || agents.every((agent) => agent.detection)) return
    void detectAgents(workspace.hostId)
  }, [agents, detectAgents, workspace])

  useEffect(() => {
    if (installedAgents.some((agent) => agent.id === agentId)) return
    const first = installedAgents[0]
    if (first) setAgentId(first.id)
  }, [agentId, installedAgents])

  async function start(): Promise<void> {
    setLaunching(true)
    try {
      await launchAgent(agentId, prompt, paneId, launcherTabId)
    } finally {
      setLaunching(false)
    }
  }

  return (
    <section className="launch-surface">
      <div className="launch-surface__heading">
        {onBack ? (
          <button type="button" className="launch-surface__icon" title="Back to content picker" onClick={onBack}><ArrowLeft size={17} /></button>
        ) : <span className="launch-surface__icon"><Sparkles size={17} /></span>}
        <div>
          <div className="eyebrow">New Agent session</div>
          <h2>Start in {workspace?.name ?? 'a workspace'}</h2>
          <p>Provider details stay in core. This pane owns the interaction.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Refresh agents on this host"
          disabled={!workspace || detecting}
          onClick={() => workspace && void detectAgents(workspace.hostId)}
        >
          {detecting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>
      <div className="agent-catalog" aria-label="Agent providers">
        <div className="agent-catalog__group">
          <div className="agent-catalog__label">
            <span><i className="agent-catalog__ready-dot" />Available</span>
            <em>{installedAgents.length}</em>
          </div>
          <div className="agent-picks">
            {installedAgents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                aria-pressed={agent.id === agentId}
                className={`agent-pick ${agent.id === agentId ? 'agent-pick--selected' : ''}`}
                onClick={() => setAgentId(agent.id)}
              >
                <span className="agent-pick__icon"><AgentProviderIcon agentId={agent.id} size={16} /></span>
                <span className="agent-pick__copy"><strong>{agent.label}</strong><small>Ready</small></span>
                {agent.id === agentId ? <span className="agent-pick__check"><Check size={10} strokeWidth={3} /></span> : null}
              </button>
            ))}
          </div>
        </div>
        {unavailableAgents.length > 0 ? (
          <div className="agent-catalog__group">
            <div className="agent-catalog__label">
              <span>Not installed on {workspace?.hostId ?? 'this host'}</span>
              <em>{unavailableAgents.length}</em>
            </div>
            <div className="agent-picks">
              {unavailableAgents.map((agent) => (
                <button type="button" key={agent.id} className="agent-pick agent-pick--unavailable" disabled>
                  <span className="agent-pick__icon"><AgentProviderIcon agentId={agent.id} size={16} /></span>
                  <span className="agent-pick__copy"><strong>{agent.label}</strong><small>Unavailable</small></span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the outcome. You can steer the agent after launch."
        rows={4}
      />
      <div className="launch-surface__footer">
        <span>
          {workspace?.hostId !== 'local' ? <RadioTower size={13} /> : null}
          {workspace?.hostId ?? 'No host'}
          {hostCheck ? <em className={`launch-host-health launch-host-health--${hostCheck.state}`}>{hostCheck.state === 'ready' ? 'Ready' : hostCheck.state === 'checking' ? 'Checking' : 'Needs attention'}</em> : null}
        </span>
        <button className="primary-button" disabled={!workspace || launching || installedAgents.length === 0} onClick={() => void start()}>
          <Play size={14} /> {launching ? 'Launching…' : 'Launch'}
        </button>
      </div>
    </section>
  )
}
