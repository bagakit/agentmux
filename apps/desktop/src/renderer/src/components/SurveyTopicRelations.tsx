import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { ArrowUpRight, Check, ChevronDown, LoaderCircle, Minus } from 'lucide-react'
import type { ReactNode } from 'react'
import * as DropdownMenu from './HoverDropdownMenu'

/** Relationship truth and mutations stay at the shared owner; Radix owns disclosure and focus. */
export function SurveyTopicRelations({ zone, topics, relatedTopics, unknownRelatedSpaces = [], pendingSpaceId, error, notice, onLinkChange, onOpenTopic }: {
  zone: AgentMuxZoneFact
  topics: readonly AgentMuxSpaceFact[] | null
  relatedTopics: readonly AgentMuxSpaceFact[] | null
  /** Confirmed relations whose original Space metadata is currently unconfirmed. */
  unknownRelatedSpaces?: readonly AgentMuxSpaceFact[]
  pendingSpaceId: string | null
  error?: ReactNode
  notice?: ReactNode
  onLinkChange(spaceId: string, linked: boolean): void
  onOpenTopic(spaceId: string): void
}) {
  const linked = relatedTopics?.filter(topic => topic.kind === 'topic')
  // Confirmed relations remain actionable when discovery is temporarily incomplete.
  // This is a render projection of owner facts, never a mirrored relationship store.
  const byId = new Map<string, AgentMuxSpaceFact>()
  for (const topic of topics ?? []) if (topic.kind === 'topic') byId.set(topic.spaceId, topic)
  for (const topic of linked ?? []) if (!byId.has(topic.spaceId)) byId.set(topic.spaceId, topic)
  const candidates = [...byId.values()]
  return <div className="survey-topic-relations" data-survey-relations-zone-id={zone.zoneId}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="survey-topic-trigger" aria-label="Link Topics">
          <span>Link Topics…</span><ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tab-context-menu survey-topic-menu" align="end" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Label className="survey-topic-menu__label">Linked Topics</DropdownMenu.Label>
          {candidates.map(topic => {
            const checked = linked === undefined ? 'indeterminate' : linked.some(candidate => candidate.spaceId === topic.spaceId)
            return <DropdownMenu.CheckboxItem key={topic.spaceId} className="tab-context-menu__item survey-topic-menu__item"
              checked={checked} disabled={linked === undefined || pendingSpaceId !== null}
              aria-label={`Link Topic: ${topic.name}, ${topic.hostId}, ${topic.directoryPath}`}
              data-survey-topic-id={topic.spaceId} title={`${topic.name}\n${topic.hostId}\n${topic.directoryPath}`}
              onSelect={event => event.preventDefault()}
              onCheckedChange={value => onLinkChange(topic.spaceId, value === true)}>
              <span className="survey-topic-menu__indicator" aria-hidden="true">
                {pendingSpaceId === topic.spaceId ? <LoaderCircle className="spin" size={13} />
                  : <DropdownMenu.ItemIndicator>{checked === 'indeterminate' ? <Minus size={13} /> : <Check size={13} />}</DropdownMenu.ItemIndicator>}
              </span>
              <span className="survey-topic-menu__context"><strong>{topic.name}</strong><small>{topic.hostId} · {topic.directoryPath}</small></span>
            </DropdownMenu.CheckboxItem>
          })}
          {topics === null ? <p className="survey-topic-menu__notice">Topic discovery is not confirmed.</p>
            : candidates.length === 0 ? <p className="survey-topic-menu__notice">No Topics are available.</p> : null}
          {relatedTopics === null ? <p className="survey-topic-menu__notice">Topic links are not confirmed. Existing content is kept.</p> : null}
          {unknownRelatedSpaces.length ? <>
            <DropdownMenu.Separator className="tab-context-menu__separator" />
            <DropdownMenu.Label className="survey-topic-menu__label">Unconfirmed linked spaces</DropdownMenu.Label>
            {unknownRelatedSpaces.map(space => <DropdownMenu.CheckboxItem key={space.spaceId} className="tab-context-menu__item survey-topic-menu__item"
              checked disabled={pendingSpaceId !== null} aria-label={`Remove unconfirmed link: ${space.hostId}, ${space.directoryPath}`}
              data-survey-topic-id={space.spaceId} onSelect={event => event.preventDefault()}
              onCheckedChange={value => { if (value === false) onLinkChange(space.spaceId, false) }}>
              <span className="survey-topic-menu__indicator" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={13} /></DropdownMenu.ItemIndicator></span>
              <span className="survey-topic-menu__context"><strong>Unconfirmed linked space</strong><small>{space.hostId} · {space.directoryPath}</small><small>{space.issue}</small></span>
            </DropdownMenu.CheckboxItem>)}
          </> : null}
          {linked && linked.length > 0 ? <>
            <DropdownMenu.Separator className="tab-context-menu__separator" />
            <DropdownMenu.Label className="survey-topic-menu__label">Open a linked Topic</DropdownMenu.Label>
            {linked.map(topic => <DropdownMenu.Item key={topic.spaceId} className="tab-context-menu__item survey-topic-menu__item"
              aria-label={`Open linked Topic: ${topic.name}, ${topic.hostId}, ${topic.directoryPath}`}
              data-survey-topic-id={topic.spaceId} title={`${topic.name}\n${topic.hostId}\n${topic.directoryPath}`}
              onSelect={() => onOpenTopic(topic.spaceId)}>
              <ArrowUpRight size={13} aria-hidden="true" /><span className="survey-topic-menu__context"><strong>{topic.name}</strong><small>{topic.hostId} · {topic.directoryPath}</small></span>
            </DropdownMenu.Item>)}
          </> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {pendingSpaceId !== null ? <div className="survey-relation-notice" role="status">Updating Topic link…</div> : null}
    {error ? <div className="survey-relation-notice survey-relation-notice--error" role="alert">{error}</div> : null}
    {notice ? <div className="survey-relation-notice">{notice}</div> : null}
  </div>
}
