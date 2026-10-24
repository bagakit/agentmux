import { AgentMuxError } from '@agentmux/core'
import { isAbsolute } from 'node:path'
import { isMoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { parseMoteAvatarTarget, type MoteAvatarTarget, type MoteAvatarRead } from '@agentmux/core/mote-avatar-write'
import { ScratchTopics, readOriginalMoteConfiguration, type ScratchWorkspace } from './mote-resources.js'
import { AVATAR_EDGE, isObjectAvatarRef } from './object-avatars.js'
import { readObjectAvatarFile, objectAvatarImageSize, assertObjectAvatarSize } from './object-avatar-files.js'
import { readMoteAvatarOperation, savedMoteAvatarSnapshot } from './mote-avatar-state.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unconfirmed = (): never => { throw new AgentMuxError(
  'The original local Mote avatar resource is unconfirmed. Its saved appearance, files and existing conversations are retained.', 'MOTE_AVATAR_SOURCE_UNCONFIRMED') }

/** Read the original saved PNG only; generation, editing and series remain with their existing owner. */
export function createHostMoteAvatarRead(options: { configurationPath: string }) {
  const topics = new ScratchTopics()
  async function configuration(target: MoteAvatarTarget) {
    const raw = await readOriginalMoteConfiguration(options.configurationPath)
    if (!record(raw) || !Array.isArray(raw.workspaces)) return unconfirmed()
    const found = raw.workspaces.filter(value => record(value) && value.id === target.workspaceId)
    if (found.length !== 1 || !record(found[0]) || found[0].hostId !== 'local' || typeof found[0].path !== 'string' || !isAbsolute(found[0].path)) return unconfirmed()
    const workspace: ScratchWorkspace = { id: target.workspaceId, hostId: found[0].hostId, path: found[0].path }
    const appearance = raw.appearance ?? {}
    if (!record(appearance) || appearance.spaceObjectIcons !== undefined && !record(appearance.spaceObjectIcons) ||
      appearance.spaceObjectIconRevisions !== undefined && !record(appearance.spaceObjectIconRevisions)) return unconfirmed()
    return { workspace, current: savedMoteAvatarSnapshot(appearance as {
      spaceObjectIcons?: Record<string, unknown>; spaceObjectIconRevisions?: Record<string, unknown>
    }, target.objectKey) }
  }
  return { async read(raw: MoteAvatarTarget, operationId?: string): Promise<MoteAvatarRead> {
    const target = parseMoteAvatarTarget(raw), original = await configuration(target)
    const directory = await topics.avatarTargetDirectory(original.workspace, target.topicId, target.objectKey)
    const result: MoteAvatarRead = { target, ...original.current, issues: [] }
    if (operationId !== undefined) {
      const operation = await readMoteAvatarOperation(directory, target, operationId)
      if (operation) result.operation = operation
    }
    const choice = original.current.choice
    const ref = isMoteAvatarSeriesChoice(choice) ? choice.image : isObjectAvatarRef(choice) ? choice : undefined
    if (!ref) {
      throw new AgentMuxError('This saved appearance has no immutable PNG available to the Node Host. Its original choice and existing editor are retained; text delivery remains available.', 'MOTE_AVATAR_SOURCE_UNAVAILABLE')
    }
    try {
      const png = await readObjectAvatarFile(directory, ref), size = objectAvatarImageSize(png, 'image/png')
      assertObjectAvatarSize(size)
      if (size.width !== AVATAR_EDGE || size.height !== AVATAR_EDGE) throw new Error('The saved avatar is not its original 256 pixel PNG crop.')
      const after = await configuration(target)
      const currentDirectory = await topics.avatarTargetDirectory(after.workspace, target.topicId, target.objectKey)
      if (after.workspace.hostId !== original.workspace.hostId || after.workspace.path !== original.workspace.path ||
        currentDirectory !== directory || after.current.revision !== original.current.revision) {
        const issue = 'The original Mote appearance changed while its PNG was being read. Read the same Mote again; the original choice and text remain available.'
        result.source = { state: 'changed', issue }; result.issues.push(issue)
        return result
      }
      result.image = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), ...size }
      if (isMoteAvatarSeriesChoice(choice)) result.source = { state: 'unavailable', issue: 'This Node Host reads the original saved PNG; the original avatar series source is not checked here.' }
    } catch (error) {
      const issue = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
      result.source = { state: 'unavailable', issue }; result.issues.push(issue)
    }
    return result
  } }
}
