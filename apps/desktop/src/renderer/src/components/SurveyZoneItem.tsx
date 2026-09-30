import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { ArrowUpRight, CircleHelp, Layers3, Link2, MoreHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import * as DropdownMenu from './HoverDropdownMenu'

/** Survey navigation only; the caller supplies original entity, resource and relationship facts. */
export function SurveyZoneItem({ zone, title, selected, sourceWorkspace, relatedTopics, activity, activityDetails, onSelect, onOpenWorkspace }: {
  zone: AgentMuxZoneFact
  title: string
  selected: boolean
  sourceWorkspace: WorkspaceRecord | null
  /** null is unconfirmed discovery, not an empty relationship set. */
  relatedTopics: readonly AgentMuxSpaceFact[] | null
  /** Scoped original Browser/Core facts, including mixed or unknown status. */
  activity: ReactNode
  activityDetails: ReactNode
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
      <strong>{title}</strong>
      <span className="survey-item-meta">
        {topics === null ? <small title={topicSummary} aria-label={topicSummary}><Link2 size={11} aria-hidden="true" /></small> : topics.length ? <small title={topicNames} aria-label={`${topicSummary}: ${topicNames}`}><Link2 size={11} aria-hidden="true" />{topics.length}</small> : null}
        {!sourceWorkspace ? <small title="Resource unknown" aria-label="Resource unknown"><CircleHelp size={11} aria-hidden="true" /></small> : null}
        <span className="survey-item-activity" aria-label={`Activity in ${title}`}>{activity}</span>
      </span>
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className="survey-item-details" aria-label={`Details for survey item: ${title}`} title="Item details"><MoreHorizontal size={13} aria-hidden="true" /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu survey-topic-menu" align="start" sideOffset={4} collisionPadding={8}>
        <DropdownMenu.Label className="survey-topic-menu__label">{title}</DropdownMenu.Label>
        <div className="survey-item-details-content"><span>{resourceDescription}</span><span>{topicSummary}</span>{topics?.map(topic => <span key={topic.spaceId}>{topic.name} · {topic.hostId} · {topic.directoryPath}</span>)}{activityDetails}</div>
        {sourceWorkspace ? <DropdownMenu.Item className="tab-context-menu__item" aria-label={`Open resource Workspace: ${sourceWorkspace.name}, ${sourceWorkspace.hostId}, ${sourceWorkspace.path}`}
          onSelect={() => onOpenWorkspace(sourceWorkspace.id)}><ArrowUpRight size={13} /><span>Open resource Workspace</span></DropdownMenu.Item> : null}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>
}
