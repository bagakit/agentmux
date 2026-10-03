import type { AgentMuxZoneFact } from '@agentmux/core/control'
import type { WorkspaceRecord } from './contracts'

/** One mapping for public read and open; Files retains the physical read boundary. */
export function zoneFileResource(workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>, zone: AgentMuxZoneFact,
  requestedPath = ''): { directoryPath: string; relativeDirectory: string; path: string } {
  if (zone.kind === 'unknown' || zone.workspaceId !== workspace.id || zone.hostId !== workspace.hostId || !zone.directoryPath) {
    throw new Error('The Zone directory is not confirmed in the original Files scope.')
  }
  const root = workspace.path.replace(/\/+$/, '') || '/', directoryPath = zone.directoryPath.replace(/\/+$/, '') || '/'
  const prefix = root === '/' ? '/' : `${root}/`
  if (directoryPath !== root && !directoryPath.startsWith(prefix)) throw new Error('The confirmed Zone directory is outside the original Files scope.')
  const relativeDirectory = directoryPath === root ? '' : directoryPath.slice(prefix.length)
  if (relativeDirectory.split('/').some(segment => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('The confirmed Zone directory cannot be represented in the original Files scope.')
  }
  if (requestedPath && (requestedPath.startsWith('/') || /^[A-Za-z]:/.test(requestedPath) || requestedPath.includes('\\') ||
      requestedPath.includes('\0') || requestedPath.split('/').some(segment => segment === '..'))) throw new Error('Choose a relative path inside the selected Zone directory.')
  const relativePath = requestedPath.split('/').filter(segment => segment && segment !== '.').join('/')
  return { directoryPath, relativeDirectory, path: relativeDirectory && relativePath ? `${relativeDirectory}/${relativePath}` : relativeDirectory || relativePath || (requestedPath ? '.' : '') }
}
