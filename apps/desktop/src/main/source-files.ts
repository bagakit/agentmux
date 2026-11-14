import { AgentMuxError, readSpaceSnapshot, type AgentMuxRpcClient } from '@agentmux/core'
import type { SpaceMountRecord } from '../shared/space-mount.js'
import type { SourceFilesResolution, SourceFilesSelection } from '../shared/source-files.js'

/** Readonly composition of the original Source's graph, directory and Files owners. */
export async function resolveSourceFiles(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>,
  target: { hostId: string; expectedRuntimeId: string }, selection: SourceFilesSelection, signal?: AbortSignal): Promise<SourceFilesResolution> {
  const unconfirmed = (code: string, message: string): SourceFilesResolution => ({ status: 'unconfirmed', issue: { code, message } })
  const context = signal ? { signal } : {}
  let mount: SpaceMountRecord
  if (selection.kind === 'directory') {
    const observation = await rpc.call('space.folder.inspect', { runtimeId: target.expectedRuntimeId, path: selection.path,
      ...(selection.expectedResource ? { expectedResource: selection.expectedResource } : {}) }, context)
    if (!observation.resource) return unconfirmed(observation.issue?.code ?? 'CONTROL_UNAVAILABLE', observation.issue?.message ?? 'The original Source directory is unconfirmed.')
    if (selection.registration) {
      const chosen = selection.registration
      const found = observation.registrations.find(value => value.reference.runtimeId === chosen.reference.runtimeId &&
        value.reference.spaceId === chosen.reference.spaceId && value.zoneId === chosen.zoneId && value.workspaceId === chosen.workspaceId)
      if (!found || chosen.hostId !== target.hostId) return unconfirmed('SPACE_RESOURCE_CHANGED', 'The selected original Source registration is unconfirmed. Existing work is retained.')
      mount = { hostId: target.hostId, reference: found.reference, zoneId: found.zoneId, workspaceId: found.workspaceId }
    } else if (observation.registrations.length === 0 && observation.issue) {
      return unconfirmed(observation.issue.code, observation.issue.message)
    } else if (observation.registrations.length === 0) {
      return { status: 'registration-required', registration: { runtimeId: target.expectedRuntimeId, directory: observation.resource } }
    } else if (observation.registrations.length !== 1 || observation.issue) {
      return { status: 'selection-required', registrations: observation.registrations, ...(observation.issue ? { issue: observation.issue } : {}) }
    } else {
      const found = observation.registrations[0]!
      mount = { hostId: target.hostId, reference: found.reference, zoneId: found.zoneId, workspaceId: found.workspaceId }
    }
  } else if (selection.kind === 'mount') mount = selection.mount
  else throw new AgentMuxError('Choose an exact original Source directory or mount.', 'INVALID_CONTROL_REQUEST')
  if (mount.hostId !== target.hostId || mount.reference.runtimeId !== target.expectedRuntimeId) throw new AgentMuxError(
    'This Files mount belongs to another original Source. Both working surfaces are retained.', 'RUNTIME_OWNER_MISMATCH')
  const snapshot = await readSpaceSnapshot(rpc, mount.reference, context)
  const zone = snapshot.scope.zones.find(value => value.zoneId === mount.zoneId && value.workspaceId === mount.workspaceId)
  if (!zone || !zone.hostId || !zone.directoryPath) return unconfirmed('SPACE_RESOURCE_CHANGED', 'The original Source Zone resource is unconfirmed. Existing work is retained.')
  const resources = await rpc.call('app.snapshot', { include: ['workspaces'] }, context)
  const workspaces = resources.workspaces.filter(value => value.workspaceId === mount.workspaceId && value.hostId === zone.hostId)
  if (workspaces.length !== 1) return unconfirmed('SPACE_RESOURCE_CHANGED', 'Choose the exact original Source Workspace. Existing work is retained.')
  const workspace = workspaces[0]!
  const observed = await rpc.call('file.stat', { zoneId: zone.zoneId, spaceId: mount.reference.spaceId, path: '.',
    expectedResource: { hostId: workspace.hostId, workspaceId: mount.workspaceId, workspacePath: workspace.path } }, context)
  if (!observed.resource || observed.result.status !== 'observed') return unconfirmed(
    observed.result.status === 'observed' ? 'CONTROL_UNAVAILABLE' : observed.result.code,
    observed.result.status === 'observed' ? 'The original Source Files resource is unconfirmed.' : observed.result.message)
  return { status: 'located', locator: { mount, resource: observed.resource } }
}
