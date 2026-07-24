import { FolderGit2, LoaderCircle, Play, RadioTower } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { agentDetectionKey, useAppStore } from '../../store'
import { agentProviderLabel } from '../AgentProviderIcon'

export function WorkspaceSettingsPane({ config, onClose }: {
  config: AppConfig
  onClose: () => void
}) {
  const [hostId, setHostId] = useState(config.workspaces[0]?.hostId ?? 'local')
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('none')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const detections = useAppStore((state) => state.agentDetections)
  const detectAgents = useAppStore((state) => state.detectAgents)
  const hostChecks = useAppStore((state) => state.hostChecks)
  const checkHost = useAppStore((state) => state.checkHost)
  const setConfig = useAppStore((state) => state.setConfig)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const readyHosts = config.hosts.filter((host) => hostChecks[host.id]?.state === 'ready')
  const checkingHosts = config.hosts.some((host) => !hostChecks[host.id] || hostChecks[host.id]?.state === 'checking')
  const agents = useMemo(() => Object.keys(config.agents).map((id) => ({
    id,
    label: agentProviderLabel(id),
    detection: detections[agentDetectionKey(hostId, id)]
  })), [config.agents, detections, hostId])
  const readyAgents = agents.filter((agent) => agent.detection?.state === 'ready')
  const checking = agents.some((agent) => agent.detection?.state === 'checking')

  useEffect(() => {
    for (const host of config.hosts) if (!hostChecks[host.id]) void checkHost(host)
  }, [checkHost, config.hosts, hostChecks])

  useEffect(() => {
    if (readyHosts.some((host) => host.id === hostId)) return
    const first = readyHosts[0]
    if (first) setHostId(first.id)
  }, [hostId, readyHosts])

  useEffect(() => {
    if (agents.every((agent) => agent.detection)) return
    void detectAgents(hostId)
  }, [agents, detectAgents, hostId])

  useEffect(() => {
    if (agentId === 'none' || readyAgents.some((agent) => agent.id === agentId)) return
    setAgentId('none')
  }, [agentId, readyAgents])

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
      const latest = await api.config.get()
      setConfig(latest)
      await selectWorkspace(workspace.id)
      if (agentId !== 'none') {
        const layout = useAppStore.getState().layouts[workspace.id]
        if (!layout) throw new Error('Workspace layout was not created')
        await launchAgent(agentId, '', layout.activeGroupId)
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="settings-pane-stack">
      <section className="workspace-composer">
        <header><span className="settings-card__icon"><FolderGit2 size={17} /></span><div><h3>Add project</h3><p>Register a project folder on a ready local or SSH host. Create worktrees later from its Branches panel.</p></div></header>
        <div className="workspace-composer__fields workspace-composer__fields--project">
          <label className="workspace-composer__wide"><span>Project folder</span><input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/path/to/project" /></label>
          <label><span>Run on</span><select value={readyHosts.some((host) => host.id === hostId) ? hostId : ''} disabled={readyHosts.length === 0} onChange={(event) => setHostId(event.target.value)}><option value="" disabled>{checkingHosts ? 'Checking hosts…' : 'No ready hosts'}</option>{readyHosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select><small>{readyHosts.find((host) => host.id === hostId)?.kind === 'ssh' ? <><RadioTower size={11} /> System SSH · Ready</> : readyHosts.some((host) => host.id === hostId) ? 'This Mac · Ready' : 'Open Hosts settings to fix unavailable machines.'}</small></label>
          <label><span>Name <em>optional</em></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" /></label>
          <label className="workspace-composer__wide"><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={checking}><option value="none">Open without an agent</option>{readyAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select><small>{checking ? 'Detecting agents on this host…' : `${readyAgents.length} installed on this host`}</small></label>
        </div>
        {error ? <div className="dialog-error">{error}</div> : null}
        <footer><span>Branches and worktrees remain Git-owned and appear in the project navigator.</span><button className="primary-button" disabled={!projectPath.trim() || creating || !readyHosts.some((host) => host.id === hostId)} onClick={() => void create()}>{creating ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{creating ? 'Adding…' : 'Add project'}</button></footer>
      </section>
      <section className="settings-group">
        <header><span>Registered workspaces</span><small>{config.workspaces.length}</small></header>
        <div className="workspace-settings-list">{config.workspaces.map((workspace) => <div key={workspace.id}><FolderGit2 size={14} /><span><strong>{workspace.name}</strong><small>{workspace.path}</small></span><em>{workspace.hostId}{workspace.branch ? ` · ${workspace.branch}` : ''}</em></div>)}</div>
      </section>
    </div>
  )
}
