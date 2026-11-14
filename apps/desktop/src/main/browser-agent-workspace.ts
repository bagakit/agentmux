import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, posix } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { BrowserAgentWorkspaceParams, BrowserAgentWorkspaceResult, BrowserAgentWorkspaceSource } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { ConfigOwner } from './config-owner.js'
import { registerWorkspace } from './settings-workspace-add-control.js'

export type BrowserAgentWorkspacePorts = {
  config: ConfigOwner
  browser(browserId: string): BrowserAgentWorkspaceSource | null
  profileLabel(profileId: string): string | undefined
  host(hostId: string): ExecutionHost
  home(hostId: string): Promise<string>
}
const sameSource = (a: Omit<BrowserAgentWorkspaceSource, 'browserId'>, b: Omit<BrowserAgentWorkspaceSource, 'browserId'>) =>
  a.workspaceId === b.workspaceId && a.mode === b.mode && a.profileId === b.profileId

/** Native Host effects occur before, and outside, the original configuration commit queue. */
export async function prepareSurveyDirectory(host: ExecutionHost, path: string): Promise<void> {
  if (host.kind === 'local') {
    await mkdir(path, { recursive: true })
    await access(path, constants.W_OK)
    return
  }
  const made = await host.run('mkdir', ['-p', '--', path])
  if (made.exitCode !== 0) throw new Error('The original Host could not confirm the Survey directory. Its page and files are kept.')
  const writable = await host.run('test', ['-d', path, '-a', '-w', path])
  if (writable.exitCode !== 0) throw new Error('The original Host could not confirm a writable Survey directory. Inspect that same Host and path.')
}

/** Browser/Profile chooses only execution resources; this operation never creates a Zone or Agent. */
export async function prepareBrowserAgentWorkspace(input: BrowserAgentWorkspaceParams, ports: BrowserAgentWorkspacePorts): Promise<BrowserAgentWorkspaceResult> {
  const source = ports.browser(input.browserId)
  if (!source || source.browserId !== input.browserId || input.expected && !sameSource(source, input.expected)) {
    throw new Error('The original Browser environment is unconfirmed or changed. Its page is kept; inspect that Browser before preparing its Agent directory.')
  }
  const resource = ports.config.current.workspaces.find(item => item.id === source.workspaceId)
  if (!resource) throw new Error('The original Browser resource is unconfirmed. No other Host or directory was selected.')
  const profileLabel = source.profileId ? ports.profileLabel(source.profileId) : undefined
  const base = { source, ...(profileLabel ? { profileLabel } : {}) }
  const selected = (workspace: typeof resource) => ({ id: workspace.id, name: workspace.name, hostId: workspace.hostId, path: workspace.path, kind: workspace.kind })
  // A normal null-Profile Capsule is its own resource, not a private/default Profile.
  if (source.workspaceId !== SCRATCH_WORKSPACE_ID || source.mode === 'normal' && source.profileId === null) {
    return { ...base, scope: 'existing', outcome: 'ready', directory: { hostId: resource.hostId, path: resource.path, status: 'not-required' },
      registration: 'confirmed', workspace: selected(resource) }
  }
  const scope = source.mode === 'private' ? 'survey-private' : 'survey-profile'
  const host = ports.host(resource.hostId)
  const paths = host.kind === 'local' ? { join } : posix
  let path: string | null = null
  let directory: BrowserAgentWorkspaceResult['directory']['status'] = 'unconfirmed'
  let registration: BrowserAgentWorkspaceResult['registration'] = 'not-attempted'
  let workspace: BrowserAgentWorkspaceResult['workspace'] = null
  let step: NonNullable<BrowserAgentWorkspaceResult['issue']>['step'] = 'directory'
  try {
    const home = await ports.home(resource.hostId)
    if (!home || !(host.kind === 'local' ? /^(?:\/|[A-Za-z]:[\\/])/u : /^\//u).test(home)) throw new Error('The original execution Host home is unconfirmed; no local home was substituted.')
    path = source.mode === 'private' ? paths.join(home, '.agentmux', 'survey', 'private', createHash('sha256').update(source.browserId).digest('hex'))
      : paths.join(home, '.agentmux', 'survey', encodeURIComponent(source.profileId!))
    await prepareSurveyDirectory(host, path)
    directory = 'confirmed'
    step = 'source'
    const current = ports.browser(input.browserId), currentResource = ports.config.current.workspaces.find(item => item.id === source.workspaceId)
    if (!current || !sameSource(current, source) || currentResource?.hostId !== resource.hostId || currentResource.path !== resource.path) {
      throw new Error('The Browser or its resource changed while the directory was being prepared. The directory is retained; inspect the current Browser before creating its Agent.')
    }
    step = 'registration'; registration = 'unconfirmed'
    const saved = await registerWorkspace({ hostId: resource.hostId, path }, ports.config, ports.host)
    workspace = selected(saved.workspace); registration = 'confirmed'
    step = 'source'
    const after = ports.browser(input.browserId), afterResource = ports.config.current.workspaces.find(item => item.id === source.workspaceId)
    if (!after || !sameSource(after, source) || afterResource?.hostId !== resource.hostId || afterResource.path !== resource.path) throw new Error('The Browser environment changed during directory registration. Its registered resource is retained; no Agent was created.')
    return { ...base, scope, outcome: 'ready', directory: { hostId: resource.hostId, path, status: directory }, registration, workspace }
  } catch (error) {
    return { ...base, scope, outcome: 'unconfirmed', directory: { hostId: resource.hostId, path, status: directory }, registration, workspace,
      issue: { step, message: error instanceof Error ? error.message : String(error) } }
  }
}
