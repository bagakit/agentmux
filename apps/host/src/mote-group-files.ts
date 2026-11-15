import { lstat } from 'node:fs/promises'
import { posix } from 'node:path'
import { AgentMuxError, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { FILE_LIST_MAX_RESULT_BYTES, type FileDirectoryEntry, type FileReadResource } from '@agentmux/core/files'
import type { WorkspaceRecord } from './content-types.js'
import { zoneFileResource } from './file-resource.js'
import type { HostMoteGroupFiles } from './mote-group.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import type { ScratchTopics } from './mote-resources.js'
import type { OrdinaryWorkspaceFiles } from './ordinary-files.js'

/** A Group shares exactly the original Topic root, including when its Zone is displayed under a category. */
export function createHostMoteGroupFiles(options: {
  spatial: AgentMuxSpatialStateStore
  workspace(id: string): Promise<WorkspaceRecord | undefined>
  topics: Pick<ScratchTopics, 'readForDirectory' | 'topicAppearanceIdentity'>
  files: OrdinaryWorkspaceFiles
}): HostMoteGroupFiles {
  const unknown = (message: string): never => { throw new AgentMuxError(message, 'MOTE_GROUP_TOPIC_UNCONFIRMED') }
  async function scope(target: MotePreferencesTarget, path: string) {
    const expected = target.expectedResource
    const [state, workspace] = await Promise.all([options.spatial.read(), options.workspace(expected.workspaceId)])
    const graph = state?.graph
    const zones = graph?.zones.filter(zone => zone.zoneId === target.zoneId) ?? []
    const zone = zones.length === 1 ? zones[0] : undefined
    const origin = graph?.resources['zone:' + target.zoneId]
    if (!workspace || workspace.id !== SCRATCH_WORKSPACE_ID || workspace.hostId !== 'local' ||
        workspace.hostId !== expected.hostId || workspace.path !== expected.workspacePath || !graph ||
        !zone || zone.kind !== 'home' || zone.hostId !== workspace.hostId || zone.workspaceId !== workspace.id || !zone.directoryPath ||
        !origin || typeof origin !== 'object' || Array.isArray(origin) || origin.contentKind !== 'topic' ||
        typeof origin.topicId !== 'string' || typeof origin.spaceId !== 'string' || origin.workspaceId !== workspace.id ||
        target.spaceId !== origin.topicId && target.spaceId !== origin.spaceId &&
        !graph.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === target.spaceId &&
          graph.spaces.some(space => space.spaceId === binding.spaceId && space.kind === 'container' && space.hostId === workspace.hostId))) {
      return unknown('Choose the exact original Topic and its saved Host, Workspace and home Zone.')
    }
    const fact = await options.topics.readForDirectory(workspace, zone.directoryPath)
    if (!fact?.physicalDirectoryPath || fact.id !== origin.topicId || !fact.identityDirectoryPath || !fact.confirmedDirectoryPaths?.includes(zone.directoryPath))
      return unknown('The original Topic directory identity is unconfirmed. Keep its saved Group binding.')
    const identity = await options.topics.topicAppearanceIdentity(workspace, fact.id, origin.spaceId)
      .catch(() => unknown('The exact Topic is no longer confirmed as an ordinary Topic. Keep its saved Group binding.'))
    if (identity.identityDirectoryPath !== fact.identityDirectoryPath)
      return unknown('The original Topic directory identity changed. Keep its saved Group binding.')
    const mapped = zoneFileResource(workspace, zone, path, [fact])
    const physical = { id: target.spaceId, hostId: workspace.hostId, path: identity.physicalDirectoryPath }
    const witness = await lstat(physical.path, { bigint: true })
    if (!witness.isDirectory() || witness.isSymbolicLink()) return unknown('The original Topic root cannot be confirmed as a physical directory.')
    const resource: FileReadResource = { ...expected, zoneId: zone.zoneId, zonePath: mapped.directoryPath, path: mapped.path,
      ...(mapped.logicalDirectory === undefined ? {} : { logicalDirectory: mapped.logicalDirectory }) }
    return { physical, resource, witness }
  }

  async function observe<T>(target: MotePreferencesTarget, path: string, read: (original: Awaited<ReturnType<typeof scope>>) => Promise<T>): Promise<T> {
    const original = await scope(target, path)
    const value = await read(original)
    const current = await scope(target, path)
    if (current.physical.path !== original.physical.path || current.resource.path !== original.resource.path ||
        current.witness.dev !== original.witness.dev || current.witness.ino !== original.witness.ino)
      return unknown('The original Topic root changed during the read. Discover its current binding before requesting the file.')
    return value
  }

  return {
    confirm: async target => { await scope(target, '.') },
    read: input => observe(input, input.path, async ({ physical, resource }) => {
      const result = await options.files.read(physical, input.path, { maxFileBytes: input.maxBytes ?? 256 * 1024 }, true)
      if (result.status === 'read') result.document.path = resource.path
      if (result.status === 'binary') result.path = resource.path
      return { resource, result }
    }),
    list: input => observe(input, input.path, async ({ physical, resource }) => {
      const directory = await options.files.readDirectory(physical, input.path, true)
      const entries: FileDirectoryEntry[] = []
      let bytes = Buffer.byteLength(JSON.stringify(resource)) + 512
      for (const { linkTarget: _target, linkIssue: _issue, ...original } of directory) {
        const entry = { ...original, path: posix.join(resource.path, original.name) }
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1
        if (entries.length >= (input.limit ?? 20000) || bytes + size > FILE_LIST_MAX_RESULT_BYTES) break
        entries.push(entry); bytes += size
      }
      const complete = entries.length === directory.length
      return { resource, result: { status: 'directory-listed', entries, complete, partialReason: complete ? null : 'limit' } }
    })
  }
}
