import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusTopicHeading } from '../lib/focus-collection-lanes'

const TopicIcon = semanticIconComponent('object.notebook')

/** Held Topic provenance is distinct from the Agent's task name and navigation. */
export function FocusTopicLabel({ topic }: { topic: FocusTopicHeading }) {
  return <span className="focus-context__topic" data-focus-topic-id={topic.id}
    title={[topic.name, topic.summary].filter(Boolean).join('\n')} aria-label={`Topic · ${topic.name}`}>
    <TopicIcon size={12} aria-hidden="true" /><span>{topic.name}</span>
  </span>
}
