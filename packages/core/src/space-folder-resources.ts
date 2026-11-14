import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { folderResourceIdentity, parseFolderDirectoryResource, type FolderDirectoryResource, type FolderSpaceResource } from './space-folder.js'
import type { AgentMuxSpatialGraph } from './spatial-graph.js'

const prefix = 'owned:folder-directory:'
export const folderDirectoryResourceKey = (workspaceId: string): string => prefix + workspaceId
/** Resource identity and the directory observed at admission, not an execution grant. */
export type FolderDirectoryFact = {
  runtimeId: string; resource: FolderSpaceResource; directory: FolderDirectoryResource; spaceId: string; zoneId: string
}
const text = (v: unknown): v is string => typeof v === 'string' && !!v && !v.includes('\0')
export function folderDirectoryFacts(graph: AgentMuxSpatialGraph): { folders: FolderDirectoryFact[]; issues: Array<{ key: string; code: string; message: string }> } {
  const folders: FolderDirectoryFact[] = [], issues: Array<{ key: string; code: string; message: string }> = []
  const spaces = new Map(graph.spaces.map(s => [s.spaceId,s])), zones = new Map(graph.zones.map(z => [z.zoneId,z]))
  const bindings = new Set(graph.bindings.map(b => JSON.stringify([b.spaceId,b.zoneId])))
  for (const [key, value] of Object.entries(graph.resources)) {
    if (!key.startsWith(prefix)) continue
    try {
      const p = rpcRecord(value, ['runtimeId', 'resource', 'directory', 'spaceId', 'zoneId'], 'SPACE_RESOURCE_UNAVAILABLE')
      const r = rpcRecord(p.resource, ['id', 'hostId', 'path', 'name', 'kind', 'repoPath', 'branch'], 'SPACE_RESOURCE_UNAVAILABLE')
      if (![p.runtimeId, p.spaceId, p.zoneId, r.id, r.hostId, r.path, r.name].every(text) ||
        r.kind !== undefined && typeof r.kind !== 'string' || r.repoPath !== undefined && typeof r.repoPath !== 'string' || r.branch !== undefined && typeof r.branch !== 'string') throw Error('The original Folder resource record is unreadable.')
      const resource = r as FolderSpaceResource, directory = parseFolderDirectoryResource(p.directory, 'SPACE_RESOURCE_UNAVAILABLE'), identity = folderResourceIdentity(resource)
      const space = spaces.get(String(p.spaceId)), zone = zones.get(String(p.zoneId))
      if (key !== folderDirectoryResourceKey(resource.id) || identity.hostId !== directory.hostId || identity.workspacePath !== directory.workspacePath || identity.projectRootPath !== directory.projectRootPath ||
        space?.kind !== 'folder' || space.hostId !== directory.hostId || space.directoryPath !== directory.projectRootPath ||
        zone?.workspaceId !== resource.id || zone.hostId !== directory.hostId || zone.directoryPath !== directory.workspacePath ||
        !bindings.has(JSON.stringify([p.spaceId,p.zoneId]))) throw Error('The original Folder resource no longer matches its Space and Zone. Keep its identities and inspect this resource.')
      folders.push({ runtimeId: p.runtimeId as string, resource: { ...resource, name: space.name }, directory, spaceId: p.spaceId as string, zoneId: p.zoneId as string })
    } catch (cause) { issues.push({ key, code: cause instanceof AgentMuxError ? cause.code : 'SPACE_RESOURCE_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) }) }
  }
  return { folders, issues }
}
