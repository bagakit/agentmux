import { TextInput } from '@agentmux/client-ui/input'
import { FolderOpen, GitBranch, LoaderCircle, Plus, Search } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AppConfig } from '../../../../shared/contracts'
import { usePathDisplay } from '../../hooks/usePathDisplay'
import { api } from '../../lib/api'
import { configuredExecutors } from '../../lib/executors'
import { projectRailNavigation } from '../../lib/workspace-projects'
import { useAppStore } from '../../store'
import type { WorkspaceRecord } from '../../../../shared/contracts'
import './host-projects.css'

type Progress = { workspace?: WorkspaceRecord; stage: 'registered' | 'opened'; message: string; error?: string }

/** One committed Host's directory resources; connection drafts and execution stay at their owners. */
export const HostProjectsPane = memo(function HostProjectsPane({ config, hostId, connectionChanged, active, hidden, onClose }: {
  config: AppConfig
  hostId: string
  connectionChanged: boolean
  active: boolean
  hidden: boolean
  onClose?: (() => void) | undefined
}) {
  const host = config.hosts.find(item => item.id === hostId)
  const displayPath = usePathDisplay()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [executorId, setExecutorId] = useState('')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const visible = useRef(active)
  visible.current = active
  useEffect(() => { visible.current = active; return () => { visible.current = false } }, [active])
  const projects = projectRailNavigation(config.workspaces.filter(workspace => workspace.hostId === hostId)).projects
  const filter = query.trim().toLocaleLowerCase()
  const matches = projects.filter(project => [project.name, project.repoPath,
    ...project.workspaces.flatMap(workspace => [workspace.name, workspace.path, workspace.branch ?? ''])]
    .some(value => value.toLocaleLowerCase().includes(filter)))
  const executors = configuredExecutors(config)

  async function open(workspace: WorkspaceRecord, startExecutor = ''): Promise<void> {
    if (!visible.current) return
    setProgress({ workspace, stage: 'registered', message: 'Folder registered. Opening its work surface…' })
    try {
      await useAppStore.getState().selectWorkspace(workspace.id)
      setProgress({ workspace, stage: 'opened', message: 'Folder opened.' })
      if (!visible.current) return
      if (startExecutor) {
        const state = useAppStore.getState()
        const current = state.config?.workspaces.find(item => item.id === workspace.id)
        if (state.activeWorkspaceId !== workspace.id || current?.hostId !== workspace.hostId) {
          setProgress({ workspace, stage: 'opened', message: 'Folder opened. Agent was not started.',
            error: 'The selected work context changed. Open this folder again before starting an Agent.' })
          return
        }
        const layout = state.layouts[workspace.id]
        if (!layout) {
          setProgress({ workspace, stage: 'opened', message: 'Folder opened. Agent was not started.',
            error: 'Its work surface is not confirmed. Open the registered folder to continue.' })
          return
        }
        await state.launchAgent(startExecutor, '', layout.activeGroupId)
        setProgress({ workspace, stage: 'opened', message: 'Folder opened. Agent start was requested; check its work surface for the result.' })
      }
      if (visible.current) onClose?.()
    } catch (cause) {
      setProgress(current => ({ workspace, stage: current?.stage ?? 'registered',
        message: current?.stage === 'opened' ? 'Folder opened. Agent start did not return a confirmed result.' : 'Folder registered. Opening did not complete.',
        error: presentError(cause) }))
    }
  }

  async function register(thenOpen: boolean): Promise<void> {
    if (!host || pending.current || !path.trim()) return
    const input = { hostId: host.id, path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }
    const startExecutor = thenOpen ? executorId : ''
    pending.current = true
    setBusy(true); setError(null); setProgress(null)
    try {
      const workspace = await api.workspaces.add(input)
      if (workspace.hostId !== input.hostId) {
        setError('The registration reply names another environment. No work surface was opened; review the saved folders before retrying.')
        return
      }
      setProgress({ workspace, stage: 'registered', message: `Folder registered on ${host.label}.` })
      if (thenOpen) await open(workspace, startExecutor)
    } catch (cause) {
      setError(`Folder registration did not return a confirmed result. ${presentError(cause)}`)
    } finally {
      pending.current = false; setBusy(false)
    }
  }

  async function openRegistered(workspace: WorkspaceRecord): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError(null)
    try { await open(workspace) }
    finally { pending.current = false; setBusy(false) }
  }

  return <section className="host-projects" hidden={hidden} data-host-projects={hostId}
    aria-label={`Projects on ${host?.label ?? 'unsaved environment'}`}>
    <header className="host-projects__heading">
      <div><strong>Projects</strong><small>{projects.length} {projects.length === 1 ? 'project' : 'projects'} on this environment</small></div>
      <button type="button" className="small-button" disabled={!host} onClick={() => setAdding(current => !current)}>
        <Plus size={13} />{adding ? 'Close folder form' : 'Add folder'}
      </button>
    </header>
    {!host ? <p role="status" className="settings-group-note">Save this connection before registering a folder on it.</p>
      : <p className="settings-group-note">Folders belong to the saved {host.label} connection{host.kind === 'ssh' ? ` (${host.hostname})` : ''}.
        {connectionChanged ? ' Your connection edits are still drafts; adding a folder does not save them.' : ' Registering a folder does not start an Agent.'}</p>}
    <form className="host-projects__form" hidden={!adding} onSubmit={event => { event.preventDefault(); void register(true) }}>
      <label className="host-projects__path"><span>Folder path</span><input value={path} placeholder="Project directory"
        onChange={event => setPath(event.target.value)} /></label>
      <label><span>Name <small>optional</small></span><input value={name} placeholder="Project name" onChange={event => setName(event.target.value)} /></label>
      <label><span>Start after opening <small>optional</small></span><select value={executorId} onChange={event => setExecutorId(event.target.value)}>
        <option value="">Open without an Agent</option>
        {executorId && !executors.some(executor => executor.id === executorId) ? <option value={executorId}>Saved Agent configuration unavailable</option> : null}
        {executors.map(executor => <option key={executor.id} value={executor.id}>{executor.label}</option>)}
      </select></label>
      <p className="field-hint host-projects__path">Uses the folder on this environment. Agent startup reports the actual connection and command result.</p>
      <footer className="host-projects__actions">
        <button type="button" className="small-button" data-register-folder disabled={!host || !path.trim() || busy} onClick={() => void register(false)}>Register folder</button>
        <button type="submit" className="primary-button" data-open-folder disabled={!host || !path.trim() || busy}>
          {busy ? <LoaderCircle size={13} className="spin" /> : <FolderOpen size={13} />}{executorId ? 'Open and start Agent' : 'Open folder'}
        </button>
      </footer>
    </form>
    {error ? <p role="alert" className="dialog-error">{error}</p> : null}
    {progress ? <div className="host-projects__progress" role={progress.error ? 'alert' : 'status'} data-folder-stage={progress.stage}>
      <strong>{progress.message}</strong>{progress.error ? <p>{progress.error}</p> : null}
      {progress.error && progress.workspace ? <button type="button" className="small-button" disabled={busy}
        onClick={() => void openRegistered(progress.workspace!)}>Open registered folder</button> : null}
    </div> : null}
    {projects.length > 0 ? <>
      <label className="settings-resource-search"><Search size={14} aria-hidden="true" /><TextInput type="search" aria-label={`Find a project on ${host?.label ?? hostId}`}
        placeholder="Find a project or worktree…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="host-projects__list">{matches.map(project => <section key={project.id} className="host-projects__project" data-project-id={project.id}>
        <header><FolderOpen size={15} aria-hidden="true" /><strong>{project.name}</strong>
          <small>{project.workspaces.filter(workspace => workspace.kind === 'worktree').length} worktrees</small></header>
        <ul>{project.workspaces.map(workspace => <li key={workspace.id} data-registered-folder={workspace.id}>
          {workspace.kind === 'worktree' ? <GitBranch size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
          <div><strong>{workspace.name}</strong><small>{workspace.kind === 'worktree' ? `Worktree · ${workspace.branch ?? 'branch unconfirmed'}` : 'Folder'}</small>
            <code title={workspace.path}>{displayPath(workspace.path, workspace.hostId)}</code></div>
          <button type="button" className="small-button" disabled={busy} aria-label={`Open ${workspace.name}`} onClick={() => void openRegistered(workspace)}>Open</button>
        </li>)}</ul>
      </section>)}</div>
      {matches.length === 0 ? <p role="status" className="settings-resource-empty">No projects match “{query}”.</p> : null}
    </> : <div className="settings-resource-editor__empty"><FolderOpen size={24} aria-hidden="true" /><strong>No projects yet</strong>
      <p>Add a folder on this environment. Branches and worktrees stay in the project’s Git tools.</p></div>}
  </section>
})
