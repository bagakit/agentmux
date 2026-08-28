import type { TopicRegionCell } from '../lib/scratch-topic-layout'
import { useId } from 'react'
import { Layers3, PanelTop, SplitSquareVertical } from 'lucide-react'
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
    {tabs.length > 0 ? <TopicWorkbenchTopology tabs={tabs} /> : cells ? <RegionMosaic cells={cells} agents={agents} /> : null}
    <SelectorPresence agents={agents.filter((agent) => !mounted.has(agent.key))} />
  </span>
}

function compactExecutorLabel(label: string): string {
  const firstWord = label.split(/[·/]/u)[0]?.trim() ?? label
  return firstWord.length > 7 ? `${firstWord.slice(0, 6)}…` : firstWord
}

function surfaceLabel(kind: TopicRegionDetail['surfaceKind']): string {
  switch (kind) {
    case 'agent': return 'Agent'
    case 'terminal': return 'Terminal'
    case 'browser': return 'Browser'
    case 'file': return 'File'
    case 'launcher': return 'Launcher'
    default: return 'Region'
  }
}

function RegionLayout({
  regions,
  className
}: {
  regions: readonly TopicRegionDetail[]
  className: string
}) {
  return (
    <span className={className} aria-label={`${regions.length} Regions`}>
      {regions.map((region) => (
        <span
          className={`${className}__region`}
          data-region-kind={region.surfaceKind}
          key={region.regionId}
          style={{
            left: `${region.bounds.x * 100}%`,
            top: `${region.bounds.y * 100}%`,
            width: `${region.bounds.width * 100}%`,
            height: `${region.bounds.height * 100}%`
          }}
          title={`${region.executorLabel}: ${region.activity}`}
        >
          <span className={`${className}__region-label`}>
            <strong>{compactExecutorLabel(region.executorLabel)}</strong>
            <small>{surfaceLabel(region.surfaceKind)}</small>
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * A compact workbench preview is the first visual answer to "what is open in this Topic?".
 * The same anchor owns the hover/focus inspector, so Tab/Region/Executor facts never become
 * three unrelated icon clusters in a selector row.
 */
export function TopicWorkbenchTopology({ tabs }: { tabs: readonly TopicTabDetail[] }) {
  const popoverId = useId()
  const active = tabs.find((tab) => tab.active) ?? tabs[0]
  const regionCount = tabs.reduce((total, tab) => total + tab.regions.length, 0)
  const tabLabel = `${tabs.length} ${tabs.length === 1 ? 'Tab' : 'Tabs'}`
  const regionLabel = `${regionCount} ${regionCount === 1 ? 'Region' : 'Regions'}`
  const label = `${tabLabel}, ${regionLabel}. Hover or focus to inspect the Topic workbench.`
  return (
    <span
      className="topic-workbench-topology"
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={popoverId}
      title={label}
    >
      <span className="topic-workbench-topology__preview" aria-hidden="true">
        <span className="topic-workbench-topology__tab-rail">
          {tabs.slice(0, 3).map((tab, index) => (
            <span className={`topic-workbench-topology__tab-chip${tab.active ? ' active' : ''}`} key={tab.tabId}>
              <PanelTop size={9} />
              <b>T{index + 1}</b>
            </span>
          ))}
          {tabs.length > 3 ? <span className="topic-workbench-topology__tab-more">+{tabs.length - 3}</span> : null}
        </span>
        {active ? <RegionLayout regions={active.regions} className="topic-workbench-topology__regions" /> : null}
      </span>
      <span className="topic-workbench-topology__counts">
        <Layers3 size={11} aria-hidden="true" />
        <strong>{tabs.length}</strong><span>tabs</span>
        <i aria-hidden="true">·</i>
        <strong>{regionCount}</strong><span>regions</span>
      </span>
      <span id={popoverId} className="topic-workbench-topology__inspector" role="tooltip">
        <span className="topic-workbench-topology__inspector-head">
          <span><Layers3 size={13} /><strong>Topic workbench</strong></span>
          <em>{tabLabel} · {regionLabel}</em>
        </span>
        <span className="topic-workbench-topology__tabs">
          {tabs.map((tab, index) => (
            <span className={`topic-workbench-topology__tab${tab.active ? ' active' : ''}`} key={tab.tabId}>
              <span className="topic-workbench-topology__tab-head">
                <span className="topic-workbench-topology__tab-index">T{index + 1}</span>
                <PanelTop size={11} />
                <strong title={tab.title}>{tab.title}</strong>
                {tab.active ? <em>Active</em> : null}
                <small>{tab.regions.length} {tab.regions.length === 1 ? 'Region' : 'Regions'}</small>
              </span>
              <RegionLayout regions={tab.regions} className="topic-workbench-topology__inspector-regions" />
              <span className="topic-workbench-topology__activity">
                {tab.regions.map((region) => (
                  <span className="topic-workbench-topology__activity-item" key={`${tab.tabId}:${region.regionId}`}>
                    <span><SplitSquareVertical size={10} /><strong>{region.executorLabel}</strong></span>
                    <small>{region.activity}</small>
                  </span>
                ))}
              </span>
            </span>
          ))}
        </span>
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
