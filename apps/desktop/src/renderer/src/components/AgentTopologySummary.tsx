import { GitBranch, Layers3, PanelTop, SplitSquareVertical } from 'lucide-react'
import type { SessionSnapshot, AppConfig } from '../../../shared/contracts'
import { agentProviderLabel } from './AgentProviderIcon'
import { workbenchSurfaces, type WorkbenchTab } from '../lib/workbench-tabs'

export type AgentTopologyRegion = {
  regionId: string
  kind: string
  sessionId?: string
  agentLabel?: string
  providerId?: string
  executorId?: string
  status?: string
}

export type AgentTopologyTab = {
  tabId: string
  topicId: string
  branch: string
  regions: AgentTopologyRegion[]
}

export type AgentTopologyProjection = {
  workspaceId: string
  topicId: string
  branch: string
  tabs: AgentTopologyTab[]
}

export function projectAgentTopology(input: {
  sessionIds: readonly string[]
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  config: AppConfig | null
}): AgentTopologyProjection[] {
  const requested = new Set(input.sessionIds)
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]))
  const projections: AgentTopologyProjection[] = []
  for (const tab of Object.values(input.tabs)) {
    const regions = workbenchSurfaces(tab).map((surface): AgentTopologyRegion => {
      const sessionId = 'sessionId' in surface ? surface.sessionId : undefined
      const session = sessionId ? sessionById.get(sessionId) : undefined
      return {
        regionId: surface.regionId,
        kind: surface.kind,
        ...(sessionId ? { sessionId } : {}),
        ...(session ? {
          agentLabel: session.label,
          ...(session.kind === 'agent' ? { providerId: session.providerId, executorId: session.executorId } : {}),
          status: session.status.state
        } : {})
      }
    })
    const linked = regions.some((region) => region.sessionId !== undefined && requested.has(region.sessionId))
    if (!linked) continue
    const workspace = input.config?.workspaces.find((entry) => entry.id === tab.workspaceId)
    const branch = workspace?.branch ?? workspace?.name ?? workspace?.path ?? 'Unknown branch'
    const topicId = tab.topicId ?? 'unbound'
    const existing = projections.find((projection) => projection.workspaceId === tab.workspaceId && projection.topicId === topicId && projection.branch === branch)
    const nextTab = { tabId: tab.id, topicId, branch, regions }
    if (existing) existing.tabs.push(nextTab)
    else projections.push({ workspaceId: tab.workspaceId, topicId, branch, tabs: [nextTab] })
  }
  for (const projection of projections) projection.tabs.sort((left, right) => left.tabId.localeCompare(right.tabId))
  return projections.sort((left, right) => `${left.topicId}/${left.branch}`.localeCompare(`${right.topicId}/${right.branch}`))
}

export function AgentTopologySummary({ sessionIds, sessions, tabs, config, className = '' }: {
  sessionIds: readonly string[]
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  config: AppConfig | null
  className?: string
}) {
  const projections = projectAgentTopology({ sessionIds, sessions, tabs, config })
  return <div className={`agent-topology-summary ${className}`.trim()} data-agent-topology aria-label="Agent work topology">
    <header className="agent-topology-summary__header"><Layers3 size={13} /><strong>Agent work topology</strong><span>{projections.reduce((count, projection) => count + projection.tabs.length, 0)} tabs</span></header>
    {projections.length === 0 ? <p className="agent-topology-summary__empty">No open Topic / Tab / Region facts for the linked Session.</p> : <div className="agent-topology-summary__tree">
      {projections.map((projection) => <section className="agent-topology-summary__topic" key={`${projection.workspaceId}:${projection.topicId}:${projection.branch}`}>
        <div className="agent-topology-summary__topic-line"><PanelTop size={12} /><strong>{projection.topicId}</strong><span><GitBranch size={11} /> {projection.branch}</span></div>
        {projection.tabs.map((tab) => <section className="agent-topology-summary__tab" key={tab.tabId} data-tab-id={tab.tabId}>
          <div className="agent-topology-summary__tab-line"><PanelTop size={11} /><strong>{tab.tabId}</strong><span>{tab.regions.length} regions</span></div>
          <div className="agent-topology-summary__regions">
            {tab.regions.map((region) => <div className="agent-topology-summary__region" key={region.regionId} data-region-id={region.regionId}>
              <SplitSquareVertical size={11} /><span className="agent-topology-summary__region-kind">{region.kind}</span>
              {region.agentLabel ? <span className="agent-topology-summary__agent">{region.agentLabel}</span> : <span className="agent-topology-summary__agent agent-topology-summary__agent--unknown">No Agent</span>}
              {region.providerId ? <span className="agent-topology-summary__provider">{agentProviderLabel(region.providerId)} · {region.executorId}</span> : null}
              {region.status ? <span className="agent-topology-summary__status">{region.status}</span> : null}
            </div>)}
          </div>
        </section>)}
      </section>)}
    </div>}
  </div>
}
