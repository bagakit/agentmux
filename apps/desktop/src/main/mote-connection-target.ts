import { AgentMuxError } from '@agentmux/core'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { directoryIdentity, homeZoneId } from '../shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID, type ScratchDirectoryFact } from '../shared/scratch-topics.js'

const unconfirmed = () =>
  new AgentMuxError(
    'The exact original Mote target is unconfirmed. Its original files, conversations and robot remain available. Refresh that Mote before starting this request.',
    'MOTE_CONNECTION_SOURCE_UNCONFIRMED'
  )
/** Qualifies the original Mote/home/workspace identity without reading its appearance or public copy. */
export class MoteConnectionTargetOwner {
  constructor(
    private readonly ports: {
      catalog(): Promise<AgentMuxSpaceCatalog | null>
      workspace(id: string): WorkspaceRecord | undefined
      topicForDirectory(workspace: WorkspaceRecord, directory: string): Promise<ScratchDirectoryFact | null>
    }
  ) {}
  async assertTarget(target: MotePreferencesTarget): Promise<void> {
    try {
      const catalog = await this.ports.catalog()
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
    } catch { throw unconfirmed() }
  }
}
