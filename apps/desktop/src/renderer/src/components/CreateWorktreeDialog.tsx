import { GitBranchPlus, RadioTower, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CreateWorktreeInput } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'

export function CreateWorktreeDialog({ onClose }: { onClose: () => void }) {
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const setConfig = useAppStore((state) => state.setConfig)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const activeWorkspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  const initial = useMemo<CreateWorktreeInput>(() => ({
    hostId: activeWorkspace?.hostId ?? 'local',
    repoPath: activeWorkspace?.repoPath ?? activeWorkspace?.path ?? '',
    path: '',
    branch: '',
    baseRef: 'HEAD',
    name: ''
  }), [activeWorkspace])
  const [draft, setDraft] = useState(initial)
  const [confirmed, setConfirmed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!config) return null
  const currentConfig = config

  function update(patch: Partial<CreateWorktreeInput>): void {
    setDraft((value) => ({ ...value, ...patch }))
  }

  async function create(): Promise<void> {
    if (!confirmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const workspace = await api.workspaces.createWorktree(draft)
      setConfig({ ...currentConfig, workspaces: [...currentConfig.workspaces, workspace] })
      await selectWorkspace(workspace.id)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  const valid = draft.repoPath.trim() && draft.path.trim() && draft.branch.trim() && draft.baseRef.trim()
  const selectedHost = config.hosts.find((host) => host.id === draft.hostId)

  return (
    <div className="scrim scrim--center" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="worktree-dialog">
        <header>
          <div className="dialog-title">
            <span className="dialog-icon"><GitBranchPlus size={18} /></span>
            <div><div className="eyebrow">Workspace automation</div><h2>Create Git worktree</h2></div>
          </div>
          <button className="icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <p className="dialog-copy">Create a new branch and worktree on the selected host, then register it as an AgentMux workspace.</p>
        <div className="worktree-form">
          <label>
            <span>Execution host</span>
            <select value={draft.hostId} onChange={(event) => update({ hostId: event.target.value })}>
              {config.hosts.map((host) => <option value={host.id} key={host.id}>{host.label}</option>)}
            </select>
            <small>{selectedHost?.kind === 'ssh' ? <><RadioTower size={11} /> Runs through system SSH</> : 'Runs on this Mac'}</small>
          </label>
          <label><span>Repository path</span><input value={draft.repoPath} onChange={(event) => update({ repoPath: event.target.value })} placeholder="/path/to/repository" /></label>
          <label><span>Worktree path</span><input value={draft.path} onChange={(event) => update({ path: event.target.value })} placeholder="/path/to/worktrees/feature-name" /></label>
          <div className="worktree-form__row">
            <label><span>New branch</span><input value={draft.branch} onChange={(event) => update({ branch: event.target.value })} placeholder="feature/name" /></label>
            <label><span>Base reference</span><input value={draft.baseRef} onChange={(event) => update({ baseRef: event.target.value })} placeholder="HEAD" /></label>
          </div>
          <label><span>Workspace name <em>optional</em></span><input value={draft.name ?? ''} onChange={(event) => update({ name: event.target.value })} placeholder="Defaults to worktree folder" /></label>
        </div>
        <label className="confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I confirm AgentMux may run <code>git worktree add -b</code> on {selectedHost?.label ?? draft.hostId}.</span>
        </label>
        {error ? <div className="dialog-error">{error}</div> : null}
        <footer>
          <button className="small-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={!valid || !confirmed || creating} onClick={() => void create()}>
            <GitBranchPlus size={14} /> {creating ? 'Creating…' : 'Create & register'}
          </button>
        </footer>
      </section>
    </div>
  )
}
