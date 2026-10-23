import { createHash } from 'node:crypto'
import {
  AgentMuxError,
  parseFileReadResult,
  parseMoteAvatarWriteResult,
  type AgentMuxRpcFilesOwner,
  type AgentMuxRpcMoteAvatarsOwner,
  type MoteConnectionSource
} from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { PreparedMoteConnectionSource } from '@agentmux/connectors'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { directoryIdentity, homeZoneId } from '../shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID, topicPublicCopy, type ScratchDirectoryFact } from '../shared/scratch-topics.js'

const unconfirmed = () =>
  new AgentMuxError(
    'The exact saved Mote profile is unconfirmed. Its original files, conversations and robot remain available. Refresh that Mote before starting this request.',
    'MOTE_CONNECTION_SOURCE_UNCONFIRMED'
  )
/** Reads the original public topic and current appearance, including its neutral static image. Personality and drafts are outside this source. */
export class MoteConnectionSourceOwner {
  constructor(
    private readonly ports: {
      catalog(): Promise<AgentMuxSpaceCatalog | null>
      workspace(id: string): WorkspaceRecord | undefined
      topicForDirectory(workspace: WorkspaceRecord, directory: string): Promise<ScratchDirectoryFact | null>
      files: AgentMuxRpcFilesOwner
      avatars: AgentMuxRpcMoteAvatarsOwner
    }
  ) {}
  private async original(source: MoteConnectionSource) {
    const catalog = await this.ports.catalog(),
      target = source.target
    const spaces = catalog?.spaces.filter((s) => s.spaceId === target.spaceId),
      zones = catalog?.zones.filter((z) => z.zoneId === target.zoneId)
    const mote = spaces?.length === 1 ? spaces[0] : null,
      zone = zones?.length === 1 ? zones[0] : null
    const workspace = this.ports.workspace(target.expectedResource.workspaceId)
    if (
      !mote ||
      mote.kind !== 'mote' ||
      !zone ||
      zone.kind !== 'home' ||
      zone.zoneId !== homeZoneId(mote.spaceId) ||
      !workspace ||
      workspace.id !== SCRATCH_WORKSPACE_ID ||
      workspace.hostId !== target.expectedResource.hostId ||
      workspace.path !== target.expectedResource.workspacePath ||
      mote.hostId !== workspace.hostId ||
      zone.hostId !== workspace.hostId ||
      zone.workspaceId !== workspace.id ||
      !mote.directoryPath ||
      !catalog?.bindings.some((b) => b.spaceId === mote.spaceId && b.zoneId === zone.zoneId)
    )
      throw unconfirmed()
    const fact = await this.ports.topicForDirectory(workspace, mote.directoryPath)
    if (
      !fact ||
      fact.id !== mote.topicId ||
      !fact.confirmedDirectoryPaths?.includes(mote.directoryPath) ||
      (!fact.identityDirectoryPath || directoryIdentity(workspace.hostId, fact.identityDirectoryPath)) !== mote.spaceId ||
      !zone.directoryPath ||
      !fact.confirmedDirectoryPaths?.includes(zone.directoryPath)
    )
      throw unconfirmed()
    return { workspace, fact }
  }
  async read(source: MoteConnectionSource, avatar: 'include-saved' | 'omit'): Promise<PreparedMoteConnectionSource> {
    try {
      const { workspace, fact } = await this.original(source)
      const input = { ...source.target, path: 'topic.md' },
        saved = parseFileReadResult(await this.ports.files.read(input), input)
      if (saved.result.status !== 'read' || saved.result.document.revision !== source.expectedTopicRevision) throw unconfirmed()
      const copy = topicPublicCopy(saved.result.document.content)
      if (!copy.title) throw unconfirmed()
      let pngDataUrl: string | null = null,
        avatarSha256: string | null = null
      if (avatar === 'include-saved') {
        const input = { target: { workspaceId: workspace.id, topicId: fact.id, objectKey: source.target.spaceId } }
        const saved = parseMoteAvatarWriteResult(
          'space.mote.avatar.read',
          await this.ports.avatars.call('space.mote.avatar.read', input),
          input
        )
        if (saved.revision !== source.expectedAvatarRevision || !saved.image) throw unconfirmed()
        const bytes = Buffer.from(saved.image.dataUrl.slice(22), 'base64')
        if (
          bytes.length > 512 * 1024 ||
          bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR' ||
          bytes.readUInt32BE(16) !== 256 ||
          bytes.readUInt32BE(20) !== 256 ||
          bytes.toString('base64') !== saved.image.dataUrl.slice(22)
        )
          throw unconfirmed()
        pngDataUrl = saved.image.dataUrl
        avatarSha256 = createHash('sha256').update(bytes).digest('hex')
      }
      await this.original(source)
      return { name: copy.title, description: copy.summary || null, avatarSha256, pngDataUrl }
    } catch {
      throw unconfirmed()
    }
  }
}
