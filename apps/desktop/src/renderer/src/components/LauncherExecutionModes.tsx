import { useEffect, useRef, useState } from 'react'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { fileNavigationSelection, useAppStore, type LauncherExecutionSelection } from '../store'
import { AgentDeviceSelect } from './AgentDeviceSelect'

/** A compact editor for the original two execution addresses; no Agent is created here. */
export function LauncherExecutionModes({ hosts, workspaces, workspace, agentWorkspace, explicitAgentWorkspaceId, disabled, active = true, onSelect, onManageProjects, onGuide, onPreparingChange }: {
  hosts: readonly HostConfig[]; workspaces: readonly WorkspaceRecord[]; workspace: WorkspaceRecord | undefined;
  agentWorkspace: WorkspaceRecord | undefined; explicitAgentWorkspaceId: string | undefined; disabled: boolean; active?: boolean;
  onSelect(selection: LauncherExecutionSelection, options: { navigateProject: boolean }): boolean
  onManageProjects(): void; onGuide?: (() => void) | undefined; onPreparingChange?(pending: boolean): void
}) {
  const [pendingHost, setPendingHost] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const original = useRef({ workspace, explicitAgentWorkspaceId }); original.current = { workspace, explicitAgentWorkspaceId }
  function cancel() { request.current?.abort(); request.current = null; setPendingHost(null); onPreparingChange?.(false) }
  useEffect(() => { cancel(); return () => { request.current?.abort(); request.current = null; onPreparingChange?.(false) } }, [workspace?.id, explicitAgentWorkspaceId, active])
  const runtime = explicitAgentWorkspaceId === undefined ? workspace : agentWorkspace
  const runtimeHost = hosts.find(host => host.id === runtime?.hostId)
  const directories = workspaces.filter(item => !isScratchWorkspaceId(item.id))
  const hostName = (id: string) => { const host = hosts.find(item => item.id === id); return host ? `${host.label}${hosts.some(other => other.id !== id && other.label === host.label) ? ` (${id})` : ''}` : id }
  const label = (item: WorkspaceRecord) => `${hostName(item.hostId)} · ${item.name} · ${item.path}`
  async function chooseDevice(hostId: string, forceHome = false) {
    cancel(); setError(null)
    if (!workspace || !hostId) return
    if (hostId === workspace.hostId && !forceHome) {
      onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: null }, { navigateProject: false }); return
    }
    const controller = new AbortController(), source = original.current, selection = fileNavigationSelection(useAppStore.getState())
    let navigationChanged = false
    const stop = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== selection) { navigationChanged = true; controller.abort() } })
    request.current = controller; setPendingHost(hostId); onPreparingChange?.(true)
    try {
      const directory = await useAppStore.getState().prepareAgentHostWorkspace(hostId, { signal: controller.signal })
      if (controller.signal.aborted || request.current !== controller || navigationChanged || original.current.workspace?.id !== source.workspace?.id || original.current.workspace?.hostId !== source.workspace?.hostId || original.current.workspace?.path !== source.workspace?.path || original.current.explicitAgentWorkspaceId !== source.explicitAgentWorkspaceId) return
      onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: directory.id }, { navigateProject: false })
    } catch (cause) { if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : 'The Agent device could not be prepared. Retry this selection.') }
    finally { stop(); if (request.current === controller) { request.current = null; setPendingHost(null); onPreparingChange?.(false) } }
  }
  function selectDirectory(id: string) {
    cancel(); setError(null)
    if (!workspace) return
    if (id === '@home') { if (runtimeHost) void chooseDevice(runtimeHost.id, true); return }
    onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: id || null }, { navigateProject: false })
  }
  return <section className="launcher-execution" aria-label="Agent location">
    <div className="launcher-agent-location">
      <AgentDeviceSelect hosts={hosts} value={pendingHost ?? runtimeHost?.id ?? ''} busy={pendingHost !== null} disabled={disabled || !active}
        onChange={hostId => void chooseDevice(hostId)} />
      {explicitAgentWorkspaceId !== undefined ? <span className="launcher-agent-location__project">Files &amp; tools: {workspace ? hostName(workspace.hostId) : 'Unknown device'}</span> : null}
    </div>
    {pendingHost ? <p className="launcher-execution-feedback" role="status">Preparing the Agent startup directory…</p> : error ? <p className="launcher-execution-feedback" role="status">{error}</p> : null}
    <details className="launcher-execution-advanced"><summary>Advanced arrangement</summary>
      <div className="launcher-execution-fields">
        <label><span>Files &amp; tools</span><select aria-label="Files and tools" value={workspace?.id ?? ''} disabled={disabled || !active} onChange={event => { cancel(); setError(null); onSelect({ resourceWorkspaceId: event.target.value, agentWorkspaceId: explicitAgentWorkspaceId ?? null }, { navigateProject: true }) }}>
          {!workspace ? <option value="">Choose a folder…</option> : null}
          {directories.map(item => <option value={item.id} key={item.id}>{label(item)}</option>)}
        </select></label>
        <label><span>Agent startup directory</span><select aria-label="Agent startup directory" value={explicitAgentWorkspaceId ?? ''} disabled={disabled || !active || pendingHost !== null} onChange={event => selectDirectory(event.target.value)}>
          <option value="">Follow project directory</option><option value="@home">Device home</option>
          {explicitAgentWorkspaceId && !directories.some(item => item.id === explicitAgentWorkspaceId) ? <option value={explicitAgentWorkspaceId}>Selected directory · unavailable</option> : null}
          {directories.filter(item => item.hostId === runtimeHost?.id).map(item => <option value={item.id} key={item.id}>{item.name} · {item.path}</option>)}
        </select></label>
      </div>
      <p>Startup directory supplies the Agent’s native configuration and Skills. Files and commands use the selected project.</p>
      <div className="launcher-execution__actions"><button type="button" onClick={onManageProjects}>Manage folders</button>{onGuide ? <button type="button" onClick={onGuide}>How it works</button> : null}</div>
    </details>
  </section>
}
