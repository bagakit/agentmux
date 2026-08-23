import type { TopicRegionCell } from '../lib/scratch-topic-layout'
import { useId } from 'react'
import { AgentAvatar } from './AgentAvatar'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'

export type TopicRegionDetail = TopicRegionCell & {
  executorLabel: string
  activity: string
}

export type TopicTabDetail = {
  tabId: string
  title: string
  active: boolean
  regions: readonly TopicRegionDetail[]
}

/** Agent identity belongs inside its Region; unmounted background Agents retain their own entry. */
export function TopicPresence({ cells, agents, tabs = [] }: {
  cells?: readonly TopicRegionCell[] | undefined
  agents: readonly SelectorPresenceAgent[]
  tabs?: readonly TopicTabDetail[]
}) {
  const mounted = new Set(cells?.map((cell) => cell.agentSessionId))
  return <span className="topic-presence">
    {cells ? <RegionMosaic cells={cells} agents={agents} /> : null}
    {tabs.length > 0 ? <TopicWorkSurfaceSummary tabs={tabs} /> : null}
    <SelectorPresence agents={agents.filter((agent) => !mounted.has(agent.key))} />
  </span>
}

function TopicWorkSurfaceSummary({ tabs }: { tabs: readonly TopicTabDetail[] }) {
  const label = `${tabs.length} ${tabs.length === 1 ? 'Tab' : 'Tabs'} in this Topic`
  const popoverId = useId()
  return (
    <span className="topic-work-surface-summary" tabIndex={0} role="group" aria-label={label} aria-describedby={popoverId} title={label}>
      <span className="topic-work-surface-summary__count">{tabs.length}</span>
      <span className="topic-work-surface-summary__label">Tabs</span>
      <span id={popoverId} className="topic-work-surface-summary__popover" role="tooltip">
        <strong>Topic work surface</strong>
        {tabs.map((tab, index) => (
          <span className="topic-work-surface-summary__tab" key={tab.tabId}>
            <span className="topic-work-surface-summary__tab-head">
              <b>{index + 1}</b>
              <strong>{tab.title}</strong>
              {tab.active ? <em>Active</em> : null}
            </span>
            <span className="topic-work-surface-summary__regions" aria-label={`${tab.regions.length} Regions`}>
              {tab.regions.map((region) => (
                <span
                  className="topic-work-surface-summary__region"
                  key={region.regionId}
                  style={{
                    left: `${region.bounds.x * 100}%`,
                    top: `${region.bounds.y * 100}%`,
                    width: `${region.bounds.width * 100}%`,
                    height: `${region.bounds.height * 100}%`
                  }}
                  title={`${region.executorLabel}: ${region.activity}`}
                >
                  <span>{region.executorLabel}</span>
                </span>
              ))}
            </span>
            <span className="topic-work-surface-summary__activity">
              {tab.regions.map((region) => (
                <span className="topic-work-surface-summary__activity-item" key={`${tab.tabId}:${region.regionId}`}>
                  <strong>{region.executorLabel}</strong><span>{region.activity}</span>
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </span>
  )
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
