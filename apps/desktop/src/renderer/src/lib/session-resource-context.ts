import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { agentWorkPlacement } from './agent-work-mode'
import { workspaceOwnsSessionPath, type ScratchTopicSnapshot } from '@agentmux/host/mote-model'

export type SessionResourceContext = {
  workspace?: WorkspaceRecord
  address?: { hostId: string; path: string }
  issue?: string
}

type ResourceSession = Pick<SessionSnapshot, 'hostId' | 'workspacePath'> & (
  { kind: 'terminal' } | Pick<Extract<SessionSnapshot, { kind: 'agent' }>, 'kind' | 'control' | 'toolExecution' | 'workPlacement'>
)

/** Project-file address only; native input, Skills and history retain their Session owner. */
export function sessionResourceContext(config: AppConfig | null, session: ResourceSession | undefined,
  topics?: readonly ScratchTopicSnapshot[] | null, preferredWorkspaceId?: string): SessionResourceContext {
  if (!session) return {}
  if (session.kind !== 'agent' || !session.toolExecution) {
    const workspace = config?.workspaces.find(item => workspaceOwnsSessionPath(item, session, topics))
    return workspace ? { workspace, address: { hostId: workspace.hostId, path: workspace.path } } : {}
  }
  const placement = agentWorkPlacement(session, null)
  if (!placement.projectHostId) return { issue: 'The original project Host is unconfirmed on this device. Your draft and Agent are kept; reconnect its original Host to use Files.' }
  const address = { hostId: placement.projectHostId, path: session.toolExecution.workspacePath }
  const matches = config?.workspaces.filter(item => item.hostId === address.hostId && item.path === address.path) ?? []
  const workspace = matches.find(item => item.id === preferredWorkspaceId) ?? (matches.length === 1 ? matches[0] : undefined)
  return workspace ? { workspace, address } : { address,
    issue: 'The original project file Workspace is unconfirmed. Your draft and Agent are kept; restore its registered project to use Files.' }
}
