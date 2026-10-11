import { COLLECTED_REPLY_TITLE } from '../lib/conversation-sources.js'
import type { ConversationSourceDisplay } from '../lib/conversation-sources.js'

/** Recorded source provenance only; never authorship, channel, delivery or adoption. */
export function ConversationSourceLabels({ sources, observation }: { observation?: string | undefined; sources?: ConversationSourceDisplay | undefined }) {
  if ((!sources || !sources.labels.length && !sources.unread) && !observation) return null
  return <span className="conversation-source-labels" aria-label="记录来源">
    {observation ? <span data-conversation-source-role="reply-observation" title={observation}>{COLLECTED_REPLY_TITLE}</span> : null}
    {sources?.labels.map(source => <span key={source.id} data-conversation-source={source.id} title={source.title}>{source.label}</span>)}
    {sources?.unread ? <span data-conversation-source-unread title="The exact related source record or version is not loaded. Original content remains readable.">关联来源未读</span> : null}
  </span>
}
