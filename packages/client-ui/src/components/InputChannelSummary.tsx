import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import { channelActorKey } from '@agentmux/core/connections'
import type { ConversationSpeaker, DescribeSpeaker } from '../lib/conversation-speaker.js'

/** Only an already-related original journal supplies quote facts; authored wire never does. */
export function InputChannelSummary({ speaker, described, inputs = [] }: {
  speaker: ConversationSpeaker
  described?: ReturnType<DescribeSpeaker> | undefined
  inputs?: readonly AgentInputMailboxItem[] | undefined
}) {
  const author = speaker.external
  if (!author) return null
  const originals = inputs.filter(item => {
    const sender = item.kind === 'controlled' ? item.message?.sender : undefined
    return sender?.kind === 'external' && sender.connectionId === author.connectionId &&
      channelActorKey(sender.actor) === channelActorKey(author.actor) && sender.externalConversationId === author.externalConversationId &&
      sender.externalMessageId === author.externalMessageId && sender.authoritySource?.hostingRuntimeId === author.authoritySource?.hostingRuntimeId
  })
  const original = originals.length === 1 && originals[0]?.kind === 'controlled' ? originals[0] : undefined
  const quote = original?.message?.channelQuote
  const reference = original?.intent.source.kind === 'message' && original.intent.source.representation?.quote === 'reference'
  const count = quote?.records.length
  const label = !quote ? 'Quote not recorded' : quote.coverage === 'unavailable' ? 'Quote unavailable'
    : `${count} quoted ${count === 1 ? 'message' : 'messages'}${quote.coverage === 'partial' ? ' · history gaps' : ''}${reference ? ' · reference' : ''}`
  const room = described?.channelConversation?.profile?.name ?? 'Conversation name unavailable'
  const issue = [described?.channelProfileReadIssue, described?.channelConversationReadIssue].filter(Boolean)
  return <span className="composer-mailbox__channel-context" data-input-channel={author.externalConversationId}>
    <span className="composer-mailbox__channel-room" title={`${room}\n${author.actor.application.domain} · ${author.externalConversationId}`}>in {room}</span>
    <span className="composer-mailbox__channel-quote" data-input-quote={quote?.coverage ?? 'unknown'} title={quote
      ? `${count} saved earlier messages; current request excluded. ${reference ? 'Context supplied by reference.' : 'Original quoted context.'}${quote.gaps.length ? ` Gaps: ${quote.gaps.map(gap => gap.reason).join(', ')}` : ''}`
      : 'No exact original quote observation is available for this record.'}>{label}</span>
    {issue.length ? <span className="composer-mailbox__channel-issue" role="status" title={[...new Set(issue)].join(' · ')}>Profile update unconfirmed</span> : null}
  </span>
}
