import type { AgentMuxZoneFact } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, type ScratchDirectoryFact } from './scratch-topics'
import { directoryIdentity, homeZoneId } from './space-addresses'
import type { WorkspaceRecord } from './contracts'

/** One mapping for public read and open; Files retains the physical read boundary. */
export function zoneFileResource(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, zone: AgentMuxZoneFact,
  requestedPath = '', topics: readonly ScratchDirectoryFact[] = []): { directoryPath: string; relativeDirectory: string; path: string; logicalDirectory?: string } {
  if (zone.kind === 'unknown' || zone.workspaceId !== workspace.id || zone.hostId !== workspace.hostId || !zone.directoryPath) {
    throw new Error('The Zone directory is not confirmed in the original Files scope.')
  }
  const root = workspace.path.replace(/\/+$/, '') || '/', directoryPath = zone.directoryPath.replace(/\/+$/, '') || '/'
  const prefix = root === '/' ? '/' : `${root}/`
  const outside = directoryPath !== root && !directoryPath.startsWith(prefix)
  const matches = outside && workspace.id === SCRATCH_WORKSPACE_ID ? topics.filter(topic => topic.identityDirectoryPath && topic.confirmedDirectoryPaths?.includes(directoryPath) &&
    homeZoneId(directoryIdentity(workspace.hostId, topic.identityDirectoryPath)) === zone.zoneId) : []
  if (outside && matches.length !== 1) throw new Error('The confirmed Zone directory is outside the original Files scope.')
  const relativeDirectory = outside ? scratchTopicDirectoryName(matches[0]!.id) : directoryPath === root ? '' : directoryPath.slice(prefix.length)
  if (relativeDirectory.split('/').some(segment => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('The confirmed Zone directory cannot be represented in the original Files scope.')
  }
  if (requestedPath && (requestedPath.startsWith('/') || /^[A-Za-z]:/.test(requestedPath) || requestedPath.includes('\\') ||
      requestedPath.includes('\0') || requestedPath.split('/').some(segment => segment === '..'))) throw new Error('Choose a relative path inside the selected Zone directory.')
  const relativePath = requestedPath.split('/').filter(segment => segment && segment !== '.').join('/')
  return { directoryPath, relativeDirectory, ...(outside ? { logicalDirectory: relativeDirectory } : {}), path: relativeDirectory && relativePath ? `${relativeDirectory}/${relativePath}` : relativeDirectory || relativePath || (requestedPath ? '.' : '') }
}
