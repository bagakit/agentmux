import { CheckCircle2, FolderPlus, Plus, RadioTower, X } from 'lucide-react'
import { useState } from 'react'
import type { AppConfig, SshHostConfig } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const config = useAppStore((state) => state.config)
  const setConfig = useAppStore((state) => state.setConfig)
  const [draft, setDraft] = useState<AppConfig | null>(config ? structuredClone(config) : null)
  const [check, setCheck] = useState<string | null>(null)
  const [workspaceHostId, setWorkspaceHostId] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  if (!draft) return null

  function updateSsh(id: string, patch: Partial<SshHostConfig>): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            hosts: current.hosts.map((host) => (host.id === id && host.kind === 'ssh' ? { ...host, ...patch } : host))
          }
        : current
    )
  }

  function clearSshField(id: string, field: 'user' | 'port'): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            hosts: current.hosts.map((host) => {
              if (host.id !== id || host.kind !== 'ssh') return host
              const next = { ...host }
              delete next[field]
              return next
            })
          }
        : current
    )
  }

  function addSsh(): void {
    const id = `ssh-${crypto.randomUUID().slice(0, 8)}`
    setDraft((current) =>
      current
        ? { ...current, hosts: [...current.hosts, { id, kind: 'ssh', label: 'Remote host', hostname: 'example.com' }] }
        : current
    )
  }

  function addRemoteWorkspace(): void {
    const path = workspacePath.trim()
    const host = draft?.hosts.find((item) => item.id === workspaceHostId)
    if (!draft || host?.kind !== 'ssh' || !path) return
    const name = workspaceName.trim() || path.split('/').filter(Boolean).pop() || path
    setDraft({
      ...draft,
      workspaces: [...draft.workspaces, { id: crypto.randomUUID(), name, hostId: host.id, path, kind: 'folder' }]
    })
    setWorkspacePath('')
    setWorkspaceName('')
  }

  async function save(): Promise<void> {
    const configToSave = draft
    if (!configToSave) return
    const saved = await api.config.save(configToSave)
    setConfig(saved)
    onClose()
  }

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-panel">
        <header><div><div className="eyebrow">Configuration</div><h2>Hosts & providers</h2></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header>
        <div className="settings-section">
          <div className="settings-section__heading"><span>Execution hosts</span><button className="small-button" onClick={addSsh}><Plus size={13} /> SSH host</button></div>
          {draft.hosts.map((host) => (
            <div className="host-card" key={host.id}>
              <div className="host-card__icon">{host.kind === 'ssh' ? <RadioTower size={16} /> : <CheckCircle2 size={16} />}</div>
              <div className="host-card__fields">
                <input value={host.label} onChange={(event) => host.kind === 'ssh' && updateSsh(host.id, { label: event.target.value })} disabled={host.kind === 'local'} />
                {host.kind === 'ssh' ? (
                  <div className="inline-fields">
                    <input value={host.hostname} onChange={(event) => updateSsh(host.id, { hostname: event.target.value })} placeholder="hostname" />
                    <input
                      value={host.user ?? ''}
                      onChange={(event) =>
                        event.target.value ? updateSsh(host.id, { user: event.target.value }) : clearSshField(host.id, 'user')
                      }
                      placeholder="user"
                    />
                    <input
                      value={host.port ?? ''}
                      onChange={(event) =>
                        event.target.value ? updateSsh(host.id, { port: Number(event.target.value) }) : clearSshField(host.id, 'port')
                      }
                      placeholder="port"
                    />
                  </div>
                ) : <span className="field-hint">Local tmux process</span>}
              </div>
              <button
                className="small-button"
                onClick={() => void api.hosts.check(host.id).then((result) => setCheck(`${host.label}: ${result.detail}`))}
              >Test</button>
            </div>
          ))}
          {check ? <div className="connection-result">{check}</div> : null}
        </div>
        <div className="settings-section">
          <div className="settings-section__heading"><span>SSH workspace path</span></div>
          <div className="workspace-config">
            <select value={workspaceHostId} onChange={(event) => setWorkspaceHostId(event.target.value)}>
              <option value="" disabled>Select SSH host</option>
              {draft.hosts.filter((host) => host.kind === 'ssh').map((host) => (
                <option value={host.id} key={host.id}>{host.label}</option>
              ))}
            </select>
            <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/remote/project/path" />
            <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Name (optional)" />
            <button className="small-button" disabled={!workspaceHostId || !workspacePath.trim()} onClick={addRemoteWorkspace}>
              <FolderPlus size={13} /> Add
            </button>
          </div>
          <span className="field-hint">The path is registered when you save configuration; no files are copied.</span>
        </div>
        <div className="settings-section">
          <div className="settings-section__heading"><span>Agent commands</span></div>
          <div className="agent-config-grid">
            {Object.entries(draft.agents).map(([id, agent]) => (
              <label key={id}><span>{id}</span><input value={agent.command} onChange={(event) => setDraft({ ...draft, agents: { ...draft.agents, [id]: { ...agent, command: event.target.value } } })} /></label>
            ))}
          </div>
        </div>
        <footer><span>SSH uses your system config and agent. Private keys are never copied.</span><button className="primary-button" onClick={() => void save()}>Save configuration</button></footer>
      </section>
    </div>
  )
}
