import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { isPrimaryMoteSpace } from '@agentmux/core/mote-preferences'
import type { MobileObjectIdentity } from './MobileIdentity'

export type MobileChatStart = { sessionId: string | null; identity: MobileObjectIdentity | null; issue: string | null }

/** Discovery chooses one typed object; a later presentation cannot substitute another owner. */
export function mobileMoteOwner(catalog: AgentMuxSpaceCatalog, spaceId: string | null,
  expected?: AgentMuxSpaceCatalog['spaces'][number]) {
  const owners = catalog.spaces.filter(space => space.kind === 'mote' && (spaceId ? space.spaceId === spaceId : isPrimaryMoteSpace(space)))
  const owner = owners.length === 1 ? owners[0] : undefined
  return owner && (!expected || owner.spaceId === expected.spaceId && owner.hostId === expected.hostId && owner.topicId === expected.topicId) ? owner : undefined
}

/** Resolve saved identities, never activity, appearance or a first Session in the list. */
export function mobileChatStart(catalog: AgentMuxSpaceCatalog, recentMoteSpaceId: string | null): MobileChatStart {
  const motes = catalog.spaces.filter(space => space.kind === 'mote')
  const recent = recentMoteSpaceId ? motes.filter(space => space.spaceId === recentMoteSpaceId) : []
  const primary = motes.filter(isPrimaryMoteSpace)
  const candidates = recent.length === 1 ? [...recent, ...primary.filter(space => space.spaceId !== recentMoteSpaceId)] : primary
  if (recentMoteSpaceId && recent.length !== 1) return { sessionId: null, identity: null, issue: '最近使用的 Mote 还没确认，可以打开 Mote 查看。' }
  let setupIdentity: MobileObjectIdentity | null = null
  for (const owner of candidates) {
    // More than one primary Host has no implicit winner. The recent exact object is independent.
    if (owner !== recent[0] && primary.length !== 1) break
    const facts = catalog.motePresentation?.filter(value => value.spaceId === owner.spaceId)
    const fact = facts?.length === 1 ? facts[0] : undefined
    const identity: MobileObjectIdentity = { name: owner.name, project: owner.name, mote: { spaceId: owner.spaceId, name: owner.name, facts: fact } }
    setupIdentity = identity
    if (!fact || fact.quickMode.status === 'unconfirmed') return { sessionId: null, identity, issue: fact?.quickMode.status === 'unconfirmed' ? fact.quickMode.message : '主对话配置还没确认，可以查看 Mote 资料或选择已有对话。' }
    const main = fact.quickMode.status === 'saved' ? fact.quickMode.defaults.conversation : undefined
    if (!main) continue
    const confirmed = fact.conversation
    const matches = confirmed && confirmed.hostId === main.hostId && confirmed.sessionId === main.sessionId &&
      confirmed.displayWorkspaceId === main.displayWorkspaceId && confirmed.groupId === main.groupId &&
      confirmed.tabId === main.tabId && confirmed.regionId === main.regionId
      ? catalog.locations.filter(place => place.spaceId === owner.spaceId && place.displayWorkspaceId === main.displayWorkspaceId &&
        place.groupId === main.groupId && place.tabId === main.tabId && place.regionId === main.regionId &&
        catalog.regions.some(region => region.regionId === place.regionId && region.tabId === place.tabId &&
          region.kind === 'agent' && region.agentSessionId === main.sessionId && region.execution?.hostId === main.hostId)) : []
    const row = catalog.agentPresentation?.find(value => value.agentSessionId === main.sessionId)
    return { sessionId: main.sessionId, identity: { ...identity, name: row?.name ?? owner.name,
      ...(matches.length === 1 ? { context: matches[0] } : {}),
      mote: { ...identity.mote!, conversationName: row?.name } }, issue: null }
  }
  return { sessionId: null, identity: setupIdentity, issue: primary.length > 1
    ? '多台 Mac 上都有主 Mote，请选择一个后继续。' : '尚未保存主对话，可在 Mote 中设置主 Agent，或选择已有对话。' }
}
