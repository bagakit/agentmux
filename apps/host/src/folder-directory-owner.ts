import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { AgentMuxError, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { folderResourceIdentity, type FolderDirectoryInspectInput, type FolderDirectoryInspection, type FolderDirectoryRegistration, type FolderDirectoryResource,
  type FolderSpaceReceipt } from '@agentmux/core/space-folder'
import { folderDirectoryFacts } from '@agentmux/core/space-folder-resources'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { SpaceAuthoritySource } from '@agentmux/core'
import { localExistingPathWithin } from './ordinary-files.js'
import type { HostWorkspaceResources } from './workspace-resources.js'

type Context = { signal?: AbortSignal; assertCurrent?(): void | Promise<void> }
const changed = (): never => { throw new AgentMuxError('The original directory changed. Keep this selection and inspect the same Source directory before another registration.', 'SPACE_DIRECTORY_CHANGED') }
const same = (a: FolderDirectoryResource, b: FolderDirectoryResource) => a.hostId === b.hostId && a.workspacePath === b.workspacePath && a.projectRootPath === b.projectRootPath &&
  a.witness.realPath === b.witness.realPath && a.witness.device === b.witness.device && a.witness.inode === b.witness.inode
/** Directory IO remains at the original Files owner; these observations grant no execution or sharing rights. */
export function createHostFolderDirectoryOwner(resources: HostWorkspaceResources, spatial: AgentMuxSpatialStateStore) {
  async function withDirectory<T>(path: string, context: Context, use: (witness: FolderDirectoryResource['witness'], current: () => Promise<void>) => Promise<T>) {
    if (!isAbsolute(path)) throw new AgentMuxError('Choose an absolute directory on its original Source.', 'INVALID_CONTROL_REQUEST')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const resolved = await localExistingPathWithin(path, '.'), handle = await open(resolved.target, 'r')
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isDirectory()) throw new AgentMuxError('The selected Source path is not a directory. Existing work is retained.', 'SPACE_DIRECTORY_REQUIRED')
      const witness = { realPath: resolved.target, device: String(stat.dev), inode: String(stat.ino) }
      const current = async () => {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        const named = await localExistingPathWithin(path, '.'), check = await open(named.target, 'r')
        try { const info = await check.stat({ bigint: true }); if (!info.isDirectory() || named.target !== witness.realPath || String(info.dev) !== witness.device || String(info.ino) !== witness.inode) changed() }
        finally { await check.close() }
      }
      await current(); return await use(witness,current)
    } finally { await handle.close() }
  }
  function projectRoot(path: string, workspaces: Awaited<ReturnType<HostWorkspaceResources['read']>>['workspaces'], graph: AgentMuxSpatialGraph | undefined) {
    const roots = new Set(workspaces.filter(r => !r.closeout && r.hostId === 'local' && r.path === path).map(r => r.repoPath ?? r.path))
    const zones = new Map(graph?.zones.map(z => [z.zoneId,z])), spaces = new Map(graph?.spaces.map(s => [s.spaceId,s]))
    if (graph) for (const binding of graph.bindings) {
      const zone = zones.get(binding.zoneId), space = spaces.get(binding.spaceId)
      if (zone?.hostId === 'local' && zone.directoryPath === path && space?.kind === 'folder' && space.hostId === 'local') roots.add(space.directoryPath)
    }
    if (roots.size > 1) throw new AgentMuxError('This directory has several original Project roots. Choose its exact configured Workspace.', 'SPACE_REGISTRATION_AMBIGUOUS')
    return roots.size ? [...roots][0]! : path
  }
  return {
    async inspect(input: FolderDirectoryInspectInput, source: SpaceAuthoritySource, context: Context = {}): Promise<FolderDirectoryInspection> {
      try {
        return await withDirectory(input.path,context,async (witness,current) => {
          const catalogue = await resources.read(), state = await spatial.read(), graph = state?.graph
          const resource: FolderDirectoryResource = { hostId: 'local', workspacePath: input.path, projectRootPath: projectRoot(input.path,catalogue.workspaces,graph), witness }
          if (input.expectedResource && !same(resource,input.expectedResource)) changed()
          const owned = graph ? folderDirectoryFacts(graph) : { folders: [], issues: [] }
          const registrations: FolderDirectoryInspection['registrations'] = []
          const spaces = new Map(graph?.spaces.map(s => [s.spaceId,s])), zones = new Map(graph?.zones.map(z => [z.zoneId,z])), byWorkspace = new Map(owned.folders.map(f => [f.resource.id,f]))
          if (graph && state) for (const binding of graph.bindings) {
            const space = spaces.get(binding.spaceId), zone = zones.get(binding.zoneId)
            if (space?.kind !== 'folder' || space.hostId !== resource.hostId || space.directoryPath !== resource.projectRootPath ||
              zone?.hostId !== resource.hostId || zone.directoryPath !== resource.workspacePath) continue
            const fact = byWorkspace.get(zone.workspaceId)
            if (fact && (fact.runtimeId !== source.runtimeId || !same(fact.directory,resource))) continue
            registrations.push({ reference: { runtimeId: source.runtimeId, spaceId: space.spaceId }, source, zoneId: zone.zoneId, workspaceId: zone.workspaceId,
              revision: state.revision, resource: folderResourceIdentity({ id: zone.workspaceId, name: space.name, hostId: resource.hostId, path: resource.workspacePath, repoPath: resource.projectRootPath }),
              ...(fact ? { directory: fact.directory } : {}) })
          }
          await current()
          return { source, resource, registrations, ...(!catalogue.complete || owned.issues.length ? { issue: { code: 'SPACE_RESOURCE_UNAVAILABLE', message: 'Some original resource metadata is unavailable. Current directory observation does not select or register a replacement resource.' } } : {}) }
        })
      } catch (cause) {
        return { source, resource: null, registrations: [], issue: { code: cause instanceof AgentMuxError ? cause.code : typeof (cause as NodeJS.ErrnoException)?.code === 'string' ? (cause as NodeJS.ErrnoException).code! : 'SPACE_DIRECTORY_UNAVAILABLE',
          message: cause instanceof Error ? cause.message : String(cause) } }
      }
    },
    async register(input: FolderDirectoryRegistration, source: SpaceAuthoritySource, context: Context = {}): Promise<FolderSpaceReceipt> {
      return await withDirectory(input.directory.workspacePath,context,async (witness,current) => {
        if (!same({ ...input.directory,witness },input.directory)) changed()
        const saved = await spatial.registerDirectory(input,async graph => {
          const catalogue = await resources.read(), matching = catalogue.workspaces.filter(r => !r.closeout && r.hostId === input.directory.hostId && r.path === input.directory.workspacePath && (r.repoPath ?? r.path) === input.directory.projectRootPath)
          if (projectRoot(input.directory.workspacePath,catalogue.workspaces,graph) !== input.directory.projectRootPath) changed()
          if (!catalogue.complete && !matching.length) throw new AgentMuxError('Original resource metadata is unavailable for this new directory. Keep its frozen selection and inspect the Source; no replacement identity was minted.', 'SPACE_RESOURCE_UNAVAILABLE')
          return catalogue.workspaces.filter(r => !r.closeout)
        },current)
        await current()
        return { reference: { runtimeId: source.runtimeId, spaceId: saved.spaceId }, source, zoneId: saved.zoneId, workspaceId: saved.workspaceId,
          revision: saved.state.revision, created: saved.created, diskDurability: 'confirmed', resource: { hostId: input.directory.hostId, workspacePath: input.directory.workspacePath, projectRootPath: input.directory.projectRootPath }, directory: input.directory }
      })
    }
  }
}
