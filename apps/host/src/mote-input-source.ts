import {
  AgentMuxError,
  spatialCatalog,
  type AgentInputMoteResolver,
  type AgentMuxSpatialStateStore
} from '@agentmux/core'
import type { AgentMuxRpcFilesOwner } from '@agentmux/core/files'
import { parseMoteQuickMode, MOTE_QUICK_MODE_PATH } from './mote-quick-mode.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { homeZoneId } from './mote-model.js'

/** Read only when a real input names this source. No watcher, client role claim or copied preference store. */
export function createHostMoteInputSource(options: {
  configurationPath: string
  spatial: AgentMuxSpatialStateStore
  files: AgentMuxRpcFilesOwner
}): AgentInputMoteResolver {
  return async ({ source, agentSessionId, signal }) => {
    const fail = (): never => {
      throw new AgentMuxError(
        'The original Mote input source or primary binding is unconfirmed. The member input remains available; inspect the original Mote and input.',
        'MOTE_INPUT_SOURCE_UNCONFIRMED'
      )
    }
    signal?.throwIfAborted()
    const state = await options.spatial.read()
    signal?.throwIfAborted()
    if (!state) return fail()
    const catalog = spatialCatalog(state.graph),
      space = catalog.spaces.find((value) => value.spaceId === source.spaceId)
    const tab = catalog.tabs.find((value) => value.tabId === source.tabId),
      region = catalog.regions.find((value) => value.tabId === source.tabId && value.regionId === source.regionId)
    if (
      !space ||
      space.kind !== 'mote' ||
      space.hostId !== 'local' ||
      !tab ||
      tab.zoneId !== source.zoneId ||
      !tab.regionIds.includes(source.regionId) ||
      region?.kind !== 'agent' ||
      region.agentSessionId !== agentSessionId ||
      region.execution?.hostId !== 'local' ||
      !catalog.bindings.some((value) => value.spaceId === source.spaceId && value.zoneId === source.zoneId)
    )
      return fail()
    const zoneId = homeZoneId(space.spaceId),
      home = catalog.zones.find((value) => value.zoneId === zoneId)
    if (
      !home ||
      home.hostId !== 'local' ||
      home.workspaceId !== SCRATCH_WORKSPACE_ID ||
      !catalog.bindings.some((value) => value.spaceId === space.spaceId && value.zoneId === zoneId)
    )
      return fail()
    const raw = await readOriginalMoteConfiguration(options.configurationPath)
    signal?.throwIfAborted()
    const workspaces =
      raw && typeof raw === 'object' && 'workspaces' in raw && Array.isArray(raw.workspaces) ? raw.workspaces : []
    const matches = workspaces.filter(
      (value) =>
        value &&
        typeof value === 'object' &&
        value.id === SCRATCH_WORKSPACE_ID &&
        value.hostId === 'local' &&
        typeof value.path === 'string'
    )
    if (matches.length !== 1) return fail()
    const file = await options.files.read({
      spaceId: space.spaceId,
      zoneId,
      path: MOTE_QUICK_MODE_PATH,
      expectedResource: { hostId: 'local', workspaceId: SCRATCH_WORKSPACE_ID, workspacePath: matches[0].path }
    })
    signal?.throwIfAborted()
    if (file.result.status !== 'read') return fail()
    const parsed = parseMoteQuickMode(file.result.document.content),
      primary = parsed.status === 'valid' ? parsed.defaults.conversation : undefined
    if (!primary) return fail()
    const primaryRegion = catalog.regions.find(
      (value) => value.tabId === primary.tabId && value.regionId === primary.regionId
    )
    if (
      primaryRegion?.kind !== 'agent' ||
      primaryRegion.agentSessionId !== primary.sessionId ||
      primaryRegion.execution?.hostId !== primary.hostId ||
      !catalog.locations.some(
        (value) =>
          value.spaceId === space.spaceId &&
          value.tabId === primary.tabId &&
          value.regionId === primary.regionId &&
          value.displayWorkspaceId === primary.displayWorkspaceId &&
          value.groupId === primary.groupId
      )
    )
      return fail()
    if (primary.hostId === 'local' && primary.sessionId === agentSessionId) return null
    return {
      source,
      primary: { hostId: primary.hostId, agentSessionId: primary.sessionId },
      moteRevision: file.result.document.revision,
      spatialRevision: state.revision
    }
  }
}
