import type { AgentMuxAgentSession, AgentMuxInteractionRequest } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceAddress, AgentMuxMoteConversationReference } from '@agentmux/core/control'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason } from '@agentmux/core/agent-interaction-state'
import type { MobileObjectIdentity } from './MobileIdentity'

export type MobileMoteMember = {
  key: string; sessionId: string; hostId: string | null; name: string; places: AgentMuxSpaceAddress[]
  regions: Array<{ tabId: string; regionId: string }>
  presentation: NonNullable<AgentMuxSpaceCatalog['agentPresentation']>[number] | undefined
  session: AgentMuxAgentSession | undefined; request: AgentMuxInteractionRequest | undefined; issue: string | undefined
}
export type MobileMoteTeam = {
  spaceId: string; name: string; members: MobileMoteMember[]
  main: { reference: AgentMuxMoteConversationReference; confirmed: boolean } | undefined
  facts: NonNullable<AgentMuxSpaceCatalog['motePresentation']>[number] | undefined
}
const sameMain = (left: AgentMuxMoteConversationReference, right: AgentMuxMoteConversationReference) =>
  (['hostId', 'sessionId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'] as const).every(key => left[key] === right[key])

/** Read-only presentation over original topology and typed Session facts, never input authority. */
export function mobileMoteTeam(catalog: AgentMuxSpaceCatalog, spaceId: string, client: AgentMuxHostedClient | null): MobileMoteTeam | null {
  const owners = catalog.spaces.filter(space => space.spaceId === spaceId && space.kind === 'mote')
  if (owners.length !== 1) return null
  const owner = owners[0]!, zones = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  const tabs = catalog.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId))
  const records = new Map<string, { sessionId: string; hostId: string | null; places: AgentMuxSpaceAddress[]; regions: MobileMoteMember['regions'] }>()
  for (const tab of tabs) for (const region of catalog.regions) {
    if (region.tabId !== tab.tabId || !tab.regionIds.includes(region.regionId) || region.kind !== 'agent' || !region.agentSessionId) continue
    const sessionId = region.agentSessionId, hostId = region.execution?.hostId ?? null
    const key = JSON.stringify(hostId ? ['agent', hostId, sessionId] : ['unknown-agent', tab.tabId, region.regionId, sessionId])
    const member = records.get(key) ?? { sessionId, hostId, places: [], regions: [] }
    member.regions.push({ tabId: tab.tabId, regionId: region.regionId })
    member.places.push(...catalog.locations.filter(place => place.spaceId === spaceId && place.zoneId === tab.zoneId &&
      place.tabId === tab.tabId && place.regionId === region.regionId))
    records.set(key, member)
  }
  const occurrences = new Map<string, number>()
  for (const record of records.values()) occurrences.set(record.sessionId, (occurrences.get(record.sessionId) ?? 0) + 1)
  const facts = catalog.motePresentation?.filter(value => value.spaceId === spaceId)
  const fact = facts?.length === 1 ? facts[0] : undefined
  const saved = fact?.quickMode.status === 'saved' ? fact.quickMode.defaults.conversation : undefined
  const confirmed = saved && fact?.conversation && sameMain(saved, fact.conversation) &&
    tabs.some(tab => tab.tabId === saved.tabId && tab.regionIds.includes(saved.regionId)) &&
    catalog.regions.some(region => region.tabId === saved.tabId && region.regionId === saved.regionId &&
      region.kind === 'agent' && region.agentSessionId === saved.sessionId && region.execution?.hostId === saved.hostId) &&
    catalog.locations.some(place => place.spaceId === spaceId && place.tabId === saved.tabId && place.regionId === saved.regionId &&
      place.displayWorkspaceId === saved.displayWorkspaceId && place.groupId === saved.groupId)
  return { spaceId, name: owner.name, facts: fact,
    main: saved ? { reference: saved, confirmed: Boolean(confirmed) } : undefined,
    members: [...records].map(([key, record]) => {
      const { sessionId, hostId } = record
      let observed: AgentMuxAgentSession | undefined
      try { observed = client?.agentSession(sessionId) } catch { /* A missing observation does not replace the original Host/Region reference. */ }
      const session = hostId && observed?.agentSessionId === sessionId && observed.hostId === hostId ? observed : undefined
      const rows = catalog.agentPresentation?.filter(row => row.agentSessionId === sessionId)
      // These name rows have no Host field. A shared bare SID cannot lend a name across Hosts or unknown Regions.
      const presentation = session && occurrences.get(sessionId) === 1 && rows?.length === 1 ? rows[0] : undefined
      const issue = !hostId ? '这个成员的执行端尚未确认；已有讨论和工作面引用保留，可刷新团队核对。'
        : observed && !session ? '当前连接与这个成员不匹配；已有引用保留，请接回对应的工作环境。'
          : !session ? '这个成员的原对话尚未确认；已有引用保留，可刷新团队或从原工作面继续。' : undefined
      const pending = !issue && hostId && session?.hostId === hostId ? session.pendingInteraction : undefined
      const request = agentInteractionActiveRequest(pending)
      const requestCurrent = request && session && request.agentSessionId === sessionId &&
        (!request.evidence?.run || request.evidence.run.runId === session.run.runId) && !agentInteractionResponseUnavailableReason(pending!)
      return { key, sessionId, hostId, name: presentation?.name ?? '成员名称未确认', places: record.places, regions: record.regions, presentation, session,
        request: requestCurrent ? request : undefined, issue }
    }) }
}

export function mobileMoteMemberIdentity(team: MobileMoteTeam, member: MobileMoteMember, place?: AgentMuxSpaceAddress): MobileObjectIdentity {
  return { name: member.name, project: team.name, ...(place ? { context: place } : {}),
    mote: { spaceId: team.spaceId, name: team.name, facts: team.facts,
      conversationName: team.main ? team.members.find(value => value.sessionId === team.main!.reference.sessionId && value.hostId === team.main!.reference.hostId)?.presentation?.name : undefined } }
}

export function mobileMoteMainIdentity(team: MobileMoteTeam): MobileObjectIdentity | undefined {
  const main = team.main
  if (!main) return undefined
  const member = team.members.find(value => value.sessionId === main.reference.sessionId && value.hostId === main.reference.hostId)
  const places = member?.places.filter(place => place.tabId === main.reference.tabId && place.regionId === main.reference.regionId &&
    place.displayWorkspaceId === main.reference.displayWorkspaceId && place.groupId === main.reference.groupId) ?? []
  return { name: member?.name ?? '原主对话', project: team.name,
    ...(main.confirmed && places.length === 1 ? { context: places[0] } : {}),
    mote: { spaceId: team.spaceId, name: team.name, facts: team.facts } }
}
