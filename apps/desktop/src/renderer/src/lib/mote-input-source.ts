import type { AgentInputMoteSource } from '@agentmux/core'
import type { OpenHttpLinkOrigin } from './open-destination'
import { useAppStore } from '../store'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import { spatialCatalog } from './space-agent-control'

/** Resolve only on explicit submit. Host verifies this original locator and freezes its primary. */
export function moteInputSource(sessionId: string, origin: OpenHttpLinkOrigin | undefined): AgentInputMoteSource | undefined {
  if (!origin?.tabId || !origin.regionId) return
  const state = useAppStore.getState(), tab = state.tabs[origin.tabId]
  const region = tab?.regions[origin.regionId]
  if (!tab || region?.kind !== 'agent' || region.sessionId !== sessionId) return
  const catalog = spatialCatalog(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [])
  const member = catalog.tabs.find(item => item.tabId === tab.id)
  if (!member?.zoneId) return
  const spaces = catalog.spaces.filter(space => space.kind === 'mote' && catalog.bindings.some(binding => binding.spaceId === space.spaceId && binding.zoneId === member.zoneId))
  if (spaces.length !== 1) return
  return { spaceId: spaces[0]!.spaceId, zoneId: member.zoneId, tabId: tab.id, regionId: origin.regionId }
}

/** Discovery only: exact MOTE.md and original identity determine primary/member roles. */
export const MOTE_INPUT_GUIDANCE = 'Mote collaboration: use the Mote guide (amux mote --skill; reuse it if already read). Inspect the original MOTE.md binding and your whoami identity to distinguish the main Agent from a member. This workface source does not assign a role or grant permission. Preserve the original human request and existing work.'
