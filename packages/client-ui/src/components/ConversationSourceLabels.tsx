import type { ConversationSourceDisplay } from '../lib/conversation-sources.js'

/** Recorded source provenance only; never authorship, channel, delivery or adoption. */
export function ConversationSourceLabels({ sources, unconfirmed = false }: { sources?: ConversationSourceDisplay | undefined; unconfirmed?: boolean }) {
  if (!sources || !sources.labels.length && !sources.unread) return null
  return <span className="conversation-source-labels" aria-label="记录来源">
    {sources.labels.map(source => <span key={source.id} data-conversation-source={source.id} title={source.title}>{source.label}</span>)}
    {sources.unread ? <span data-conversation-source-unread title="The exact related source record or version is not loaded. Original content remains readable.">关联来源未读</span> : null}
    {unconfirmed ? <span className="conversation-source-labels__unknown" title="Cross-source relationships are partial. Independent records do not establish separate accepted inputs or executions.">跨来源关联未确认</span> : null}
  </span>
}
