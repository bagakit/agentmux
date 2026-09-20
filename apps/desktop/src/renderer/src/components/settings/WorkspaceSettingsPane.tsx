import { FolderGit2, LoaderCircle, Play, Plus, RadioTower, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { currentHostCheck } from '../../lib/host-check'
import { presentError } from '../../lib/error-presentation'
import { configuredExecutors } from '../../lib/executors'
import { currentExecutorDetection } from '../../lib/executor-detection'
import { executorDetectionKey, useAppStore } from '../../store'
import { agentProviderLabel } from '../AgentProviderIcon'

export function WorkspaceSettingsPane({ config, onClose }: {
  config: AppConfig
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const [hostId, setHostId] = useState(config.workspaces[0]?.hostId ?? 'local')
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [executorId, setExecutorId] = useState('none')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(config.workspaces.length === 0)
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const hostChecks = useAppStore((state) => state.hostChecks)
  const checkHost = useAppStore((state) => state.checkHost)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const readyHosts = config.hosts.filter((host) => currentHostCheck(hostChecks[host.id], host)?.state === 'ready')
  const checkingHosts = config.hosts.some((host) => !hostChecks[host.id] || hostChecks[host.id]?.state === 'checking')
  const executors = useMemo(() => configuredExecutors(config).map((executor) => ({
    ...executor,
    detection: currentExecutorDetection(detections[executorDetectionKey(hostId, executor.id)], executor.id, executor, config.hosts.find(host => host.id === hostId))
  })), [config.executors, config.hosts, detections, hostId])
  const readyExecutors = executors.filter((executor) => executor.detection?.state === 'ready')
  const checking = executors.some((executor) => executor.detection?.state === 'checking')
  const matchingWorkspaces = config.workspaces.filter((workspace) =>
    `${workspace.name} ${workspace.path} ${workspace.hostId} ${workspace.branch ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())
  )

  useEffect(() => {
    for (const host of config.hosts) if (!hostChecks[host.id]) void checkHost(host)
  }, [checkHost, config.hosts, hostChecks])

  useEffect(() => {
    if (readyHosts.some((host) => host.id === hostId)) return
    const first = readyHosts[0]
    if (first) setHostId(first.id)
  }, [hostId, readyHosts])

  useEffect(() => {
    if (executors.every((executor) => executor.detection)) return
    void detectExecutors(hostId)
  }, [executors, detectExecutors, hostId])

  useEffect(() => {
    if (executorId === 'none' || readyExecutors.some((executor) => executor.id === executorId)) return
    setExecutorId('none')
  }, [executorId, readyExecutors])

  async function create(): Promise<void> {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const workspace = await api.workspaces.add({
        hostId,
        path: projectPath.trim(),
        ...(name.trim() ? { name: name.trim() } : {})
      })
      // Main publishes the committed config before replying. A later get reply could be older.
      await selectWorkspace(workspace.id)
      if (executorId !== 'none') {
        const layout = useAppStore.getState().layouts[workspace.id]
        if (!layout) throw new Error('Workspace layout was not created')
        await launchAgent(executorId, '', layout.activeGroupId)
      }
      onClose()
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <div className="settings-pane-toolbar">
        <span className="settings-resource-count">{filter.trim() ? `${matchingWorkspaces.length} of ` : ''}{config.workspaces.length} {config.workspaces.length === 1 ? 'workspace' : 'workspaces'}</span>
        {!adding ? <button className="small-button" onClick={() => setAdding(true)}><Plus size={13} /> Add project</button> : null}
      </div>
      <div className="settings-workspace-create" hidden={!adding}>
        <div className="settings-workspace-create__header"><strong>Add project</strong><button className="icon-button" aria-label="Cancel adding project" onClick={() => setAdding(false)}><X size={15} /></button></div>
      <section className="workspace-composer">
        <header><p>Choose a folder and a host. You can start an agent now or open the project on its own.</p></header>
        <div className="workspace-composer__fields workspace-composer__fields--project">
          <label className="workspace-composer__wide"><span>Project folder</span><input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/path/to/project" /></label>
          <label><span>Run on</span><select value={readyHosts.some((host) => host.id === hostId) ? hostId : ''} disabled={readyHosts.length === 0} onChange={(event) => setHostId(event.target.value)}><option value="" disabled>{checkingHosts ? 'Checking hosts…' : 'No ready hosts'}</option>{readyHosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select><small>{readyHosts.find((host) => host.id === hostId)?.kind === 'ssh' ? <><RadioTower size={11} /> System SSH · Ready</> : readyHosts.some((host) => host.id === hostId) ? 'This Mac · Ready' : 'Open Hosts settings to fix unavailable machines.'}</small></label>
          <label><span>Name <em>optional</em></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" /></label>
          <label className="workspace-composer__wide"><span>Agent</span><select value={executorId} onChange={(event) => setExecutorId(event.target.value)} disabled={checking}><option value="none">Open without an agent</option>{readyExecutors.map((executor) => <option key={executor.id} value={executor.id}>{executor.label} · {agentProviderLabel(executor.providerId)}</option>)}</select><small>{checking ? 'Detecting agents on this host…' : `${readyExecutors.length} available on this host`}</small></label>
        </div>
        {error ? <div className="dialog-error">{error}</div> : null}
        <footer><span>Branches and worktrees remain Git-owned and appear in the project navigator.</span><button className="primary-button" disabled={!projectPath.trim() || creating || !readyHosts.some((host) => host.id === hostId)} onClick={() => void create()}>{creating ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{creating ? 'Adding…' : 'Add project'}</button></footer>
      </section>
      </div>
      {config.workspaces.length > 0 ? <section className="settings-group">
        <label className="settings-resource-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Filter workspaces" placeholder="Find a workspace…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <div className="workspace-settings-list">{matchingWorkspaces.map((workspace) => <div key={workspace.id}><FolderGit2 size={14} /><span><strong>{workspace.name}</strong><small>{workspace.path}</small></span><em>{workspace.hostId}{workspace.branch ? ` · ${workspace.branch}` : ''}</em></div>)}</div>
      {matchingWorkspaces.length === 0 ? <p className="settings-resource-empty" role="status">No workspaces match “{filter}”.</p> : null}
      </section> : <div className="settings-workspaces-empty"><p>Your projects will appear here.</p>{!adding ? <button className="small-button" onClick={() => setAdding(true)}><Plus size={13} /> Add your first project</button> : null}</div>}
    </div>
  )
}
