import { AlertTriangle, CheckCircle2, ChevronDown, LoaderCircle, RefreshCw, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentConfig, AppConfig } from '../../../../shared/contracts'
import { agentDetectionKey, useAppStore } from '../../store'
import { AgentProviderIcon, agentProviderLabel } from '../AgentProviderIcon'

type AgentDraft = { command: string; args: string; env: string }

function toDraft(config: AgentConfig): AgentDraft {
  return {
    command: config.command,
    args: config.args.join('\n'),
    env: Object.entries(config.env).map(([name, value]) => `${name}=${value}`).join('\n')
  }
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line) continue
    const separator = line.indexOf('=')
    const name = separator > 0 ? line.slice(0, separator).trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Environment line ${index + 1} must use NAME=value`)
    }
    env[name] = line.slice(separator + 1)
  }
  return env
}

function statusCopy(state: ReturnType<typeof useAppStore.getState>['agentDetections'][string] | undefined) {
  switch (state?.state) {
    case 'ready': return { label: 'Installed', icon: <CheckCircle2 size={13} /> }
    case 'missing': return { label: 'Not installed', icon: <XCircle size={13} /> }
    case 'checking': return { label: 'Checking', icon: <LoaderCircle className="spin" size={13} /> }
    case 'error': return { label: 'Check failed', icon: <AlertTriangle size={13} /> }
    default: return { label: 'Not checked', icon: <XCircle size={13} /> }
  }
}

export function AgentSettingsPane({ config, onSave }: {
  config: AppConfig
  onSave: (agents: Record<string, AgentConfig>) => Promise<void>
}) {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const detections = useAppStore((state) => state.agentDetections)
  const detectAgents = useAppStore((state) => state.detectAgents)
  const initialHost = config.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.hostId ?? 'local'
  const [hostId, setHostId] = useState(initialHost)
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>(() =>
    Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, toDraft(agent)]))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agents = useMemo(() => Object.keys(config.agents).map((id) => ({
    id,
    label: agentProviderLabel(id),
    detection: detections[agentDetectionKey(hostId, id)]
  })), [config.agents, detections, hostId])
  const checking = agents.some((agent) => agent.detection?.state === 'checking')
  const groups = [
    { title: 'Installed', items: agents.filter((agent) => agent.detection?.state === 'ready') },
    { title: 'Not installed', items: agents.filter((agent) => agent.detection?.state !== 'ready') }
  ]

  useEffect(() => {
    if (agents.every((agent) => agent.detection)) return
    void detectAgents(hostId)
  }, [agents, detectAgents, hostId])

  function update(id: string, patch: Partial<AgentDraft>): void {
    setDrafts((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const agents = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, {
        command: draft.command.trim(),
        args: draft.args.split('\n').map((value) => value.trim()).filter(Boolean),
        env: parseEnv(draft.env)
      }]))
      if (Object.values(agents).some((agent) => !agent.command)) throw new Error('Agent commands cannot be empty')
      await onSave(agents)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <div className="settings-pane-toolbar">
        <label className="settings-compact-field"><span>Detect on</span><select value={hostId} onChange={(event) => setHostId(event.target.value)}>{config.hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
        <button className="small-button" disabled={checking} onClick={() => void detectAgents(hostId)}>{checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Refresh</button>
      </div>
      {groups.map((group) => group.items.length > 0 ? (
        <section className="settings-group" key={group.title}>
          <header><span>{group.title}</span><small>{group.items.length}</small></header>
          <div className="agent-settings-list">
            {group.items.map((agent) => {
              const status = statusCopy(agent.detection)
              const draft = drafts[agent.id]!
              return (
                <details className="agent-settings-card" key={agent.id}>
                  <summary>
                    <span className="agent-provider-mark"><AgentProviderIcon agentId={agent.id} size={17} /></span>
                    <span><strong>{agent.label}</strong><small>{draft.command}</small></span>
                    <em className={`check-pill check-pill--${agent.detection?.state ?? 'idle'}`}>{status.icon}{status.label}</em>
                    <ChevronDown className="settings-disclosure-icon" size={14} />
                  </summary>
                  <div className="agent-settings-fields">
                    <label><span>Command</span><input value={draft.command} onChange={(event) => update(agent.id, { command: event.target.value })} /></label>
                    <label><span>Arguments <small>one per line</small></span><textarea value={draft.args} onChange={(event) => update(agent.id, { args: event.target.value })} placeholder="--model&#10;gpt-5" rows={3} /></label>
                    <label><span>Environment <small>NAME=value</small></span><textarea value={draft.env} onChange={(event) => update(agent.id, { env: event.target.value })} placeholder="API_BASE=https://example.test" rows={3} /></label>
                    {agent.detection?.detail ? <p className="settings-inline-error">{agent.detection.detail}</p> : null}
                  </div>
                </details>
              )
            })}
          </div>
        </section>
      ) : null)}
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="settings-pane-actions"><span>Detection uses the selected host and the command shown above.</span><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save agent settings'}</button></div>
    </div>
  )
}
