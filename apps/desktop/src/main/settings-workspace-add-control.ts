import { randomUUID } from 'node:crypto'
import type {
  AgentMuxControlSettingsWorkspaceAddRequest,
  AgentMuxControlResult
} from '@agentmux/core'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { createWorkspaceInputSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import { insertOrGetWorkspace } from './workspace-location.js'

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_SETTING_VALUE' })
}

/** Registration uses the current committed config, never a pre-queue insertion snapshot. */
export async function registerWorkspace(
  value: unknown,
  owner: ConfigOwner,
  executionHost: (hostId: string) => unknown
): Promise<{ workspace: WorkspaceRecord; changed: boolean }> {
  const parsed = createWorkspaceInputSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.code}`)
    invalid(`Invalid project: ${issues.join('; ')}.`)
  }
  const input = parsed.data
  let selectedId: string | undefined
  let changed = false
  const saved = await owner.update(current => {
    if (!current.hosts.some(host => host.id === input.hostId)) invalid(`Host “${input.hostId}” is not configured.`)
    try {
      executionHost(input.hostId)
    } catch {
      invalid(`Host “${input.hostId}” is unavailable. Review Hosts settings before adding this project.`)
    }
    const insertion = insertOrGetWorkspace(current, {
      id: randomUUID(),
      name: input.name?.trim() || input.path.split(/[\\/]/).filter(Boolean).pop() || input.path,
      hostId: input.hostId,
      path: input.path,
      kind: 'folder'
    })
    selectedId = insertion.workspace.id
    changed = insertion.inserted
    return insertion.config
  })
  const workspace = saved.workspaces.find(item => item.id === selectedId)
  if (!workspace) throw new Error('Committed project registration is missing.')
  return { workspace: structuredClone(workspace), changed }
}

export async function executeSettingsWorkspaceAddControl(
  request: AgentMuxControlSettingsWorkspaceAddRequest,
  owner: ConfigOwner,
  executionHost: (hostId: string) => unknown
): Promise<Extract<AgentMuxControlResult, { operation: 'settings.workspaces.add' }>> {
  const { workspace: { id, ...value }, changed } = await registerWorkspace(request.input, owner, executionHost)
  return { operation: request.operation, item: { id, value }, changed }
}
