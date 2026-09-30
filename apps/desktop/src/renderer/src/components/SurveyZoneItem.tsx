import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { ArrowUpRight, Layers3 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'

/** Survey navigation only; the caller supplies original entity, resource and relationship facts. */
export function SurveyZoneItem({ zone, title, selected, sourceWorkspace, relatedTopics, activity, onSelect, onOpenWorkspace }: {
  zone: AgentMuxZoneFact
  title: string
  selected: boolean
  sourceWorkspace: WorkspaceRecord | null
  /** null is unconfirmed discovery, not an empty relationship set. */
  relatedTopics: readonly AgentMuxSpaceFact[] | null
  /** Scoped original Browser/Core facts, including mixed or unknown status. */
  activity: ReactNode
  onSelect(zoneId: string): void
  onOpenWorkspace(workspaceId: string): void
}) {
  const topics = relatedTopics === null ? null : relatedTopics.filter(topic => topic.kind === 'topic')
  const topicNames = topics?.map(topic => `${topic.name} · ${topic.hostId} · ${topic.directoryPath}`).join('\n')
  const topicSummary = topics === null ? 'Topic links unknown'
    : topics.length === 0 ? 'No Topic links' : `${topics.length} linked Topic${topics.length === 1 ? '' : 's'}`
  const resourceDescription = sourceWorkspace
    ? `${sourceWorkspace.name}\n${sourceWorkspace.hostId}\n${sourceWorkspace.path}${sourceWorkspace.branch ? `\nBranch: ${sourceWorkspace.branch}` : ''}`
    : 'Resource Workspace is not confirmed. The original item is retained.'

  return <div className="survey-item-row" data-survey-zone-id={zone.zoneId} data-selected={selected}>
    <button type="button" className="survey-item" aria-label={`Show survey item: ${title}`}
      aria-current={selected ? 'true' : undefined} title={title} onClick={() => onSelect(zone.zoneId)}>
      <Layers3 size={14} aria-hidden="true" />
      <span><strong>{title}</strong><small title={topicNames} aria-label={topicNames ? `${topicSummary}: ${topicNames}` : topicSummary}>{topicSummary}</small></span>
    </button>
    <div className="survey-item-meta">
      {sourceWorkspace ? <button type="button" className="survey-item-source"
        aria-label={`Open source Workspace: ${sourceWorkspace.name}, ${sourceWorkspace.hostId}, ${sourceWorkspace.path}`} title={resourceDescription}
        onClick={() => onOpenWorkspace(sourceWorkspace.id)}>
        <span>{sourceWorkspace.name}</span><ArrowUpRight size={10} aria-hidden="true" />
      </button> : <span className="survey-item-source" title={resourceDescription}>Resource unknown</span>}
      <span className="survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span>
    </div>
  </div>
}
