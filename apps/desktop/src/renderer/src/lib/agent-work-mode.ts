import type { AgentWorkPlacement, AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'

export type AgentWorkMode = 'local' | 'remote-project' | 'remote-agent' | 'remote-workspace'
export type ObservedAgentWorkMode = AgentWorkMode | 'unknown'
export const AGENT_WORK_MODES = [
  { id: 'local', brand: 'Local', label: 'Local', description: 'Agent and project here.' },
  { id: 'remote-project', brand: 'Reach', label: 'Remote Project', description: 'Agent here · project remotely.' },
  { id: 'remote-agent', brand: 'Relay', label: 'Remote Agent', description: 'Project here · Agent remotely.' },
  { id: 'remote-workspace', brand: 'Orbit', label: 'Remote Workspace', description: 'Agent and project remotely.' }
] as const satisfies readonly { id: AgentWorkMode; brand: string; label: string; description: string }[]

/** The current Desktop's configured local route, never a displayed project's Host. */
export function workReferenceHostId(hosts: AppConfig['hosts']): string | null {
  return hosts.find(host => host.kind === 'local')?.id ?? null
}

/** Relative presentation only. No mode is stored or used to authorize execution. */
export function agentWorkMode(referenceHostId: string | null, agentHostId: string | null, projectHostId: string | null): ObservedAgentWorkMode {
  if (!referenceHostId || !agentHostId || !projectHostId) return 'unknown'
  if (agentHostId === referenceHostId) return projectHostId === referenceHostId ? 'local' : 'remote-project'
  return projectHostId === referenceHostId ? 'remote-agent' : 'remote-workspace'
}

export type AgentWorkSource = {
  hostId: string
  workspacePath: string
  control?: { hostId: string } | undefined
  /** A retained history descriptor may know the Agent Host without the original tool binding. */
  resourceUnobserved?: boolean | undefined
  workPlacement?: AgentWorkPlacement | undefined
  toolExecution?: Extract<SessionSnapshot, { kind: 'agent' }>['toolExecution'] | undefined
}

/** Main's Session/retained projection owns these addresses; absence of a binding is ordinary same-Host execution. */
export function agentWorkPlacement(source: AgentWorkSource, referenceHostId: string | null) {
  const agentHostId = source.workPlacement?.agentHostId ?? source.control?.hostId ?? source.hostId
  const projectHostId = source.resourceUnobserved ? null : source.toolExecution ? source.workPlacement?.resourceHostId ?? null : agentHostId
  return { mode: agentWorkMode(referenceHostId, agentHostId, projectHostId), agentHostId,
    agentPath: source.workspacePath, projectHostId, projectPath: source.resourceUnobserved ? '' : source.toolExecution?.workspacePath ?? source.workspacePath }
}

export function launcherWorkPlacement(project: WorkspaceRecord | undefined, agent: WorkspaceRecord | undefined, referenceHostId: string | null) {
  return { mode: agentWorkMode(referenceHostId, agent?.hostId ?? null, project?.hostId ?? null), agentHostId: agent?.hostId ?? null,
    agentPath: agent?.path ?? '', projectHostId: project?.hostId ?? null, projectPath: project?.path ?? '' }
}

export function agentWorkModeLabel(mode: ObservedAgentWorkMode): string {
  if (mode === 'unknown') return 'Placement unknown'
  const item = AGENT_WORK_MODES.find(item => item.id === mode)!
  return item.brand === item.label ? item.label : `${item.brand} · ${item.label}`
}

/** Labels help distinguish the original objects; they never change an address. */
export function workHostLabel(hosts: AppConfig['hosts'], id: string | null): string {
  const host = hosts.find(item => item.id === id)
  if (!host) return id ?? 'Host unknown'
  return hosts.some(other => other.id !== host.id && other.label === host.label) ? `${host.label} · ${host.id}` : host.label
}
