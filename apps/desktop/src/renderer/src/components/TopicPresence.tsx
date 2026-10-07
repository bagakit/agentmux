import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'
import { WorkbenchTopology, type WorkbenchTabDetail } from './WorkbenchTopology'

/** Agent identity belongs inside its Region; unmounted background Agents retain their own entry. */
export function TopicPresence({ agents, tabs, onSelectTab }: {
  agents: readonly SelectorPresenceAgent[]
  tabs: readonly WorkbenchTabDetail[]
  onSelectTab?: (tabId: string, groupId?: string) => void
}) {
  // A Session already represented by any Tab has an identity slot in that Tab. Keep the
  // separate roster for healthy background Agents that have no open Region only.
  const mounted = new Set(
    tabs.flatMap((tab) => tab.regions.flatMap((region) => {
      const sessionId = region.agent?.sessionId ?? region.agentSessionId
      return sessionId ? [sessionId] : []
    }))
  )
  return <span className="topic-presence">
    {tabs.length > 0 ? <WorkbenchTopology tabs={tabs} onSelectTab={onSelectTab} /> : null}
    <SelectorPresence agents={agents.filter((agent) => !mounted.has(agent.key))} />
  </span>
}
