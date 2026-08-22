import type { TopicRegionCell } from '../lib/scratch-topic-layout'
import { AgentAvatar } from './AgentAvatar'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'

/** Agent identity belongs inside its Region; unmounted background Agents retain their own entry. */
export function TopicPresence({ cells, agents }: {
  cells?: readonly TopicRegionCell[] | undefined
  agents: readonly SelectorPresenceAgent[]
}) {
  const mounted = new Set(cells?.map((cell) => cell.agentSessionId))
  return <span className="topic-presence">
    {cells ? <RegionMosaic cells={cells} agents={agents} /> : null}
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

