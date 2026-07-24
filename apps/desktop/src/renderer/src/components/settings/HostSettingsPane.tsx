import { CheckCircle2, ChevronDown, LoaderCircle, Monitor, Plus, RadioTower, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppConfig, HostConfig, SshHostConfig, WorkspaceRecord } from '../../../../shared/contracts'
import { useAppStore } from '../../store'
import { ConfirmationDialog } from '../ConfirmationDialog'

export function HostSettingsPane({ config, onSave }: {
  config: AppConfig
  onSave: (hosts: HostConfig[], workspaces: WorkspaceRecord[]) => Promise<void>
}) {
  const [hosts, setHosts] = useState<HostConfig[]>(() => structuredClone(config.hosts))
  const [removeRequest, setRemoveRequest] = useState<SshHostConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checks = useAppStore((state) => state.hostChecks)
  const checkHost = useAppStore((state) => state.checkHost)
  const sessions = useAppStore((state) => state.sessions)

  useEffect(() => setHosts(structuredClone(config.hosts)), [config.hosts])

  function update(id: string, patch: Partial<SshHostConfig>): void {
    setHosts((current) => current.map((host) => host.id === id && host.kind === 'ssh' ? { ...host, ...patch } : host))
  }

  function clear(id: string, field: 'user' | 'port' | 'identityFile'): void {
    setHosts((current) => current.map((host) => {
      if (host.id !== id || host.kind !== 'ssh') return host
      const next = { ...host }
      delete next[field]
      return next
    }))
  }

  function addHost(): void {
    const id = `ssh-${crypto.randomUUID().slice(0, 8)}`
    setHosts((current) => [...current, {
      id,
      kind: 'ssh',
      label: 'Remote host',
      hostname: ''
    }])
  }

  async function save(nextHosts = hosts, nextWorkspaces = config.workspaces): Promise<boolean> {
    setSaving(true)
    setError(null)
    try {
      if (nextHosts.some((host) => host.kind === 'ssh' && (
        !host.label.trim() ||
        !host.hostname.trim()
      ))) {
        throw new Error('Every SSH host needs connection details')
      }
      await onSave(nextHosts, nextWorkspaces)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function confirmRemove(): Promise<void> {
    const target = removeRequest
    if (!target) return
    const nextHosts = hosts.filter((host) => host.id !== target.id)
    const nextWorkspaces = config.workspaces.filter((workspace) => workspace.hostId !== target.id)
    if (await save(nextHosts, nextWorkspaces)) {
      setHosts(nextHosts)
      setRemoveRequest(null)
    }
  }

  return (
    <div className="settings-pane-stack">
      <div className="settings-pane-toolbar">
        <div><strong>Execution hosts</strong><span>Local and SSH machines available to workspaces and agents.</span></div>
        <button className="small-button" onClick={addHost}><Plus size={13} /> Add SSH host</button>
      </div>
      <div className="host-settings-list">
        {hosts.map((host) => {
          const check = checks[host.id]
          const sessionCount = sessions.filter((session) => session.hostId === host.id).length
          return (
            <section className="host-settings-card" key={host.id}>
              <header>
                <span className="host-card__icon">{host.kind === 'ssh' ? <RadioTower size={16} /> : <Monitor size={16} />}</span>
                <div><strong>{host.label}</strong><small>{host.kind === 'ssh' ? `${host.user ? `${host.user}@` : ''}${host.hostname || 'hostname required'}${host.port ? `:${host.port}` : ''}` : 'Local AgentMux Runtime'}</small></div>
                {check ? <span className={`check-pill check-pill--${check.state}`}>{check.state === 'checking' ? <LoaderCircle className="spin" size={13} /> : check.state === 'ready' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{check.state === 'checking' ? 'Testing' : check.detail}</span> : null}
                <button className="small-button" disabled={check?.state === 'checking' || (host.kind === 'ssh' && !host.hostname.trim())} onClick={() => void checkHost(host)}>Test</button>
                {host.kind === 'ssh' ? <button className="icon-button icon-button--danger" title={`Remove ${host.label}`} disabled={sessionCount > 0} onClick={() => setRemoveRequest(host)}><Trash2 size={14} /></button> : null}
              </header>
              {host.kind === 'ssh' ? (
                <details className="host-edit-disclosure" open={!host.hostname}>
                  <summary>Edit connection <ChevronDown size={13} /></summary>
                  <div className="host-edit-grid">
                    <label><span>Label</span><input value={host.label} onChange={(event) => update(host.id, { label: event.target.value })} /></label>
                    <label><span>Hostname</span><input value={host.hostname} onChange={(event) => update(host.id, { hostname: event.target.value })} placeholder="dev.example.com" /></label>
                    <label><span>User</span><input value={host.user ?? ''} onChange={(event) => event.target.value ? update(host.id, { user: event.target.value }) : clear(host.id, 'user')} placeholder="optional" /></label>
                    <label><span>Port</span><input type="number" min={1} max={65535} value={host.port ?? ''} onChange={(event) => event.target.value ? update(host.id, { port: Number(event.target.value) }) : clear(host.id, 'port')} placeholder="22" /></label>
                    <label className="host-edit-grid__wide"><span>Identity file path <small>optional; key contents are never stored</small></span><input value={host.identityFile ?? ''} onChange={(event) => event.target.value ? update(host.id, { identityFile: event.target.value }) : clear(host.id, 'identityFile')} placeholder="~/.ssh/id_ed25519" /></label>
                    <p className="field-hint host-edit-grid__wide">Remote Runs are unavailable until the ctxmux Remote contract is delivered.</p>
                  </div>
                </details>
              ) : null}
              {sessionCount > 0 ? <p className="field-hint">{sessionCount} running session{sessionCount === 1 ? '' : 's'} must be stopped before this host can be changed or removed.</p> : null}
            </section>
          )
        })}
      </div>
      {error ? <div className="dialog-error">{error}</div> : null}
      <div className="settings-pane-actions"><span>SSH commands use the system client and existing authentication.</span><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save hosts'}</button></div>
      <ConfirmationDialog
        open={removeRequest !== null}
        title="Remove SSH host?"
        description={`This removes the host and ${config.workspaces.filter((workspace) => workspace.hostId === removeRequest?.id).length} linked workspace registrations. Remote files are not deleted.`}
        {...(removeRequest ? { subject: removeRequest.label } : {})}
        confirmLabel="Remove Host"
        busy={saving}
        onCancel={() => {
          if (!saving) setRemoveRequest(null)
        }}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  )
}
