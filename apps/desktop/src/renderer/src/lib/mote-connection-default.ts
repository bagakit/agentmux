import type { MotePreferencesTarget, MoteConnectionRef } from '@agentmux/core/mote-preferences'
import type { ConnectionRecord } from '@agentmux/core/connections'
import { homeZoneId, originalTopicAddress, type SpaceZoneBindings } from '../../../shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { workbenchNavigationCatalog } from './workbench-navigation-catalog'
import type { useAppStore } from '../store'
import type { MoteWorkfaceScope } from './mote-workface'

/** The original content home is independent of the Agent's execution resource. */
export function moteConnectionTarget(scope: MoteWorkfaceScope, bindings: SpaceZoneBindings): MotePreferencesTarget | null {
  const address = originalTopicAddress(scope.workspace, scope.topic, bindings)
  return address ? { ...address, expectedResource: { hostId: scope.workspace.hostId,
    workspaceId: scope.workspace.id, workspacePath: scope.workspace.path } } : null
}

/** This checks a reference; it never substitutes another healthy application. */
export function moteConnectionChoice(ref: MoteConnectionRef, records: readonly ConnectionRecord[]): {
  record: ConnectionRecord | null; issue: string | null
} {
  const matches = records.filter(record => record.config.connectionId === ref.connectionId)
  const record = matches.length === 1 ? matches[0]! : null
  if (!record) return { record: null, issue: 'The saved bot is unavailable here. Choose another saved bot or open bot settings.' }
  if (record.config.application.domain !== ref.application.domain || record.config.application.appId !== ref.application.appId)
    return { record: null, issue: 'This connection belongs to a different bot. Keep the original reference or choose another bot.' }
  return { record, issue: record.config.enabled ? null : 'This bot is paused. Choose another saved bot or enable it in bot settings.' }
}

export type AgentMoteConnectionSource = { target: MotePreferencesTarget; name: string } | { issue: string }

/** Read the original Tab's effective memberships once when its menu action is selected. */
export function agentMoteConnectionSource(state: ReturnType<typeof useAppStore.getState>, tabId: string,
  regionId: string, sessionId: string): AgentMoteConnectionSource | undefined {
  const tab = state.tabs[tabId], region = tab?.regions[regionId]
  if (!tab || region?.kind !== 'agent' || region.sessionId !== sessionId) return { issue: 'The original Agent display changed. Choose a bot explicitly for this group.' }
  const workspace = state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) return undefined
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []
  const catalog = workbenchNavigationCatalog(state, topics)
  const original = catalog.tabs.find(item => item.tabId === tabId)
  if (!original?.zoneId) return { issue: 'This Agent’s original group context is unconfirmed. Choose a bot for this group.' }
  const motes = catalog.spaces.filter(space => space.kind === 'mote' && catalog.bindings.some(binding => binding.spaceId === space.spaceId && binding.zoneId === original.zoneId))
  // A content-home Tab identifies its Mote even when its Agent executes elsewhere.
  const home = tab.workspaceId === workspace.id && tab.topicId ? motes.filter(space => space.topicId === tab.topicId && original.zoneId === homeZoneId(space.spaceId)) : []
  const candidates = home.length === 1 ? home : motes
  if (!candidates.length) return undefined
  if (candidates.length !== 1) return { issue: 'This Agent is shared by several Motes. Choose the bot for this group.' }
  const mote = candidates[0]!, zoneId = homeZoneId(mote.spaceId)
  const zone = catalog.zones.find(item => item.zoneId === zoneId && item.kind === 'home' && item.workspaceId === workspace.id && item.hostId === workspace.hostId)
  if (!zone || !catalog.bindings.some(binding => binding.spaceId === mote.spaceId && binding.zoneId === zoneId))
    return { issue: 'The original Mote home is unconfirmed. Choose a bot for this group.' }
  return { name: mote.name, target: { spaceId: mote.spaceId, zoneId,
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } } }
}
