import type { TopicRegionCell } from '../lib/scratch-topic-layout'
import { AgentAvatar } from './AgentAvatar'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'
import { WorkbenchTopology, type WorkbenchTabDetail } from './WorkbenchTopology'

/** Agent identity belongs inside its Region; unmounted background Agents retain their own entry. */
export function TopicPresence({ cells, agents, tabs = [], onSelectTab }: {
  cells?: readonly TopicRegionCell[] | undefined
  agents: readonly SelectorPresenceAgent[]
  tabs?: readonly WorkbenchTabDetail[]
  onSelectTab?: (tabId: string, groupId?: string) => void
}) {
  // A Session already represented by any Tab has an identity slot in that Tab. Keep the
  // separate roster for healthy background Agents that have no open Region only.
  const mounted = new Set(
    tabs.length > 0
      ? tabs.flatMap((tab) => tab.regions.flatMap((region) => {
        const sessionId = region.agent?.sessionId ?? region.agentSessionId
        return sessionId ? [sessionId] : []
      }))
      : (cells ?? []).flatMap((cell) => cell.agentSessionId ? [cell.agentSessionId] : [])
  )
  return <span className="topic-presence">
    {tabs.length > 0 ? <WorkbenchTopology tabs={tabs} onSelectTab={onSelectTab} /> : cells ? <RegionMosaic cells={cells} agents={agents} /> : null}
    <SelectorPresence agents={agents.filter((agent) => !mounted.has(agent.key))} />
  </span>
}

export function RegionMosaic({ cells, agents = [] }: {
  cells: readonly TopicRegionCell[]
  agents?: readonly SelectorPresenceAgent[]
}) {
  return (
    <span className="topic-region-mosaic">
      {cells.map((cell) => {
        const agent = agents.find((entry) => entry.key === cell.agentSessionId)
        return <span
          key={cell.regionId}
          className="topic-region-mosaic__cell"
          data-region-id={cell.regionId}
          style={{
            left: `${cell.bounds.x * 100}%`,
            top: `${cell.bounds.y * 100}%`,
            width: `${cell.bounds.width * 100}%`,
            height: `${cell.bounds.height * 100}%`
          }}
        >{agent ? <AgentAvatar executorId={agent.executorId} sessionId={agent.sessionId} label={agent.label} providerId={agent.providerId} state={agent.state} appearance={agent.appearance} count={agent.count} onOpen={agent.onOpen} /> : null}</span>
      })}
    </span>
  )
}
