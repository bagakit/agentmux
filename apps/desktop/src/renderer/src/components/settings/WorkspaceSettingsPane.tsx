import { usePathDisplay } from '../../hooks/usePathDisplay'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { currentHostCheck } from '../../lib/host-check'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { hostExecutorInventoryMatches, executorsForHost } from '../../lib/executors'
import { useAppStore } from '../../store'
import { agentProviderLabel } from '../AgentProviderIcon'

const ThemeActionCreateProjectIcon = semanticIconComponent('action.create-project')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeObjectBroadcastIcon = semanticIconComponent('object.broadcast')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeObjectRepositoryIcon = semanticIconComponent('object.repository')


export function WorkspaceSettingsPane({ config, onClose }: {
  config: AppConfig
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const displayPath = usePathDisplay()
  const [hostId, setHostId] = useState(config.workspaces[0]?.hostId ?? 'local')
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [executorId, setExecutorId] = useState('none')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(config.workspaces.length === 0)
  const detections = useAppStore((state) => state.executorDetections)
  const inventory = useAppStore(state => state.hostExecutorInventories[hostId])
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const hostChecks = useAppStore((state) => state.hostChecks)
  const checkHost = useAppStore((state) => state.checkHost)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const readyHosts = config.hosts.filter((host) => currentHostCheck(hostChecks[host.id], host)?.state === 'ready')
  const checkingHosts = config.hosts.some((host) => !hostChecks[host.id] || hostChecks[host.id]?.state === 'checking')
  const executors = useMemo(() => executorsForHost(config, hostId, detections, inventory), [config.executors, config.hosts, detections, hostId, inventory])
  const readyExecutors = executors.filter((executor) => executor.detection?.state !== 'missing')
  const checking = inventory?.state === 'checking' || executors.some((executor) => executor.detection?.state === 'checking')
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
    if (config.hosts.find(host => host.id === hostId)?.kind === 'ssh' ? hostExecutorInventoryMatches(inventory, config.hosts.find(host => host.id === hostId)) : executors.every((executor) => executor.detection)) return
    void detectExecutors(hostId)
  }, [executors, inventory, config.hosts, detectExecutors, hostId])

  useEffect(() => {
    if (executorId === 'none' || !executors.some(executor => executor.id === executorId && executor.detection?.state === 'missing')) return
    setExecutorId('none')
  }, [executorId, executors])

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
        {!adding ? <button className="small-button" onClick={() => setAdding(true)}><ThemeActionCreateProjectIcon size={13} /> Add project</button> : null}
      </div>
      <div className="settings-workspace-create" hidden={!adding}>
        <div className="settings-workspace-create__header"><strong>Add project</strong><button className="icon-button" aria-label="Cancel adding project" onClick={() => setAdding(false)}><ThemeActionCancelIcon size={15} /></button></div>
      <section className="workspace-composer">
        <header><p>Choose a folder and a host. You can start an agent now or open the project on its own.</p></header>
        <div className="workspace-composer__fields workspace-composer__fields--project">
          <label className="workspace-composer__wide"><span>Project folder</span><input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="Project directory" /></label>
          <label><span>Run on</span><select value={readyHosts.some((host) => host.id === hostId) ? hostId : ''} disabled={readyHosts.length === 0} onChange={(event) => { setHostId(event.target.value); setExecutorId('none') }}><option value="" disabled>{checkingHosts ? 'Checking hosts…' : 'No ready hosts'}</option>{readyHosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select><small>{readyHosts.find((host) => host.id === hostId)?.kind === 'ssh' ? <><ThemeObjectBroadcastIcon size={11} /> System SSH · Ready</> : readyHosts.some((host) => host.id === hostId) ? 'This Mac · Ready' : 'Open Hosts settings to fix unavailable machines.'}</small></label>
          <label><span>Name <em>optional</em></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" /></label>
          <label className="workspace-composer__wide"><span>Agent</span><select value={executorId} onChange={(event) => setExecutorId(event.target.value)} ><option value="none">Open without an agent</option>{readyExecutors.map((executor) => <option key={executor.id} value={executor.id}>{executor.label} · {agentProviderLabel(executor.providerId)}</option>)}</select><small>{checking ? 'Detecting agents on this host…' : inventory?.state === 'error' ? 'Host check failed; known configurations are retained.' : `${readyExecutors.length} configurations on this host`}</small></label>
        </div>
        {error ? <div className="dialog-error">{error}</div> : null}
        <footer><span>Branches and worktrees remain Git-owned and appear in the project navigator.</span><button className="primary-button" disabled={!projectPath.trim() || creating || !readyHosts.some((host) => host.id === hostId)} onClick={() => void create()}>{creating ? <ThemeStatusLoadingIcon className="spin" size={14} /> : <ThemeActionStartIcon size={14} />}{creating ? 'Adding…' : 'Add project'}</button></footer>
      </section>
      </div>
      {config.workspaces.length > 0 ? <section className="settings-group">
        <label className="settings-resource-search"><ThemeActionSearchIcon size={14} aria-hidden="true" /><input type="search" aria-label="Filter workspaces" placeholder="Find a workspace…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <div className="workspace-settings-list">{matchingWorkspaces.map((workspace) => <div key={workspace.id}><ThemeObjectRepositoryIcon size={14} /><span><strong>{workspace.name}</strong><small title={displayPath(workspace.path, workspace.hostId)}>{displayPath(workspace.path, workspace.hostId)}</small></span><em>{workspace.hostId}{workspace.branch ? ` · ${workspace.branch}` : ''}</em></div>)}</div>
      {matchingWorkspaces.length === 0 ? <p className="settings-resource-empty" role="status">No workspaces match “{filter}”.</p> : null}
      </section> : <div className="settings-workspaces-empty"><p>Your projects will appear here.</p>{!adding ? <button className="small-button" onClick={() => setAdding(true)}><ThemeActionCreateProjectIcon size={13} /> Add your first project</button> : null}</div>}
    </div>
  )
}
