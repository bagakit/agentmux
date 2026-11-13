import { useEffect, useRef, useState } from 'react'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { useAppStore, type LauncherExecutionSelection } from '../store'
import { HostIcon } from './HostBadge'
import { SelectionField } from './SelectionField'

/**
 * Where the Agent runs, beside the Agent list. The project and its device stay
 * fixed by the Space entry. Settings-prepared arrangements are read here, not edited.
 */
export function LauncherAgentDevice({ hosts, workspace, agentWorkspace, explicitAgentWorkspaceId, disabled, active, onSelect, onPreparingChange, onEditArrangement }: {
  hosts: readonly HostConfig[]; workspace: WorkspaceRecord | undefined; agentWorkspace: WorkspaceRecord | undefined
  explicitAgentWorkspaceId: string | undefined; disabled: boolean; active: boolean
  onSelect(selection: LauncherExecutionSelection): boolean
  onPreparingChange(pending: boolean): void
  onEditArrangement?: (() => void) | undefined
}) {
  const [pendingHost, setPendingHost] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ hostId: string; message: string } | null>(null)
  const request = useRef<AbortController | null>(null)
  function cancel() { request.current?.abort(); request.current = null; setPendingHost(null); onPreparingChange(false) }
  // Leaving this exact project or this Launcher cancels preparation; unrelated navigation does not.
  useEffect(() => { cancel(); setFailure(null); return cancel }, [workspace?.id, workspace?.hostId, workspace?.path])
  useEffect(() => { if (!active) cancel() }, [active])
  if (!workspace || isScratchWorkspaceId(workspace.id)) return null
  const projectHost = hosts.find(host => host.id === workspace.hostId)
  const agentHost = hosts.find(host => host.id === agentWorkspace?.hostId)
  const settingsArrangement = explicitAgentWorkspaceId !== undefined &&
    (projectHost?.kind !== 'local' || agentWorkspace?.hostId === workspace.hostId)
  if (settingsArrangement) {
    const label = agentHost?.label ?? agentWorkspace?.hostId ?? 'Unknown device'
    return <div className="launcher-agent-device" data-arrangement="settings">
      <span className="launcher-agent-device__read"><span>Runs on</span><strong>{label}</strong>
        <code title={agentWorkspace?.path}>{agentWorkspace?.path ?? 'Startup directory unavailable'}</code></span>
      <button type="button" className="launcher-agent-device__action" disabled={disabled}
        onClick={() => onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: null })}>Use project device</button>
      {onEditArrangement ? <button type="button" className="launcher-agent-device__action" onClick={onEditArrangement}>Remote Agents</button> : null}
    </div>
  }
  // A single configured device or a remote project leaves nothing to choose here.
  if (projectHost?.kind !== 'local' || hosts.length < 2) return null
  async function choose(hostId: string) {
    cancel(); setFailure(null)
    if (!workspace || !hostId) return
    if (hostId === workspace.hostId) { onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: null }); return }
    const controller = new AbortController()
    request.current = controller; setPendingHost(hostId); onPreparingChange(true)
    try {
      const directory = await useAppStore.getState().prepareAgentHostWorkspace(hostId, { signal: controller.signal })
      if (controller.signal.aborted || request.current !== controller) return
      onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: directory.id })
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setFailure({ hostId, message: cause instanceof Error ? cause.message : 'The Agent device could not be prepared.' })
    } finally { if (request.current === controller) { request.current = null; setPendingHost(null); onPreparingChange(false) } }
  }
  const current = pendingHost ?? agentWorkspace?.hostId ?? workspace.hostId
  const options = hosts.map(host => ({ value: host.id, icon: <HostIcon kind={host.kind} size={13} />,
    label: `${host.label}${hosts.some(other => other.id !== host.id && other.label === host.label) ? ` · ${host.id}` : ''}`,
    ...(host.id === workspace.hostId ? { description: 'Project device' } : {}) }))
  return <div className="launcher-agent-device" data-pending={pendingHost !== null || undefined}>
    <span className="launcher-agent-device__label" aria-hidden="true">Runs on</span>
    <SelectionField label="Runs on" value={current} options={options} disabled={disabled || !active}
      onValueChange={hostId => { if (hostId !== current) void choose(hostId) }} />
    {pendingHost ? <span className="launcher-agent-device__status" role="status">Preparing…</span>
      : failure ? <span className="launcher-agent-device__status" role="status" data-state="failed">{failure.message}
        <button type="button" className="launcher-agent-device__action" onClick={() => void choose(failure.hostId)}>Retry</button></span> : null}
  </div>
}
